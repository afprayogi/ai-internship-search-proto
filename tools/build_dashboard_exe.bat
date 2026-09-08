@echo off
REM Compiles tools\dashboard_server.mjs into a standalone tools\JobSearchDashboard.exe
REM using Bun's built-in compiler (bun build --compile). The resulting .exe embeds
REM the Bun runtime, so it runs on this machine without needing Bun on PATH -
REM only building it here requires Bun. Not committed to git (see .gitignore);
REM re-run this any time dashboard_server.mjs, dashboard.html, or
REM scraper_config_defaults.mjs change, so the .exe stays in sync.
REM
REM "Run scraper now" inside the dashboard still needs Bun on PATH regardless,
REM since it spawns tools\offline_scraper.mjs (and the LinkedIn CLI it calls)
REM as separate bun subprocesses that aren't bundled into this .exe.
setlocal
cd /d "%~dp0.."
echo Building tools\JobSearchDashboard.exe...
bun build tools\dashboard_server.mjs --compile --outfile tools\JobSearchDashboard.exe
if errorlevel 1 (
  echo.
  echo Build gagal. Pastikan Bun ter-install: winget install Oven-sh.Bun
  pause
  exit /b 1
)
echo.
echo Selesai. Double-click tools\JobSearchDashboard.exe buat jalanin dashboard-nya.
pause
