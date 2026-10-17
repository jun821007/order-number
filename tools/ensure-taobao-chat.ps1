# 確保淘寶桌面版以同步模式執行（必須在使用者桌面工作階段執行）
# 主視窗關掉後行程常留在背景且除錯埠仍開 → 視為殭屍，強制殺掉重開。
$ErrorActionPreference = "SilentlyContinue"
$debugPort = 9333
$taobaoExe = Join-Path $env:LOCALAPPDATA "Programs\taobao\淘宝桌面版.exe"

function Test-DebugPort {
    try {
        $null = Invoke-WebRequest "http://127.0.0.1:$debugPort/json/version" -UseBasicParsing -TimeoutSec 2
        return $true
    } catch {
        return $false
    }
}

function Test-UsableUi {
    try {
        $pages = (Invoke-WebRequest "http://127.0.0.1:$debugPort/json/list" -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json
        foreach ($p in $pages) {
            if ($p.type -eq "page" -and $p.url -match "^https?://") {
                return $true
            }
        }
        return $false
    } catch {
        return $false
    }
}

if ((Test-DebugPort) -and (Test-UsableUi)) {
    Write-Output "ALREADY_OK"
    exit 0
}

if (-not (Test-Path $taobaoExe)) {
    Write-Output "NO_EXE"
    exit 2
}

if (Test-DebugPort) {
    Write-Output "SHELL_ONLY_RESTART"
} else {
    Write-Output "COLD_START"
}

Get-Process "淘宝桌面版" | Stop-Process -Force
Start-Sleep -Seconds 3
Start-Process -FilePath $taobaoExe -ArgumentList "--remote-debugging-port=$debugPort"

for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    if ((Test-DebugPort) -and (Test-UsableUi)) {
        Write-Output "RESTARTED_OK"
        exit 0
    }
}

Write-Output "START_FAILED"
exit 1
