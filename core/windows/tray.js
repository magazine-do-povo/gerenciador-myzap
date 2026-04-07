const { Menu, Tray } = require('electron');

let trayInstance = null;
let actions = null;
let getMyzapStatus = () => false;
let appVersion = '?.?.?';

function buildMenuTemplate(myzapAtivo, callbacks) {
  const {
    createSettings,
    toggleMyzap,
    startExternalMyZapNow,
    installExternalMyZapAutoStart,
    removeExternalMyZapAutoStart,
    getExternalMyZapState,
    updateMyZapNow,
    createPainelMyZap,
    createFilaMyZap,
    createManualSetupWindow,
    openLogViewer,
    abrirPastaLogs,
    checkUpdates
  } = callbacks;

  const externalState = typeof getExternalMyZapState === 'function'
    ? getExternalMyZapState()
    : { available: false, autoStartInstalled: false, manualMode: false, configuredDir: false };

  const template = [
    { label: '📱  Gerenciador MyZap', enabled: false },
    { label: `      v${appVersion}`, enabled: false },
    { type: 'separator' },
    { label: '── MyZap ──', enabled: false },
    {
      label: myzapAtivo ? '🟢  MyZap ativo' : '🔴  MyZap pausado',
      click: toggleMyzap
    },
    { label: '🔄  Atualizar MyZap agora', click: updateMyZapNow },
    { label: '💬  Painel MyZap', click: createPainelMyZap },
    { label: '📬  Fila de mensagens', click: createFilaMyZap },
  ];

  if (externalState.available) {
    template.push({ type: 'separator' });
    template.push({ label: '── MaisApp Externo ──', enabled: false });
    template.push({
      label: externalState.manualMode
        ? '▶️  Iniciar MaisApp por fora agora'
        : '▶️  Disparar start externo agora',
      click: () => startExternalMyZapNow(),
      enabled: !!startExternalMyZapNow && externalState.configuredDir,
    });
    template.push({
      label: externalState.autoStartInstalled
        ? '✅  Auto inicio externo ativado'
        : '🪟  Ativar auto inicio externo',
      click: () => installExternalMyZapAutoStart(),
      enabled: !!installExternalMyZapAutoStart && externalState.configuredDir && !externalState.autoStartInstalled,
    });
    template.push({
      label: '🧹  Remover auto inicio externo',
      click: () => removeExternalMyZapAutoStart(),
      enabled: !!removeExternalMyZapAutoStart && externalState.autoStartInstalled,
    });
  }

  template.push({ type: 'separator' });
  template.push({ label: '── Sistema ──', enabled: false });
  template.push({ label: '⚙️  Configuracoes da API', click: createSettings });
  template.push({ label: '🛠️  Ajuda de configuracao manual', click: createManualSetupWindow });
  template.push({ label: '📋  Ver logs', click: openLogViewer });
  template.push({ label: '📁  Abrir pasta de logs', click: abrirPastaLogs });
  template.push({
    label: '🔎  Verificar atualizacao',
    click: () => {
      if (checkUpdates) checkUpdates();
    },
    enabled: !!checkUpdates
  });
  template.push({ type: 'separator' });
  template.push({ label: '🚪  Sair', role: 'quit' });

  return template;
}

function init(iconPath, callbackSet, version = '?.?.?', myzapStatusState) {
  actions = callbackSet;
  appVersion = version;

  if (typeof myzapStatusState === 'function') {
    getMyzapStatus = myzapStatusState;
  }

  trayInstance = new Tray(iconPath);
  trayInstance.setToolTip(`Gerenciador MyZap  v${version}`);
  rebuildMenu();
  return trayInstance;
}

function rebuildMenu() {
  if (!trayInstance || !actions) {
    return;
  }

  const menu = Menu.buildFromTemplate(buildMenuTemplate(getMyzapStatus(), actions));
  trayInstance.setContextMenu(menu);
}

module.exports = {
  init,
  rebuildMenu
};
