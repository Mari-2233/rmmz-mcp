# One-shot PMGT launcher for Windows.
#   powershell -ExecutionPolicy Bypass -File run-pmgt.ps1
#   ... -GameDir "D:\Pocket Mirror - Goldenertraum" -Port 9333 -Width 1296 -Height 759
#
# Does, in order:
#   1. kills any running Game.exe
#   2. builds/refreshes the overlay (delegates to start-game.ps1)
#   3. repairs the overlay index.html (the shipped one has an unclosed <script>)
#   4. copies the AI bridge + parts into the overlay
#   5. launches the game FROM the overlay (NW.js resolves package.json from the exe folder)
#   6. waits for CDP, injects the bridge, un-maximises and sizes the window
param(
  [string]$GameDir = "D:\Pocket Mirror - Goldenertraum",
  [int]$Port = 9333,
  [int]$Width = 1296,
  [int]$Height = 759,
  [string]$BridgeRepo = "C:\Users\Administrator\Documents\Chat\rmmz-mcp"
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$GameDir = (Resolve-Path $GameDir).Path
$Overlay = Join-Path (Split-Path $GameDir -Parent) ((Split-Path $GameDir -Leaf) + '-pmgt')

Get-Process -Name "Game" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 2) overlay (start-game.ps1 launches the game; we relaunch afterwards with the right cwd)
& powershell -ExecutionPolicy Bypass -File (Join-Path $here 'start-game.ps1') -GameDir $GameDir -Port $Port | Out-Host
Get-Process -Name "Game" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 3) repair index.html inside the overlay (never touch the game folder)
$idx = Join-Path $Overlay 'index.html'
$needFix = $true
if (Test-Path $idx) {
  $txt = Get-Content $idx -Raw -Encoding UTF8
  if ($txt -match '\<script type="text/javascript" src="js/main.js"\>' -and $txt -notmatch '(?m)^\s*<script>\s*$') { $needFix = $false }
}
if ($needFix) {
  if (Test-Path $idx) { Remove-Item $idx -Force }   # drop the hard link, not the original
  $html = @'
<!DOCTYPE html>
<html>
    <head>
        <meta charset="UTF-8">
        <meta name="apple-mobile-web-app-capable" content="yes">
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <meta name="viewport" content="user-scalable=no">
        <link rel="icon" href="icon/icon.png" type="image/png">
        <link rel="apple-touch-icon" href="icon/icon.png">
        <link rel="stylesheet" type="text/css" href="css/game.css">
        <title>Pocket Mirror ~ GoldenerTraum</title>
    </head>
    <body style="background-color: black">
        <script type="text/javascript" src="js/main.js"></script>
    </body>
</html>
'@
  [System.IO.File]::WriteAllText($idx, $html, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "index.html repaired in overlay"
}

# 4) bridge files
New-Item -ItemType Directory -Force (Join-Path $Overlay 'mcp-mod\game\parts') | Out-Null
Copy-Item (Join-Path $BridgeRepo 'game\parts\*.js') (Join-Path $Overlay 'mcp-mod\game\parts') -Force
Copy-Item (Join-Path $BridgeRepo 'game\ai-bridge.js') (Join-Path $Overlay 'ai-bridge.js') -Force

# 5) launch from the overlay
Write-Host "Starting game from overlay on port $Port ..."
Start-Process -FilePath (Join-Path $Overlay 'Game.exe') -WorkingDirectory $Overlay `
  -ArgumentList @("`"$Overlay`"", "--remote-debugging-port=$Port")

# 6) wait for CDP, then bridge + window
$deadline = (Get-Date).AddSeconds(60)
do {
  Start-Sleep -Milliseconds 800
  $ok = $false
  try { $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json" -UseBasicParsing -TimeoutSec 2; $ok = $true } catch {}
} until ($ok -or (Get-Date) -gt $deadline)
if (-not $ok) { throw "CDP did not come up on $Port" }

Start-Sleep -Seconds 6   # let the boot scene settle
& node (Join-Path $here 'boot_bridge.cjs') $Port ($Overlay -replace '\\','/') $Width $Height

Write-Host ""
Write-Host "Ready. From the MCP host: PMGT_CDP_HOST=<windows ip> PMGT_CDP_PORT=$Port (loopback tunnel or expose-cdp.ps1)"
