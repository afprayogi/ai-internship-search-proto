@echo off
setlocal

set GATEWAY_DIR=D:\bot wa\go-whatsapp-web-multidevice
set DOCKER_EXE=C:\Program Files\Docker\Docker\Docker Desktop.exe

echo === Cek Docker Desktop ===
docker info >nul 2>&1
if %errorlevel% equ 0 (
    echo Docker sudah nyala.
) else (
    echo Docker belum nyala, nyalain Docker Desktop...
    start "" "%DOCKER_EXE%"
    echo Nunggu Docker siap (bisa 30-60 detik pas pertama kali)...
    :waitloop
    timeout /t 3 /nobreak >nul
    docker info >nul 2>&1
    if %errorlevel% neq 0 (
        echo   ...masih nunggu Docker...
        goto waitloop
    )
    echo Docker udah siap.
)

echo.
echo === Nyalain WhatsApp gateway ===
cd /d "%GATEWAY_DIR%"
docker compose up -d

echo.
echo Selesai. Gateway seharusnya jalan di http://localhost:3000
echo Cek statusnya: docker compose ps
echo Lihat log kalau ada masalah: docker compose logs -f
echo.
pause
