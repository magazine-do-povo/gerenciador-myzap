const { Menu, Tray } = require('electron');

let trayInstance = null;
let actions = null;
let getMyzapStatus = () => false;
let appVersion = '?.?.?';
let errorCount = 0;

function buildMenuTemplate(myzapAtivo, callbacks) {
  const {
    createSettings,
    toggleMyzap,
    updateMyZapNow,
    createPainelMyZap,
    createFilaMyZap,
    createManualSetupWindow,
    openLogViewer,
    abrirPastaLogs,
    checkUpdates
  } = callbacks;

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

function buildTooltip() {
  const base = `Gerenciador MyZap  v${appVersion}`;
  if (errorCount > 0) {
    const plural = errorCount === 1 ? 'erro recente' : 'erros recentes';
    return `${base}\n⚠️ ${errorCount} ${plural} no envio`;
  }
  return base;
}

function refreshTooltip() {
  if (trayInstance) {
    trayInstance.setToolTip(buildTooltip());
  }
}

/**
 * Atualiza o contador de erros recentes refletido no tooltip/titulo da tray.
 * Chamado pelo watcher da fila quando ha falhas de envio.
 */
function setErrorCount(count) {
  const next = Number(count);
  errorCount = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0;
  refreshTooltip();
}

function init(iconPath, callbackSet, version = '?.?.?', myzapStatusState) {
  actions = callbackSet;
  appVersion = version;

  if (typeof myzapStatusState === 'function') {
    getMyzapStatus = myzapStatusState;
  }

  trayInstance = new Tray(iconPath);
  trayInstance.setToolTip(buildTooltip());
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
  rebuildMenu,
  setErrorCount
};
