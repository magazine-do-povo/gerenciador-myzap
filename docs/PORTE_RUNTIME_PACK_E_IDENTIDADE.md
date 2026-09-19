# Identidade própria + Runtime Pack — v1.9.0

> Chamado · Por que uma loja amanheceu rodando o gerenciador da **JZTech**, e o porte do
> Runtime Pack (v2.3 de lá). **17/09/2026**, partindo do v1.8.0.
> Ligado: [[PORTE_JZTECH_V2]].

## 1. O chamado: "a tela de login sumiu"

A loja abriu o gerenciador e viu **"Código da empresa · Endereço · Token de acesso"** no
lugar de **"Endereço do Hub · Seu login · Sua senha"**. A suspeita era o porte de ontem.

**Não foi o porte.** O `settings.html` daqui (🌐 API · 👤 login · 🔒 senha · 🏢 *"ID da filial
resolvido automaticamente após o login"*) e o `backendAuth.js` estavam intactos na v1.8.0.

O que a loja estava rodando era **o app da JZTech v2.3.9**:

| | Magazine | JZTech |
|---|---|---|
| release mais nova | **v1.8.0** (16/09 23:24) | **v2.3.9** (01/09) |
| tela de conexão | login + senha | código da empresa + token |

A tela de código+token nasceu na **v2.3.0 da JZTech** — a reescrita *"janela única com
semáforo"*, que apagou `settings.html`, `settings.js` e `painelMyZap.js` e juntou três
janelas numa `app.html`. Lá o modelo é multi-empresa por token, então login/senha não
fazia sentido.

## 2. Por que um app virou o outro

Este projeto nasceu de um clone e **ficou com a identidade da JZTech**:

```
appId  com.jvtech.myzap     name  gerenciador-myzap      (os DOIS apps)
```

- Mesmo `appId` → o Windows trata como **o mesmo produto**; um instala por cima do outro.
- Mesmo `name` → `new Store()` grava no **mesmo** `%APPDATA%\<name>\config.json`. Foi por
  isso que o app da JZTech abriu com o `mdp` já preenchido: leu a configuração daqui.

E o `package.json` **nasceu apontando o auto-update para `JZ-TECH-SYS/gerenciadorMyzap`** —
corrigido em 06/04/2026, mas as releases **v1.3.2, v1.4.0 e v1.4.1** saíram com o defeito.
Máquina parada numa dessas se atualiza sozinha para a JZTech.

### O conserto

```
appId  com.magazinedopovo.myzap    name  gerenciador-myzap-mdp
```

- `core/migracaoIdentidade.js` copia o `config.json` antigo na primeira abertura — ninguém
  reconfigura. ⚠️ **COPIA, não move**: a pasta antiga pode estar em uso pelo app da JZTech
  na mesma máquina. ⚠️ **Roda antes de qualquer `require` do core**, senão o primeiro
  `new Store()` cria um `config.json` vazio no destino e a migração se acha desnecessária.
- `build/installer.nsh` remove também a instalação **per-user** da identidade antiga
  (HKCU), senão a loja fica com dois atalhos "Gerenciador MyZap", um deles morto.

⚠️ **O que NÃO mudou, de propósito:** `%LOCALAPPDATA%\gerenciador-myzap\` (runtime-tools,
installers, suporte) e o marker `.gerenciador-myzap-install-ok`. Renomear forçaria toda
loja a rebaixar Node/git e reinstalar o motor — custo alto para um conflito que era do
`config.json` e do instalador.

## 3. O que veio da v2.3, e o que NÃO veio

### ✅ Veio: o Runtime Pack

`magazine-do-povo/myzap` **já publica** o artefato (release `v3.0.20` tem
`myzap-pack-win32-x64.zip`, 270 MB, e o manifest) — faltava o gerenciador saber usar.

Instalar deixa de ser *"clonar + rodar o gerenciador de pacotes na máquina da loja"* e
passa a ser *"baixar um zip conferido por sha256, extrair ao lado e trocar de pasta, com
rollback"*. Foi o pnpm no cliente que quebrou instalações na v2.0.x.

| gancho | onde |
|---|---|
| instalar | `clonarRepositorio.js` — pack primeiro, rede como fallback |
| atualizar / reparar | `updateMyZap.reinstallPreservingData` — **o supervisor chega aqui no degrau 3, então um gancho serve os dois** |
| update de versão | `main.js` — `checkAndUpdatePack()` antes do update por commit SHA |
| subir o motor | `iniciarMyZap.js` — runner de pack no **topo** da lista |
| `.env` e banco | `syncConfigs.js` e `core/ipc/myzap.js` — passam a usar `resolveDataDir` |

⚠️ **Duas coisas no start do motor que não são estética:** o pack sobe com **o `node.exe`
dele** (o `sqlite3` vem compilado com aquela ABI) e com **CWD na pasta de dados**
(`myzap-data` ao lado) — é o que deixa `.env`, sqlite e sessão do WhatsApp fora da pasta
que a atualização troca.

⚠️ O runner de pack entrou **no topo da lista de runners daqui**, não no lugar dela: esta
base tem fallback entre runners (tenta um, falhou tenta o próximo) e a JZTech não tem.
Instalação legada (sem `manifest.json`) não vê diferença nenhuma.

### ❌ Não veio: a janela única

Medido antes de decidir: o painel daqui tem **111 funções**, a `app.js` da JZTech tem
**17**. Adotar a janela única não seria portar — jogaria fora ~2.400 linhas que só existem
aqui: histórico de envios, fila, capabilities, instalação com guarda de admin, mensagem
padrão/IA e a central de diagnóstico de 16/09. E levaria junto a tela de login/senha, que é
exatamente o que o chamado pediu de volta.

Se a janela única for desejada um dia, é **projeto de UI próprio** — não um porte.

## 4. Como isso foi verificado

O app é Electron/Windows e não roda neste ambiente. Foi feito:

- `node --check` em tudo que foi tocado;
- **smoke de carga** com stub do Electron: os 8 módulos carregam e as 7 funções que os
  ganchos chamam existem de fato (`installFromBestSourceUnlocked`, `checkAndUpdatePack`,
  `cleanupLeftovers`, `getInstalledPackVersion`, `isPackEngine`, `getEngineNodeExe`,
  `resolveDataDir`);
- `pnpm test` — `test/migracaoIdentidade.test.js` (migra, não sobrescreve o que já existe,
  instalação nova, config corrompido) e `test/enginePaths.test.js` (**legado mantém os
  dados DENTRO do motor**, manifest de outro produto não vira pack, manifest quebrado não
  estoura, pack põe os dados ao lado).

**Falta o teste de fumaça no Windows**, e ele é obrigatório antes de publicar: instalar
por cima de uma máquina com a identidade antiga e confirmar (1) que a configuração
apareceu preenchida, (2) que sobrou **um** atalho, (3) que o motor subiu pelo pack e (4)
que a sessão do WhatsApp continuou conectada.
