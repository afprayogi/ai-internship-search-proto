@echo off
cd /d "%~dp0.."
echo Mencari lowongan baru...
echo.
bun run tools\offline_scraper.mjs
echo.
echo Selesai. Hasil lengkap ada di job_scraper\offline_jobs_log.csv (buka pakai Excel).
echo.
pause
