@echo off
REM Starts the local dashboard server (adds scraped-postings + "Run scraper now"
REM on top of the plain offline tracker) and opens it in the default browser.
REM Uses tools\JobSearchDashboard.exe if it's been built (see build_dashboard_exe.bat -
REM no Bun install needed to run that way), otherwise falls back to
REM `bun run tools\dashboard_server.mjs` (needs Bun on PATH). Either way, if
REM neither is available you can still open tools\dashboard.html directly as a
REM file - the application tracker works fully offline, just without the
REM scraper tab.
setlocal
set DASHBOARD_PORT=4870
cd /d "%~dp0.."

REM Already running (e.g. from an earlier double-click you forgot about)?
REM Starting a second instance would just crash with EADDRINUSE and show a
REM scary error window for no reason - detect it and skip straight to
REM opening the browser instead.
netstat -ano | findstr /c:":%DASHBOARD_PORT% " | findstr /c:"LISTENING" >nul
if %errorlevel%==0 (
  echo Dashboard sudah jalan di http://localhost:%DASHBOARD_PORT%/ - langsung dibuka di browser.
  start "" "http://localhost:%DASHBOARD_PORT%/"
  exit /b 0
)

echo Menjalankan dashboard server di http://localhost:%DASHBOARD_PORT%/ ...
echo (Biarkan jendela ini tetap terbuka selama dashboard dipakai. Tutup untuk mematikan server.)
echo.
if exist "tools\JobSearchDashboard.exe" (
  start "Job Search Dashboard" cmd /c "tools\JobSearchDashboard.exe & pause"
) else (
  start "Job Search Dashboard" cmd /c "bun run tools\dashboard_server.mjs & pause"
)
timeout /t 2 /nobreak >nul
start "" "http://localhost:%DASHBOARD_PORT%/"
