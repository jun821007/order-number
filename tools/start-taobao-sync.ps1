# 一鍵啟用淘寶桌面版同步：以除錯埠開淘寶 → 啟動背景同步排程 → 顯示狀態
$ErrorActionPreference = "SilentlyContinue"
$Host.UI.RawUI.WindowTitle = "淘寶同步"

$debugPort = 9333
$taobaoExe = Join-Path $env:LOCALAPPDATA "Programs\taobao\淘宝桌面版.exe"
$syncScript = Join-Path $PSScriptRoot "taobao-desktop-sync.mjs"
$appDir = Join-Path $env:LOCALAPPDATA "order-number-taobao-sync"
$configFile = Join-Path $appDir "config.json"
$logFile = Join-Path $appDir "sync.log"

function Test-DebugPort {
    try {
        $null = Invoke-WebRequest "http://127.0.0.1:$debugPort/json/version" -UseBasicParsing -TimeoutSec 2
        return $true
    } catch {
        return $false
    }
}

Write-Host "== 淘寶同步 ==" -ForegroundColor Cyan

if (-not (Test-Path $configFile)) {
    Write-Host "第一次使用，需要設定密鑰。" -ForegroundColor Yellow
    node $syncScript --set-secret
}

if (Test-DebugPort) {
    Write-Host "[1/3] 淘寶桌面版已是同步模式" -ForegroundColor Green
} else {
    if (Get-Process "淘宝桌面版") {
        Write-Host "[1/3] 淘寶桌面版不是同步模式，重新開啟中…" -ForegroundColor Yellow
        Get-Process "淘宝桌面版" | Stop-Process -Force
        Start-Sleep -Seconds 3
    } else {
        Write-Host "[1/3] 開啟淘寶桌面版…"
    }
    Start-Process -FilePath $taobaoExe -ArgumentList "--remote-debugging-port=$debugPort"
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (Test-DebugPort) { $ready = $true; break }
    }
    if ($ready) {
        Write-Host "      淘寶桌面版已開啟" -ForegroundColor Green
    } else {
        Write-Host "      淘寶桌面版開啟失敗，請關掉淘寶後再點一次捷徑" -ForegroundColor Red
    }
}

$task = Get-ScheduledTask -TaskName "OrderNumberTaobaoSync"
if (-not $task) {
    Write-Host "[2/3] 找不到背景同步排程 OrderNumberTaobaoSync" -ForegroundColor Red
} elseif ($task.State -eq "Running") {
    Write-Host "[2/3] 背景同步已在執行" -ForegroundColor Green
} else {
    Start-ScheduledTask -TaskName "OrderNumberTaobaoSync"
    Write-Host "[2/3] 背景同步已啟動" -ForegroundColor Green
}

Write-Host "[3/3] 請在淘寶點開「消息」→「捷豹國際集運站」對話，視窗可縮小但不要關閉。"
Start-Sleep -Seconds 4
if (Test-Path $logFile) {
    Write-Host ""
    Write-Host "最近狀態：" -ForegroundColor Cyan
    Get-Content $logFile -Tail 5 -Encoding UTF8
}

Write-Host ""
Write-Host "此視窗 10 秒後自動關閉（同步會繼續在背景執行）。"
Start-Sleep -Seconds 10
