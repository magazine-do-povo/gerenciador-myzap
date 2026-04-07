@echo off
setlocal EnableExtensions

if "%~1"=="" (
  set "TASK_NAME=GerenciadorMyZap-MyZapDev"
) else (
  set "TASK_NAME=%~1"
)

schtasks /Delete /F /TN "%TASK_NAME%"
if errorlevel 1 (
  echo Falha ao remover a tarefa "%TASK_NAME%".
  exit /b %ERRORLEVEL%
)

echo Tarefa removida com sucesso: %TASK_NAME%
exit /b 0
