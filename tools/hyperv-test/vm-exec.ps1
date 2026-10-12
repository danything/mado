# 試験用 VM の中でコマンドを実行する(PowerShell Direct。ネットワークを使わない)。rdptest で入る。
#   pwsh -File tools/hyperv-test/vm-exec.ps1 -Command 'quser'
# Hyper-V の操作に管理者が要る。Hyper-V Administrators に入っていて(サインインし直したあと)なら昇格は要らない。
# 結果は ~/.mado-test/exec.txt にも書く(昇格した別のウィンドウで走ったときに読めるように)
param([Parameter(Mandatory)][string]$Command, [string]$Name = 'mado-test', [string]$State = (Join-Path $env:USERPROFILE '.mado-test'))
$ErrorActionPreference = 'Stop'
$out = Join-Path $State 'exec.txt'
try { $null = Get-VM -Name $Name -ErrorAction Stop } catch {
	Set-Content -Path $out -Value '(running elevated)' -Encoding utf8
	$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Command', "`"$($Command -replace '"', '\"')`"", '-Name', $Name, '-State', "`"$State`"")
	Start-Process (Get-Command pwsh).Source -Verb RunAs -ArgumentList $argList -Wait
	Get-Content $out
	return
}
$pw = ConvertTo-SecureString (Get-Content (Join-Path $State 'rdptest.txt') -Raw).Trim() -AsPlainText -Force
$cred = [pscredential]::new('rdptest', $pw)
$result = Invoke-Command -VMName $Name -Credential $cred -ScriptBlock ([scriptblock]::Create($Command)) 2>&1 | Out-String -Width 300
Set-Content -Path $out -Value $result -Encoding utf8
$result
