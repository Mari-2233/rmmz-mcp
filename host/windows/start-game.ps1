# Start an RPG Maker MZ game on Windows with the DevTools protocol enabled, so the MCP server
# (on this or another machine) can drive it. The game folder is never modified:
# an overlay folder next to it holds junctions (folders) + hard links (files) to the game files,
# plus our own package.json (DevTools enabled, inject script). Neither needs admin rights.
#
#   powershell -ExecutionPolicy Bypass -File start-game.ps1 -GameDir "D:\Steam\steamapps\common\Pocket Mirror GoldenerTraum"
#   ... -Port 9333        DevTools port (local only; use expose-cdp.ps1 for remote access)
#   ... -Rebuild          recreate the overlay (after a game update)
param(
  [Parameter(Mandatory = $true)][string]$GameDir,
  [int]$Port = 9333,
  [switch]$Rebuild
)
$ErrorActionPreference = 'Stop'
$GameDir = (Resolve-Path $GameDir).Path
if (-not (Test-Path (Join-Path $GameDir 'index.html')) -or -not (Test-Path (Join-Path $GameDir 'Game.exe'))) {
  throw "Not an RMMZ game folder (index.html / Game.exe missing): $GameDir"
}
# Same volume as the game, so hard links work.
$Overlay = Join-Path (Split-Path $GameDir -Parent) ((Split-Path $GameDir -Leaf) + '-pmgt')

function Remove-OverlayEntry([string]$p) {
  $item = Get-Item -LiteralPath $p -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { cmd /c rmdir "$p" | Out-Null }  # junction only, never its target
  elseif ($item.PSIsContainer) { throw "Unexpected real folder in overlay, refusing to delete: $p" }
  else { Remove-Item -LiteralPath $p -Force }  # a hard link: the game's copy stays
}

if ($Rebuild -and (Test-Path $Overlay)) {
  Get-ChildItem -LiteralPath $Overlay -Force | ForEach-Object { Remove-OverlayEntry $_.FullName }
}
New-Item -ItemType Directory -Force -Path $Overlay | Out-Null

Get-ChildItem -LiteralPath $GameDir -Force | ForEach-Object {
  if ($_.Name -eq 'package.json') { return }
  $dst = Join-Path $Overlay $_.Name
  if (Test-Path -LiteralPath $dst) { return }
  if ($_.PSIsContainer) { cmd /c mklink /J "$dst" "$($_.FullName)" | Out-Null }
  else { New-Item -ItemType HardLink -Path $dst -Target $_.FullName | Out-Null }
}

# Inject script: Steam-less greenworks fallback (+ harmless path fixes). Shipped next to this file.
Copy-Item -Force (Join-Path $PSScriptRoot '..\runtime\linux-inject.js') (Join-Path $Overlay 'linux-inject.js')

# Same as the game's package.json, minus --disable-devtools, plus the inject script.
$orig = Get-Content -Raw (Join-Path $GameDir 'package.json') | ConvertFrom-Json
$pkg = [ordered]@{
  name = $orig.name; main = $orig.main; 'inject_js_start' = 'linux-inject.js'
  'chromium-args' = ((($orig.'chromium-args' -replace '--disable-devtools', '') -replace '\s+', ' ').Trim() + ' --force-device-scale-factor=1 --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion')
  window = $orig.window
}
$pkg | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $Overlay 'package.json')

Write-Host "Overlay: $Overlay"
Write-Host "Starting game with DevTools on 127.0.0.1:$Port ..."
# overlay exe: NW.js resolves package.json from the exe folder, so run the overlay's copy
Start-Process -FilePath (Join-Path $Overlay 'Game.exe') -WorkingDirectory $Overlay `
  -ArgumentList @("`"$Overlay`"", "--remote-debugging-port=$Port")
