@echo off
chcp 65001 >nul
title JobSearch - pencarian lowongan
cd /d "%~dp0.."
echo.
echo   JobSearch - mencari lowongan baru...
echo   (jendela ini menampilkan progres; jangan ditutup sampai selesai)
echo.
bun run tools\offline_scraper.mjs
if errorlevel 1 (
  echo.
  echo   Ada masalah saat mencari. Pastikan Bun terpasang: winget install Oven-sh.Bun
)
echo.
echo   Hasil lengkap: job_scraper\offline_jobs_log.csv (buka dengan Excel) atau lewat dashboard.
echo.
pause
