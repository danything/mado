# 試験用の小さな mado(ホストで動かす)。画面(dist/web)を配り、/ws で本物の中継(server/Relay.cs をそのままコンパイル)を通して
# Hyper-V の試験用 VM の RDP へつなぐ。OIDC のログインは無い(localhost だけで待つ)。ブラウザで http://localhost:<Port>/ を開く。
#   pwsh -File tools/hyperv-test/mini-mado.ps1 -Target 172.22.x.x
# 先に `bun run build:web` で dist/web を作っておく(wslc の oven/bun でよい)
param([Parameter(Mandatory)][string]$Target, [int]$TargetPort = 3389, [int]$Port = 8790)
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot)
$web = Join-Path $repo 'dist/web'
if (-not (Test-Path (Join-Path $web 'index.html'))) { throw "$web が無い(先に bun run build:web)" }

# 中継は本物のコードを使う。internal なので、同じアセンブリに公開の入口を足す
$tmp = Join-Path ([IO.Path]::GetTempPath()) "mini-mado-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
@'
#nullable enable
global using System;
global using System.IO;
global using System.Linq;
global using System.Collections.Generic;
global using System.Threading;
global using System.Threading.Tasks;
namespace Mado
{
    internal sealed record Target(string Name, string Host, int Port);
    public static class MiniRelay
    {
        public static Task Run(System.Net.WebSockets.WebSocket ws, string host, int port) =>
            Relay.Run(ws, _ => new Target("vm", host, port), m => Console.WriteLine($"{DateTime.Now:HH:mm:ss} relay: {m}"), CancellationToken.None);
    }
}
'@ | Set-Content (Join-Path $tmp 'mini.cs') -Encoding utf8
$files = @((Join-Path $tmp 'mini.cs')) + ('Der.cs', 'RdCleanPath.cs', 'Relay.cs' | ForEach-Object { Join-Path $repo "server/$_" })
# サーバーの csproj と同じく、nullable の注釈を有効にしてコンパイルする
Add-Type -Path $files -CompilerOptions "-nullable:enable"
Remove-Item -Recurse -Force $tmp

$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.svg' = 'image/svg+xml'; '.woff2' = 'font/woff2' }
$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "mini-mado: http://localhost:$Port/ -> ${Target}:$TargetPort"
while ($listener.IsListening) {
	$ctx = $listener.GetContext()
	$path = $ctx.Request.Url.AbsolutePath
	$res = $ctx.Response
	try {
		# ほかのサイト(ブラウザで開いた別のページ)から中継や試験用の口を使わせない
		$origin = $ctx.Request.Headers['Origin']
		if ($origin -and $origin -ne "http://localhost:$Port") { $res.StatusCode = 403; $res.Close(); continue }
		if ($path -eq '/ws' -and $ctx.Request.IsWebSocketRequest) {
			$wsctx = $ctx.AcceptWebSocketAsync([NullString]::Value).GetAwaiter().GetResult()
			$null = [Mado.MiniRelay]::Run($wsctx.WebSocket, $Target, $TargetPort)
			continue
		}
		$body = $null; $type = 'application/json'
		if ($path -eq '/api/session') {
			$body = [Text.Encoding]::UTF8.GetBytes((@{ name = 'test'; version = 'mini-mado'; targets = @('mado-test'); ws = "ws://localhost:$Port/ws" } | ConvertTo-Json -Compress))
		} elseif ($path -eq '/test/password') {
			# 試験の自動化用(localhost だけ)。new-test-vm.ps1 が作った rdptest のパスワード
			$body = [IO.File]::ReadAllBytes((Join-Path $env:USERPROFILE '.mado-test/rdptest.txt')); $type = 'text/plain'
		} elseif ($path -eq '/test/upload' -and $ctx.Request.HttpMethod -eq 'POST') {
			# 試験用: ブラウザが記録した受信データ(WebSocket)を ~/.mado-test/capture.bin に置く
			$f = [IO.File]::Create((Join-Path $env:USERPROFILE '.mado-test/capture.bin'))
			$ctx.Request.InputStream.CopyTo($f); $f.Close()
			$body = [Text.Encoding]::UTF8.GetBytes('{"ok":true}')
		} elseif ($path -eq '/api/token') {
			$body = [Text.Encoding]::UTF8.GetBytes('{"token":"test"}')
		} else {
			$file = Join-Path $web ($(if ($path -eq '/') { 'index.html' } else { $path.TrimStart('/') }))
			$full = [IO.Path]::GetFullPath($file)
			if ($full.StartsWith([IO.Path]::GetFullPath($web)) -and (Test-Path $full -PathType Leaf)) {
				$body = [IO.File]::ReadAllBytes($full)
				$type = $types[[IO.Path]::GetExtension($full)] ?? 'application/octet-stream'
			}
		}
		if ($null -eq $body) { $res.StatusCode = 404; $body = [byte[]]@() }
		$res.ContentType = $type
		$res.Headers['Cache-Control'] = 'no-store'
		$res.OutputStream.Write($body, 0, $body.Length)
		$res.Close()
	} catch {
		Write-Host "error: $_"
		try { $res.Abort() } catch {}
	}
}
