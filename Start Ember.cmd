@echo off
rem Ember by soybean_alien
rem Starts the local tracker (if it is not already running) and opens the desk in its own window.
cd /d "%~dp0"
set "URL=http://localhost:4319"
start "Ember (close this window to stop it)" /min node server.js
timeout /t 1 /nobreak >nul

rem Open as a clean app window in Brave, Chrome or Edge (first one found); otherwise use the default browser.
set "APP="
for %%B in (
  "%ProgramFiles%\BraveSoftware\Brave-Origin\Application\brave.exe"
  "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if not defined APP if exist %%B set "APP=%%~B"
if defined APP (start "" "%APP%" --app=%URL%) else (start "" %URL%)
