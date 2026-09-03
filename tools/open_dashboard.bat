@echo off
REM Starts the local dashboard server (adds scraped-postings + "Run scraper now"
REM on top of the plain offline tracker) and opens it in the default browser.
REM Needs Bun (winget install Oven-sh.Bun). If Bun isn't available, you can
REM still open tools\dashboard.html directly as a file - the application
REM tracker works fully offline either way, just without the scraper tab.
setlocal
set DASHBOARD_PORT=4870
cd /d "%~dp0.."
echo Menjalankan dashboard server di http://localhost:%DASHBOARD_PORT%/ ...
echo (Biarkan jendela ini tetap terbuka selama dashboard dipakai. Tutup untuk mematikan server.)
echo.
start "Job Search Dashboard" cmd /c "bun run tools\dashboard_server.mjs & pause"
timeout /t 2 /nobreak >nul
start "" "http://localhost:%DASHBOARD_PORT%/"
