# 確保淘寶桌面版以同步模式執行（必須在使用者桌面工作階段執行）
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

if (Test-DebugPort) {
    Write-Output "ALREADY_OK"
    exit 0
}

if (-not (Test-Path $taobaoExe)) {
    Write-Output "NO_EXE"
    exit 2
}

Get-Process "淘宝桌面版" | Stop-Process -Force
Start-Sleep -Seconds 3
Start-Process -FilePath $taobaoExe -ArgumentList "--remote-debugging-port=$debugPort"

for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    if (Test-DebugPort) {
        Write-Output "RESTARTED_OK"
        exit 0
    }
}

Write-Output "START_FAILED"
exit 1
