# Napkin Runbook

## Curation Rules

- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)

1. **[2026-03-16] Bootstrap local do MyZap nao deve depender de Git ou Node globais**
   Do instead: baixar o pacote oficial do MyZap via arquivo compactado e executar o `pnpm` com o runtime do proprio app.
2. **[2026-03-16] CLI do `pnpm` empacotado precisa sobreviver ao asar**
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
4. **[2026-04-03] `pnpm start` do MyZap local pode disparar `cmd.exe` no Windows**
   Do instead: quando o script `start` for apenas `node <arquivo>.js`, iniciar direto via `process.execPath` com `ELECTRON_RUN_AS_NODE=1` e evitar o shell do package manager.

## User Directives

1. **[2026-03-16] O setup do gerenciador precisa ser automatico**
   Do instead: nao devolver mensagens pedindo instalacao manual de Git ou Node no fluxo padrao do MyZap.
