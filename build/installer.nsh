; Migracao perMachine -> perUser do Gerenciador MyZap.
;
; Ate a v1.6.x o app instalava em Program Files (perMachine, exigia admin).
; A partir desta versao a instalacao e por usuario (%LOCALAPPDATA%\Programs,
; sem UAC, updates silenciosos). Este hook detecta uma instalacao antiga
; per-machine (HKLM) e a remove antes de instalar a nova — evitando duas
; copias do app no PC do cliente.
;
; Tudo acontece num UNICO comando elevado (1 clique de UAC):
;   1. se o uninstaller antigo existir, roda silencioso (start /wait);
;   2. remove a pasta inteira a forca (cobre instalacao MUTILADA — caso real:
;      um uninstall sem elevacao apagou metade dos arquivos e morreu, deixando
;      um app que nem abria e sem uninstaller);
;   3. apaga a entrada orfa de "Adicionar/Remover Programas" (reg 64 e 32).
; Se o usuario negar o UAC, o instalador segue normalmente: o app novo per-user
; funciona do mesmo jeito e a casca antiga (sem atalhos) fica inerte.
;
; Os dados NAO se perdem na migracao: o electron-store fica em %APPDATA% e o
; MyZap local (sessao do WhatsApp, banco) em %LOCALAPPDATA%, fora da pasta de
; instalacao — nada disso e tocado aqui.

!include "FileFunc.nsh"

!macro customInit
  ; Procura a instalacao antiga per-machine no registro (64 e 32 bits)
  SetRegView 64
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
  ReadRegStr $1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "InstallLocation"
  ${If} $0 == ""
    SetRegView 32
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
    ReadRegStr $1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "InstallLocation"
    SetRegView 64
  ${EndIf}

  ; Fallback: registro sem InstallLocation -> deriva da UninstallString
  ${If} $1 == ""
  ${AndIf} $0 != ""
    StrCpy $2 $0
    StrCpy $3 $2 1
    ${If} $3 == '"'
      StrCpy $2 $2 "" 1
      StrLen $4 $2
      IntOp $4 $4 - 1
      StrCpy $2 $2 $4
    ${EndIf}
    ${GetParent} $2 $1
  ${EndIf}

  ${If} $1 != ""
    DetailPrint "Removendo instalacao antiga (todos os usuarios)..."
    ; ExecWait nao dispara UAC (falha com ERROR_ELEVATION_REQUIRED). Um unico
    ; cmd elevado via "runas" faz: uninstall silencioso (se o exe existir) +
    ; remocao forcada da pasta + limpeza da entrada orfa no registro.
    ExecShellWait "runas" "$SYSDIR\cmd.exe" '/c if exist "$1\${UNINSTALL_FILENAME}" (start "" /wait "$1\${UNINSTALL_FILENAME}" /S _?=$1) & rd /s /q "$1" & reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" /f /reg:64 & reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" /f /reg:32' SW_HIDE
  ${EndIf}

  ; ------------------------------------------------------------------------
  ; Identidade antiga (17/09/2026): ate a v1.8.0 este app usava o appId da
  ; JZTech (com.jvtech.myzap) e se instalava na pasta "gerenciador-myzap".
  ; Com appId proprio o Windows passa a ver DOIS produtos — e a loja ficaria
  ; com dois atalhos "Gerenciador MyZap", um deles morto. Remove a instalacao
  ; per-user da identidade antiga antes de instalar esta.
  ;
  ; ⚠️ Per-USER (HKCU), sem UAC: desde a v1.7 a instalacao e por usuario. E so
  ; a PASTA DO APP sai — a configuracao fica em %APPDATA% e o MyZap local
  ; (sessao do WhatsApp) em %LOCALAPPDATA%\gerenciador-myzap, intocados. Quem
  ; leva a configuracao para a pasta nova e core/migracaoIdentidade.js.
  ; ------------------------------------------------------------------------
  StrCpy $5 "com.jvtech.myzap"
  SetRegView 64
  ReadRegStr $6 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$5" "UninstallString"
  ReadRegStr $7 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$5" "InstallLocation"
  ${If} $6 == ""
    SetRegView 32
    ReadRegStr $6 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$5" "UninstallString"
    ReadRegStr $7 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$5" "InstallLocation"
    SetRegView 64
  ${EndIf}

  ${If} $7 == ""
  ${AndIf} $6 != ""
    StrCpy $8 $6
    StrCpy $3 $8 1
    ${If} $3 == '"'
      StrCpy $8 $8 "" 1
      StrLen $4 $8
      IntOp $4 $4 - 1
      StrCpy $8 $8 $4
    ${EndIf}
    ${GetParent} $8 $7
  ${EndIf}

  ${If} $7 != ""
    DetailPrint "Removendo a versao anterior (identidade antiga)..."
    nsExec::ExecToLog 'cmd.exe /c if exist "$7\${UNINSTALL_FILENAME}" (start "" /wait "$7\${UNINSTALL_FILENAME}" /S _?=$7) & rd /s /q "$7" & reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\$5" /f /reg:64 & reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\$5" /f /reg:32'
    Pop $9
  ${EndIf}
!macroend
