function setButtonsState({ canStart, canDelete, canSendTest = false }) {
  const btnStart = document.getElementById('btn-start-session');
  const btnDelete = document.getElementById('btn-delete-session');
  const btnSendTest = document.getElementById('btn-send-test-message');

  if (btnStart) btnStart.disabled = !canStart;
  if (btnDelete) btnDelete.disabled = !canDelete;
  if (btnSendTest) btnSendTest.disabled = !canSendTest;
}

function setTestMessageFeedback(type, message) {
  const box = document.getElementById('myzap-test-feedback');
  if (!box) return;

  box.classList.remove('d-none', 'info', 'success', 'error');

  if (!message) {
    box.textContent = '';
    box.classList.add('d-none');
    return;
  }

  const normalizedType = type === 'success' || type === 'error' ? type : 'info';
  box.textContent = String(message);
  box.classList.add(normalizedType);
}

function canSendTestMessage() {
  const statusIndicator = document.querySelector('.status-indicator');
  return Boolean(statusIndicator?.classList.contains('connected'));
}

function setIaConfigVisibility(isVisible) {
  const box = document.getElementById('ia-config-box');
  if (!box) return;
  box.classList.toggle('d-none', !isVisible || !isIaConfigCapabilityEnabled());
}

const CONFIG_SYNC_INTERVAL_MS = 30 * 1000;
const QUEUE_POLL_INTERVAL_MS = 30 * 1000;
const STATUS_WATCH_INTERVAL_MS = 10 * 1000;
const PROGRESS_POLL_INTERVAL_MS = 1000;
const STALE_PROGRESS_HIDE_MS = 15 * 60 * 1000;

let myzapProgressPollTimer = null;
let connectionStatusPollTimer = null;
let qrPollingTimer = null;
let qrPollingAttempts = 0;
let lastConfigDebugPayload = null;
let currentCapabilityState = {
  preferences: {},
  snapshot: {}
};
let currentPrivilegeStatus = {
  platform: '',
  isElevated: false,
  requiresAdminForLocalInstall: false,
  needsAdminForLocalInstall: false,
  method: '',
  message: ''
};
const QR_POLL_INTERVAL_MS = 3000;
const QR_POLL_MAX_ATTEMPTS = 100; // ~300s (5 min) - Chrome pode demorar para inicializar

const CAPABILITY_FIELD_IDS = {
  supportsIaConfig: 'capability-ia-config-mode',
  supportsTokenSync: 'capability-token-sync-mode',
  supportsPassiveStatus: 'capability-passive-status-mode',
  supportsQueuePolling: 'capability-queue-polling-mode'
};

function normalizeCapabilityMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'enabled' || raw === 'on' || raw === 'true' || raw === '1') return 'enabled';
  if (raw === 'disabled' || raw === 'off' || raw === 'false' || raw === '0') return 'disabled';
  return 'auto';
}

function getCapabilityEntry(capability) {
  return currentCapabilityState?.snapshot?.[capability] || null;
}

function getCapabilityPreference(capability) {
  return normalizeCapabilityMode(currentCapabilityState?.preferences?.[capability] || 'auto');
}

function isIaConfigCapabilityEnabled() {
  return Boolean(getCapabilityEntry('supportsIaConfig')?.enabled);
}

function getCapabilityModeLabel(mode) {
  const normalized = normalizeCapabilityMode(mode);
  if (normalized === 'enabled') return 'habilitado manualmente';
  if (normalized === 'disabled') return 'desabilitado manualmente';
  return 'automatico';
}

function getCapabilityReasonLabel(entry = {}) {
  const reason = String(entry?.reason || '').trim().toLowerCase();
  const reasonLabels = {
    manual_enabled: 'forcado manualmente como habilitado',
    manual_disabled: 'forcado manualmente como desabilitado',
    remote_hint_enabled: 'hint remoto informou suporte',
    remote_hint_disabled: 'hint remoto informou ausencia',
    remote_ia_fields_present: 'campos de IA presentes na API remota',
    remote_ia_fields_missing: 'API remota nao retornou campos de IA',
    ia_supported_and_active: 'IA suportada e ativa',
    ia_unavailable_or_inactive: 'IA ausente ou inativa',
    default_enabled: 'padrao habilitado',
    default_disabled: 'padrao desabilitado',
    local_ia_config_not_supported: 'MyZap local nao suporta update-config de IA'
  };

  return reasonLabels[reason] || (entry?.reason ? String(entry.reason) : 'sem detalhe');
}

function renderCapabilitySummary() {
  const box = document.getElementById('capability-summary');
  if (!box) return;

  const labels = {
    supportsIaConfig: 'Config. IA',
    supportsTokenSync: 'Sync tokens',
    supportsPassiveStatus: 'Status passivo',
    supportsQueuePolling: 'Fila'
  };

  const html = Object.keys(CAPABILITY_FIELD_IDS).map((capability) => {
    const entry = getCapabilityEntry(capability) || {};
    const mode = getCapabilityPreference(capability);
    const status = entry?.enabled ? 'ativo' : 'ignorado';
    return `<div><strong>${labels[capability]}:</strong> ${status} (${getCapabilityModeLabel(mode)}; ${getCapabilityReasonLabel(entry)})</div>`;
  }).join('');

  box.innerHTML = html || 'Nenhuma capability resolvida ainda.';
}

function applyCapabilityState(payload = {}) {
  currentCapabilityState = {
    preferences: payload?.preferences || {},
    snapshot: payload?.snapshot || {}
  };

  Object.entries(CAPABILITY_FIELD_IDS).forEach(([capability, fieldId]) => {
    const select = document.getElementById(fieldId);
    if (!select) return;
    select.value = getCapabilityPreference(capability);
  });

  renderCapabilitySummary();
  if (!isIaConfigCapabilityEnabled()) {
    setIaConfigVisibility(false);
  }
}

async function refreshCapabilityState() {
  if (!window.api?.getCapabilitySnapshot) return currentCapabilityState;
  const payload = await window.api.getCapabilitySnapshot();
  applyCapabilityState(payload);
  return payload;
}

function getCapabilityPreferencesFromForm() {
  return Object.entries(CAPABILITY_FIELD_IDS).reduce((acc, [capability, fieldId]) => {
    const select = document.getElementById(fieldId);
    acc[capability] = normalizeCapabilityMode(select?.value || 'auto');
    return acc;
  }, {});
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizePrivilegeStatus(payload = {}) {
  return {
    platform: String(payload?.platform || ''),
    isElevated: Boolean(payload?.isElevated),
    requiresAdminForLocalInstall: Boolean(payload?.requiresAdminForLocalInstall),
    needsAdminForLocalInstall: Boolean(payload?.needsAdminForLocalInstall),
    method: String(payload?.method || ''),
    message: String(payload?.message || '')
  };
}

function buildAdminRequiredInstallMessage(actionLabel = 'instalar ou reinstalar o MyZap local') {
  return `Para ${actionLabel}, feche o Gerenciador MyZap e abra novamente como Administrador.`;
}

async function refreshPrivilegeStatus() {
  if (!window.api?.getPrivilegeStatus) {
    currentPrivilegeStatus = normalizePrivilegeStatus();
    return currentPrivilegeStatus;
  }

  try {
    currentPrivilegeStatus = normalizePrivilegeStatus(await window.api.getPrivilegeStatus());
  } catch (err) {
    console.warn('Falha ao verificar privilegios do processo atual:', err?.message || err);
    currentPrivilegeStatus = normalizePrivilegeStatus();
  }

  return currentPrivilegeStatus;
}

function needsAdminForLocalInstall(privilegeStatus = currentPrivilegeStatus) {
  return Boolean(
    privilegeStatus?.requiresAdminForLocalInstall
    && privilegeStatus?.needsAdminForLocalInstall
  );
}

function normalizeLocalStartMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'manual' ? 'manual' : 'automatic';
}

function normalizeLocalStartCommand(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['start', 'dev'].includes(normalized) ? normalized : 'auto';
}

function getLocalStartModeLabel(mode) {
  return normalizeLocalStartMode(mode) === 'manual'
    ? 'manual pela pasta do MyZap'
    : 'automatica pelo gerenciador';
}

function getLocalStartCommandLabel(command) {
  const normalized = normalizeLocalStartCommand(command);
  if (normalized === 'start') return 'start';
  if (normalized === 'dev') return 'dev';
  return 'automatico';
}

function getLocalStartCommandExample(command) {
  const normalized = normalizeLocalStartCommand(command);
  if (normalized === 'dev') return 'pnpm run dev';
  if (normalized === 'start') return 'pnpm start';
  return 'pnpm start ou pnpm run dev';
}

async function getStoredLocalStartPreferences() {
  const [localStartMode, localStartCommand] = await Promise.all([
    window.api.getStore('myzap_localStartMode'),
    window.api.getStore('myzap_localStartCommand')
  ]);

  return {
    localStartMode: normalizeLocalStartMode(localStartMode),
    localStartCommand: normalizeLocalStartCommand(localStartCommand)
  };
}

function getLocalStartPreferencesFromForm() {
  const localStartMode = normalizeLocalStartMode(document.getElementById('myzap-local-start-mode')?.value || 'automatic');
  let localStartCommand = normalizeLocalStartCommand(document.getElementById('myzap-local-start-command')?.value || 'auto');

  if (localStartMode === 'manual') {
    localStartCommand = 'dev';
  }

  return {
    localStartMode,
    localStartCommand
  };
}

function renderLocalStartPreferenceHelp(preferences = {}) {
  const localStartMode = normalizeLocalStartMode(preferences.localStartMode);
  const localStartCommand = normalizeLocalStartCommand(preferences.localStartCommand);
  const help = document.getElementById('myzap-local-start-help');
  if (!help) return;

  if (localStartMode === 'manual') {
    help.textContent = `Modo manual: o gerenciador vai disparar o MaisApp por fora com ${getLocalStartCommandExample(localStartCommand)}. Voce tambem pode usar o tray para iniciar agora ou ativar/remover o auto inicio externo.`;
    return;
  }

  help.textContent = `Modo automatico: o gerenciador tenta subir a API local sozinho. Comando preferido salvo: ${getLocalStartCommandLabel(localStartCommand)}.`;
}

function updateStartServiceButtonLabel(localStartMode = 'automatic') {
  const btnStart = document.getElementById('btn-start');
  if (!btnStart) return;
  btnStart.textContent = normalizeLocalStartMode(localStartMode) === 'manual'
    ? 'Iniciar MaisApp por fora'
    : 'Iniciar MyZap';
}

async function refreshExternalStartControls(preferences = getLocalStartPreferencesFromForm()) {
  const actionsBox = document.getElementById('myzap-external-start-actions');
  const stateText = document.getElementById('myzap-external-start-state');
  const btnStartExternal = document.getElementById('btn-external-start-now');
  const btnEnableAutoStart = document.getElementById('btn-external-autostart-enable');
  const btnRemoveAutoStart = document.getElementById('btn-external-autostart-remove');

  if (!actionsBox || !stateText || !btnStartExternal || !btnEnableAutoStart || !btnRemoveAutoStart) {
    return;
  }

  const normalized = {
    localStartMode: normalizeLocalStartMode(preferences.localStartMode),
    localStartCommand: normalizeLocalStartCommand(preferences.localStartCommand)
  };

  if (normalized.localStartMode === 'manual') {
    normalized.localStartCommand = 'dev';
  }

  if (!window.api?.getExternalMyZapAutoStartState) {
    actionsBox.classList.add('d-none');
    return;
  }

  try {
    const state = await window.api.getExternalMyZapAutoStartState();
    const shouldShow = Boolean(state?.available) && (normalized.localStartMode === 'manual' || state?.autoStartInstalled);
    const hasConfiguredDir = Boolean(state?.configuredDir);
    const autoStartInstalled = Boolean(state?.autoStartInstalled);

    actionsBox.classList.toggle('d-none', !shouldShow);
    if (!shouldShow) {
      return;
    }

    btnStartExternal.disabled = !hasConfiguredDir;
    btnEnableAutoStart.disabled = !hasConfiguredDir || autoStartInstalled;
    btnRemoveAutoStart.disabled = !autoStartInstalled;

    if (!hasConfiguredDir) {
      stateText.textContent = 'Configure o diretorio do MyZap para liberar o start externo.';
      return;
    }

    if (autoStartInstalled) {
      stateText.textContent = `Auto inicio externo ativo. O gerenciador vai chamar ${getLocalStartCommandExample(normalized.localStartCommand)} no logon do Windows.`;
      return;
    }

    stateText.textContent = `Start externo disponivel com ${getLocalStartCommandExample(normalized.localStartCommand)}. Use os botoes abaixo para testar agora ou ativar o auto inicio externo.`;
  } catch (error) {
    actionsBox.classList.toggle('d-none', normalized.localStartMode !== 'manual');
    btnStartExternal.disabled = true;
    btnEnableAutoStart.disabled = true;
    btnRemoveAutoStart.disabled = true;
    stateText.textContent = `Nao foi possivel consultar o start externo: ${error?.message || error}`;
  }
}

function applyStoredLocalStartPreferencesToUi(preferences = {}) {
  const normalized = {
    localStartMode: normalizeLocalStartMode(preferences.localStartMode),
    localStartCommand: normalizeLocalStartCommand(preferences.localStartCommand)
  };

  if (normalized.localStartMode === 'manual') {
    normalized.localStartCommand = 'dev';
  }

  const localStartModeField = document.getElementById('myzap-local-start-mode');
  const localStartCommandField = document.getElementById('myzap-local-start-command');

  if (localStartModeField) localStartModeField.value = normalized.localStartMode;
  if (localStartCommandField) localStartCommandField.value = normalized.localStartCommand;

  renderLocalStartPreferenceHelp(normalized);
  updateStartServiceButtonLabel(normalized.localStartMode);
  refreshExternalStartControls(normalized).catch((error) => {
    console.warn('Falha ao atualizar controles do start externo:', error?.message || error);
  });
}

async function saveLocalStartPreferencesFromUi() {
  if (!window.api?.saveLocalStartPreferences) {
    const fallback = getLocalStartPreferencesFromForm();
    applyStoredLocalStartPreferencesToUi(fallback);
    return { status: 'success', ...fallback };
  }

  const result = await window.api.saveLocalStartPreferences(getLocalStartPreferencesFromForm());
  applyStoredLocalStartPreferencesToUi(result);
  return result;
}

function setBadgeState(element, text, className) {
  if (!element) return;
  element.textContent = text;
  element.className = className;
}

function applyAdminGuardToLocalInstallUi(options = {}) {
  const {
    installed = false,
    remoteConfigOk = true,
    modoLocal = true
  } = options;

  if (!remoteConfigOk || !modoLocal || !needsAdminForLocalInstall()) {
    return false;
  }

  if (installed) {
    return false;
  }

  const message = currentPrivilegeStatus.message || buildAdminRequiredInstallMessage('instalar o MyZap local');
  const statusInstallation = document.getElementById('status-installation');
  const statusApi = document.getElementById('status-api');
  const btnInstall = document.getElementById('btn-install');
  const btnSaveAndInstall = document.getElementById('btn-save-and-install');
  const btnInstallAgain = document.getElementById('btn-install-again');
  const btnStart = document.getElementById('btn-start');

  setBadgeState(statusInstallation, message, 'badge bg-warning text-dark status-badge');
  setBadgeState(statusApi, 'Instalacao local bloqueada ate abrir o app como Administrador.', 'badge bg-warning text-dark status-badge');

  if (btnInstall) btnInstall.disabled = true;
  if (btnSaveAndInstall) btnSaveAndInstall.disabled = true;
  if (btnInstallAgain) btnInstallAgain.disabled = true;
  if (btnStart) btnStart.disabled = true;

  return true;
}

async function ensureAdminForLocalInstall(actionLabel = 'instalar o MyZap local') {
  const privilegeStatus = await refreshPrivilegeStatus();
  if (!needsAdminForLocalInstall(privilegeStatus)) {
    return true;
  }

  const message = privilegeStatus.message || buildAdminRequiredInstallMessage(actionLabel);
  const statusInstallation = document.getElementById('status-installation');
  const statusApi = document.getElementById('status-api');

  setBadgeState(statusInstallation, message, 'badge bg-warning text-dark status-badge');
  setBadgeState(statusApi, message, 'badge bg-warning text-dark status-badge');
  alert(message);
  return false;
}

function getProgressPercentByPhase(phase) {
  const map = {
    start: 5,
    prepare: 10,
    remote_validate: 15,
    check_install: 25,
    install_local: 35,
    update_existing_install: 55,
    precheck: 10,
    reinstall_cleanup: 20,
    clone_repo: 35,
    install_dependencies: 55,
    sync_configs: 75,
    restart_service: 78,
    start_service: 88,
    check_runtime: 86,
    git_pull: 90,
    run_start: 93,
    wait_port: 96,
    ready: 98,
    start_confirmed: 95,
    sync_ia: 97,
    already_running: 95,
    admin_required: 100,
    done: 100,
    error: 100,
    mode_web: 100
  };

  return map[String(phase || '').trim().toLowerCase()] ?? 0;
}

function getProgressPhaseLabel(phase) {
  const normalized = String(phase || '').trim().toLowerCase();
  if (!normalized) return 'aguardando';

  const labels = {
    start: 'inicio',
    prepare: 'preparacao',
    remote_validate: 'validacao remota',
    check_install: 'verificacao local',
    install_local: 'instalacao local',
    update_existing_install: 'atualizacao local',
    precheck: 'pre-requisitos',
    reinstall_cleanup: 'limpeza',
    clone_repo: 'clone git',
    install_dependencies: 'dependencias',
    sync_configs: 'sync configs',
    restart_service: 'reinicio',
    start_service: 'inicializacao',
    check_runtime: 'runtime',
    git_pull: 'git pull',
    run_start: 'start',
    wait_port: 'porta local',
    ready: 'servico pronto',
    start_confirmed: 'confirmacao',
    sync_ia: 'sync ia',
    already_running: 'ja em execucao',
    admin_required: 'permissao',
    done: 'concluido',
    error: 'erro',
    mode_web: 'modo online'
  };

  return labels[normalized] || normalized.replace(/_/g, ' ');
}

function shouldHideProgress(progress) {
  if (!progress || typeof progress !== 'object') return true;
  if (!progress.active && String(progress.phase || '').toLowerCase() === 'mode_web') {
    return true;
  }
  // Esconder quando ja concluido com sucesso e processo nao esta mais ativo
  if (!progress.active && String(progress.state || '').toLowerCase() === 'success') {
    return true;
  }
  if (!progress.active) {
    const updatedAt = Number(progress.updated_at || 0);
    if (updatedAt > 0 && (Date.now() - updatedAt) > STALE_PROGRESS_HIDE_MS) {
      return true;
    }
  }
  return false;
}

function resolveProgressPercent(progress = {}) {
  const fromMetadata = progress?.metadata?.percent;
  if (fromMetadata !== undefined && fromMetadata !== null && fromMetadata !== '') {
    return clampPercent(fromMetadata);
  }
  return clampPercent(getProgressPercentByPhase(progress?.phase));
}

function applyProgressStateClasses(box, bar, state, isActive) {
  box.classList.remove('alert-info', 'alert-success', 'alert-danger', 'alert-secondary');
  bar.classList.remove('bg-info', 'bg-success', 'bg-danger');

  if (state === 'success') {
    box.classList.add('alert-success');
    bar.classList.add('bg-success');
    bar.classList.remove('progress-bar-animated');
    return;
  }

  if (state === 'error') {
    box.classList.add('alert-danger');
    bar.classList.add('bg-danger');
    bar.classList.remove('progress-bar-animated');
    return;
  }

  box.classList.add('alert-info');
  bar.classList.add('bg-info');
  if (isActive) {
    bar.classList.add('progress-bar-animated');
  } else {
    bar.classList.remove('progress-bar-animated');
  }
}

function renderMyZapProgress(progress) {
  const box = document.getElementById('myzap-progress-box');
  const title = document.getElementById('myzap-progress-title');
  const phase = document.getElementById('myzap-progress-phase');
  const message = document.getElementById('myzap-progress-message');
  const bar = document.getElementById('myzap-progress-bar');
  const updated = document.getElementById('myzap-progress-updated');
  const statusApi = document.getElementById('status-api');

  if (!box || !title || !phase || !message || !bar || !updated) return;

  if (shouldHideProgress(progress)) {
    box.classList.add('d-none');
    return;
  }

  const state = String(progress?.state || (progress?.active ? 'running' : '') || 'running').toLowerCase();
  const phaseLabel = getProgressPhaseLabel(progress?.phase);
  const percent = (state === 'success')
    ? 100
    : resolveProgressPercent(progress);
  const isActive = Boolean(progress?.active);

  box.classList.remove('d-none');
  title.textContent = isActive ? 'Processo local do MyZap em andamento' : 'Ultimo processo local do MyZap';
  phase.textContent = phaseLabel;
  message.textContent = String(progress?.message || 'Aguardando execucao...');
  bar.style.width = `${percent}%`;
  bar.textContent = `${percent}%`;
  bar.setAttribute('aria-valuenow', String(percent));
  updated.textContent = `Ultima atualizacao: ${formatDateTimeBR(progress?.updated_at)}`;

  applyProgressStateClasses(box, bar, state, isActive);

  if (statusApi && isActive) {
    statusApi.textContent = `Processando: ${progress?.message || 'instalando MyZap local...'}`;
    statusApi.className = 'badge bg-warning text-dark status-badge';
  }
}

async function refreshMyZapProgress() {
  try {
    const progress = await window.api.getStore('myzap_progress');
    const modoIntegracao = (await window.api.getStore('myzap_modoIntegracao')) ?? 'local';
    const remoteConfigOk = Boolean(await window.api.getStore('myzap_remoteConfigOk'));
    const modoLocalAtivo = remoteConfigOk && isModoLocal(modoIntegracao);

    if (!modoLocalAtivo && !progress?.active) {
      renderMyZapProgress(null);
      return;
    }

    renderMyZapProgress(progress);
  } catch (err) {
    console.warn('Falha ao carregar progresso MyZap:', err?.message || err);
  }
}

function startMyZapProgressPolling() {
  if (myzapProgressPollTimer) return;
  refreshMyZapProgress();
  myzapProgressPollTimer = setInterval(() => {
    refreshMyZapProgress();
  }, PROGRESS_POLL_INTERVAL_MS);
}

function normalizeModoIntegracao(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'local';

  if (raw.includes('fila') || raw.includes('local')) return 'local';
  if (raw.includes('web') || raw.includes('online') || raw.includes('cloud') || raw.includes('nuvem')) return 'web';
  return raw;
}

function isModoLocal(value) {
  return normalizeModoIntegracao(value) === 'local';
}

function formatDateTimeBR(value) {
  const ts = Number(value || 0);
  if (!ts) return 'ainda nao sincronizado';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'ainda nao sincronizado';
  return d.toLocaleString('pt-BR');
}

function buildConfigDebugMeta(debugSnapshot) {
  const generatedAt = debugSnapshot?.generatedAt
    ? new Date(debugSnapshot.generatedAt).toLocaleString('pt-BR')
    : '-';
  const attempts = Array.isArray(debugSnapshot?.attempts) ? debugSnapshot.attempts.length : 0;
  const selectedEndpoint = debugSnapshot?.selectedEndpoint || 'nenhum';
  const reason = debugSnapshot?.reason || '-';
  const success = debugSnapshot?.success ? 'sim' : 'nao';

  return `Gerado em: ${generatedAt} | sucesso: ${success} | tentativas: ${attempts} | endpoint vencedor: ${selectedEndpoint} | motivo: ${reason}`;
}

async function atualizarDebugConfigPainel(autoConfigResult = null) {
  const meta = document.getElementById('config-debug-meta');
  const pre = document.getElementById('config-debug-json');
  if (!meta || !pre || !window.api?.getAutoConfigDebug) return;

  try {
    const debugSnapshot = await window.api.getAutoConfigDebug();
    const payload = {
      autoConfig: autoConfigResult
        ? {
          status: autoConfigResult?.status || null,
          message: autoConfigResult?.message || null
        }
        : null,
      debug: debugSnapshot
    };

    lastConfigDebugPayload = payload;
    meta.textContent = buildConfigDebugMeta(debugSnapshot);
    pre.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    meta.textContent = `Falha ao carregar debug: ${error?.message || error}`;
    pre.textContent = '{}';
  }
}

async function copiarDebugConfigApi() {
  const meta = document.getElementById('config-debug-meta');
  const text = JSON.stringify(lastConfigDebugPayload || {}, null, 2);

  if (!navigator.clipboard?.writeText) {
    if (meta) meta.textContent = 'Clipboard indisponivel neste ambiente.';
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    if (meta) meta.textContent = `${meta.textContent.split(' | ')[0]} | JSON copiado para a area de transferencia.`;
  } catch (error) {
    if (meta) meta.textContent = `Falha ao copiar JSON: ${error?.message || error}`;
  }
}

async function carregarDebugConfigApi() {
  const btn = document.getElementById('btn-config-debug-refresh');
  const originalText = btn?.textContent || 'Atualizar debug API';

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Atualizando...';
  }

  try {
    const autoConfig = await window.api.prepareMyZapAutoConfig(true);
    await atualizarDebugConfigPainel(autoConfig);
  } catch (error) {
    const meta = document.getElementById('config-debug-meta');
    if (meta) {
      meta.textContent = `Falha ao atualizar debug da API: ${error?.message || error}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

function renderRuntimeInfo({
  modoIntegracao,
  lastSyncAt,
  remoteConfigOk = true,
  localStartMode = 'automatic',
  localStartCommand = 'auto'
}) {
  const box = document.getElementById('myzap-runtime-info');
  if (!box) return;

  const modo = normalizeModoIntegracao(modoIntegracao);
  const modoLabel = modo === 'local' ? 'local/fila' : 'web/online';

  box.innerHTML = `
    <div><strong>Modo atual:</strong> ${modoLabel}</div>
    <div><strong>Configuracao remota validada:</strong> ${remoteConfigOk ? 'sim' : 'nao'}</div>
    <div><strong>Inicializacao local:</strong> ${getLocalStartModeLabel(localStartMode)}</div>
    <div><strong>Comando preferido do runtime local:</strong> ${getLocalStartCommandLabel(localStartCommand)}</div>
    <div><strong>Sincronizacao API -> gerenciador:</strong> a cada ${CONFIG_SYNC_INTERVAL_MS / 1000}s</div>
    <div><strong>Troca de modo no backend:</strong> aplicada automaticamente em ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s</div>
    <div><strong>Tentativa de iniciar fila local:</strong> a cada ${QUEUE_POLL_INTERVAL_MS / 1000}s (somente modo local)</div>
    <div><strong>Atualizacao de status passivo:</strong> a cada ${STATUS_WATCH_INTERVAL_MS / 1000}s (somente modo local)</div>
    <div><strong>Atualizacao de codigo do MyZap (git pull):</strong> ao iniciar o MyZap local</div>
    <div><strong>Ultima sincronizacao remota:</strong> ${formatDateTimeBR(lastSyncAt)}</div>
  `;
}

function applyModoInfoBanner(modoIntegracao) {
  const box = document.getElementById('myzap-modo-info');
  if (!box) return;
  const modo = normalizeModoIntegracao(modoIntegracao);

  if (modo === 'local') {
    box.classList.remove('alert-warning');
    box.classList.add('alert-info');
    box.textContent = `Modo local/fila ativo. O gerenciador instala/sincroniza/inicia o MyZap automaticamente e revalida config a cada ${CONFIG_SYNC_INTERVAL_MS / 1000}s.`;
    return;
  }

  box.classList.remove('alert-info');
  box.classList.add('alert-warning');
  box.textContent = `Modo web/online ativo. O MyZap local esta desativado neste computador. Atualize o backend da empresa para modo local/fila se quiser usar WhatsApp local. A sincronizacao aplica em ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s.`;
}

function setOnlineOnlyView(enabled, customMessage = '') {
  const onlineBox = document.getElementById('myzap-online-only');
  const localContent = document.getElementById('myzap-local-content');
  const myzapTabBtn = document.getElementById('myzap-tab');
  const myzapPane = document.getElementById('myzap');
  const statusTabBtn = document.getElementById('status-tab');
  const statusTabItem = statusTabBtn?.closest('li');
  const statusPane = document.getElementById('status');
  const runtimeInfo = document.getElementById('myzap-runtime-info');

  if (!onlineBox || !localContent) return;

  if (enabled) {
    onlineBox.classList.remove('d-none');
    localContent.classList.add('d-none');
    if (statusTabItem) statusTabItem.classList.add('d-none');
    if (statusPane) {
      statusPane.classList.add('d-none');
      statusPane.classList.remove('show', 'active');
    }
    if (myzapTabBtn) myzapTabBtn.classList.add('active');
    if (myzapPane) myzapPane.classList.add('show', 'active');
    if (statusTabBtn) statusTabBtn.classList.remove('active');
    if (runtimeInfo) runtimeInfo.classList.add('d-none');
    onlineBox.textContent = customMessage || `Modo web/online ativo. As mensagens do WhatsApp estao sendo enviadas de forma online (nao local). Para usar WhatsApp local, altere o modo para local/fila no backend da empresa. Aplicacao automatica em ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s.`;
    return;
  }

  onlineBox.classList.add('d-none');
  localContent.classList.remove('d-none');
  if (statusTabItem) statusTabItem.classList.remove('d-none');
  if (statusPane) statusPane.classList.remove('d-none');
  if (runtimeInfo) runtimeInfo.classList.remove('d-none');
}

async function isModoLocalAtivo() {
  const modo = (await window.api.getStore('myzap_modoIntegracao')) ?? 'local';
  const remoteOk = Boolean(await window.api.getStore('myzap_remoteConfigOk'));
  return remoteOk && isModoLocal(modo);
}

let configAutoRefreshTimer = null;

async function refreshConfigFromApiAndRender() {
  const autoConfig = await window.api.prepareMyZapAutoConfig(true);
  await refreshCapabilityState();
  await atualizarDebugConfigPainel(autoConfig);
  if (autoConfig?.status === 'error') {
    setOnlineOnlyView(true, `Nao foi possivel consultar a rota de configuracao do MyZap agora: ${autoConfig?.message || 'erro desconhecido'}. Verifique URL, usuario e senha nas Configuracoes e tente novamente.`);
    await refreshMyZapProgress();
    return;
  }

  const myzap_modoIntegracao = (await window.api.getStore('myzap_modoIntegracao')) ?? 'local';
  const myzap_lastRemoteConfigSyncAt = (await window.api.getStore('myzap_lastRemoteConfigSyncAt')) ?? 0;
  const myzap_remoteConfigOk = Boolean(await window.api.getStore('myzap_remoteConfigOk'));
  const modoLocal = isModoLocal(myzap_modoIntegracao);
  const localStartPreferences = await getStoredLocalStartPreferences();

  applyStoredLocalStartPreferencesToUi(localStartPreferences);

  applyModoInfoBanner(myzap_modoIntegracao);
  renderRuntimeInfo({
    modoIntegracao: myzap_modoIntegracao,
    lastSyncAt: myzap_lastRemoteConfigSyncAt,
    remoteConfigOk: myzap_remoteConfigOk,
    localStartMode: localStartPreferences.localStartMode,
    localStartCommand: localStartPreferences.localStartCommand
  });
  if (!myzap_remoteConfigOk) {
    setOnlineOnlyView(true, `Nao foi possivel validar a configuracao do MyZap na API neste momento. O painel local foi bloqueado para evitar decisao por cache. Verifique URL, usuario e senha nas Configuracoes e tente novamente.`);
  } else {
    setOnlineOnlyView(!modoLocal);
  }

  const statusApi = document.getElementById('status-api');
  const statusInstallation = document.getElementById('status-installation');
  const statusConfig = document.getElementById('status-config');
  const btnStart = document.getElementById('btn-start');

  if (!myzap_remoteConfigOk || !modoLocal) {
    if (statusApi) {
      statusApi.textContent = !myzap_remoteConfigOk
        ? 'Nao foi possivel validar modo na API. Start local bloqueado.'
        : `Modo web/online: start local desativado. Troque para local/fila no backend da empresa (sync em ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s).`;
      statusApi.className = 'badge bg-info text-dark status-badge';
    }
    if (statusInstallation) {
      statusInstallation.textContent = !myzap_remoteConfigOk
        ? 'Modo nao validado na API'
        : 'Nao aplicavel no modo web/online';
      statusInstallation.className = 'badge bg-info text-dark status-badge';
    }
    if (statusConfig) {
      statusConfig.textContent = 'Automatico via API';
      statusConfig.className = 'badge bg-info text-dark status-badge';
    }
    if (btnStart) btnStart.disabled = true;
    setButtonsState({ canStart: false, canDelete: false });
    setIaConfigVisibility(false);
  }

  await refreshMyZapProgress();
}

function startConfigAutoRefresh() {
  if (configAutoRefreshTimer) return;
  configAutoRefreshTimer = setInterval(() => {
    refreshConfigFromApiAndRender().catch((err) => {
      console.warn('Falha no refresh automatico de config MyZap:', err?.message || err);
    });
  }, CONFIG_SYNC_INTERVAL_MS);
}

function startConnectionStatusPolling() {
  if (connectionStatusPollTimer) return;

  connectionStatusPollTimer = setInterval(() => {
    checkConnection().catch((err) => {
      console.warn('Falha no refresh automatico do status MyZap:', err?.message || err);
    });
  }, STATUS_WATCH_INTERVAL_MS);
}

function stopConnectionStatusPolling() {
  if (!connectionStatusPollTimer) return;
  clearInterval(connectionStatusPollTimer);
  connectionStatusPollTimer = null;
}


(async () => {
  try {
    await refreshPrivilegeStatus();

    // Se usuario removeu tudo anteriormente, manter estado entre reaberturas do app
    const userRemoved = await window.api.getStore('myzap_userRemovedLocal');
    if (userRemoved === true) {
      if (needsAdminForLocalInstall()) {
        setPanelVisible(false);
        setResetFeedback({
          show: true,
          type: 'warning',
          icon: '',
          title: 'Abra o app como Administrador',
          message: currentPrivilegeStatus.message || buildAdminRequiredInstallMessage('instalar o MyZap local'),
          details: 'Feche o Gerenciador MyZap, abra novamente como Administrador e tente a reinstalacao local.',
          showInstallAgain: false
        });
        return;
      }

      setPanelVisible(false);
      setResetFeedback({
        show: true,
        type: 'success',
        icon: '',
        title: 'MyZap foi removido',
        message: 'O MyZap local foi removido. Clique em "Instalar Novamente" para reinstalar com TOKEN gerado automaticamente.',
        details: null,
        showInstallAgain: true
      });
      return;
    }
    await loadConfigs();
    startMyZapProgressPolling();
    startConfigAutoRefresh();
  } catch (e) {
    alert('Erro ao carregar configuracoes: ' + (e?.message || e));
  }
})();


async function loadConfigs() {
  try {
    const configIntro = document.querySelector('#config > p.text-muted.mb-3');
    if (configIntro) {
      configIntro.innerHTML = 'O <strong>TOKEN local do MyZap</strong> e sincronizado automaticamente do Hub quando disponivel. Se a filial nao devolver essa chave, voce pode ajusta-la abaixo antes de instalar.';
    }
    const autoConfig = await window.api.prepareMyZapAutoConfig(true);
    await refreshPrivilegeStatus();
    await refreshCapabilityState();
    await atualizarDebugConfigPainel(autoConfig);
    const remoteConfigOk = autoConfig?.status !== 'error';
    if (autoConfig?.status === 'error') {
      console.warn('Falha na prepara??o autom?tica do MyZap:', autoConfig?.message);
    }
    const configTab = document.getElementById('config-tab');
    const configTabItem = configTab?.closest('li');
    const configPane = document.getElementById('config');
    const installGroup = document.getElementById('install-group');
    if (installGroup) installGroup.classList.add('d-none');
    const myzap_diretorio = (await window.api.getStore('myzap_diretorio')) ?? '';
    const myzap_sessionKey = (await window.api.getStore('myzap_sessionKey')) ?? '';
    const myzap_sessionName = (await window.api.getStore('myzap_sessionName')) ?? myzap_sessionKey;
    const myzap_apiToken = (await window.api.getStore('myzap_apiToken')) ?? '';
    const myzap_envContent = (await window.api.getStore('myzap_envContent')) ?? '';
    const myzap_mensagemPadrao = (await window.api.getStore('myzap_mensagemPadrao')) ?? '';
    const myzap_modoIntegracao = (await window.api.getStore('myzap_modoIntegracao')) ?? 'local';
    const myzap_lastRemoteConfigSyncAt = (await window.api.getStore('myzap_lastRemoteConfigSyncAt')) ?? 0;
    const myzap_remoteConfigOk = Boolean(await window.api.getStore('myzap_remoteConfigOk'));
    const modoLocal = isModoLocal(myzap_modoIntegracao);
    const localStartPreferences = await getStoredLocalStartPreferences();

    applyStoredLocalStartPreferencesToUi(localStartPreferences);

    applyModoInfoBanner(myzap_modoIntegracao);
    renderRuntimeInfo({
      modoIntegracao: myzap_modoIntegracao,
      lastSyncAt: myzap_lastRemoteConfigSyncAt,
      remoteConfigOk: myzap_remoteConfigOk,
      localStartMode: localStartPreferences.localStartMode,
      localStartCommand: localStartPreferences.localStartCommand
    });
    setOnlineOnlyView(
      !remoteConfigOk || !myzap_remoteConfigOk || !modoLocal,
      !remoteConfigOk
        ? `Nao foi possivel consultar a rota de configuracao do MyZap agora: ${autoConfig?.message || 'erro desconhecido'}. Verifique URL, usuario e senha nas Configuracoes e tente novamente.`
        : (!myzap_remoteConfigOk
          ? 'Nao foi possivel validar a configuracao do MyZap na API neste momento. O painel local foi bloqueado para evitar decisao por cache.'
          : '')
    );

    const statusConfig = document.getElementById('status-config');
    if (!myzap_remoteConfigOk || !modoLocal) {
      statusConfig.textContent = 'Automatico via API';
      statusConfig.classList.remove('bg-secondary', 'bg-danger', 'bg-success');
      statusConfig.classList.add('bg-info', 'text-dark');
    } else if (myzap_diretorio && myzap_sessionKey && myzap_apiToken && myzap_envContent) {
      statusConfig.textContent = 'Tudo em ordem!';
      statusConfig.classList.remove('bg-secondary');
      statusConfig.classList.add('bg-success');
    }
    const statusInstallation = document.getElementById('status-installation');
    const statusApi = document.getElementById('status-api');
    const btnStart = document.getElementById('btn-start');

    if (!myzap_remoteConfigOk || !modoLocal) {
      statusInstallation.textContent = !myzap_remoteConfigOk
        ? 'Modo nao validado na API'
        : 'Nao aplicavel no modo web/online';
      statusInstallation.classList.remove('bg-secondary', 'bg-danger', 'bg-success');
      statusInstallation.classList.add('bg-info', 'text-dark');
      setInstalled(false);

      statusApi.textContent = !myzap_remoteConfigOk
        ? 'Nao foi possivel validar modo na API. Start local bloqueado.'
        : `Modo web/online: start local desativado. Troque para local/fila no backend da empresa (sync em ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s).`;
      statusApi.classList.remove('bg-secondary', 'bg-danger', 'bg-success');
      statusApi.classList.add('bg-info', 'text-dark');
      btnStart.disabled = true;
      setButtonsState({ canStart: false, canDelete: false });
      setIaConfigVisibility(false);
    } else {
      const hasFiles = await window.api.checkDirectoryHasFiles(
        String(myzap_diretorio)
      );
      const isInstalled = hasFiles.status === 'success';
      statusInstallation.textContent = hasFiles.message || 'Erro na configuracao!';
      statusInstallation.classList.remove('bg-secondary');
      statusInstallation.classList.add(isInstalled ? 'bg-success' : 'bg-danger');
      setInstalled(isInstalled);
      btnStart.disabled = false;

      applyAdminGuardToLocalInstallUi({
        installed: isInstalled,
        remoteConfigOk: myzap_remoteConfigOk,
        modoLocal
      });

      if (isInstalled) {
        statusApi.innerHTML = `
              <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
              Verificando...
          `;
        const localServiceStatus = await window.api.getLocalServiceStatus();
        const localApiAcessivel = Boolean(localServiceStatus?.isAvailable);

        statusApi.classList.remove('bg-secondary', 'bg-info', 'bg-danger', 'bg-success', 'bg-warning', 'text-dark');
        if (localApiAcessivel) {
          statusApi.textContent = 'MyZap local acessivel.';
          statusApi.classList.add('bg-success');
          btnStart.disabled = true;
        } else if (localStartPreferences.localStartMode === 'manual') {
          statusApi.textContent = `Modo manual ativo. Clique em "Iniciar MaisApp por fora" ou use o tray para disparar ${getLocalStartCommandExample(localStartPreferences.localStartCommand)}.`;
          statusApi.classList.add('bg-warning', 'text-dark');
          btnStart.disabled = false;
        } else {
          statusApi.textContent = 'MyZap local parado. Clique em Iniciar MyZap.';
          statusApi.classList.add('bg-warning', 'text-dark');
          btnStart.disabled = false;
        }
      }
    }

    if (myzap_sessionKey) {
      document.getElementById('myzap-sessionkey').value = myzap_sessionKey;
      document.getElementById('myzap-sessionname').value = myzap_sessionName || myzap_sessionKey;
    }
    if (document.getElementById('myzap-sessionkey')) {
      document.getElementById('myzap-sessionkey').placeholder = 'Carregado automaticamente da API';
    }
    if (document.getElementById('myzap-sessionname')) {
      document.getElementById('myzap-sessionname').placeholder = 'Carregado automaticamente da API';
    }
    if (modoLocal && myzap_sessionKey) {
      startConnectionStatusPolling();
    } else {
      stopConnectionStatusPolling();
    }

    if (document.getElementById('myzap-mensagem-padrao')) document.getElementById('myzap-mensagem-padrao').value = myzap_mensagemPadrao;

    // Carrega segredos do .env para a aba de configurações
    try {
      const envSecrets = await window.api.readEnvSecrets();
      if (document.getElementById('input-env-token')) document.getElementById('input-env-token').value = envSecrets.TOKEN || '';
      if (document.getElementById('input-env-openai')) document.getElementById('input-env-openai').value = envSecrets.OPENAI_API_KEY || '';
      if (document.getElementById('input-env-emailtoken')) document.getElementById('input-env-emailtoken').value = envSecrets.EMAIL_TOKEN || '';
      // Mostrar hint + botão "Salvar e Instalar" se TOKEN vazio
      updateConfigInstallHint(envSecrets.TOKEN || '');
    } catch (envErr) {
      console.warn('Falha ao carregar segredos do .env:', envErr?.message || envErr);
    }

    await refreshMyZapProgress();
  } catch (e) {
    alert('Erro ao carregar configura??es: ' + (e?.message || e));
  }
}

async function checkRealConnection() {
  console.log('[MyZap UI] checkRealConnection: iniciando verificacao de status real');
  const qrBox = document.getElementById('qrcode-box');
  const statusIndicator = document.querySelector('.status-indicator');

  qrBox.innerHTML = `<span class="text-muted-small">Verificando status real...</span>`;

  try {
    const response = await window.api.verifyRealStatus();

    if (!response.dbStatus && !response.status) {
      throw new Error('Resposta invalida da API');
    }

    const {
      realStatus,
      dbStatus,
      dbState,
      status,
      message
    } = response;

    if (status == 'NOT FOUND') {
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = 'Sessao nao iniciada!';

      qrBox.innerHTML = `
        <span class="text-muted-small">
          Nenhuma instancia de sessao foi criada!
        </span>
      `;

      setButtonsState({ canStart: true, canDelete: false, canSendTest: false });
      setIaConfigVisibility(false);
      return { isConnected: false, isQrWaiting: false, response };
    }

    const isConnected = realStatus === 'CONNECTED' || isPayloadConnected(response);
    const isQrWaiting = dbState === 'QRCODE' || dbStatus === 'qrCode';

    if (isConnected) {
      statusIndicator.className = 'status-indicator connected';
      statusIndicator.textContent = 'Conectado';

      qrBox.innerHTML = `
        <span class="text-muted-small">
          WhatsApp conectado com sucesso
        </span>
      `;

      setButtonsState({ canStart: false, canDelete: true, canSendTest: true });
      setIaConfigVisibility(true);
      return { isConnected: true, isQrWaiting: false, response };
    }

    if (isQrWaiting) {
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = '⏳ Aguardando leitura do QR Code';

      setButtonsState({ canStart: false, canDelete: true, canSendTest: false });
      setIaConfigVisibility(false);
      return { isConnected: false, isQrWaiting: true, response };
    }

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = '❌ Desconectado';

    // Traduzir mensagem tecnica da API para algo amigavel
    var displayMessage = 'QR Code nao disponivel';
    if (message) {
      var msgLower = String(message).toLowerCase();
      if (msgLower.includes('client') && (msgLower.includes('memoria') || msgLower.includes('mem\u00f3ria'))) {
        displayMessage = 'Sessao nao iniciada. Clique em "Iniciar instancia" para comecar.';
      } else {
        displayMessage = message;
      }
    }
    qrBox.innerHTML = `
      <span class="text-muted-small">
        ${displayMessage}
      </span>
    `;

    setButtonsState({ canStart: true, canDelete: false, canSendTest: false });
    setIaConfigVisibility(false);
    return { isConnected: false, isQrWaiting: false, response };

  } catch (err) {
    console.error('Erro ao verificar status real:', err);

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = '⚠️ Erro de conexão';

    qrBox.innerHTML = `
      <span class="text-danger text-small">
        Erro ao verificar status do MyZap
      </span>
    `;

    setButtonsState({ canStart: false, canDelete: false, canSendTest: false });
    setIaConfigVisibility(false);
    return { isConnected: false, isQrWaiting: false, response: null };
  }
}

async function checkConnection() {
  console.log('[MyZap UI] checkConnection: verificando modo e status');
  const qrBox = document.getElementById('qrcode-box');
  const statusIndicator = document.querySelector('.status-indicator');

  // Se o polling de QR esta ativo, nao interferir (ele cuida da UI)
  if (qrPollingTimer) {
    console.log('[MyZap UI] checkConnection: polling de QR ativo, ignorando');
    return;
  }

  if (!(await isModoLocalAtivo())) {
    statusIndicator.className = 'status-indicator waiting';
    statusIndicator.textContent = 'Modo local inativo ou nao validado';
    qrBox.innerHTML = `<span class="text-muted-small">QR Code local indisponivel. Verifique o modo no backend da empresa e a validacao da rota de configuracao.</span>`;
    setButtonsState({ canStart: false, canDelete: false, canSendTest: false });
    setIaConfigVisibility(false);
    return;
  }

  // loading simples (opcional)
  qrBox.innerHTML = `<span class="text-muted-small">Verificando status...</span>`;

  try {
    const realCheck = await checkRealConnection();

    if (!realCheck || realCheck.isConnected) {
      return;
    }

    if (!realCheck.isQrWaiting) {
      return;
    }

    const response = await window.api.getConnectionStatus();

    if (!response || response.result !== 200) {
      throw new Error('Resposta invalida da API');
    }

    const { status, state, qrCode } = response;

    if ((state === 'QRCODE' || status === 'qrCode') && qrCode) {
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = '⏳ Aguardando leitura do QR Code';

      qrBox.innerHTML = `
        <img
          src="${qrCode}"
          alt="QR Code WhatsApp"
        />
        <div class="qrcode-hint">
          Escaneie o QR Code com o WhatsApp
        </div>
      `;
    }

  } catch (err) {
    console.error('Erro ao verificar conexao:', err);

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = '⚠️ Erro de conexão';

    qrBox.innerHTML = `
      <span class="text-danger text-small">
        Erro ao verificar status do MyZap
      </span>
    `;
  }
}


// ---- Helpers para detectar conexao/QR de qualquer payload do MyZap ----
function isPayloadConnected(payload) {
  if (!payload || Array.isArray(payload)) return false;
  var fields = ['realStatus', 'status', 'dbStatus', 'state', 'dbState', 'connectionStatus'];
  var connectedKeywords = ['connected', 'open', 'authenticated', 'islogged'];
  for (var i = 0; i < fields.length; i++) {
    var val = String(payload[fields[i]] || '').trim().toLowerCase();
    for (var j = 0; j < connectedKeywords.length; j++) {
      if (val.indexOf(connectedKeywords[j]) !== -1) return true;
    }
  }
  if (payload.result && typeof payload.result === 'object') {
    return isPayloadConnected(payload.result);
  }
  return false;
}

function extractQrCode(payload) {
  if (!payload || Array.isArray(payload)) return '';
  var qrFields = ['qrCode', 'qr_code', 'qrcode', 'base64Qrimg', 'urlCode', 'qr', 'qr_base64', 'qrBase64'];
  for (var i = 0; i < qrFields.length; i++) {
    var val = payload[qrFields[i]];
    if (val && typeof val === 'string' && val.trim().length > 20) return val.trim();
  }
  if (payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)) {
    return extractQrCode(payload.result);
  }
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return extractQrCode(payload.data);
  }
  return '';
}
// ---- Fim helpers ----

function stopQrPolling() {
  if (qrPollingTimer) {
    clearInterval(qrPollingTimer);
    qrPollingTimer = null;
  }
  qrPollingAttempts = 0;
}

async function tickQrPolling() {
  qrPollingAttempts++;
  console.log('[MyZap UI] tickQrPolling: tentativa', qrPollingAttempts, '/', QR_POLL_MAX_ATTEMPTS);
  var qrBox = document.getElementById('qrcode-box');
  var statusIndicator = document.querySelector('.status-indicator');
  if (!qrBox || !statusIndicator) { stopQrPolling(); return; }

  try {
    // Usar getSessionSnapshot que consolida verify + connection + cache de QR
    var snapshot = null;
    try {
      snapshot = await window.api.getSessionSnapshot();
      console.log('[MyZap UI] getSessionSnapshot:', JSON.stringify(snapshot));
    } catch (_snapErr) {
      console.warn('[MyZap UI] getSessionSnapshot falhou:', _snapErr.message);
    }

    // Fallback: se getSessionSnapshot nao estiver disponivel, tentar metodo antigo
    if (!snapshot || snapshot.status === 'error') {
      console.warn('[MyZap UI] tickQrPolling: snapshot indisponivel, tentando metodo legado');
      var snap = null;
      try { snap = await window.api.verifyRealStatus(); } catch (_e) {}
      var connStatus = null;
      try { connStatus = await window.api.getConnectionStatus(); } catch (_e) {}

      if (isPayloadConnected(snap) || isPayloadConnected(connStatus)) {
        stopQrPolling();
        statusIndicator.className = 'status-indicator connected';
        statusIndicator.textContent = 'Conectado';
        qrBox.innerHTML = '<span class="text-muted-small">WhatsApp conectado com sucesso</span>';
        setButtonsState({ canStart: false, canDelete: true, canSendTest: true });
        setIaConfigVisibility(true);
        return;
      }
      var legacyQr = extractQrCode(connStatus) || extractQrCode(snap);
      if (legacyQr) {
        statusIndicator.className = 'status-indicator waiting';
        statusIndicator.textContent = 'Aguardando leitura do QR Code';
        qrBox.innerHTML = '<img src="' + legacyQr + '" alt="QR Code WhatsApp"/>' +
          '<div class="qrcode-hint">Escaneie o QR Code com o WhatsApp</div>';
        setButtonsState({ canStart: false, canDelete: true, canSendTest: false });
      }
      return;
    }

    var sessionStatus = (snapshot.session_status || '').toLowerCase();

    // ---- CASO 1: Conectado -> atualizar UI e parar polling ----
    if (sessionStatus === 'connected') {
      stopQrPolling();
      statusIndicator.className = 'status-indicator connected';
      statusIndicator.textContent = 'Conectado';
      qrBox.innerHTML = '<span class="text-muted-small">WhatsApp conectado com sucesso</span>';
      setButtonsState({ canStart: false, canDelete: true, canSendTest: true });
      setIaConfigVisibility(true);
      console.log('[MyZap UI] Sessao conectada! Polling de QR encerrado.');
      return;
    }

    // Verificar conexao tambem nos payloads raw (caso session_status nao reflita)
    if (snapshot.raw) {
      if (isPayloadConnected(snapshot.raw.verify) || isPayloadConnected(snapshot.raw.connection)) {
        stopQrPolling();
        statusIndicator.className = 'status-indicator connected';
        statusIndicator.textContent = 'Conectado';
        qrBox.innerHTML = '<span class="text-muted-small">WhatsApp conectado com sucesso</span>';
        setButtonsState({ canStart: false, canDelete: true, canSendTest: true });
        setIaConfigVisibility(true);
        console.log('[MyZap UI] Sessao conectada (raw)! Polling de QR encerrado.');
        return;
      }
    }

    // ---- CASO 2: QR Code disponivel - exibir/atualizar ----
    var newQr = snapshot.qr_base64 || '';
    // Fallback: tentar extrair QR dos payloads raw
    if (!newQr && snapshot.raw) {
      newQr = extractQrCode(snapshot.raw.connection) || extractQrCode(snapshot.raw.verify);
    }

    if (newQr) {
      var existingImg = qrBox.querySelector('img');
      if (!existingImg || existingImg.src !== newQr) {
        statusIndicator.className = 'status-indicator waiting';
        statusIndicator.textContent = 'Aguardando leitura do QR Code';
        qrBox.innerHTML = '<img src="' + newQr + '" alt="QR Code WhatsApp"/>' +
          '<div class="qrcode-hint">Escaneie o QR Code com o WhatsApp</div>';
        setButtonsState({ canStart: false, canDelete: true, canSendTest: false });
      }
    } else {
      // Sem QR ainda - mostrar feedback de progresso baseado no status
      var feedbackStatus = sessionStatus || '';
      if (snapshot && snapshot.raw && snapshot.raw.connection) {
        feedbackStatus = feedbackStatus || (snapshot.raw.connection.status || snapshot.raw.connection.state || '').toLowerCase();
      }
      // Durante o boot do MyZap, "Client nao esta na memoria" retorna not_found/disconnected.
      // Enquanto o polling estiver ativo, tratar esses status como "inicializando" tambem.
      var isInitializing = feedbackStatus === 'initializing' || feedbackStatus === 'starting'
        || feedbackStatus === 'reconnecting' || feedbackStatus === 'loading'
        || feedbackStatus === 'not_found' || feedbackStatus === 'disconnected';
      if (isInitializing) {
        statusIndicator.className = 'status-indicator waiting';
        statusIndicator.textContent = 'Inicializando navegador... (' + qrPollingAttempts + '/' + QR_POLL_MAX_ATTEMPTS + ')';
        if (!qrBox.querySelector('.initializing-feedback')) {
          qrBox.innerHTML = '<div class="initializing-feedback"><span class="spinner-border spinner-border-sm" role="status"></span> ' +
            'Aguardando Chrome/WhatsApp inicializar. Isso pode levar alguns minutos na primeira vez...</div>';
        }
      }
    }
  } catch (err) {
    console.warn('[MyZap UI] tickQrPolling: erro transiente', err && err.message ? err.message : err);
  }
}

function startQrPolling() {
  stopQrPolling();
  console.log('[MyZap UI] startQrPolling: iniciando polling de QR Code');
  // Primeira tentativa apos 2s (MyZap precisa de tempo para gerar o QR)
  setTimeout(tickQrPolling, 2000);
  qrPollingTimer = setInterval(async () => {
    if (qrPollingAttempts >= QR_POLL_MAX_ATTEMPTS) {
      console.log('[MyZap UI] QR polling: limite de tentativas atingido');
      const qrBox = document.getElementById('qrcode-box');
      const statusIndicator = document.querySelector('.status-indicator');
      stopQrPolling();

      // Verificacao final antes de desistir — talvez conectou no ultimo segundo
      try {
        const finalSnap = await window.api.verifyRealStatus();
        if (isPayloadConnected(finalSnap)) {
          if (statusIndicator) {
            statusIndicator.className = 'status-indicator connected';
            statusIndicator.textContent = '✅ Conectado';
          }
          if (qrBox) qrBox.innerHTML = '<span class="text-muted-small">WhatsApp conectado com sucesso</span>';
          setButtonsState({ canStart: false, canDelete: true, canSendTest: true });
          setIaConfigVisibility(true);
          return;
        }
      } catch (_e) { /* melhor esforco */ }

      // De fato expirou — informar o usuario
      if (statusIndicator) {
        statusIndicator.className = 'status-indicator waiting';
        statusIndicator.textContent = 'QR Code expirado';
      }
      if (qrBox) {
        qrBox.innerHTML = '<span class="text-muted-small">QR Code expirou. Clique em Iniciar instancia para gerar um novo.</span>';
      }
      setButtonsState({ canStart: true, canDelete: true, canSendTest: false });
      return;
    }
    await tickQrPolling();
  }, QR_POLL_INTERVAL_MS);
}


async function iniciarSessao() {
  console.log('[MyZap UI] iniciarSessao: botao clicado');
  if (!(await isModoLocalAtivo())) {
    alert(`Modo local inativo ou nao validado pela API. Verifique o modo no backend da empresa e aguarde ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s para sincronizacao.`);
    return;
  }

  const qrBox = document.getElementById('qrcode-box');
  const statusIndicator = document.querySelector('.status-indicator');

  try {
    const realCheck = await checkRealConnection();
    if (realCheck?.isConnected || realCheck?.isQrWaiting) {
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = '⚠️ Sessão já existe';

      setButtonsState({ canStart: false, canDelete: true, canSendTest: Boolean(realCheck?.isConnected) });
      return;
    }

    statusIndicator.className = 'status-indicator waiting';
    statusIndicator.textContent = 'Iniciando sessao...';

    qrBox.innerHTML = `
      <div class="initializing-feedback">
        <span class="spinner-border spinner-border-sm" role="status"></span>
        Iniciando sessao e aguardando QR Code. Isso pode levar alguns minutos...
      </div>
    `;

    const response = await window.api.startSession();
    console.log('[MyZap UI] startSession resposta:', JSON.stringify(response));

    if (!response || (response.result !== 'success' && response.result !== 200)) {
      throw new Error('Sem resposta do MyZap. Verifique se o servico esta rodando (porta 5555).');
    }

    setButtonsState({ canStart: false, canDelete: true, canSendTest: false });

    // Verificar se sessao conectou durante espera interna do startSession
    var startStatus = (response.session_status || response.status || '').toString().toUpperCase();
    if (startStatus === 'CONNECTED') {
      console.log('[MyZap UI] Sessao conectou durante startSession');
      statusIndicator.className = 'status-indicator connected';
      statusIndicator.textContent = 'Conectado';
      qrBox.innerHTML = '<span class="text-muted-small">WhatsApp conectado com sucesso</span>';
      setButtonsState({ canStart: false, canDelete: true, canSendTest: true });
      setIaConfigVisibility(true);
      return;
    }

    // Se o start retornou QR code (polling interno encontrou), exibir imediatamente
    const qrFromStart = response.qrCode || response.qr_code || response.qrcode || response.base64Qrimg || response.urlCode || '';
    if (qrFromStart) {
      console.log('[MyZap UI] QR code recebido direto do startSession');
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = '⏳ Aguardando leitura do QR Code';
      qrBox.innerHTML = `
        <img src="${qrFromStart}" alt="QR Code WhatsApp"/>
        <div class="qrcode-hint">Escaneie o QR Code com o WhatsApp</div>
      `;
    } else {
      statusIndicator.textContent = 'Sessao iniciada, aguardando QR Code...';
    }

    // Iniciar polling para atualizar QR e detectar conexao (3s, ate ~120s)
    startQrPolling();

  } catch (err) {
    console.error('Erro ao iniciar sessao:', err);

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = '❌ Erro ao iniciar sessao';

    qrBox.innerHTML = `
      <span class="text-danger text-small">
        Nao foi possivel iniciar a sessao
      </span>
    `;
  }
}


async function deletarSessao() {
  console.log('[MyZap UI] deletarSessao: botao clicado');
  stopQrPolling(); // Cancelar polling de QR em andamento
  if (!(await isModoLocalAtivo())) {
    alert(`Modo local inativo ou nao validado pela API. Verifique o modo no backend da empresa e aguarde ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s para sincronizacao.`);
    return;
  }

  const qrBox = document.getElementById('qrcode-box');
  const statusIndicator = document.querySelector('.status-indicator');

  try {
    // 1. Verifica se existe sessao
    const realCheck = await checkRealConnection();

    if (!realCheck || (!realCheck.isConnected && !realCheck.isQrWaiting)) {
      statusIndicator.className = 'status-indicator disconnected';
      statusIndicator.textContent = 'Nenhuma sessao ativa';

      setButtonsState({ canStart: true, canDelete: false, canSendTest: false });
      return;
    }

    // 2. Feedback visual
    statusIndicator.className = 'status-indicator waiting';
    statusIndicator.textContent = 'Encerrando sessao...';

    qrBox.innerHTML = `
      <span class="text-muted-small">
        Encerrando sessao do WhatsApp...
      </span>
    `;

    // 3. Chamada de delete
    const response = await window.api.deleteSession();

    if (!response || response.status !== 'SUCCESS') {
      throw new Error('Falha ao deletar sessao');
    }

    // 4. UI final
    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = '❌ Sessao encerrada';

    qrBox.innerHTML = `
      <span class="text-muted-small">
        Sessao removida com sucesso
      </span>
    `;

    setButtonsState({ canStart: true, canDelete: false, canSendTest: false });

  } catch (err) {
    console.error('Erro ao deletar sessao:', err);

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = '⚠️ Erro ao deletar sessão';

    qrBox.innerHTML = `
      <span class="text-danger text-small">
        Nao foi possivel encerrar a sessao
      </span>
    `;
  }
}

async function enviarMensagemTeste() {
  const btnSendTest = document.getElementById('btn-send-test-message');
  if (!btnSendTest) return;

  if (!(await isModoLocalAtivo())) {
    setTestMessageFeedback('error', 'Modo local inativo ou nao validado pela API.');
    btnSendTest.disabled = true;
    return;
  }

  const oldText = btnSendTest.textContent;
  btnSendTest.disabled = true;
  btnSendTest.textContent = 'Enviando...';
  setTestMessageFeedback('info', 'Enviando mensagem de teste para o proprio numero...');

  try {
    const response = await window.api.sendTestMessage();

    if (!response || response.status !== 'success') {
      throw new Error(response?.message || 'Falha ao enviar mensagem de teste.');
    }

    setTestMessageFeedback(
      'success',
      `Teste enviado para ${response.number} em ${response.sentAtLabel}.`
    );
  } catch (err) {
    console.error('Erro ao enviar mensagem de teste:', err);
    setTestMessageFeedback('error', err?.message || String(err));
  } finally {
    btnSendTest.textContent = oldText;
    btnSendTest.disabled = !canSendTestMessage();
  }
}

async function salvarMensagemPadrao() {
  if (!(await isModoLocalAtivo())) {
    alert(`Modo local inativo ou nao validado pela API. Para aplicar no local, verifique o modo no backend da empresa e aguarde ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s.`);
    return;
  }

  if (!isIaConfigCapabilityEnabled()) {
    alert('Configuracao de IA ignorada: este backend/MyZap local nao suporta essa feature no momento.');
    return;
  }

  const textarea = document.getElementById('myzap-mensagem-padrao');
  const btnSave = document.getElementById('btn-save-ia-config');
  const mensagemPadrao = textarea?.value?.trim() || '';

  if (!mensagemPadrao) {
    alert('Informe uma mensagem padrao antes de salvar.');
    return;
  }

  btnSave.disabled = true;
  const oldText = btnSave.textContent;
  btnSave.textContent = 'Salvando...';

  try {
    const response = await window.api.updateIaConfig(mensagemPadrao);

    if (!response || response.status === 'error') {
      throw new Error(response?.message || 'Falha ao salvar configuracao da IA');
    }

    await refreshCapabilityState();
    if (response?.status === 'skipped') {
      setIaConfigVisibility(false);
      alert(response?.message || 'Configuracao opcional de IA ignorada.');
      return;
    }

    alert('Mensagem padrao atualizada com sucesso.');
  } catch (err) {
    console.error('Erro ao atualizar mensagem padrao:', err);
    alert(`Erro ao atualizar mensagem padrao: ${err?.message || err}`);
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = oldText;
  }
}

function showConfigStatus(type, message) {
  const el = document.getElementById('config-save-status');
  if (!el) return;
  el.classList.remove('d-none', 'alert-success', 'alert-danger', 'alert-warning', 'alert-info');
  el.classList.add(type === 'success' ? 'alert-success' : type === 'error' ? 'alert-danger' : 'alert-info');
  el.textContent = message;

  if (type === 'success') {
    setTimeout(() => el.classList.add('d-none'), 4000);
  }
}

async function runExternalConfigAction(buttonId, busyText, action) {
  const button = document.getElementById(buttonId);
  const oldText = button?.textContent || '';

  if (button) {
    button.disabled = true;
    button.textContent = busyText;
  }

  try {
    return await action();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = oldText;
    }

    refreshExternalStartControls().catch((error) => {
      console.warn('Falha ao atualizar acoes do start externo:', error?.message || error);
    });
  }
}

async function iniciarMyZapExternoAgora() {
  if (!window.api?.startExternalMyZapNow) {
    showConfigStatus('error', 'Esta versao do gerenciador nao expoe o start externo do MaisApp.');
    return;
  }

  const result = await runExternalConfigAction('btn-external-start-now', 'Iniciando...', () => window.api.startExternalMyZapNow());
  if (result?.status === 'success') {
    showConfigStatus('success', result.message || 'Disparo externo solicitado com sucesso.');
    startConnectionStatusPolling();
    setTimeout(() => {
      checkConnection().catch((error) => {
        console.warn('Falha ao revalidar conexao apos start externo:', error?.message || error);
      });
    }, 5000);
    return;
  }

  showConfigStatus('error', result?.message || 'Nao foi possivel iniciar o MaisApp por fora.');
}

async function ativarAutoInicioExterno() {
  if (!window.api?.installExternalMyZapAutoStart) {
    showConfigStatus('error', 'Esta versao do gerenciador nao expoe o auto inicio externo.');
    return;
  }

  const result = await runExternalConfigAction('btn-external-autostart-enable', 'Ativando...', () => window.api.installExternalMyZapAutoStart());
  if (result?.status === 'success') {
    showConfigStatus('success', result.message || 'Auto inicio externo ativado com sucesso.');
    return;
  }

  showConfigStatus('error', result?.message || 'Nao foi possivel ativar o auto inicio externo.');
}

async function removerAutoInicioExterno() {
  if (!window.api?.removeExternalMyZapAutoStart) {
    showConfigStatus('error', 'Esta versao do gerenciador nao expoe a remocao do auto inicio externo.');
    return;
  }

  const result = await runExternalConfigAction('btn-external-autostart-remove', 'Removendo...', () => window.api.removeExternalMyZapAutoStart());
  if (result?.status === 'success') {
    showConfigStatus('success', result.message || 'Auto inicio externo removido com sucesso.');
    return;
  }

  showConfigStatus('error', result?.message || 'Nao foi possivel remover o auto inicio externo.');
}

function updateConfigInstallHint(tokenValue) {
  const hint = document.getElementById('config-install-hint');
  const btnInstall = document.getElementById('btn-save-and-install');
  if (!hint || !btnInstall) return;

  if (!tokenValue || !tokenValue.trim()) {
    hint.classList.remove('d-none');
    btnInstall.classList.remove('d-none');
  } else {
    hint.classList.add('d-none');
    btnInstall.classList.add('d-none');
  }
}

async function saveCapabilityPreferencesFromUi() {
  if (!window.api?.saveCapabilityPreferences) {
    return { status: 'success', preferences: {}, snapshot: {} };
  }

  const result = await window.api.saveCapabilityPreferences(getCapabilityPreferencesFromForm());
  applyCapabilityState(result);
  return result;
}

const cfg_myzap = document.getElementById('myzap-config-form');
const localStartModeField = document.getElementById('myzap-local-start-mode');
const localStartCommandField = document.getElementById('myzap-local-start-command');

if (localStartModeField) {
  localStartModeField.addEventListener('change', () => {
    if (normalizeLocalStartMode(localStartModeField.value) === 'manual' && localStartCommandField) {
      localStartCommandField.value = 'dev';
    }
    const preferences = getLocalStartPreferencesFromForm();
    renderLocalStartPreferenceHelp(preferences);
    refreshExternalStartControls(preferences).catch((error) => {
      console.warn('Falha ao atualizar controles do start externo:', error?.message || error);
    });
  });
}

if (localStartCommandField) {
  localStartCommandField.addEventListener('change', () => {
    const preferences = getLocalStartPreferencesFromForm();
    renderLocalStartPreferenceHelp(preferences);
    refreshExternalStartControls(preferences).catch((error) => {
      console.warn('Falha ao atualizar controles do start externo:', error?.message || error);
    });
  });
}

cfg_myzap.onsubmit = async (e) => {
  e.preventDefault();
  const btnSave = document.getElementById('btn-save-config');
  const oldText = btnSave.textContent;
  btnSave.disabled = true;
  btnSave.textContent = 'Salvando...';
  const tokenVal = (document.getElementById('input-env-token')?.value || '').trim();
  try {
    const capabilityResult = await saveCapabilityPreferencesFromUi();
    if (capabilityResult?.status !== 'success') {
      throw new Error(capabilityResult?.message || 'Falha ao salvar as features opcionais.');
    }

    const localStartResult = await saveLocalStartPreferencesFromUi();
    if (localStartResult?.status !== 'success') {
      throw new Error(localStartResult?.message || 'Falha ao salvar a estrategia de inicializacao local.');
    }

    const secrets = {
      TOKEN: tokenVal,
      OPENAI_API_KEY: (document.getElementById('input-env-openai')?.value || '').trim(),
      EMAIL_TOKEN: (document.getElementById('input-env-emailtoken')?.value || '').trim()
    };
    const result = await window.api.saveEnvSecrets(secrets);
    if (result?.status === 'success') {
      const externalMessage = localStartResult?.externalStartResult?.message;
      const saveMessage = externalMessage
        ? `${result.message} ${externalMessage}`
        : result.message;
      showConfigStatus('success', '✅ ' + saveMessage);
      updateConfigInstallHint(tokenVal);
    } else {
      showConfigStatus('error', 'Erro ao salvar: ' + (result?.message || 'desconhecido'));
    }
  } catch (err) {
    showConfigStatus('error', 'Erro ao salvar: ' + (err?.message || err));
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = oldText;
  }
};

async function salvarEInstalar() {
  // 1. Salvar segredos primeiro
  const btnInstall = document.getElementById('btn-save-and-install');
  if (!(await ensureAdminForLocalInstall('instalar o MyZap local'))) {
    if (btnInstall) {
      btnInstall.disabled = false;
      btnInstall.textContent = '🚀 Salvar e Instalar';
    }
    return;
  }

  if (btnInstall) {
    btnInstall.disabled = true;
    btnInstall.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Salvando...`;
  }

  const tokenVal = (document.getElementById('input-env-token')?.value || '').trim();
  if (!tokenVal) {
    showConfigStatus('error', 'Preencha o TOKEN antes de instalar.');
    if (btnInstall) { btnInstall.disabled = false; btnInstall.textContent = '🚀 Salvar e Instalar'; }
    return;
  }

  try {
    const capabilityResult = await saveCapabilityPreferencesFromUi();
    if (capabilityResult?.status !== 'success') {
      throw new Error(capabilityResult?.message || 'Falha ao salvar as features opcionais.');
    }

    const localStartResult = await saveLocalStartPreferencesFromUi();
    if (localStartResult?.status !== 'success') {
      throw new Error(localStartResult?.message || 'Falha ao salvar a estrategia de inicializacao local.');
    }

    const secrets = {
      TOKEN: tokenVal,
      OPENAI_API_KEY: (document.getElementById('input-env-openai')?.value || '').trim(),
      EMAIL_TOKEN: (document.getElementById('input-env-emailtoken')?.value || '').trim()
    };
    await window.api.saveEnvSecrets(secrets);
    showConfigStatus('success', '✅ Configurações salvas. Iniciando instalação...');

    if (btnInstall) {
      btnInstall.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Instalando...`;
    }

    // Ir para aba Status para acompanhar o progresso
    const statusTab = document.getElementById('status-tab');
    if (statusTab) statusTab.click();

    // Limpar flag de remoção se existir e instalar
    await window.api.clearUserRemovedFlag();
    const autoConfig = await window.api.prepareMyZapAutoConfig(true);
    if (autoConfig?.status === 'error') {
      showConfigStatus('error', 'Erro ao buscar configurações da API: ' + (autoConfig?.message || ''));
      if (btnInstall) { btnInstall.disabled = false; btnInstall.textContent = '🚀 Salvar e Instalar'; }
      return;
    }

    const result = await window.api.ensureMyZapStarted(true);
    if (result?.status === 'success') {
      showConfigStatus('success', '✅ MyZap instalado e iniciado com sucesso!');
      setTimeout(() => window.location.reload(), 2000);
    } else {
      showConfigStatus('error', 'Aviso na instalação: ' + (result?.message || ''));
      if (btnInstall) { btnInstall.disabled = false; btnInstall.textContent = '🚀 Salvar e Instalar'; }
    }
  } catch (err) {
    showConfigStatus('error', 'Erro: ' + (err?.message || err));
    if (btnInstall) { btnInstall.disabled = false; btnInstall.textContent = '🚀 Salvar e Instalar'; }
  }
}

function atualizaStatus() {
  window.location.reload();
}

async function iniciarMyZapServico() {
  const btnStart = document.getElementById('btn-start');
  const statusApi = document.getElementById('status-api');
  const myzap_modoIntegracao = (await window.api.getStore('myzap_modoIntegracao')) ?? 'local';
  const myzap_remoteConfigOk = Boolean(await window.api.getStore('myzap_remoteConfigOk'));
  const localStartPreferences = await getStoredLocalStartPreferences();

  updateStartServiceButtonLabel(localStartPreferences.localStartMode);

  if (!myzap_remoteConfigOk || !isModoLocal(myzap_modoIntegracao)) {
    statusApi.textContent = !myzap_remoteConfigOk
      ? 'Nao foi possivel validar modo na API. Start local bloqueado.'
      : `Modo web/online: MyZap local desativado. Troque para local/fila no backend da empresa (sync em ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s).`;
    statusApi.className = 'badge bg-info text-dark status-badge';
    btnStart.disabled = true;
    return;
  }

  const myzap_diretorio = (await window.api.getStore('myzap_diretorio')) ?? '';
  const hasFiles = myzap_diretorio
    ? await window.api.checkDirectoryHasFiles(String(myzap_diretorio))
    : { status: 'error' };

  if (hasFiles.status !== 'success' && !(await ensureAdminForLocalInstall('instalar o MyZap local'))) {
    btnStart.disabled = true;
    return;
  }

  btnStart.disabled = true;
  statusApi.innerHTML = `
    <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
    Iniciando...
  `;
  statusApi.className = 'badge bg-warning text-dark status-badge';
  try {
    if (localStartPreferences.localStartMode === 'manual') {
      const result = await window.api.startExternalMyZapNow();
      statusApi.classList.remove('bg-success', 'bg-danger', 'bg-warning', 'text-dark');

      if (result?.status === 'success') {
        statusApi.textContent = result.message || `Disparo externo solicitado com ${getLocalStartCommandExample(localStartPreferences.localStartCommand)}.`;
        statusApi.classList.add('bg-info', 'text-dark');
        startConnectionStatusPolling();
        setTimeout(() => {
          checkConnection().catch((error) => {
            console.warn('Falha ao revalidar MyZap apos start externo:', error?.message || error);
          });
        }, 5000);
      } else {
        statusApi.textContent = result?.message || `Nao foi possivel disparar ${getLocalStartCommandExample(localStartPreferences.localStartCommand)} pelo gerenciador.`;
        statusApi.classList.add('bg-danger');
      }

      btnStart.disabled = false;
      return;
    }

    const result = await window.api.ensureMyZapStarted(true);
    statusApi.textContent = result.message || 'Erro ao iniciar MyZap!';
    statusApi.classList.remove('bg-warning', 'text-dark');
    if (result?.status === 'success' && result?.skippedLocalStart) {
      statusApi.classList.add('bg-info', 'text-dark');
      btnStart.disabled = true;
      return;
    }
    statusApi.classList.add(result.status === 'success' ? 'bg-success' : 'bg-danger');
    btnStart.disabled = (result.status === 'success');
  } catch (err) {
    console.error('Erro ao iniciar MyZap:', err);
    statusApi.textContent = 'Erro ao iniciar MyZap!';
    statusApi.classList.remove('bg-warning', 'text-dark');
    statusApi.classList.add('bg-danger');
    btnStart.disabled = false;
  }
}

function setInstalled(isInstalled) {
  const dropdownBtn = document.getElementById("btn-install-dropdown");
  const mainBtn = document.getElementById("btn-install");

  if (isInstalled) {
    dropdownBtn.classList.remove("d-none");
    mainBtn.innerText = "Instalado";
    mainBtn.classList.remove("btn-primary");
    mainBtn.classList.add("btn-success");
    mainBtn.disabled = true;
  } else {
    dropdownBtn.classList.add("d-none");
    mainBtn.innerText = "Instalar";
    mainBtn.classList.remove("btn-success");
    mainBtn.classList.add("btn-primary");
    mainBtn.disabled = false;
  }
}

async function installMyZap() {
  const myzap_diretorio = (await window.api.getStore('myzap_diretorio')) ?? '';
  const myzap_envContent = (await window.api.getStore('myzap_envContent')) ?? '';

  if (!myzap_diretorio) {
    alert('Por favor, salve as configuracoes antes de instalar o MyZap.');
    return;
  }

  if (!(await ensureAdminForLocalInstall('instalar o MyZap local'))) {
    return;
  }

  // 1. Elementos da UI
  const btnInstall = document.getElementById('btn-install');
  const btnStart = document.getElementById('btn-start');
  const btnRefresh = document.getElementById('btn-refresh-status');
  const statusBadge = document.getElementById('status-installation');

  // Guardamos o texto original para restaurar em caso de erro
  const originalBtnText = btnInstall.innerHTML;
  const originalBadgeText = statusBadge.textContent;
  const originalBadgeClass = statusBadge.className;

  try {
    btnInstall.disabled = true;
    btnStart.disabled = true;
    btnRefresh.disabled = true;

    btnInstall.innerHTML = `
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            Instalando...
        `;

    statusBadge.textContent = 'Baixando arquivos...';
    statusBadge.className = 'badge bg-warning text-dark status-badge';

    const clone = await window.api.cloneRepository(
      String(myzap_diretorio),
      String(myzap_envContent)
    );

    if (clone.status === 'error') {
      throw new Error((clone.message || 'Erro desconhecido') + (clone.debugLogPath ? '\n\nLog de debug: ' + clone.debugLogPath : ''));
    }

    statusBadge.textContent = 'MyZap se encontra no diretorio configurado!';
    statusBadge.className = 'badge bg-success status-badge';

    setTimeout(() => {
      alert('MyZap instalado com sucesso!');
      atualizaStatus();
    }, 500);

  } catch (error) {
    console.error(error);
    alert('Erro ao instalar MyZap: ' + error.message);

    btnInstall.innerHTML = originalBtnText;
    btnInstall.disabled = false;

    statusBadge.textContent = 'Falha na instalacao';
    statusBadge.className = 'badge bg-danger status-badge';
  }
}

async function reinstallMyZap() {
  if (!confirm("Deseja reinstalar o MyZap? Isso ira substituir a instalacao atual.")) {
    return;
  }

  const myzap_diretorio = (await window.api.getStore('myzap_diretorio')) ?? '';
  const myzap_envContent = (await window.api.getStore('myzap_envContent')) ?? '';

  if (!myzap_diretorio) {
    alert('Por favor, salve as configuracoes antes de re-instalar o MyZap.');
    return;
  }

  if (!(await ensureAdminForLocalInstall('reinstalar o MyZap local'))) {
    return;
  }

  // 1. Elementos da UI
  const btnInstall = document.getElementById('btn-install');
  const btnReInstall = document.getElementById('btn-reinstall');
  const btnStart = document.getElementById('btn-start');
  const btnRefresh = document.getElementById('btn-refresh-status');
  const statusBadge = document.getElementById('status-installation');
  const statusRunBadge = document.getElementById('status-api');
  const dropdownBtn = document.getElementById("btn-install-dropdown");

  // Guardamos o texto original para restaurar em caso de erro
  const originalBtnText = btnInstall.innerHTML;
  const originalBadgeText = statusBadge.textContent;
  const originalBadgeClass = statusBadge.className;

  try {
    btnInstall.disabled = true;
    btnStart.disabled = true;
    btnReInstall.disabled = true;
    dropdownBtn.disabled = true;
    btnRefresh.disabled = true;

    btnInstall.innerHTML = `
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            Re-Instalando...
        `;

    statusBadge.textContent = 'Baixando arquivos...';
    statusBadge.className = 'badge bg-warning text-dark status-badge';

    statusRunBadge.textContent = 'Aguardando reinstalacao...';
    statusRunBadge.className = 'badge bg-secondary status-badge';

    const clone = await window.api.cloneRepository(
      String(myzap_diretorio),
      String(myzap_envContent),
      true
    );

    if (clone.status === 'error') {
      throw new Error((clone.message || 'Erro desconhecido') + (clone.debugLogPath ? '\n\nLog de debug: ' + clone.debugLogPath : ''));
    }

    statusBadge.textContent = 'MyZap se encontra no diretorio configurado!';
    statusBadge.className = 'badge bg-success status-badge';

    setTimeout(() => {
      alert('MyZap re-instalado com sucesso!');
      atualizaStatus();
    }, 500);

  } catch (error) {
    console.error(error);
    alert('Erro ao re-instalar MyZap: ' + error.message);

    btnInstall.innerHTML = originalBtnText;
    btnInstall.disabled = false;

    statusBadge.textContent = 'Falha na instalacao';
    statusBadge.className = 'badge bg-danger status-badge';
    setTimeout(() => {
      atualizaStatus();
    }, 1500);
  }
}

// ═══════════════════════════════════════════════════
// REMOVER TUDO (RESET COMPLETO)
// ═══════════════════════════════════════════════════

function setPanelVisible(visible) {
  const tabs = document.getElementById('myzapTabs');
  const tabContent = document.querySelector('.tab-content');
  if (tabs) tabs.classList.toggle('d-none', !visible);
  if (tabContent) tabContent.classList.toggle('d-none', !visible);
}

function setResetFeedback({ show, type, icon, title, message, details, showInstallAgain }) {
  const box = document.getElementById('reset-feedback-box');
  const alertEl = document.getElementById('reset-feedback-alert');
  const iconEl = document.getElementById('reset-feedback-icon');
  const titleEl = document.getElementById('reset-feedback-title');
  const msgEl = document.getElementById('reset-feedback-message');
  const detailsEl = document.getElementById('reset-feedback-details');
  const btnAgain = document.getElementById('btn-install-again');

  if (!box) return;

  if (!show) {
    box.classList.add('d-none');
    return;
  }

  box.classList.remove('d-none');

  alertEl.classList.remove('alert-info', 'alert-success', 'alert-danger', 'alert-warning');
  alertEl.classList.add(type === 'success' ? 'alert-success' : type === 'error' ? 'alert-danger' : type === 'warning' ? 'alert-warning' : 'alert-info');

  iconEl.textContent = icon || '';
  titleEl.textContent = title || '';
  msgEl.textContent = message || '';

  if (details) {
    detailsEl.classList.remove('d-none');
    detailsEl.textContent = details;
  } else {
    detailsEl.classList.add('d-none');
    detailsEl.textContent = '';
  }

  if (showInstallAgain) {
    btnAgain.classList.remove('d-none');
  } else {
    btnAgain.classList.add('d-none');
  }

  // Scroll pro topo para garantir visibilidade
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setAllButtonsDisabled(disabled) {
  const ids = ['btn-start', 'btn-install', 'btn-reinstall', 'btn-install-dropdown', 'btn-refresh-status', 'btn-remove-all', 'btn-start-session', 'btn-delete-session'];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

async function removerTudoMyZap() {
  if (!confirm('Tem certeza que deseja REMOVER TUDO do MyZap local?\n\nIsso ira:\n- Parar o servico do MyZap\n- Remover todos os arquivos instalados\n- Limpar todas as configuracoes salvas\n\nVoce podera reinstalar depois.')) {
    return;
  }

  const btnRemove = document.getElementById('btn-remove-all');
  const originalBtnText = btnRemove ? btnRemove.innerHTML : '';

  try {
    // Desabilitar todos os botoes durante o processo
    setAllButtonsDisabled(true);

    if (btnRemove) {
      btnRemove.innerHTML = `
        <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
        Removendo...
      `;
    }

    // Feedback: processo iniciado
    setResetFeedback({
      show: true,
      type: 'info',
      icon: '',
      title: 'Removendo MyZap local...',
      message: 'Parando servicos, removendo arquivos e limpando configuracoes. Aguarde...',
      details: null,
      showInstallAgain: false
    });

    // Esconder painel durante o processo
    setPanelVisible(false);

    // Chamar o reset no backend
    const result = await window.api.resetEnvironment({ removeTools: false });

    if (!result || result.status === 'error') {
      // Erro — reexibir painel
      setPanelVisible(true);

      setResetFeedback({
        show: true,
        type: 'error',
        icon: '',
        title: 'Erro ao remover MyZap',
        message: result?.message || 'Erro desconhecido durante a remocao.',
        details: result?.data?.warnings?.length ? 'Avisos: ' + result.data.warnings.join('; ') : null,
        showInstallAgain: false
      });

      if (btnRemove) {
        btnRemove.innerHTML = originalBtnText;
        btnRemove.disabled = false;
      }
      return;
    }

    // Sucesso ou warning
    const isWarning = result.status === 'warning';
    const dirResults = result.data?.directories || [];
    const removedDirs = dirResults.filter((d) => d.removed).map((d) => d.path);
    const skippedDirs = dirResults.filter((d) => d.skipped).map((d) => `${d.path} (${d.reason})`);

    let detailsText = '';
    if (removedDirs.length > 0) detailsText += `Diretorios removidos: ${removedDirs.join(', ')}. `;
    if (skippedDirs.length > 0) detailsText += `Diretorios ignorados: ${skippedDirs.join(', ')}. `;
    if (result.data?.warnings?.length) detailsText += `Avisos: ${result.data.warnings.join('; ')}`;

    setResetFeedback({
      show: true,
      type: isWarning ? 'warning' : 'success',
      icon: isWarning ? '' : '',
      title: isWarning ? 'Remocao concluida com avisos' : 'MyZap removido com sucesso!',
      message: result.message,
      details: detailsText.trim() || null,
      showInstallAgain: true
    });

    // Painel continua escondido — so mostra feedback + botao instalar novamente
    if (btnRemove) btnRemove.classList.add('d-none');
    setAllButtonsDisabled(true);

  } catch (err) {
    console.error('Erro ao remover MyZap:', err);

    // Reexibir painel em caso de erro
    setPanelVisible(true);

    setResetFeedback({
      show: true,
      type: 'error',
      icon: '',
      title: 'Erro inesperado',
      message: `Falha ao remover MyZap: ${err?.message || err}`,
      details: null,
      showInstallAgain: false
    });

    if (btnRemove) {
      btnRemove.innerHTML = originalBtnText;
      btnRemove.disabled = false;
    }
  }
}

async function instalarNovamente() {
  const btnAgain = document.getElementById('btn-install-again');
  if (!(await ensureAdminForLocalInstall('instalar o MyZap local'))) {
    if (btnAgain) {
      btnAgain.disabled = false;
      btnAgain.textContent = 'Instalar Novamente';
    }
    return;
  }

  if (btnAgain) {
    btnAgain.disabled = true;
    btnAgain.innerHTML = `
      <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
      Preparando instalacao...
    `;
  }

  try {
    // Limpar flag que impede auto-install
    await window.api.clearUserRemovedFlag();

    // Verificar TOKEN — gerar automaticamente se estiver vazio
    setResetFeedback({
      show: true,
      type: 'info',
      icon: '',
      title: 'Preparando instalacao...',
      message: 'Verificando configuracoes e TOKEN. Aguarde...',
      details: null,
      showInstallAgain: false
    });

    const envSecrets = await window.api.readEnvSecrets();
    const tokenAtual = (envSecrets?.TOKEN || '').trim();
    if (!tokenAtual) {
      // Gerar token aleatorio de 64 chars hex
      const arr = new Uint8Array(32);
      crypto.getRandomValues(arr);
      const novoToken = Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
      await window.api.saveEnvSecrets({
        TOKEN: novoToken,
        OPENAI_API_KEY: envSecrets?.OPENAI_API_KEY || '',
        EMAIL_TOKEN: envSecrets?.EMAIL_TOKEN || ''
      });
      setResetFeedback({
        show: true,
        type: 'info',
        icon: '',
        title: 'Token gerado automaticamente',
        message: `Novo TOKEN gerado e salvo nas configuracoes: ${novoToken.slice(0, 16)}...`,
        details: 'O TOKEN completo esta salvo em Configuracoes > TOKEN.',
        showInstallAgain: false
      });
      // Aguardar 1.5s para o usuario ver o token gerado
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Forcar refresh da config remota para repopular o store
    setResetFeedback({
      show: true,
      type: 'info',
      icon: '',
      title: 'Reinstalando MyZap...',
      message: 'Buscando configuracoes da API e preparando nova instalacao. Aguarde...',
      details: null,
      showInstallAgain: false
    });

    const autoConfig = await window.api.prepareMyZapAutoConfig(true);

    if (autoConfig?.status === 'error') {
      setResetFeedback({
        show: true,
        type: 'error',
        icon: '',
        title: 'Erro ao buscar configuracoes',
        message: `Nao foi possivel obter configuracoes da API: ${autoConfig?.message || 'erro desconhecido'}. Feche e reabra o painel para tentar novamente.`,
        details: null,
        showInstallAgain: true
      });
      if (btnAgain) {
        btnAgain.disabled = false;
        btnAgain.textContent = 'Instalar Novamente';
      }
      return;
    }

    // Atualizar feedback — agora executando instalacao
    setResetFeedback({
      show: true,
      type: 'info',
      icon: '',
      title: 'Instalando MyZap...',
      message: 'Clonando repositorio, instalando dependencias e iniciando servico. Isso pode levar alguns minutos...',
      details: null,
      showInstallAgain: false
    });

    // Tentar iniciar o processo completo (ensureStarted faz clone + install + start)
    const result = await window.api.ensureMyZapStarted(true);

    if (result?.status === 'success') {
      setResetFeedback({
        show: true,
        type: 'success',
        icon: '',
        title: 'MyZap instalado e iniciado!',
        message: result.message || 'O MyZap foi reinstalado com sucesso. Recarregando painel...',
        details: null,
        showInstallAgain: false
      });

      // Recarregar painel completo apos 2s
      setTimeout(() => {
        window.location.reload();
      }, 2000);
    } else {
      setResetFeedback({
        show: true,
        type: 'warning',
        icon: '',
        title: 'Instalacao com avisos',
        message: result?.message || 'A instalacao pode nao ter completado totalmente.',
        details: result?.message?.includes('TOKEN') || result?.message?.includes('required') || result?.message?.includes('codigo 1')
          ? 'Verifique se o TOKEN esta preenchido: va em Configuracoes > TOKEN e salve a chave do MyZap.'
          : 'Verifique os logs e tente novamente.',
        showInstallAgain: true
      });
      if (btnAgain) {
        btnAgain.disabled = false;
        btnAgain.textContent = 'Instalar Novamente';
      }
    }

  } catch (err) {
    console.error('Erro ao reinstalar MyZap:', err);
    setResetFeedback({
      show: true,
      type: 'error',
      icon: '',
      title: 'Erro ao reinstalar',
      message: `Falha: ${err?.message || err}. Feche e reabra o painel para tentar novamente.`,
      details: null,
      showInstallAgain: true
    });
    if (btnAgain) {
      btnAgain.disabled = false;
      btnAgain.textContent = 'Instalar Novamente';
    }
  }
}
