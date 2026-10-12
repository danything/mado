# 試験用 VM にホストの GPU を分けて渡す(GPU-P)。Windows が H.264 をハードウェアで作るかを試すため。
#   pwsh -File tools/hyperv-test/add-gpu.ps1
# VM を止めて GPU の分割を付け、起動してホストの表示ドライバーを VM の HostDriverStore へ写す(GPU-P の VM はホストのドライバーを使う)。
# Hyper-V の操作に管理者が要る。Hyper-V Administrators に入っていなければ、UAC で昇格して走り直す。結果は ~/.mado-test/gpu.txt にも書く
param([string]$Name = 'mado-test', [string]$Gpu = '*Radeon*', [string]$State = (Join-Path $env:USERPROFILE '.mado-test'))
$ErrorActionPreference = 'Stop'
$log = Join-Path $State 'gpu.txt'
try { $null = Get-VM -Name $Name -ErrorAction Stop } catch {
	Set-Content -Path $log -Value '(running elevated)' -Encoding utf8
	$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Name', $Name, '-Gpu', "`"$Gpu`"", '-State', "`"$State`"")
	Start-Process (Get-Command pwsh).Source -Verb RunAs -ArgumentList $argList -Wait
	Get-Content $log
	return
}
Start-Transcript -Path $log -Force | Out-Null
try {
	$parts = @(Get-VMHostPartitionableGpu)
	"分割できる GPU: $($parts.Count)"
	$parts | ForEach-Object { "  $($_.Name)" }
	if ($parts.Count -eq 0) { throw 'このホストには分割できる GPU が無い' }

	# 表示ドライバーのファイル(DriverStore の中のもの)を、ホストで集める
	$card = Get-CimInstance Win32_VideoController | Where-Object Name -Like $Gpu | Select-Object -First 1
	if (-not $card) { throw "GPU が見つからない: $Gpu" }
	"GPU: $($card.Name) / ドライバー $($card.DriverVersion)"
	$signed = Get-CimInstance Win32_PnPSignedDriver | Where-Object DeviceName -EQ $card.Name | Select-Object -First 1
	$files = @(Get-CimAssociatedInstance -InputObject $signed -Association Win32_PnPSignedDriverCIMDataFile -ErrorAction SilentlyContinue |
			ForEach-Object Name)
	# 関連を辿れないときは、表示ドライバーの DLL の場所(DriverStore のフォルダー)だけ使う
	if ($files.Count -eq 0) { $files = @($card.InstalledDisplayDrivers -split ',') }
	$repo = $files | Where-Object { $_ -match '\\DriverStore\\FileRepository\\([^\\]+)\\' } | ForEach-Object { $Matches[1] } | Sort-Object -Unique
	$system = $files | Where-Object { $_ -notmatch '\\DriverStore\\' -and (Test-Path $_) }
	"DriverStore のフォルダー: $($repo -join ', ')"
	"System32 などのファイル: $($system.Count)"

	# 付け直しは VM を止める必要がある。もう付いていれば止めない(ドライバーを写し直すだけ)
	if (-not (Get-VMGpuPartitionAdapter -VMName $Name -ErrorAction SilentlyContinue)) {
		if ((Get-VM -Name $Name).State -ne 'Off') { 'VM を止める'; Stop-VM -Name $Name -Force }
		'GPU の分割を付ける'
		Add-VMGpuPartitionAdapter -VMName $Name
	Set-VMGpuPartitionAdapter -VMName $Name `
		-MinPartitionVRAM 80000000 -MaxPartitionVRAM 100000000 -OptimalPartitionVRAM 100000000 `
		-MinPartitionEncode 80000000 -MaxPartitionEncode 100000000 -OptimalPartitionEncode 100000000 `
		-MinPartitionDecode 80000000 -MaxPartitionDecode 100000000 -OptimalPartitionDecode 100000000 `
		-MinPartitionCompute 80000000 -MaxPartitionCompute 100000000 -OptimalPartitionCompute 100000000
	# GPU-P の VM は保存(サスペンド)できない。メモリの割り当て窓も広げる
	Set-VM -Name $Name -GuestControlledCacheTypes $true -LowMemoryMappedIoSpace 1GB -HighMemoryMappedIoSpace 32GB -AutomaticStopAction TurnOff
	}
	if ((Get-VM -Name $Name).State -ne 'Running') { 'VM を起動する'; Start-VM -Name $Name }
	$pw = ConvertTo-SecureString (Get-Content (Join-Path $State 'rdptest.txt') -Raw).Trim() -AsPlainText -Force
	$cred = [pscredential]::new('rdptest', $pw)
	$session = $null
	for ($i = 0; $i -lt 60 -and -not $session; $i++) {
		try { $session = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop } catch { Start-Sleep 5 }
	}
	if (-not $session) { throw 'VM に入れない(PowerShell Direct)' }
	'ドライバーを写す'
	foreach ($d in $repo) {
		# ドライバーが書いている .log は開けないので除く。一度ホストの一時フォルダーへ集めてから写す
		$src = "C:\Windows\System32\DriverStore\FileRepository\$d"
		$tmp = Join-Path $env:TEMP "mado-gpu\$d"
		Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
		Get-ChildItem -Recurse -File $src | Where-Object Extension -NE '.log' | ForEach-Object {
			$to = Join-Path $tmp $_.FullName.Substring($src.Length + 1)
			New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
			Copy-Item -Path $_.FullName -Destination $to
		}
		$dst = "C:\Windows\System32\HostDriverStore\FileRepository\$d"
		Invoke-Command -Session $session { param($p) New-Item -ItemType Directory -Force -Path $p | Out-Null } -ArgumentList $dst
		Copy-Item -ToSession $session -Recurse -Force -Path "$tmp\*" -Destination $dst
		Remove-Item -Recurse -Force $tmp
	}
	foreach ($f in $system) {
		Copy-Item -ToSession $session -Force -Path $f -Destination $f -ErrorAction Continue
	}
	Remove-PSSession $session
	'VM を再起動する(ドライバーを読ませる)'
	Restart-VM -Name $Name -Force
	'終わり'
} catch {
	"失敗: $($_.Exception.Message)"
} finally {
	Stop-Transcript | Out-Null
}
