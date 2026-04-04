const Store = require('electron-store');
const { info, warn, error, debug } = require('../myzap/myzapLogger');
const {
  isCapabilityEnabled,
  getCapabilityEntry
} = require('../myzap/capabilities');
const { ensureBackendSession } = require('../myzap/backendAuth');

const store = new Store();
const MYZAP_API_URL = 'http://localhost:5555/';
const LOOP_INTERVAL_MS = 3000;
const FETCH_TIMEOUT_MS = 15000;
const PROCESSANDO_TIMEOUT_MS = 120000;
const MAX_ULTIMOS_ENVIOS = 50;

let ativo = false;
let processando = false;
let processandoDesde = 0;
let timer = null;
let ultimaExecucaoEm = null;
let ultimoErro = null;
let ultimoLote = 0;
let ultimosPendentes = [];
let ultimosEnvios = [];
let consecutiveSkips = 0;
const MAX_CONSECUTIVE_SKIPS = 10;
const SKIP_LOG_EVERY = 5;

function supportsQueuePolling() {
  return isCapabilityEnabled('supportsQueuePolling', store);
}

function cloneSerializable(value) {
  if (value === null || value === undefined) {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return value;
  }
}

function sanitizePhone(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  return digits || '';
}

function truncateText(value, maxLength = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function extractMyZapError(body, statusCode) {
  const fallback = statusCode ? `HTTP ${statusCode}` : 'Falha ao enviar para o MyZap';
  if (!body || typeof body !== 'object') {
    return fallback;
  }

  const candidates = [
    body.error,
    body.message,
    body.messages,
    body.reason,
    body.log?.message,
    body.data?.message,
    body.log
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (typeof candidate === 'string') {
      const normalized = candidate.trim();
      if (normalized) {
        return normalized;
      }
      continue;
    }

    try {
      const serialized = JSON.stringify(candidate);
      if (serialized && serialized !== '{}') {
        return serialized;
      }
    } catch (_error) {
      continue;
    }
  }

  return fallback;
}

function normalizeSendTextData(data) {
  const normalized = cloneSerializable(data) || {};
  if (!normalized.text && normalized.mensagem) {
    normalized.text = normalized.mensagem;
  }
  if (!normalized.text && normalized.message) {
    normalized.text = normalized.message;
  }
  return normalized;
}

function normalizeSendFile64Data(data) {
  const normalized = cloneSerializable(data) || {};

  if (!normalized.path && normalized.base64) {
    normalized.path = normalized.base64;
  }
  if (!normalized.path && normalized.file64) {
    normalized.path = normalized.file64;
  }
  if (!normalized.path && typeof normalized.data === 'string') {
    normalized.path = normalized.data;
  }
  if (!normalized.filename && normalized.name) {
    normalized.filename = normalized.name;
  }
  if (!normalized.mimetype && typeof normalized.path === 'string') {
    const mimeMatch = normalized.path.match(/^data:([^;,]+)[;,]/i);
    if (mimeMatch) {
      normalized.mimetype = mimeMatch[1];
    }
  }

  return normalized;
}

function normalizeSendMultipleFile64Data(data) {
  const normalized = cloneSerializable(data) || {};

  if (Array.isArray(normalized.files)) {
    normalized.files = normalized.files.map((file) => {
      if (!file || typeof file !== 'object') {
        return file;
      }

      const nextFile = { ...file };
      if (!nextFile.data && nextFile.base64) {
        nextFile.data = nextFile.base64;
      }
      if (!nextFile.filename && nextFile.name) {
        nextFile.filename = nextFile.name;
      }
      if (!nextFile.mimetype && typeof nextFile.data === 'string') {
        const mimeMatch = nextFile.data.match(/^data:([^;,]+)[;,]/i);
        if (mimeMatch) {
          nextFile.mimetype = mimeMatch[1];
        }
      }
      return nextFile;
    });
  }

  return normalized;
}

function normalizePayloadForMyZap(endpoint, data, sessionKey, sessionName) {
  let normalized = (data && typeof data === 'object' && !Array.isArray(data))
    ? (cloneSerializable(data) || {})
    : {};

  const resolvedSessionKey = String(normalized.sessionkey || sessionKey || '').trim();
  const resolvedSessionName = String(
    normalized.session
    || normalized.session_name
    || sessionName
    || resolvedSessionKey
    || ''
  ).trim();
  const number = sanitizePhone(
    normalized.number
    || normalized.numero
    || normalized.phone
    || normalized.telefone
    || normalized.celular
  );

  if (number) {
    normalized.number = number;
  }

  normalized.session = resolvedSessionName;
  normalized.sessionkey = resolvedSessionKey;
  normalized.session_name = resolvedSessionName;

  const normalizedEndpoint = String(endpoint || '').toLowerCase();
  if (normalizedEndpoint === 'sendtext') {
    normalized = normalizeSendTextData(normalized);
  }
  if (normalizedEndpoint === 'sendfile64') {
    normalized = normalizeSendFile64Data(normalized);
  }
  if (normalizedEndpoint === 'sendmultiplefile64') {
    normalized = normalizeSendMultipleFile64Data(normalized);
  }

  return normalized;
}

function buildPayloadSummary(endpoint, data) {
  const endpointLabel = String(endpoint || '').replace(/^\/+/, '').trim() || '-';
  const endpointNormalized = endpointLabel.toLowerCase();
  const number = sanitizePhone(
    data?.number
    || data?.numero
    || data?.phone
    || data?.telefone
    || data?.celular
  ) || '-';

  let resumo = '';

  if (endpointNormalized === 'sendtext') {
    resumo = data?.text || data?.mensagem || data?.message || '';
  } else if (endpointNormalized === 'sendfile64' || endpointNormalized === 'sendfile' || endpointNormalized === 'sendimage' || endpointNormalized === 'sendvideo') {
    const filename = String(data?.filename || data?.name || '').trim();
    const caption = String(data?.caption || data?.text || '').trim();
    resumo = [filename, caption].filter(Boolean).join(' - ');
    if (!resumo) {
      resumo = endpointNormalized === 'sendfile64' ? 'Arquivo em base64' : 'Arquivo/midia';
    }
  } else if (endpointNormalized === 'sendmultiplefile64' || endpointNormalized === 'sendmultiplefiles') {
    const totalFiles = Array.isArray(data?.files) ? data.files.length : 0;
    resumo = totalFiles > 0 ? `${totalFiles} arquivo(s)` : 'Multiplos arquivos';
  } else {
    resumo = data?.caption || data?.text || data?.message || data?.filename || data?.name || '';
  }

  if (!resumo) {
    resumo = `Endpoint ${endpointLabel}`;
  }

  return {
    endpoint: endpointLabel,
    numero: number,
    resumo: truncateText(resumo, 160) || '-'
  };
}

function summarizeQueueMessage(mensagem) {
  let payload = {};

  try {
    payload = mensagem?.json ? JSON.parse(mensagem.json) : {};
  } catch (_error) {
    return {
      endpoint: '-',
      numero: '-',
      resumo: 'JSON invalido',
      data: {}
    };
  }

  const endpoint = String(payload?.endpoint || '').replace(/^\/+/, '').trim();
  const data = (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data))
    ? payload.data
    : {};

  return {
    ...buildPayloadSummary(endpoint, data),
    data
  };
}

function registerRecentSend(entry) {
  const normalizedEntry = {
    idfila: entry?.idfila ?? '-',
    endpoint: String(entry?.endpoint || '-').trim() || '-',
    numero: String(entry?.numero || '-').trim() || '-',
    resumo: truncateText(entry?.resumo || '-', 180) || '-',
    status: String(entry?.status || '-').trim() || '-',
    erro: truncateText(entry?.erro || '', 220),
    processadoEm: entry?.processadoEm || new Date().toISOString(),
    datahorainclusao: entry?.datahorainclusao || null,
    httpStatus: entry?.httpStatus || null
  };

  ultimosEnvios = [normalizedEntry, ...ultimosEnvios].slice(0, MAX_ULTIMOS_ENVIOS);
}

function buildRecentSendEntry(mensagem, envio, status, erro = '') {
  const baseSummary = summarizeQueueMessage(mensagem);
  const requestSummary = envio?.requestBody
    ? buildPayloadSummary(envio.endpoint || baseSummary.endpoint, envio.requestBody)
    : baseSummary;

  return {
    idfila: mensagem?.idfila ?? '-',
    endpoint: requestSummary.endpoint || baseSummary.endpoint || '-',
    numero: requestSummary.numero || baseSummary.numero || '-',
    resumo: requestSummary.resumo || baseSummary.resumo || '-',
    status,
    erro,
    processadoEm: new Date().toISOString(),
    datahorainclusao: mensagem?.datahorainclusao || null,
    httpStatus: envio?.httpStatus || null
  };
}

async function validarDisponibilidadeMyZap(sessionKey, sessionName, sessionToken) {
  try {
    debug('[FilaMyZap] Validando disponibilidade do MyZap (/verifyRealStatus)...', {
      metadata: { sessionKey }
    });

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(`${MYZAP_API_URL}verifyRealStatus`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apitoken: sessionToken,
        sessionkey: sessionKey
      },
      body: JSON.stringify({
        session: sessionName || sessionKey,
        sessionkey: sessionKey,
        session_name: sessionName || sessionKey
      }),
      signal: ctrl.signal
    });

    clearTimeout(timeout);

    const data = await res.json().catch(() => ({}));
    debug('[FilaMyZap] Retorno verifyRealStatus', { metadata: { status: res.status, data } });
    return res.ok;
  } catch (err) {
    warn('[FilaMyZap] Erro ao validar disponibilidade do MyZap', {
      metadata: { error: err?.message || err }
    });
    return false;
  }
}

async function buscarPendentes(apiBaseUrl, authorization, sessionKey) {
  const params = new URLSearchParams({
    sessionKey: sessionKey || ''
  });

  const query = params.toString();

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  debug('[FilaMyZap] Buscando pendentes', {
    metadata: {
      apiBaseUrl,
      sessionKey,
      query
    }
  });
  const res = await fetch(`${apiBaseUrl}parametrizacao-myzap/pendentes?${query}`, {
    method: 'GET',
    headers: { Authorization: authorization },
    signal: ctrl.signal
  });

  clearTimeout(timeout);

  const data = await res.json().catch(() => ({}));
  debug('[FilaMyZap] Retorno /parametrizacao-myzap/pendentes', {
    metadata: {
      status: res.status,
      total: data?.result?.total,
      error: data?.error
    }
  });
  if (!res.ok || data?.error) {
    throw new Error(data?.error || 'Falha ao consultar pendentes');
  }

  return Array.isArray(data?.result?.mensagens) ? data.result.mensagens : [];
}

async function atualizarStatusFila(apiBaseUrl, authorization, payload) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  debug('[FilaMyZap] Atualizando status da fila', { metadata: payload });
  const res = await fetch(`${apiBaseUrl}parametrizacao-myzap/fila/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authorization
    },
    body: JSON.stringify(payload),
    signal: ctrl.signal
  });

  clearTimeout(timeout);

  const data = await res.json().catch(() => ({}));
  debug('[FilaMyZap] Retorno /parametrizacao-myzap/fila/status', {
    metadata: { status: res.status, data }
  });
  return res.ok && !data?.error;
}

async function enviarParaMyZap(mensagem, fallbackSessionKey, fallbackSessionName, fallbackApiToken) {
  if (String(mensagem?.status || '').toLowerCase() === 'enviado') {
    return { ok: true, skipped: true, motivo: 'status_enviado' };
  }

  let payloadFila = {};
  try {
    payloadFila = mensagem?.json ? JSON.parse(mensagem.json) : {};
  } catch (e) {
    return { ok: false, erro: `JSON invalido da fila: ${e.message}` };
  }

  const endpoint = payloadFila?.endpoint;
  const data = payloadFila?.data;

  if (!endpoint || !data) {
    return { ok: false, erro: 'Mensagem sem endpoint ou payload para MyZap' };
  }

  const endpointNormalizado = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const sessionKey = mensagem?.sessionkey || fallbackSessionKey;
  const sessionName = mensagem?.sessionname || mensagem?.session_name || fallbackSessionName || sessionKey;
  const apiToken = mensagem?.apitoken || fallbackApiToken;
  const requestBody = normalizePayloadForMyZap(endpointNormalizado, data, sessionKey, sessionName);

  if (!sessionKey || !apiToken) {
    return {
      ok: false,
      endpoint: endpointNormalizado,
      requestBody,
      erro: 'SessionKey ou APIToken do MyZap ausente'
    };
  }

  debug('[FilaMyZap] Enviando para MyZap', {
    metadata: {
      idfila: mensagem?.idfila,
      endpoint: endpointNormalizado,
      sessionKey
    }
  });

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  const res = await fetch(`${MYZAP_API_URL}${endpointNormalizado}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apitoken: apiToken,
      sessionkey: sessionKey
    },
    body: JSON.stringify(requestBody),
    signal: ctrl.signal
  });

  clearTimeout(timeout);

  const body = await res.json().catch(() => ({}));
  debug('[FilaMyZap] Retorno MyZap', {
    metadata: {
      idfila: mensagem?.idfila,
      status: res.status,
      body
    }
  });
  if (!res.ok || body?.error || String(body?.status || '').toUpperCase() === 'FAIL') {
    return {
      ok: false,
      endpoint: endpointNormalizado,
      requestBody,
      httpStatus: res.status,
      body,
      erro: extractMyZapError(body, res.status)
    };
  }

  if (endpointNormalizado.toLowerCase() === 'sendtext' && body?.result !== 200) {
    return {
      ok: false,
      endpoint: endpointNormalizado,
      requestBody,
      httpStatus: res.status,
      body,
      erro: 'Retorno do sendText diferente de 200'
    };
  }

  return {
    ok: true,
    endpoint: endpointNormalizado,
    requestBody,
    httpStatus: res.status,
    body
  };
}

async function obterCredenciaisAtivas() {
  const backendSession = await ensureBackendSession({ storeLike: store });
  const sessionKey = String(store.get('myzap_sessionKey') || '').trim();
  const sessionName = String(store.get('myzap_sessionName') || sessionKey).trim();
  const myzapApiToken = String(store.get('myzap_apiToken') || '').trim();
  const idfilial = String(backendSession?.idfilial || store.get('idfilial') || store.get('idempresa') || '').trim();

  return {
    backendApiUrl: String(backendSession?.apiUrl || '').trim(),
    backendAuthorization: String(backendSession?.authorization || '').trim(),
    sessionKey,
    sessionName,
    myzapApiToken,
    idfilial
  };
}

async function listarPendentesMyZap() {
  const config = await obterCredenciaisAtivas();
  const {
    backendApiUrl,
    backendAuthorization,
    sessionKey
  } = config;

  if (!backendApiUrl || !backendAuthorization || !sessionKey) {
    return [];
  }

  return buscarPendentes(backendApiUrl, backendAuthorization, sessionKey);
}

async function processarFilaUmaRodada() {
  if (!ativo) return;

  if (!supportsQueuePolling()) {
    info('[FilaMyZap] Watcher interrompido porque a capability foi desabilitada', {
      metadata: { area: 'whatsappQueueWatcher' }
    });
    stopWhatsappQueueWatcher();
    return;
  }

  // Protecao contra processamento travado (timeout de seguranca)
  if (processando) {
    const elapsed = Date.now() - processandoDesde;
    if (elapsed > PROCESSANDO_TIMEOUT_MS) {
      warn('[FilaMyZap] Processamento anterior travado, resetando flag processando', {
        metadata: { area: 'whatsappQueueWatcher', elapsedMs: elapsed }
      });
      processando = false;
    } else {
      return;
    }
  }

  processando = true;
  processandoDesde = Date.now();

  info('[FilaMyZap] Iniciando ciclo de processamento da fila', {
    metadata: { area: 'whatsappQueueWatcher' }
  });

  try {
    // Validar MyZap disponivel antes de buscar pendentes
    const configAtual = await obterCredenciaisAtivas();
    if (!configAtual.sessionKey || !configAtual.myzapApiToken) {
      consecutiveSkips++;
      if (consecutiveSkips % SKIP_LOG_EVERY === 1) {
        warn(`[FilaMyZap] Credenciais ausentes (skip #${consecutiveSkips})`, {
          metadata: { consecutiveSkips }
        });
      }
      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        warn(`[FilaMyZap] Auto-stop: ${MAX_CONSECUTIVE_SKIPS} skips consecutivos`, {
          metadata: { area: 'whatsappQueueWatcher' }
        });
        stopWhatsappQueueWatcher();
      }
      return;
    }

    const myzapOk = await validarDisponibilidadeMyZap(
      configAtual.sessionKey,
      configAtual.sessionName,
      configAtual.myzapApiToken
    );
    if (!myzapOk) {
      consecutiveSkips++;
      if (consecutiveSkips % SKIP_LOG_EVERY === 1) {
        warn(`[FilaMyZap] MyZap indisponivel (skip #${consecutiveSkips})`, {
          metadata: { consecutiveSkips }
        });
      }
      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        warn(`[FilaMyZap] Auto-stop: ${MAX_CONSECUTIVE_SKIPS} skips consecutivos (MyZap down)`, {
          metadata: { area: 'whatsappQueueWatcher' }
        });
        stopWhatsappQueueWatcher();
      }
      return;
    }

    // MyZap ok, reset skip counter
    consecutiveSkips = 0;

    const pendentes = await listarPendentesMyZap();
    ultimosPendentes = Array.isArray(pendentes) ? pendentes : [];
    const lote = pendentes.filter((m) => String(m?.status || '').toLowerCase() !== 'enviado');

    ultimoLote = lote.length;
    ultimaExecucaoEm = new Date().toISOString();

    info('[FilaMyZap] Busca de pendentes concluida', {
      metadata: { totalPendentes: pendentes.length, tamanhoLote: lote.length }
    });

    if (lote.length === 0) {
      info('[FilaMyZap] Nenhuma mensagem pendente para envio neste ciclo', {
        metadata: { area: 'whatsappQueueWatcher' }
      });
    }

    const {
      backendApiUrl,
      backendAuthorization,
      sessionKey,
      sessionName,
      myzapApiToken,
      idfilial
    } = await obterCredenciaisAtivas();

    for (const mensagem of lote) {
      if (!ativo) break;

      let novoStatus = 'erro';
      const filaIdfilial = String(mensagem?.idfilial || mensagem?.idempresa || idfilial || '').trim();
      try {
        info('[FilaMyZap] Enviando mensagem', {
          metadata: { idfila: mensagem?.idfila, idfilial: filaIdfilial || null }
        });

        const envio = await enviarParaMyZap(mensagem, sessionKey, sessionName, myzapApiToken);
        novoStatus = envio.ok ? 'enviado' : 'erro';
        registerRecentSend(buildRecentSendEntry(
          mensagem,
          envio,
          novoStatus,
          envio.ok ? '' : (envio?.erro || envio?.motivo || '')
        ));

        if (envio.ok) {
          info('[FilaMyZap] Mensagem enviada com sucesso', {
            metadata: { idfila: mensagem?.idfila, idfilial: filaIdfilial || null }
          });
        } else {
          warn('[FilaMyZap] Falha ao enviar mensagem para MyZap', {
            metadata: {
              idfila: mensagem?.idfila,
              idfilial: filaIdfilial || null,
              motivo: envio?.erro || envio?.motivo
            }
          });
        }
      } catch (envioError) {
        registerRecentSend(buildRecentSendEntry(
          mensagem,
          null,
          'erro',
          envioError?.message || String(envioError)
        ));
        warn('Erro inesperado no envio para MyZap', {
          metadata: {
            idfila: mensagem?.idfila,
            idfilial: filaIdfilial || null,
            error: envioError
          }
        });
      }

      const statusOk = await atualizarStatusFila(backendApiUrl, backendAuthorization, {
        idfila: mensagem?.idfila,
        idfilial: filaIdfilial,
        status: novoStatus
      });

      if (!statusOk) {
        warn('Nao foi possivel atualizar status da fila MyZap', {
          metadata: {
            idfila: mensagem?.idfila,
            idfilial: filaIdfilial || null,
            status: novoStatus
          }
        });
      }
    }

    info('[FilaMyZap] Ciclo de processamento concluido', {
      metadata: { area: 'whatsappQueueWatcher', loteProcessado: lote.length }
    });

    ultimoErro = null;
  } catch (e) {
    ultimoErro = e?.message || String(e);
    error('Erro no watcher da fila MyZap', {
      metadata: { area: 'whatsappQueueWatcher', error: e }
    });
  } finally {
    processando = false;
  }
}

async function startWhatsappQueueWatcher() {
  if (ativo) {
    return { status: 'success', message: 'Watcher da fila MyZap ja esta em execucao.' };
  }

  if (!supportsQueuePolling()) {
    info('[FilaMyZap] Watcher ignorado por capability desabilitada', {
      metadata: {
        area: 'whatsappQueueWatcher',
        capability: getCapabilityEntry('supportsQueuePolling', store)
      }
    });
    return {
      status: 'skipped',
      message: 'Watcher da fila ignorado: recurso nao suportado ou desabilitado.'
    };
  }

  const config = await obterCredenciaisAtivas();
  if (!config.backendApiUrl || !config.backendAuthorization || !config.sessionKey || !config.myzapApiToken) {
    warn('[FilaMyZap] Configuracao incompleta para iniciar watcher', {
      metadata: {
        backendApiUrl: !!config.backendApiUrl,
        backendAuthorization: !!config.backendAuthorization,
        sessionKey: !!config.sessionKey,
        sessionName: !!config.sessionName,
        myzapApiToken: !!config.myzapApiToken
      }
    });
    return { status: 'error', message: 'Configuracao do backend/MyZap incompleta.' };
  }

  const myzapDisponivel = await validarDisponibilidadeMyZap(
    config.sessionKey,
    config.sessionName,
    config.myzapApiToken
  );
  if (!myzapDisponivel) {
    return {
      status: 'error',
      message: 'MyZap indisponivel. Verifique se a sessao esta ativa antes de iniciar a fila.'
    };
  }

  ativo = true;
  ultimoErro = null;

  info('Iniciando watcher da fila MyZap', {
    metadata: { area: 'whatsappQueueWatcher', loopMs: LOOP_INTERVAL_MS }
  });

  timer = setInterval(() => {
    debug('[FilaMyZap] Tick de processamento da fila');
    processarFilaUmaRodada().catch((err) => {
      error('Erro inesperado no loop da fila MyZap', {
        metadata: { area: 'whatsappQueueWatcher', error: err }
      });
    });
  }, LOOP_INTERVAL_MS);

  await processarFilaUmaRodada();
  return { status: 'success', message: 'Watcher da fila MyZap iniciado com sucesso.' };
}

function stopWhatsappQueueWatcher() {
  if (!ativo && !timer) {
    return { status: 'success', message: 'Watcher da fila MyZap ja estava parado.' };
  }

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  ativo = false;
  processando = false;

  info('Watcher da fila MyZap parado', {
    metadata: { area: 'whatsappQueueWatcher' }
  });

  return { status: 'success', message: 'Watcher da fila MyZap parado com sucesso.' };
}

function getWhatsappQueueWatcherStatus() {
  const proximaExecucaoEm = ultimaExecucaoEm
    ? new Date(new Date(ultimaExecucaoEm).getTime() + LOOP_INTERVAL_MS).toISOString()
    : null;

  return {
    ativo,
    capabilityEnabled: supportsQueuePolling(),
    processando,
    ultimoLote,
    ultimaExecucaoEm,
    proximaExecucaoEm,
    loopIntervalMs: LOOP_INTERVAL_MS,
    ultimoErro
  };
}

function getUltimosPendentesMyZap() {
  return Array.isArray(ultimosPendentes) ? [...ultimosPendentes] : [];
}

function getUltimosEnviosMyZap() {
  return Array.isArray(ultimosEnvios) ? [...ultimosEnvios] : [];
}

module.exports = {
  listarPendentesMyZap,
  getUltimosEnviosMyZap,
  getUltimosPendentesMyZap,
  startWhatsappQueueWatcher,
  stopWhatsappQueueWatcher,
  getWhatsappQueueWatcherStatus,
  processarFilaUmaRodada
};
