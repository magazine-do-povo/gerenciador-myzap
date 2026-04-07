@echo off
setlocal EnableExtensions

if "%~1"=="" (
  echo Uso: %~nx0 "C:\caminho\do\myzap" ["npm run dev"]
  exit /b 64
)

set "MYZAP_DIR=%~1"
shift

if "%~1"=="" (
  set "MYZAP_COMMAND=npm run dev"
) else (
  set "MYZAP_COMMAND=%~1"
)

if not exist "%MYZAP_DIR%\package.json" (
  echo Pasta invalida do MyZap: "%MYZAP_DIR%"
  exit /b 2
)

if defined LOCALAPPDATA (
  set "MYZAP_LOG_DIR=%LOCALAPPDATA%\GerenciadorMyZap\logs"
) else (
  set "MYZAP_LOG_DIR=%TEMP%\GerenciadorMyZap\logs"
)

if not exist "%MYZAP_LOG_DIR%" mkdir "%MYZAP_LOG_DIR%" >nul 2>&1

set "MYZAP_LOG_FILE=%MYZAP_LOG_DIR%\myzap-dev-autostart.log"

echo [%date% %time%] Iniciando MyZap em background. Dir=%MYZAP_DIR% Command=%MYZAP_COMMAND%>> "%MYZAP_LOG_FILE%"

cd /d "%MYZAP_DIR%" || (
  echo [%date% %time%] Falha ao entrar na pasta do MyZap.>> "%MYZAP_LOG_FILE%"
  exit /b 3
)

call %MYZAP_COMMAND% >> "%MYZAP_LOG_FILE%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

echo [%date% %time%] MyZap finalizou com codigo %EXIT_CODE%.>> "%MYZAP_LOG_FILE%"
exit /b %EXIT_CODE%
