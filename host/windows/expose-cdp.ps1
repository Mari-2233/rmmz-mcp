# Let ONE other machine (where the MCP server / OpenClaw runs) reach the game's DevTools port.
# Chromium only listens on 127.0.0.1, so this adds a Windows port proxy plus a firewall rule
# limited to that machine's IP. Run in an ADMIN PowerShell.
#
#   powershell -ExecutionPolicy Bypass -File expose-cdp.ps1 -RemoteIp 192.168.1.50
#   ... -GamePort 9333 -ListenPort 9334      (defaults)
#   ... -Remove                              undo everything
#
# WARNING: whoever can reach this port can run any code inside the game process (and, through
# NW.js, on this PC). Only allow a machine you trust, on a private network. Remove it afterwards.
param(
  [string]$RemoteIp,
  [int]$GamePort = 9333,
  [int]$ListenPort = 9334,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$rule = "PMGT CDP $ListenPort"
if ($Remove) {
  netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
  Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
  Write-Host "Removed port proxy and firewall rule for $ListenPort."
  return
}
if (-not $RemoteIp) { throw 'Give -RemoteIp <IP of the machine running the MCP server>' }
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 connectport=$GamePort connectaddress=127.0.0.1 | Out-Null
Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $ListenPort -RemoteAddress $RemoteIp -Action Allow | Out-Null
$ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }).IPAddress -join ', '
Write-Host "OK. From $RemoteIp use:  PMGT_CDP_HOST=<one of: $ips>  PMGT_CDP_PORT=$ListenPort"
