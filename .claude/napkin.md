# Napkin Runbook

## Curation Rules

- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)

1. **[2026-04-06] refreshPathWindows DEVE rodar DENTRO de findSystemNodePath, nao so em getPnpmCommand**
   Do instead: chamar `refreshPathWindows()` no inicio de `findSystemNodePath()` em win32 para garantir que o PATH do registro esta atualizado ANTES de rodar `where node`. O `findSystemNodePath` e chamado antes do refresh em `getPnpmCommand` e o resultado e cacheado — sem refresh interno, o cache guarda `null` permanentemente.
2. **[2026-04-06] Validar comandos encontrados no PATH com --version antes de usar**
   Do instead: apos `resolveCommandPath`, rodar `spawnSync(cmd, ['--version'])` e descartar se falhar. Evita falso positivo de PATH stale.
3. **[2026-04-06] aguardarPorta deve abortar se child process ja morreu**
   Do instead: passar `getChildError` e `isChildAlive` como callbacks para `aguardarPorta`; verificar a cada iteracao e retornar false imediatamente se o child finalizou.
4. **[2026-04-06] Refresh PATH do Windows antes de resolver comandos**
   Do instead: chamar `refreshPathWindows()` no inicio de `getPnpmCommand` e `getGitCommand` em win32 para ler PATH atualizado do registro.
4. **[2026-03-16] Bootstrap local do MyZap nao deve depender de Git ou Node globais**
   Do instead: baixar o pacote oficial do MyZap via arquivo compactado e executar o `pnpm` com o runtime do proprio app.
5. **[2026-03-16] CLI do `pnpm` empacotado precisa sobreviver ao asar**
   Do instead: manter `node_modules/pnpm/**` em `asarUnpack` e resolver o caminho com fallback para `app.asar.unpacked`.

## Shell & Command Reliability

1. **[2026-04-03] Sem `node_modules`, `npx eslint` pode puxar uma major nova incompativel com `.eslintrc.js`**
   Do instead: validar JS pelo editor ou instalar as dependencias do repo antes de rodar lint; nao confiar em `npx eslint` solto nesse workspace.
2. **[2026-03-16] Bash do terminal integrado expande `!` em scripts inline**
   Do instead: evitar `!` em `node -e` ou montar o script com aspas que nao acionem history expansion.
3. **[2026-03-16] `electron-builder --dir` pode falhar no Windows por symlink do cache winCodeSign**
   Do instead: rodar o build com privilegio elevado ou habilitar o Developer Mode do Windows antes de empacotar.

## Domain Behavior Guardrails

1. **[2026-04-03] Instalacoes locais podem ter `.git` sem repositorio valido**
   Do instead: validar o bootstrap com `git rev-parse --is-inside-work-tree` ou `git remote -v`; nao assumir que a simples existencia de `.git` permite usar comandos Git.
2. **[2026-03-16] Instalacoes por arquivo compactado nao possuem `.git`**
   Do instead: tratar `git pull` como opcional e so tentar atualizar quando a pasta `.git` existir.
3. **[2026-04-03] Chamadas locais do MyZap com body customizado usam contrato proprio, nao o alias do Hub**
   Do instead: antes de chamar a API local, sempre mesclar `session`, `sessionkey` e `session_name` ao body e normalizar aliases como `numero -> number` e `base64 -> path` nas rotas de fila como `sendFile64`.
4. **[2026-04-06] NUNCA usar Electron como fallback para rodar MyZap (Puppeteer/Chrome falha)**
   Do instead: se o Node.js real nao for encontrado, retornar null do runner direto e delegar para `getPnpmCommand()` que tem mais opcoes. Se nada funcionar, retornar erro claro ao usuario. O `ELECTRON_RUN_AS_NODE=1` contamina sub-processos e impede Chrome/Puppeteer de inicializar.
5. **[2026-04-06] Sempre limpar env vars do Electron em runners que spawnam MyZap**
   Do instead: usar `buildCleanEnvForChild()` (que remove `ELECTRON_RUN_AS_NODE` e `ELECTRON_NO_ASAR`) em todos os runners (system-pnpm, system-npx, system-npm-exec, direct-node). Nao usar `process.env` diretamente.

## User Directives

1. **[2026-03-16] O setup do gerenciador precisa ser automatico**
   Do instead: nao devolver mensagens pedindo instalacao manual de Git ou Node no fluxo padrao do MyZap.
