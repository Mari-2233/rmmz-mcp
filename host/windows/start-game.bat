@echo off
rem Double-click helper: asks for the game folder once, then starts it with DevTools enabled.
setlocal
set "CFG=%~dp0game-dir.txt"
if exist "%CFG%" (set /p GAMEDIR=<"%CFG%") else (
  set /p GAMEDIR=Game folder ^(the one with Game.exe^):
)
if not exist "%CFG%" (echo %GAMEDIR%>"%CFG%")
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-game.ps1" -GameDir "%GAMEDIR%" %*
pause
