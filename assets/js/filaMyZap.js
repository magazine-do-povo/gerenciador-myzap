const LOOP_INTERVAL_FALLBACK_MS = 3000;

let nextRunAt = null;
let pollingHandle = null;
let countdownHandle = null;

function formatDateTime(value) {
  if (!value) return '-';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  return dt.toLocaleString('pt-BR');
}

function showInlineError(message) {
  const alertBox = document.getElementById('queue-error-alert');
  if (!alertBox) return;

  if (!message) {
    alertBox.classList.add('d-none');
    alertBox.textContent = '';
    return;
  }

  alertBox.textContent = String(message);
  alertBox.classList.remove('d-none');
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  return digits || '-';
}

function truncateText(value, maxLength = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildPayloadSummary(endpoint, data) {
  const endpointLabel = String(endpoint || '').replace(/^\/+/, '').trim() || '-';
  const endpointNormalized = endpointLabel.toLowerCase();
  const numero = normalizePhone(
    data?.number
    || data?.numero
    || data?.phone
    || data?.telefone
    || data?.celular
  );

  let texto = '';

  if (endpointNormalized === 'sendtext') {
    texto = data?.text || data?.mensagem || data?.message || '';
  } else if (endpointNormalized === 'sendfile64' || endpointNormalized === 'sendfile' || endpointNormalized === 'sendimage' || endpointNormalized === 'sendvideo') {
    const filename = String(data?.filename || data?.name || '').trim();
    const caption = String(data?.caption || data?.text || '').trim();
    texto = [filename, caption].filter(Boolean).join(' - ');
    if (!texto) {
      texto = endpointNormalized === 'sendfile64' ? 'Arquivo em base64' : 'Arquivo/midia';
    }
  } else if (endpointNormalized === 'sendmultiplefile64' || endpointNormalized === 'sendmultiplefiles') {
    const totalFiles = Array.isArray(data?.files) ? data.files.length : 0;
    texto = totalFiles > 0 ? `${totalFiles} arquivo(s)` : 'Multiplos arquivos';
  } else {
    texto = data?.caption || data?.text || data?.message || data?.filename || data?.name || '';
  }

  if (!texto) {
    texto = `Endpoint ${endpointLabel}`;
  }

  return {
    endpoint: endpointLabel,
    numero,
    texto: truncateText(texto, 160) || '-'
  };
}

function extrairResumoMensagem(jsonStr) {
  try {
    const payload = jsonStr ? JSON.parse(jsonStr) : {};
    return buildPayloadSummary(payload?.endpoint, payload?.data || {});
  } catch (_e) {
    return { endpoint: '-', numero: '-', texto: 'JSON invalido' };
  }
}

function renderFilaPendentes(mensagens) {
  const tbody = document.getElementById('queue-pendentes-body');
  const total = document.getElementById('queue-total-pendentes');
  if (!tbody || !total) return;

  total.textContent = String(mensagens.length);

  if (!mensagens.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center text-muted-small">Nenhuma mensagem pendente.</td>
      </tr>
    `;
    return;
  }

  const linhas = mensagens.map((m) => {
    const { numero, texto, endpoint } = extrairResumoMensagem(m?.json);
    return `
      <tr>
        <td>${m?.idfila ?? '-'}</td>
        <td>${numero}</td>
        <td class="queue-message-cell">
          <div class="queue-endpoint-tag">${escapeHtml(endpoint)}</div>
          <div>${escapeHtml(texto)}</div>
        </td>
        <td>${m?.status ?? '-'}</td>
        <td>${m?.datahorainclusao ?? '-'}</td>
      </tr>
    `;
  }).join('');

  tbody.innerHTML = linhas;
}

function setButtonsState({ ativo, processando }) {
  const btnStart = document.getElementById('btn-start-queue');
  const btnStop = document.getElementById('btn-stop-queue');

  if (btnStart) {
    btnStart.disabled = Boolean(ativo || processando);
  }

  if (btnStop) {
    btnStop.disabled = !Boolean(ativo || processando);
  }
}

function renderCountdown() {
  const countdown = document.getElementById('queue-next-run-countdown');
  if (!countdown) return;

  if (!nextRunAt) {
    countdown.textContent = '-';
    return;
  }

  const remainingMs = nextRunAt - Date.now();
  if (remainingMs <= 0) {
    countdown.textContent = 'agora';
    return;
  }

  const totalSec = Math.ceil(remainingMs / 1000);
  if (totalSec < 60) {
    countdown.textContent = `${totalSec}s`;
  } else {
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    countdown.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
}

async function atualizarStatusProcessoFila() {
  const badge = document.getElementById('queue-process-status');
  const lastRun = document.getElementById('queue-last-run');
  const lastBatch = document.getElementById('queue-last-batch');
  if (!badge || !lastRun || !lastBatch) return;

  try {
    const status = await window.api.getQueueWatcherStatus();
    const ativo = !!status?.ativo;
    const processando = !!status?.processando;

    badge.textContent = processando ? 'Processando' : (ativo ? 'Ativo' : 'Parado');
    badge.classList.remove('bg-secondary', 'bg-success', 'bg-warning', 'bg-danger');
    badge.classList.add(processando ? 'bg-warning' : (ativo ? 'bg-success' : 'bg-secondary'));

    lastRun.textContent = formatDateTime(status?.ultimaExecucaoEm);
    lastBatch.textContent = String(status?.ultimoLote ?? 0);

    setButtonsState({ ativo, processando });

    const loopIntervalMs = Number(status?.loopIntervalMs) || LOOP_INTERVAL_FALLBACK_MS;
    const nextRunFromApi = status?.proximaExecucaoEm ? new Date(status.proximaExecucaoEm).getTime() : null;
    if (ativo && nextRunFromApi && Number.isFinite(nextRunFromApi)) {
      nextRunAt = nextRunFromApi;
    } else if (ativo && status?.ultimaExecucaoEm) {
      const lastRunTs = new Date(status.ultimaExecucaoEm).getTime();
      nextRunAt = Number.isFinite(lastRunTs) ? (lastRunTs + loopIntervalMs) : null;
    } else {
      nextRunAt = null;
    }

    showInlineError(status?.ultimoErro || '');
  } catch (e) {
    badge.textContent = 'Erro';
    badge.classList.remove('bg-secondary', 'bg-success', 'bg-warning');
    badge.classList.add('bg-danger');
    setButtonsState({ ativo: false, processando: false });
    nextRunAt = null;
    showInlineError(`Falha ao obter status da fila: ${e?.message || e}`);
  }

  renderCountdown();
}

async function atualizarFilaMyZap() {
  try {
    const pendentes = await window.api.getQueuePendentes();
    renderFilaPendentes(Array.isArray(pendentes) ? pendentes : []);
  } catch (e) {
    renderFilaPendentes([]);
    showInlineError(`Falha ao carregar pendentes: ${e?.message || e}`);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getStatusChip(status) {
  const normalized = String(status || '').toLowerCase();

  if (normalized === 'enviado') {
    return '<span class="queue-status-chip success">Enviado</span>';
  }
  if (normalized === 'erro') {
    return '<span class="queue-status-chip error">Erro</span>';
  }
  if (normalized === 'pendente') {
    return '<span class="queue-status-chip pending">Pendente</span>';
  }

  return `<span class="queue-status-chip neutral">${escapeHtml(status || '-')}</span>`;
}

function renderHistoricoEnvios(envios) {
  const tbody = document.getElementById('queue-history-body');
  const total = document.getElementById('queue-total-history');
  if (!tbody || !total) return;

  total.textContent = String(envios.length);

  if (!envios.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center text-muted-small">Nenhuma mensagem processada ainda.</td>
      </tr>
    `;
    return;
  }

  const linhas = envios.map((entry) => {
    const detalhe = entry?.erro
      ? `<div class="queue-history-detail error">${escapeHtml(entry.erro)}</div>`
      : '';
    const inclusoEm = entry?.datahorainclusao
      ? `<div class="queue-history-detail">Incluida em ${escapeHtml(formatDateTime(entry.datahorainclusao))}</div>`
      : '';

    return `
      <tr>
        <td>${escapeHtml(formatDateTime(entry?.processadoEm))}</td>
        <td>${entry?.idfila ?? '-'}</td>
        <td>${escapeHtml(entry?.numero || '-')}</td>
        <td class="queue-message-cell">
          <div class="queue-endpoint-tag">${escapeHtml(entry?.endpoint || '-')}</div>
          <div>${escapeHtml(entry?.resumo || '-')}</div>
          ${inclusoEm}
          ${detalhe}
        </td>
        <td>${getStatusChip(entry?.status)}</td>
      </tr>
    `;
  }).join('');

  tbody.innerHTML = linhas;
}

async function atualizarHistoricoFila() {
  try {
    const envios = await window.api.getQueueRecentMessages();
    renderHistoricoEnvios(Array.isArray(envios) ? envios : []);
  } catch (e) {
    renderHistoricoEnvios([]);
    showInlineError(`Falha ao carregar historico da fila: ${e?.message || e}`);
  }
}

async function iniciarFilaMyZap() {
  const btn = document.getElementById('btn-start-queue');
  if (!btn) return;

  btn.disabled = true;
  const txt = btn.textContent;
  btn.textContent = 'Iniciando...';

  try {
    const result = await window.api.startQueueWatcher();
    if (result?.status !== 'success') {
      throw new Error(result?.message || 'Falha ao iniciar a fila');
    }

    showInlineError('');
    await refreshAll();
  } catch (e) {
    showInlineError(`Erro ao iniciar processo da fila: ${e?.message || e}`);
  } finally {
    btn.textContent = txt;
    await refreshAll();
  }
}

async function pararFilaMyZap() {
  const btn = document.getElementById('btn-stop-queue');
  if (!btn) return;

  btn.disabled = true;
  const txt = btn.textContent;
  btn.textContent = 'Parando...';

  try {
    const result = await window.api.stopQueueWatcher();
    if (result?.status !== 'success') {
      throw new Error(result?.message || 'Falha ao parar a fila');
    }

    showInlineError('');
    await refreshAll();
  } catch (e) {
    showInlineError(`Erro ao parar processo da fila: ${e?.message || e}`);
  } finally {
    btn.textContent = txt;
    await refreshAll();
  }
}

async function refreshAll() {
  await Promise.all([
    atualizarStatusProcessoFila(),
    atualizarFilaMyZap(),
    atualizarHistoricoFila()
  ]);
}

// ── Buscar Agora ─────────────────────────────────────────

async function forcarBuscaAgora() {
  const btn = document.getElementById('btn-force-cycle');
  if (!btn) return;

  btn.disabled = true;
  const txt = btn.textContent;
  btn.textContent = 'Buscando...';

  try {
    const result = await window.api.forceQueueCycle();
    if (result?.status !== 'success') {
      throw new Error(result?.message || 'Falha ao executar busca manual');
    }
    showInlineError('');
    await refreshAll();
  } catch (e) {
    showInlineError(`Erro ao buscar agora: ${e?.message || e}`);
  } finally {
    btn.textContent = txt;
    btn.disabled = false;
  }
}

(async () => {
  const btnStart = document.getElementById('btn-start-queue');
  const btnStop = document.getElementById('btn-stop-queue');
  const btnForce = document.getElementById('btn-force-cycle');

  if (btnStart) {
    btnStart.addEventListener('click', iniciarFilaMyZap);
  }

  if (btnStop) {
    btnStop.addEventListener('click', pararFilaMyZap);
  }

  if (btnForce) {
    btnForce.addEventListener('click', forcarBuscaAgora);
  }

  await refreshAll();

  pollingHandle = setInterval(refreshAll, 3000);
  countdownHandle = setInterval(renderCountdown, 1000);

  window.addEventListener('beforeunload', () => {
    if (pollingHandle) clearInterval(pollingHandle);
    if (countdownHandle) clearInterval(countdownHandle);
  });
})();
