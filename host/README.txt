PMGT-MCP Windows game host
==========================
1. Unzip anywhere (keep the windows\ and runtime\ folders together).
2. Double-click windows\start-game.bat, enter the game folder (the one with Game.exe).
   The game starts with DevTools on 127.0.0.1:9333. The game folder is not modified
   (an overlay folder "<game>-pmgt" is created next to it).
3. Once, in an ADMIN PowerShell, allow the Linux machine to connect:
     powershell -ExecutionPolicy Bypass -File windows\expose-cdp.ps1 -RemoteIp <Linux IP>
   It prints the Windows IP to use. Undo later with:  ... expose-cdp.ps1 -Remove
4. On the Linux machine: PMGT_CDP_HOST=<Windows IP> PMGT_CDP_PORT=9334
WARNING: the DevTools port lets the allowed machine run code in the game. Private network only.
