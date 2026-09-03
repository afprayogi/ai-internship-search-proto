@echo off
setlocal
cd /d "%~dp0.."

echo Memasang pre-commit privacy check ke .git\hooks\pre-commit ...

> .git\hooks\pre-commit (
    echo #!/bin/sh
    echo bun run tools/pre_commit_privacy_check.mjs
    echo exit $?
)

echo Selesai. Mulai sekarang, "git commit" otomatis dicek dulu.
echo Bypass sekali pakai kalau perlu: git commit --no-verify
pause
