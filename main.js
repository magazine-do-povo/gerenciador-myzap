if (process.platform !== 'win32') {
  try { require('fix-path')(); } catch (_e) { /* melhor esforco */ }
}

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  ipcMain,
  shell
} = require('electron');
const { autoUpdater } = require('electron-updater');

// Desabilita aceleracao por hardware — previne crashes nativos do GPU
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-compositing');
const path = require('path');
const Store = require('electron-store');
const { info, warn, error, abrirPastaLogs } = require('./core/utils/logger');
const {
  startWhatsappQueueWatcher,
  stopWhatsappQueueWatcher,
  getWhatsappQueueWatcherStatus
} = require('./core/api/whatsappQueueWatcher');
const {
  startMyzapStatusWatcher,
  stopMyzapStatusWatcher,
  enviarStatusMyZap,
  getMyzapStatusWatcherInfo,
  setTrayCallback
} = require('./core/api/myzapStatusWatcher');
const {
  startTokenSyncWatcher,
  stopTokenSyncWatcher,
  getTokenSyncWatcherStatus
} = require('./core/api/tokenSyncWatcher');
const { createSettings } = require('./core/windows/settings');
const { openLogViewer } = require('./core/windows/logViewer');
const { createPainelMyZap } = require('./core/windows/painelMyZap');
const { createFilaMyZap } = require('./core/windows/filaMyZap');
const { createManualSetupWindow } = require('./core/windows/manualSetup');
const trayManager = require('./core/windows/tray');
const { registerMyZapHandlers } = require('./core/ipc/myzap');
const { attachAutoUpdaterHandlers, checkForUpdates } = require('./core/updater');
const { ensureMyZapReadyAndStart, refreshRemoteConfigAndSyncIa } = require('./core/myzap/autoConfig');
const {
  buildBackendProfileKey,
  clearDerivedBackendState,
  isCapabilityEnabled,
  getCapabilityEntry,
  getCapabilitySnapshotPayload,
  saveCapabilityPreferences
} = require('./core/myzap/capabilities');
const { clearProgress, getCurrentProgress, finishProgressSuccess } = require('./core/myzap/progress');
const { killProcessesOnPort, isPortInUse, isLocalHttpServiceReachable } = require('./core/myzap/processUtils');
const { killMyZapProcess } = require('./core/myzap/iniciarMyZap');
const {
  DEFAULT_EXTERNAL_START_TASK_NAME,
  getExternalMyZapSupportState,
  installExternalMyZapAutoStart,
  removeExternalMyZapAutoStart,
  startExternalMyZapNow,
} = require('./core/myzap/externalRuntimeSupport');
const {
  MYZAP_REPO_WEB_URL,
  ensureManualSetupGuideFile
} = require('./core/myzap/manualSetupSupport');
const deleteSession = require('./core/myzap/api/deleteSession');
const { info: myzapInfo, warn: myzapWarn, error: myzapError } = require('./core/myzap/myzapLogger');

Menu.setApplicationMenu(null);

const AUTO_LAUNCH_ARGS = ['--autostart'];
const hasSingleInstanceLock = app.requestSingleInstanceLock();

const store = new Store({
  defaults: {
    idfilial: '',
    idempresa: '',
    apiUrl: '',
    apiLogin: '',
    apiPassword: '',
    apiToken: '',
    myzap_diretorio: '',
    myzap_sessionKey: '',
    myzap_sessionName: '',
    myzap_apiToken: '',
    myzap_envContent: '',
    myzap_localStartMode: 'automatic',
    myzap_localStartCommand: 'start',
    myzap_capabilityIaConfigMode: 'auto',
    myzap_capabilityTokenSyncMode: 'auto',
    myzap_capabilityPassiveStatusMode: 'auto',
    myzap_capabilityQueuePollingMode: 'auto'
  }
});

let myzapConfigRefreshTimer = null;
let queueAutoStartTimer = null;
let myzapEnsureLoopTimer = null;
let myzapManualUpdateInProgress = false;
let lastKnownModoIntegracao = null;
let lastAdminRequiredToastAt = 0;
const MYZAP_CONFIG_REFRESH_MS = 30 * 1000;
const MYZAP_ENSURE_LOOP_MS = 60 * 1000;
const ADMIN_REQUIRED_TOAST_INTERVAL_MS = 10 * 60 * 1000;

function toast(msg) {
  new Notification({
    title: 'Gerenciador MyZap',
    body: msg,
    icon: path.join(__dirname, 'assets/icon.png')
  }).show();
}

function notifyAdminRequired(result, context = 'runtime') {
  if (!result || !result.requiresAdmin) {
    return;
  }

  const now = Date.now();
  if ((now - lastAdminRequiredToastAt) < ADMIN_REQUIRED_TOAST_INTERVAL_MS) {
    return;
  }

  lastAdminRequiredToastAt = now;
  toast(result.message || 'Abra o Gerenciador MyZap como Administrador para concluir a instalacao local do MyZap.');
  myzapWarn('MyZap: instalacao local bloqueada por falta de privilegios de administrador', {
    metadata: {
      context,
      result,
    }
  });
}

function hasValidConfigMyZap() {
  return !!store.get('apiUrl') && !!store.get('apiLogin') && !!store.get('apiPassword');
}

function getModoIntegracaoMyZap() {
  return String(store.get('myzap_modoIntegracao') || 'local').trim().toLowerCase() || 'local';
}

function normalizeMyZapLocalStartMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'manual' ? 'manual' : 'automatic';
}

function normalizeMyZapLocalStartCommand(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['start', 'dev'].includes(normalized) ? normalized : 'auto';
}

function getMyZapLocalStartMode() {
  return normalizeMyZapLocalStartMode(store.get('myzap_localStartMode'));
}

function getMyZapLocalStartCommand() {
  return normalizeMyZapLocalStartCommand(store.get('myzap_localStartCommand'));
}

function isMyZapManualStartMode() {
  return getMyZapLocalStartMode() === 'manual';
}

function getMyZapDirectory() {
  return String(store.get('myzap_diretorio') || '').trim();
}

function getMyZapExternalCommand() {
  const preferred = getMyZapLocalStartCommand();

  if (isMyZapManualStartMode()) {
    return preferred === 'dev' ? 'npm run dev' : 'npm run dev';
  }

  return preferred === 'dev' ? 'npm run dev' : 'npm start';
}

function getExternalMyZapTrayState() {
  const supportState = getExternalMyZapSupportState(DEFAULT_EXTERNAL_START_TASK_NAME);
  return {
    ...supportState,
    manualMode: isMyZapManualStartMode(),
    localMode: isMyZapModoLocal(),
    configuredDir: Boolean(getMyZapDirectory()),
  };
}

async function startExternalMyZapFlow(reason = 'manual_external_start') {
  const dirPath = getMyZapDirectory();
  if (!dirPath) {
    return {
      status: 'error',
      message: 'Diretorio do MyZap nao configurado no gerenciador.',
    };
  }

  return startExternalMyZapNow(dirPath, getMyZapExternalCommand(), reason);
}

async function installExternalMyZapAutoStartFlow() {
  const dirPath = getMyZapDirectory();
  if (!dirPath) {
    return {
      status: 'error',
      message: 'Diretorio do MyZap nao configurado no gerenciador.',
    };
  }

  const result = await installExternalMyZapAutoStart(
    dirPath,
    getMyZapExternalCommand(),
    DEFAULT_EXTERNAL_START_TASK_NAME
  );
  rebuildTrayMenu();
  return result;
}

async function removeExternalMyZapAutoStartFlow() {
  const result = await removeExternalMyZapAutoStart(DEFAULT_EXTERNAL_START_TASK_NAME);
  rebuildTrayMenu();
  return result;
}

function isMyZapModoLocal() {
  return getModoIntegracaoMyZap() === 'local';
}

function rebuildTrayMenu() {
  trayManager.rebuildMenu();
}

function focusExistingWindow() {
  const targetWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
  if (!targetWindow) {
    return false;
  }

  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }

  targetWindow.show();
  targetWindow.focus();
  return true;
}

function showPrimaryInstance() {
  if (focusExistingWindow()) {
    return;
  }

  if (!hasValidConfigMyZap()) {
    createSettings();
    return;
  }

  createPainelMyZap();
}

function handleSecondInstanceLaunch() {
  const revealPrimaryInstance = () => {
    info('Nova execucao detectada; mantendo apenas a instancia principal.', {
      metadata: { pid: process.pid }
    });
    showPrimaryInstance();
    toast('Gerenciador MyZap ja esta em execucao');
  };

  if (app.isReady()) {
    revealPrimaryInstance();
    return;
  }

  app.whenReady().then(revealPrimaryInstance).catch(() => {});
}

function configureAutoLaunch() {
  if (!app.isPackaged) {
    info('Inicializacao com o sistema ignorada em ambiente de desenvolvimento.', {
      metadata: { platform: process.platform, execPath: process.execPath }
    });
    return;
  }

  if (!['win32', 'darwin'].includes(process.platform)) {
    warn('Inicializacao com o sistema nao suportada nesta plataforma via Electron.', {
      metadata: { platform: process.platform }
    });
    return;
  }

  const loginItemSettings = {
    openAtLogin: true
  };

  if (process.platform === 'win32') {
    loginItemSettings.path = process.execPath;
    loginItemSettings.args = AUTO_LAUNCH_ARGS;
    loginItemSettings.enabled = true;
  } else if (process.platform === 'darwin') {
    loginItemSettings.openAsHidden = true;
  }

  app.setLoginItemSettings(loginItemSettings);

  const currentLoginItemSettings = process.platform === 'win32'
    ? app.getLoginItemSettings({ path: process.execPath, args: AUTO_LAUNCH_ARGS })
    : app.getLoginItemSettings();

  const autoLaunchEnabled = process.platform === 'win32'
    ? Boolean(
      currentLoginItemSettings.openAtLogin
        || currentLoginItemSettings.executableWillLaunchAtLogin
    )
    : Boolean(currentLoginItemSettings.openAtLogin);

  if (autoLaunchEnabled) {
    info('Inicializacao automatica com o sistema operacional habilitada.', {
      metadata: { platform: process.platform, execPath: process.execPath }
    });
    return;
  }

  warn('Nao foi possivel confirmar a inicializacao automatica com o sistema operacional.', {
    metadata: {
      platform: process.platform,
      execPath: process.execPath,
      loginItemSettings: currentLoginItemSettings
    }
  });
}

function getCapabilityMetadata(capability) {
  return getCapabilityEntry(capability, store) || null;
}

function isMyZapServiceAtivo() {
  return Boolean(
    getMyzapStatusWatcherInfo().ativo
    || getTokenSyncWatcherStatus().ativo
    || getWhatsappQueueWatcherStatus().ativo
  );
}

function buildManualSetupLink(kind, info) {
  if (kind === 'node') return info.nodeDownloadUrl;
  if (kind === 'git') return info.gitDownloadUrl;
  if (kind === 'repo') return MYZAP_REPO_WEB_URL;
  return '';
}

function clearQueueAutoStartTimer() {
  if (queueAutoStartTimer) {
    clearInterval(queueAutoStartTimer);
    queueAutoStartTimer = null;
  }
}

function clearMyZapEnsureLoopTimer() {
  if (myzapEnsureLoopTimer) {
    clearInterval(myzapEnsureLoopTimer);
    myzapEnsureLoopTimer = null;
  }
}

function maybeLogCapabilityIgnored(capability, trigger) {
  if (trigger === 'config_refresh') {
    return;
  }

  const labels = {
    supportsPassiveStatus: 'status passivo',
    supportsTokenSync: 'sync de tokens',
    supportsQueuePolling: 'polling da fila'
  };

  myzapInfo(`MyZap: ${labels[capability] || capability} ignorado por nao suportado/desabilitado.`, {
    metadata: {
      trigger,
      capability: getCapabilityMetadata(capability)
    }
  });
}

function applyOptionalWatchersByCapabilities(trigger = 'runtime_apply') {
  const supportsPassiveStatus = isCapabilityEnabled('supportsPassiveStatus', store);
  const supportsTokenSync = isCapabilityEnabled('supportsTokenSync', store);
  const supportsQueuePolling = isCapabilityEnabled('supportsQueuePolling', store);

  if (supportsPassiveStatus) {
    startMyzapStatusWatcher();
  } else {
    if (trigger !== 'config_refresh' || getMyzapStatusWatcherInfo().ativo) {
      maybeLogCapabilityIgnored('supportsPassiveStatus', trigger);
    }
    stopMyzapStatusWatcher();
  }

  if (supportsTokenSync) {
    startTokenSyncWatcher();
  } else {
    if (trigger !== 'config_refresh' || getTokenSyncWatcherStatus().ativo) {
      maybeLogCapabilityIgnored('supportsTokenSync', trigger);
    }
    stopTokenSyncWatcher();
  }

  if (supportsQueuePolling) {
    scheduleQueueAutoStart();
  } else {
    if (trigger !== 'config_refresh' || queueAutoStartTimer || getWhatsappQueueWatcherStatus().ativo) {
      maybeLogCapabilityIgnored('supportsQueuePolling', trigger);
    }
    clearQueueAutoStartTimer();
    stopWhatsappQueueWatcher();
  }
}

function applyMyZapRuntimeByMode(trigger = 'runtime_apply') {
  const modoAtual = getModoIntegracaoMyZap();
  const modoMudou = lastKnownModoIntegracao !== null && lastKnownModoIntegracao !== modoAtual;
  lastKnownModoIntegracao = modoAtual;

  if (isMyZapModoLocal()) {
    scheduleMyZapEnsureLoop();
    applyOptionalWatchersByCapabilities(trigger);
    rebuildTrayMenu();
    return;
  }

  clearQueueAutoStartTimer();
  clearMyZapEnsureLoopTimer();

  stopWhatsappQueueWatcher();
  stopMyzapStatusWatcher();
  stopTokenSyncWatcher();

  deleteSession().catch((err) => {
    myzapWarn('Falha ao encerrar sessao WhatsApp na troca para modo web', {
      metadata: { error: err?.message || String(err) }
    });
  });

  try {
    killMyZapProcess();
  } catch (_e) { /* melhor esforco */ }

  try {
    killProcessesOnPort(5555);
  } catch (_e) { /* melhor esforco */ }

  if (modoMudou) {
    toast('MyZap alterado para modo web/online. Rotinas locais desativadas.');
  }
  myzapInfo('MyZap em modo web/online. Rotinas locais e processo MyZap foram desativados.', {
    metadata: { modo: modoAtual }
  });
  rebuildTrayMenu();
}

async function ensureMyZapLocalRuntime(trigger = 'watchdog') {
  if (!hasValidConfigMyZap()) {
    return { status: 'skipped', reason: 'missing_base_config' };
  }

  if (store.get('myzap_userRemovedLocal') === true) {
    return { status: 'skipped', reason: 'user_removed_local' };
  }

  if (!isMyZapModoLocal()) {
    return { status: 'skipped', reason: 'mode_not_local' };
  }

  try {
    const [portaAtiva, httpAtivo] = await Promise.all([
      isPortInUse(5555),
      isLocalHttpServiceReachable({ timeoutMs: 3000 }),
    ]);
    if (portaAtiva || httpAtivo) {
      // Garante que a state machine reflete o estado real (ex: porta subiu
      // apos timeout anterior ter marcado 'error')
      const { getState, forceTransition } = require('./core/myzap/stateMachine');
      if (getState() !== 'running') {
        forceTransition('running', {
          message: 'MyZap local ativo (detectado automaticamente).',
          porta: 5555,
          detectadoVia: portaAtiva ? 'porta' : 'http',
        });
      }

      const progress = getCurrentProgress();
      if (progress && progress.active) {
        finishProgressSuccess('MyZap local ja estava ativo.', 'runtime_detected', {
          trigger,
          detectadoVia: portaAtiva ? 'porta' : 'http',
          porta: 5555,
        });
      }

      return {
        status: 'success',
        message: 'MyZap local ja ativo.',
        detectadoVia: portaAtiva ? 'porta' : 'http',
      };
    }

    if (isMyZapManualStartMode()) {
      const externalStartResult = await startExternalMyZapFlow(`ensure:${trigger}`);
      if (externalStartResult.status === 'success') {
        myzapInfo('MyZap local em modo manual. Disparo externo solicitado pelo gerenciador.', {
          metadata: {
            trigger,
            localStartMode: getMyZapLocalStartMode(),
            localStartCommand: getMyZapLocalStartCommand(),
            externalStartResult,
          }
        });

        return {
          ...externalStartResult,
          manualExternalStart: true,
        };
      }

      myzapWarn('Falha ao solicitar start externo do MyZap em modo manual', {
        metadata: {
          trigger,
          externalStartResult,
        }
      });
      return externalStartResult;
    }

    myzapInfo('MyZap auto-ensure: porta local fechada, tentando iniciar automaticamente', {
      metadata: {
        trigger,
        modo: getModoIntegracaoMyZap(),
        localStartMode: getMyZapLocalStartMode(),
        localStartCommand: getMyZapLocalStartCommand(),
      }
    });

    const result = await ensureMyZapReadyAndStart({ forceRemote: false });
    if (result?.requiresAdmin) {
      notifyAdminRequired(result, `ensure:${trigger}`);
      return result;
    }

    applyMyZapRuntimeByMode(trigger);
    return result;
  } catch (err) {
    myzapWarn('MyZap auto-ensure: erro ao validar/iniciar runtime local', {
      metadata: { trigger, error: err?.message || String(err) }
    });
    return { status: 'error', message: err?.message || String(err) };
  }
}

async function toggleMyzap() {
  if (isMyZapServiceAtivo()) {
    clearQueueAutoStartTimer();
    stopWhatsappQueueWatcher();
    stopMyzapStatusWatcher();
    stopTokenSyncWatcher();
    toast('Servico MyZap pausado');
    info('Servico MyZap pausado via toggle', {
      metadata: { status: 'parado' }
    });
  } else {
    applyMyZapRuntimeByMode('manual_toggle_start');
    if (isMyZapModoLocal() && isMyZapManualStartMode()) {
      const result = await startExternalMyZapFlow('tray_toggle_manual');
      toast(result.message || 'Disparo externo do MyZap solicitado.');
    } else {
      toast('Servico MyZap iniciado');
    }
    info('Servico MyZap iniciado via toggle', {
      metadata: { status: 'iniciado' }
    });
  }
  rebuildTrayMenu();
}

function handleUpdateCheck() {
  checkForUpdates(autoUpdater, { toast, warn });
}

async function updateMyZapNow() {
  if (myzapManualUpdateInProgress) {
    toast('Atualizacao do MyZap ja em andamento');
    return;
  }

  if (!hasValidConfigMyZap()) {
    toast('Configure URL da API, usuario e senha antes de atualizar o MyZap');
    createSettings();
    return;
  }

  myzapManualUpdateInProgress = true;
  toast('Atualizando MyZap manualmente...');
  myzapInfo('Atualizacao manual do MyZap solicitada via tray');

  try {
    const result = await ensureMyZapReadyAndStart({ forceRemote: true });
    notifyAdminRequired(result, 'manual_update');
    applyMyZapRuntimeByMode('manual_update');

    if (result?.status === 'success' && result?.skippedLocalStart) {
      toast('Modo web/online ativo. Atualizacao local ignorada.');
      return;
    }

    if (result?.status === 'success') {
      toast('MyZap atualizado e reiniciado com sucesso');
      if (isMyZapModoLocal()) {
        enviarStatusMyZap().catch((err) => {
          myzapWarn('Falha ao enviar status apos atualizacao manual do MyZap', {
            metadata: { error: err }
          });
        });
      }
      return;
    }

    toast(`Falha ao atualizar MyZap: ${result?.message || 'erro desconhecido'}`);
    myzapWarn('Falha na atualizacao manual do MyZap', {
      metadata: { result }
    });
  } catch (err) {
    toast('Erro inesperado ao atualizar MyZap');
    myzapError('Erro inesperado na atualizacao manual do MyZap', {
      metadata: { error: err }
    });
  } finally {
    myzapManualUpdateInProgress = false;
  }
}

async function autoStartMyZap() {
  if (!hasValidConfigMyZap()) {
    myzapWarn('MyZap: configuracoes base ausentes (apiUrl/apiLogin/apiPassword).');
    toast('Configure a API do MyZap pelo icone na bandeja');
    createSettings();
    return;
  }

  if (store.get('myzap_userRemovedLocal') === true) {
    myzapInfo('MyZap: auto-start ignorado (usuario removeu instalacao local previamente).');
    return;
  }

  if (isMyZapModoLocal() && isMyZapManualStartMode()) {
    myzapInfo('MyZap: auto-start local ignorado por preferencia de inicializacao manual.', {
      metadata: {
        localStartMode: getMyZapLocalStartMode(),
        localStartCommand: getMyZapLocalStartCommand(),
      }
    });
    const result = await startExternalMyZapFlow('auto_start_manual_mode');
    if (result.status !== 'success') {
      myzapWarn('Falha ao solicitar start externo do MyZap no startup manual', {
        metadata: { result }
      });
    }
    applyMyZapRuntimeByMode('auto_start_manual_mode');
    return;
  }

  try {
    myzapInfo('MyZap: iniciando fluxo automatico de preparacao/start...');
    let result = await ensureMyZapReadyAndStart({ forceRemote: true });

    if (result?.status !== 'success') {
      myzapWarn('MyZap: auto-start remoto falhou. Tentando fallback local com cache.', {
        metadata: { result }
      });
      result = await ensureMyZapReadyAndStart({ forceRemote: false });
    }

    notifyAdminRequired(result, 'auto_start');

    if (result.status === 'success' && result?.skippedLocalStart) {
      myzapInfo('MyZap em modo web/online. Execucao local desativada.', {
        metadata: { modo: getModoIntegracaoMyZap() }
      });
    } else if (result.status === 'success') {
      toast('Servico MyZap iniciado automaticamente');
    } else {
      myzapError('MyZap: falha no fluxo automatico de start', { metadata: { result } });
    }

    applyMyZapRuntimeByMode('auto_start');
  } catch (err) {
    myzapError('MyZap: erro critico no auto-start', { metadata: { error: err } });
  }
}

async function refreshMyZapConfigPeriodicamente() {
  if (!hasValidConfigMyZap()) {
    return;
  }

  try {
    const modoAntes = getModoIntegracaoMyZap();
    const result = await refreshRemoteConfigAndSyncIa();
    if (result?.status !== 'success') {
      myzapWarn('MyZap: falha ao atualizar config remota periodica', {
        metadata: { result }
      });
    }

    const modoDepois = getModoIntegracaoMyZap();
    if (modoAntes !== 'local' && modoDepois === 'local') {
      myzapInfo('MyZap: modo alterado para local/fila. Iniciando ambiente local automaticamente.');
      const startResult = await ensureMyZapLocalRuntime('config_refresh_mode_switch');
      notifyAdminRequired(startResult, 'config_refresh_mode_switch');
      if ((!startResult || startResult.status !== 'success') && !(startResult && startResult.manualStartRequired)) {
        myzapWarn('MyZap: falha ao iniciar ambiente local apos troca de modo', {
          metadata: { startResult }
        });
      }
    }

    applyMyZapRuntimeByMode('config_refresh');
    if (isMyZapModoLocal()) {
      await ensureMyZapLocalRuntime('config_refresh');
    }
  } catch (err) {
    myzapWarn('MyZap: erro na atualizacao remota periodica', {
      metadata: { error: err }
    });
  }
}

function scheduleMyZapConfigRefresh() {
  if (myzapConfigRefreshTimer) {
    return;
  }

  myzapConfigRefreshTimer = setInterval(() => {
    refreshMyZapConfigPeriodicamente();
  }, MYZAP_CONFIG_REFRESH_MS);
}

function scheduleMyZapEnsureLoop() {
  if (myzapEnsureLoopTimer) {
    return;
  }

  setTimeout(() => {
    ensureMyZapLocalRuntime('startup_delay').catch((err) => {
      myzapWarn('MyZap ensure-loop: erro na rodada inicial', {
        metadata: { error: err?.message || String(err) }
      });
    });
  }, 8000);

  myzapEnsureLoopTimer = setInterval(() => {
    ensureMyZapLocalRuntime('interval').catch((err) => {
      myzapWarn('MyZap ensure-loop: erro no loop de garantia de start', {
        metadata: { error: err?.message || String(err) }
      });
    });
  }, MYZAP_ENSURE_LOOP_MS);
}

async function tryStartQueueWatcherAuto() {
  if (!isMyZapModoLocal()) {
    return true;
  }

  if (!isCapabilityEnabled('supportsQueuePolling', store)) {
    myzapInfo('Watcher da fila MyZap ignorado por nao suportado/desabilitado', {
      metadata: {
        trigger: 'auto_queue_start',
        capability: getCapabilityMetadata('supportsQueuePolling')
      }
    });
    clearQueueAutoStartTimer();
    stopWhatsappQueueWatcher();
    return true;
  }

  try {
    const result = await startWhatsappQueueWatcher();
    if (result?.status === 'success') {
      if (queueAutoStartTimer) {
        clearInterval(queueAutoStartTimer);
        queueAutoStartTimer = null;
      }
      info('Watcher da fila MyZap iniciado automaticamente', {
        metadata: { trigger: 'inicializacao', message: result?.message }
      });
      return true;
    }

    warn('Fila MyZap ainda nao foi iniciada automaticamente', {
      metadata: { message: result?.message || 'resultado sem mensagem' }
    });
    return false;
  } catch (err) {
    warn('Erro ao iniciar automaticamente o watcher da fila MyZap', {
      metadata: { error: err }
    });
    return false;
  }
}

function scheduleQueueAutoStart() {
  if (!isCapabilityEnabled('supportsQueuePolling', store)) {
    clearQueueAutoStartTimer();
    stopWhatsappQueueWatcher();
    return;
  }

  if (queueAutoStartTimer) {
    return;
  }

  queueAutoStartTimer = setInterval(() => {
    tryStartQueueWatcherAuto();
  }, 30000);
  tryStartQueueWatcherAuto();
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', handleSecondInstanceLaunch);

  attachAutoUpdaterHandlers(autoUpdater, { toast });

  app.whenReady().then(() => {
    configureAutoLaunch();

    info('Aplicacao pronta para uso', {
      metadata: { ambiente: app.isPackaged ? 'producao' : 'desenvolvimento' }
    });

    trayManager.init(
      path.join(__dirname, 'assets/icon.png'),
      {
        createSettings,
        toggleMyzap,
        startExternalMyZapNow: async () => {
          const result = await startExternalMyZapFlow('tray_start_now');
          toast(result.message || 'Disparo externo do MyZap solicitado.');
          return result;
        },
        installExternalMyZapAutoStart: async () => {
          const result = await installExternalMyZapAutoStartFlow();
          toast(result.message || 'Auto inicio externo do MyZap atualizado.');
          return result;
        },
        removeExternalMyZapAutoStart: async () => {
          const result = await removeExternalMyZapAutoStartFlow();
          toast(result.message || 'Auto inicio externo do MyZap atualizado.');
          return result;
        },
        getExternalMyZapState: getExternalMyZapTrayState,
        updateMyZapNow,
        createPainelMyZap,
        createFilaMyZap,
        createManualSetupWindow,
        openLogViewer,
        abrirPastaLogs,
        checkUpdates: handleUpdateCheck
      },
      app.getVersion(),
      isMyZapServiceAtivo
    );

    setTrayCallback(rebuildTrayMenu);
    rebuildTrayMenu();

    if (!hasValidConfigMyZap()) {
      warn('Configuracao da API ausente no startup', {
        metadata: {
          apiUrl: !!store.get('apiUrl'),
          apiLogin: !!store.get('apiLogin'),
          apiPassword: !!store.get('apiPassword')
        }
      });
      toast('Configure a API do MyZap antes de iniciar');
      createSettings();
    }

    try {
      const progress = getCurrentProgress();
      if (progress && progress.active) {
        myzapWarn('Progresso stale detectado na inicializacao, limpando', {
          metadata: { progress }
        });
        clearProgress();
      }
    } catch (_e) { /* melhor esforco */ }

    autoStartMyZap();
    scheduleMyZapConfigRefresh();
    handleUpdateCheck();
  });

  app.on('window-all-closed', (e) => e.preventDefault());

  app.on('before-quit', () => {
    if (myzapConfigRefreshTimer) {
      clearInterval(myzapConfigRefreshTimer);
      myzapConfigRefreshTimer = null;
    }

    clearQueueAutoStartTimer();
    clearMyZapEnsureLoopTimer();

    stopWhatsappQueueWatcher();
    stopMyzapStatusWatcher();
    stopTokenSyncWatcher();
  });

  ipcMain.handle('settings:get', (_e, key) => store.get(key));
  ipcMain.handle('myzap:getManualSetupInfo', async () => {
    try {
      const info = ensureManualSetupGuideFile();
      return {
        status: 'success',
        data: info
      };
    } catch (error) {
      warn('Falha ao montar ajuda manual do MyZap', {
        metadata: { error }
      });
      return {
        status: 'error',
        message: error.message || String(error)
      };
    }
  });
  ipcMain.handle('myzap:openManualSetupGuide', async () => {
    try {
      const info = ensureManualSetupGuideFile();
      const openError = await shell.openPath(info.guideFilePath);
      if (openError) {
        return {
          status: 'error',
          message: `Nao foi possivel abrir o arquivo TXT: ${openError}`
        };
      }

      return {
        status: 'success',
        message: 'Arquivo TXT de ajuda aberto no sistema.',
        path: info.guideFilePath
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message || String(error)
      };
    }
  });
  ipcMain.handle('myzap:openManualSetupTargetDirectory', async () => {
    try {
      const info = ensureManualSetupGuideFile();
      require('fs').mkdirSync(info.targetDir, { recursive: true });
      const openError = await shell.openPath(info.targetDir);
      if (openError) {
        return {
          status: 'error',
          message: `Nao foi possivel abrir a pasta do MyZap: ${openError}`
        };
      }

      return {
        status: 'success',
        message: 'Pasta alvo do MyZap aberta no sistema.',
        path: info.targetDir
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message || String(error)
      };
    }
  });
  ipcMain.handle('myzap:openManualSetupLink', async (_e, kind) => {
    try {
      const info = ensureManualSetupGuideFile();
      const url = buildManualSetupLink(kind, info);
      if (!url) {
        return {
          status: 'error',
          message: 'Link solicitado nao e suportado.'
        };
      }

      await shell.openExternal(url);
      return {
        status: 'success',
        message: 'Link aberto no navegador padrao.',
        url
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message || String(error)
      };
    }
  });
  ipcMain.handle('myzap:getCapabilitySnapshot', () => getCapabilitySnapshotPayload(store));
  ipcMain.handle('myzap:saveCapabilityPreferences', async (_e, preferences = {}) => {
    const result = saveCapabilityPreferences(preferences, store);
    applyMyZapRuntimeByMode('preferences_saved');
    rebuildTrayMenu();
    return result;
  });
  ipcMain.handle('myzap:getLocalServiceStatus', async () => {
    const [portActive, httpActive] = await Promise.all([
      isPortInUse(5555),
      isLocalHttpServiceReachable({ timeoutMs: 3000 })
    ]);

    return {
      status: 'success',
      portActive,
      httpActive,
      isAvailable: Boolean(portActive || httpActive),
      localStartMode: getMyZapLocalStartMode(),
      localStartCommand: getMyZapLocalStartCommand()
    };
  });
  ipcMain.handle('myzap:startExternalNow', async () => startExternalMyZapFlow('renderer_manual_button'));
  ipcMain.handle('myzap:installExternalAutoStart', async () => installExternalMyZapAutoStartFlow());
  ipcMain.handle('myzap:removeExternalAutoStart', async () => removeExternalMyZapAutoStartFlow());
  ipcMain.handle('myzap:getExternalAutoStartState', async () => getExternalMyZapTrayState());
  ipcMain.handle('myzap:saveLocalStartPreferences', async (_e, preferences = {}) => {
    const localStartMode = normalizeMyZapLocalStartMode(preferences.localStartMode || preferences.startMode);
    const requestedStartCommand = normalizeMyZapLocalStartCommand(preferences.localStartCommand || preferences.startCommand);
    const localStartCommand = localStartMode === 'manual' ? 'dev' : requestedStartCommand;

    store.set({
      myzap_localStartMode: localStartMode,
      myzap_localStartCommand: localStartCommand
    });

    myzapInfo('Preferencias locais de inicializacao do MyZap atualizadas', {
      metadata: {
        localStartMode,
        localStartCommand
      }
    });

    applyMyZapRuntimeByMode('local_start_preferences_saved');
    let externalStartResult = null;
    if (isMyZapModoLocal()) {
      const runtimeResult = await ensureMyZapLocalRuntime('local_start_preferences_saved');
      if (localStartMode === 'manual') {
        externalStartResult = runtimeResult;
      }
    }
    rebuildTrayMenu();

    return {
      status: 'success',
      localStartMode,
      localStartCommand,
      manualStart: localStartMode === 'manual',
      externalStartResult,
    };
  });
  registerMyZapHandlers(ipcMain);

  ipcMain.on('settings-saved', async (_e, { apiUrl, apiLogin, apiPassword }) => {
    info('Configuracoes da API salvas pelo usuario', {
      metadata: { apiUrl, apiLogin }
    });

    const baseConfigChanged = (
      String(store.get('apiUrl') || '').trim() !== String(apiUrl || '').trim()
      || String(store.get('apiLogin') || '').trim() !== String(apiLogin || '').trim()
      || String(store.get('apiPassword') || '') !== String(apiPassword || '')
    );

    const previousBackendProfileKey = buildBackendProfileKey({
      apiUrl: store.get('apiUrl'),
      login: store.get('apiLogin'),
      idfilial: store.get('idfilial') || store.get('idempresa')
    });
    const nextBackendProfileKey = buildBackendProfileKey({ apiUrl, login: apiLogin });

    if (baseConfigChanged || (previousBackendProfileKey && nextBackendProfileKey && previousBackendProfileKey !== nextBackendProfileKey)) {
      myzapInfo('MyZap: backend/API da empresa alterado. Limpando cache remoto derivado.', {
        metadata: {
          previousBackendProfileKey,
          nextBackendProfileKey
        }
      });
      clearDerivedBackendState(store);
    }

    store.set({
      apiUrl,
      apiLogin,
      apiPassword,
      apiToken: '',
      idfilial: '',
      idempresa: '',
      myzap_backendProfileKey: nextBackendProfileKey
    });
    await autoStartMyZap();
  });

  ipcMain.on('myzap-settings-saved', async (_e, {
    myzap_diretorio,
    myzap_sessionKey,
    myzap_apiToken,
    myzap_envContent,
    clickexpress_apiUrl,
    clickexpress_queueToken
  }) => {
    myzapInfo('Configuracoes do painel MyZap salvas pelo usuario', {
      metadata: {
        myzap_diretorio,
        myzap_sessionKey,
        myzap_apiToken,
        myzap_envContent,
        clickexpress_apiUrl: !!clickexpress_apiUrl,
        clickexpress_queueToken: !!clickexpress_queueToken
      }
    });

    store.set({
      myzap_diretorio,
      myzap_sessionKey,
      myzap_sessionName: myzap_sessionKey,
      myzap_apiToken,
      myzap_envContent,
      myzap_backendApiUrl: clickexpress_apiUrl,
      myzap_backendApiToken: clickexpress_queueToken,
      clickexpress_apiUrl,
      clickexpress_queueToken
    });

    const result = await ensureMyZapReadyAndStart({ forceRemote: true });
    if (result.status === 'success') {
      toast('MyZap: configuracoes atualizadas automaticamente!');
    }

    applyMyZapRuntimeByMode('panel_manual_save');
    if (isMyZapModoLocal()) {
      enviarStatusMyZap().catch((err) => {
        myzapWarn('Falha ao enviar status passivo do MyZap apos salvar configuracoes', {
          metadata: { error: err }
        });
      });
    }
  });

  process.on('uncaughtException', (err) => {
    // Log sincrono de emergencia — sobrevive a crash
    const fsCrash = require('fs');
    const osCrash = require('os');
    const crashDir = require('path').join(osCrash.tmpdir(), 'jv-myzap', 'logs');
    try {
      if (!fsCrash.existsSync(crashDir)) fsCrash.mkdirSync(crashDir, { recursive: true });
      const crashLine = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'CRASH',
        type: 'uncaughtException',
        message: err?.message || String(err),
        stack: err?.stack || 'sem stack',
        pid: process.pid
      }) + osCrash.EOL;
      fsCrash.appendFileSync(require('path').join(crashDir, 'crash.log'), crashLine, 'utf8');
    } catch (_e) { /* melhor esforco */ }

    error('uncaughtException', {
      metadata: { error: err, stack: err?.stack }
    });
  });

  process.on('unhandledRejection', (reason) => {
    const fsCrash = require('fs');
    const osCrash = require('os');
    const crashDir = require('path').join(osCrash.tmpdir(), 'jv-myzap', 'logs');
    try {
      if (!fsCrash.existsSync(crashDir)) fsCrash.mkdirSync(crashDir, { recursive: true });
      const crashLine = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'CRASH',
        type: 'unhandledRejection',
        message: reason?.message || String(reason),
        stack: reason?.stack || 'sem stack',
        pid: process.pid
      }) + osCrash.EOL;
      fsCrash.appendFileSync(require('path').join(crashDir, 'crash.log'), crashLine, 'utf8');
    } catch (_e) { /* melhor esforco */ }

    error('unhandledRejection', {
      metadata: { error: reason, stack: reason?.stack }
    });
  });

  process.on('exit', (code) => {
    const fsCrash = require('fs');
    const osCrash = require('os');
    const crashDir = require('path').join(osCrash.tmpdir(), 'jv-myzap', 'logs');
    try {
      if (!fsCrash.existsSync(crashDir)) fsCrash.mkdirSync(crashDir, { recursive: true });
      const exitLine = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'EXIT',
        type: 'process_exit',
        code,
        pid: process.pid
      }) + osCrash.EOL;
      fsCrash.appendFileSync(require('path').join(crashDir, 'crash.log'), exitLine, 'utf8');
    } catch (_e) { /* melhor esforco */ }
  });
}
