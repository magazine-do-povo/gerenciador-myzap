# Porte das melhorias da JZTech (v2.x) — v1.8.0

> Estudo/registro · O que veio do `gerenciadorMyzap` da JZTech (v2.0.0 → v2.1.5) para
> esta base, o que **não** veio e por quê. Feito em **16/09/2026**, partindo do v1.7.0.

## Por que não foi um "copiar por cima"

Os dois projetos **divergiram**: cada um tem ~15 funções que o outro não tem.

| | mais forte em |
|---|---|
| **JZTech** | ritmo de envio, saúde de sessão |
| **Magazine** (esta base) | envio de mídia (normalização de payload), tray de erros, histórico de envios, setup manual |

Por isso cada item foi conferido contra o código daqui antes de aplicar.

## O que foi portado

| Origem | O que resolve |
|---|---|
| **v2.0.5** | `OPENING` (subindo, sem login) casava com a keyword `open` por **substring** e o painel dizia "Conectado" sem QR lido. Agora é match por palavra inteira. |
| **v2.1.3** | Novo estado `isInitializing` + `connectSession.js`: o fluxo normal **nunca mais deleta a sessão**. O delete automático apagava a sessão no exato momento em que o QR ia aparecer (Chrome lento leva 20-40s; o delete vencia a corrida e "o QR nunca aparecia"). Delete destrutivo só em "Forçar reconexão" manual. |
| **v2.1.2** | Supervisor deixa de reiniciar MyZap **vivo porém lento**: reiniciar derruba todas as sessões, e em geral é só pico de CPU do envio. `down` = 5 falhas; `degraded` = 16 (~4 min). Health timeout 5s → 8s. |
| **v2.0.4** | `getConnectionStatus`/`verifyRealStatus` passam a usar `getMyZapApiBaseUrls()` (127.0.0.1 antes de localhost, que no Windows resolve `::1` e dá timeout). 404 com corpo útil vira "sessão não criada" em vez de erro genérico. Novo IPC `testConnection` (diagnóstico de 1 clique). |
| **v2.1.1** | `limparSessoesOrfas` no boot: sessões de teste órfãs sobem junto com a real, cada uma é um Chromium, competem por memória e **zumbificam juntas**. |
| **v2.1.0** | Número sem WhatsApp confirmado vai ao backend com `permanente: true` — sem isso o Hub reenfileira para sempre. |
| **v2.0.9** | Salvar mensagem padrão **vazia** voltou a desligar a auto-resposta (o gate de capability do backend barrava a chamada ao MyZap local, que é quem responde). |
| **v2.0.6** | Botão "Cancelar pendentes (em massa)". |
| ritmo | `ritmoConfig.js` + espaçamento entre mensagens, janela de horário, teto diário e "digitando". |

## O que NÃO foi portado, e por quê

- **`tentarAutoReparoSessao` / `canAutoRepair` (v2.1.0).** O próprio **v2.1.5** da JZTech
  desativou a chamada automática: `/repairSession` faz `logout()` + apaga
  `instances/<sessao>` (a autenticação) e **era a causa do "conecta e cai"**. Esta base
  nunca teve auto-reparo no worker — portar seria *introduzir* o bug.
- **`sendSelfTest` (v2.0.4/2.0.5).** Já existe equivalente aqui: o `sendTestMessage()`
  desta base já resolve o próprio número (`extractOwnNumber`) e envia para si mesmo.
- **`backendLogger.js`.** Equivalente já existe: `myzapLogger.forArea('backend')`.
- **Tratar 401/403 com corpo JSON como sucesso.** A JZTech devolve o corpo de *qualquer*
  erro HTTP; esta base tem a regra explícita de que 401/403 é credencial inválida e nunca
  vira sucesso. **A regra daqui foi preservada** — só o 404 passou a ser informação.

## Duas adaptações que mudam o comportamento em relação à JZTech

1. **`idfilial` no lugar de `idempresa`** — é o escopo desta base (com fallback legado).
2. **O ritmo entra INERTE.** Na JZTech o default é conservador (10-45s entre mensagens);
   aqui o espaçamento sempre foi decidido server-side pelo Hub e o gerenciador enviava na
   velocidade em que recebia. Estrear com 10-45s **estrangularia o disparo atual** sem
   ninguém pedir. Então os defaults são neutros (0s, sem janela, sem teto) e
   `randomDelayMs()` devolve `0` até o Hub mandar o bloco `ritmo` em
   `GET /parametrizacao-myzap/config/{idfilial}`. O código está instalado e desligado.

## Pendência que depende do backend

O botão **"Cancelar pendentes (em massa)"** precisa da rota
`parametrizacao-myzap/fila/cancelar-pendentes` no Hub do Magazine — que **não existe hoje**
(conferido no repositório do Hub). Até ser criada, o botão responde com um aviso dizendo
exatamente qual rota falta, em vez de um "HTTP 404" seco.

## Como isso foi validado

Sem lint/testes no projeto, e o app é Electron/Windows (não roda neste ambiente). Foi feito:

- `node --check` em todos os arquivos tocados;
- teste funcional do parser, que é o coração da correção principal:
  `OPENING → initializing` (isConnected **false**) e `CONNECTED → connected`;
- teste da fórmula do ritmo: sem configuração o delay é **0 ms** (comportamento atual
  preservado); com ritmo 10-45s o valor cai dentro da faixa.

**Falta o teste de fumaça no Windows** — conectar lendo o QR, deixar a fila rodar e
confirmar que a sessão não cai. Só isso fecha a verificação do "conecta e cai".
