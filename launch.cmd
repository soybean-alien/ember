@echo off
rem Ember by soybean_alien
rem Shared by both launchers: reuses a running Ember, starts one only when none is running, then opens the page given
rem (for example "/" or "/wall.html") in its own window. Called as: launch.cmd /wall.html
setlocal
cd /d "%~dp0"
set "URL=http://localhost:4319%~1"

where node >nul 2>nul || (echo Ember needs Node.js 22.13 or newer, and it was not found on this PC.& echo Install the current LTS from https://nodejs.org, then start Ember again.& pause & exit /b 1)

rem 0 = Ember is already running, 1 = the port is free, 2 = another program holds the port, 3 = Node.js is too old.
node server.js --check
set "STATE=%ERRORLEVEL%"
if "%STATE%"=="3" (pause & exit /b 1)
if "%STATE%"=="2" (echo.& echo Close the program using port 4319, then start Ember again.& pause & exit /b 1)
if "%STATE%"=="1" (
  start "Ember (close this window to stop it)" /min node server.js
  rem Wait until it answers, up to about 15 seconds, instead of guessing how long start-up takes.
  for /l %%N in (1,1,30) do (
    node server.js --check >nul 2>nul && goto ready
    ping -n 1 -w 500 127.0.0.1 >nul
  )
  echo Ember did not start. Open the minimized "Ember" window to see why.& pause & exit /b 1
)
:ready

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
