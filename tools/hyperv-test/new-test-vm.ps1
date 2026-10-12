# mado の試験用の Windows を Hyper-V に作る(無人)。RDP(NLA)を有効にし、試験用ユーザー rdptest を作る。
#   pwsh -File tools/hyperv-test/new-test-vm.ps1 -Iso <Windows 11 の ISO>
# Hyper-V の操作に管理者が要るので、昇格していなければ UAC で昇格して流し直す。
# パスワードと状態はリポジトリの外(~/.mado-test/)に置く: rdptest.txt(パスワード)、ip.txt(つなぎ先)、status.txt(進み具合)
param(
	[Parameter(Mandatory)][string]$Iso,
	[string]$Name = 'mado-test',
	[string]$Dir = (Join-Path $env:ProgramData 'mado-test'),
	[string]$State = (Join-Path $env:USERPROFILE '.mado-test')
)
$ErrorActionPreference = 'Stop'
$Iso = (Resolve-Path $Iso).Path
New-Item -ItemType Directory -Force $State | Out-Null
$status = Join-Path $State 'status.txt'
function Say([string]$t) { $line = "$(Get-Date -Format HH:mm:ss) $t"; Write-Host $line; Add-Content -Path $status -Value $line -Encoding utf8 }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
	Set-Content -Path $status -Value '' -Encoding utf8
	$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Iso', "`"$Iso`"", '-Name', $Name, '-Dir', "`"$Dir`"", '-State', "`"$State`"")
	Start-Process (Get-Command pwsh).Source -Verb RunAs -ArgumentList $argList
	Write-Host "昇格して続ける。進み具合は $status"
	return
}

try {
	# 次からは昇格なしで操作できるように(サインインし直すと効く)
	$me = "$env:USERDOMAIN\$env:USERNAME"
	if (-not (Get-LocalGroupMember -SID 'S-1-5-32-578' -ErrorAction SilentlyContinue | Where-Object Name -EQ $me)) {
		Add-LocalGroupMember -SID 'S-1-5-32-578' -Member $me
		Say "$me を Hyper-V Administrators に入れた(サインインし直すと効く)"
	}
	if (Get-VM -Name $Name -ErrorAction SilentlyContinue) { throw "仮想マシン $Name はもうある(作り直すなら先に消す)" }
	New-Item -ItemType Directory -Force $Dir | Out-Null

	# パスワード(英数字 + 記号。XML にそのまま入る文字だけ)
	$pwFile = Join-Path $State 'rdptest.txt'
	if (-not (Test-Path $pwFile)) {
		$chars = [char[]]((48..57) + (65..90) + (97..122))
		[IO.File]::WriteAllText($pwFile, (-join (1..20 | ForEach-Object { $chars | Get-Random })) + '!a1')
	}
	$pw = (Get-Content $pwFile -Raw).Trim()

	# 無人インストールの設定を小さな ISO に(Setup は CD の直下の autounattend.xml を読む)
	$src = Join-Path $Dir 'unattend'
	New-Item -ItemType Directory -Force $src | Out-Null
	(Get-Content (Join-Path $PSScriptRoot 'autounattend.xml') -Raw).Replace('__PASSWORD__', $pw) |
		Set-Content -Path (Join-Path $src 'autounattend.xml') -Encoding utf8
	Add-Type -TypeDefinition @'
using System; using System.IO; using System.Runtime.InteropServices.ComTypes;
public static class IsoWriter {
	public static void Write(string path, object stream, int blockSize, int totalBlocks) {
		var s = (IStream)stream; var buf = new byte[blockSize];
		using (var f = File.Create(path)) { for (int i = 0; i < totalBlocks; i++) { s.Read(buf, blockSize, IntPtr.Zero); f.Write(buf, 0, blockSize); } }
	}
}
'@
	$fsi = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
	$fsi.FileSystemsToCreate = 3 # ISO9660 + Joliet
	$fsi.VolumeName = 'UNATTEND'
	$fsi.Root.AddTree($src, $false)
	$img = $fsi.CreateResultImage()
	$unattendIso = Join-Path $Dir 'unattend.iso'
	[IsoWriter]::Write($unattendIso, $img.ImageStream, $img.BlockSize, $img.TotalBlocks)
	Remove-Item -Recurse -Force $src
	Say '無人インストールの ISO を作った'

	# 仮想マシン(Gen2、Secure Boot、vTPM。Windows 11 の要件)
	$vhd = Join-Path $Dir "$Name.vhdx"
	New-VM -Name $Name -Generation 2 -MemoryStartupBytes 8GB -NewVHDPath $vhd -NewVHDSizeBytes 80GB -SwitchName 'Default Switch' -Path $Dir | Out-Null
	Set-VM -Name $Name -ProcessorCount 4 -StaticMemory -AutomaticCheckpointsEnabled $false
	Set-VMFirmware -VMName $Name -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
	Set-VMKeyProtector -VMName $Name -NewLocalKeyProtector
	Enable-VMTPM -VMName $Name
	$dvd = Add-VMDvdDrive -VMName $Name -Path $Iso -Passthru
	Add-VMDvdDrive -VMName $Name -Path $unattendIso
	Set-VMFirmware -VMName $Name -FirstBootDevice $dvd
	Enable-VMIntegrationService -VMName $Name -Name 'Guest Service Interface'
	Say "仮想マシン $Name を作った($Dir)"

	# 起動。「Press any key to boot from CD」に答えるため、しばらく Enter を送り続ける
	Start-VM -Name $Name
	$cs = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$Name'"
	$kb = Get-CimAssociatedInstance -InputObject $cs -ResultClassName Msvm_Keyboard
	for ($i = 0; $i -lt 30; $i++) { Invoke-CimMethod -InputObject $kb -MethodName TypeKey -Arguments @{ keyCode = 13 } | Out-Null; Start-Sleep 1 }
	Say 'インストールを始めた(20〜30 分)'

	# インストールが終わり、RDP に届くまで待つ
	$deadline = (Get-Date).AddMinutes(90)
	$ip = $null
	while ((Get-Date) -lt $deadline) {
		Start-Sleep 20
		$ip = (Get-VMNetworkAdapter -VMName $Name).IPAddresses | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notlike '169.254.*' } | Select-Object -First 1
		if ($ip -and (Test-NetConnection $ip -Port 3389 -InformationLevel Quiet -WarningAction SilentlyContinue)) { break }
		$ip = $null
	}
	if (-not $ip) { throw '90 分待っても RDP に届かない(仮想マシンの画面を Hyper-V マネージャーで見る)' }
	# インストールの ISO は外す(次の起動で CD から立ち上がらないように)
	Get-VMDvdDrive -VMName $Name | Remove-VMDvdDrive
	Set-Content -Path (Join-Path $State 'ip.txt') -Value $ip -NoNewline -Encoding ascii
	Say "できた: ${ip}:3389(rdptest / $pwFile)"
} catch {
	Say "失敗: $($_.Exception.Message)"
	Read-Host 'Enter で閉じる'
	exit 1
}
