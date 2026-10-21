@echo off
chcp 65001 >nul
rem 보호구역 경계 갱신: 브이월드·KDPA 받기 → 가공 → 사이트 올리기 → 릴리스 파일 교체 (국내 컴퓨터에서)
cd /d "%~dp0"
"C:\Program Files\Gitinash.exe" tools/update.sh
echo.
pause
