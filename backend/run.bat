@echo off
chcp 65001 >nul
title CircleVault (chay tu ma nguon)
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Chua cai Python. Tai o https://www.python.org/downloads/ va tick "Add python.exe to PATH" khi cai.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Lan dau chay: dang tao moi truong Python...
  python -m venv .venv
  if errorlevel 1 ( pause & exit /b 1 )
)

echo Dang kiem tra thu vien...
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
  echo Cai thu vien that bai. Kiem tra ket noi mang roi chay lai.
  pause
  exit /b 1
)

".venv\Scripts\python.exe" -m app %*
pause
