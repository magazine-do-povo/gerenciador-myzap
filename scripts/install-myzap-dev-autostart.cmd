@echo off
setlocal EnableExtensions

if "%~1"=="" (
  echo Uso: %~nx0 "C:\caminho\do\myzap" ["npm run dev"] ["GerenciadorMyZap-MyZapDev"]
  exit /b 64
)

set "MYZAP_DIR=%~1"
shift

if "%~1"=="" (
  set "MYZAP_COMMAND=npm run dev"
) else (
  set "MYZAP_COMMAND=%~1"
)

if "%~2"=="" (
  set "TASK_NAME=GerenciadorMyZap-MyZapDev"
) else (
  set "TASK_NAME=%~2"
)

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%start-myzap-background.ps1"

if not exist "%PS_SCRIPT%" (
  echo Script nao encontrado: "%PS_SCRIPT%"
  exit /b 2
)

if not exist "%MYZAP_DIR%\package.json" (
  echo Pasta invalida do MyZap: "%MYZAP_DIR%"
  exit /b 3
)

set "TASK_ACTION=powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""%PS_SCRIPT%"" -MyZapDir ""%MYZAP_DIR%"" -Command ""%MYZAP_COMMAND%"""

schtasks /Create /F /SC ONLOGON /DELAY 0000:30 /TN "%TASK_NAME%" /TR "%TASK_ACTION%"
if errorlevel 1 (
  echo Falha ao criar a tarefa agendada "%TASK_NAME%".
  exit /b %ERRORLEVEL%
)

echo Tarefa criada com sucesso.
echo Nome: %TASK_NAME%
echo Pasta do MyZap: %MYZAP_DIR%
echo Comando: %MYZAP_COMMAND%
echo.
echo No Windows, esse agendamento foi configurado para rodar no logon do usuario.
echo Isso e mais seguro para o MyZap do que tentar subir antes do login.
exit /b 0
