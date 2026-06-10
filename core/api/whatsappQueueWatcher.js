const Store = require('electron-store');
const { info, warn, error, debug } = require('../myzap/myzapLogger').forArea('watcher');
// Canal 'backend' dedicado (myzap-backend) para as chamadas ao Hub
// (buscarPendentes / atualizarStatusFila), separando-as dos logs do MyZap local.
const backendLog = require('../myzap/myzapLogger').forArea('backend');
const {
  isCapabilityEnabled,
  getCapabilityEntry
} = require('../myzap/capabilities');
const { ensureBackendSession } = require('../myzap/backendAuth');

const store = new Store();
// 127.0.0.1 (e nao localhost, que pode resolver ::1 no Windows e dar timeout)
const MYZAP_API_URL = 'http://127.0.0.1:5555/';
const LOOP_INTERVAL_MS = 3000;
const FETCH_TIMEOUT_MS = 15000;
const PROCESSANDO_TIMEOUT_MS = 120000;
const MAX_ULTIMOS_ENVIOS = 50;

// Limite de caracteres da resposta crua do MyZap enviada ao backend / logada.
const MAX_RESPOSTA_MYZAP_CHARS = 2000;

// Reconexao: backoff exponencial (com teto) enquanto o MyZap estiver indisponivel.
// Nao confundir com humanizacao/ritmo de envio: o ritmo entre mensagens e
// controlado server-side pelo Hub (liberar_apos); este backoff so espaca as
// TENTATIVAS de reconexao quando o MyZap nao responde.
const BACKOFF_BASE_MS = LOOP_INTERVAL_MS;
const BACKOFF_MAX_MS = 30000;

// Proxima rodada efetiva so volta a acontecer apos esse timestamp (backoff).
let backoffAteEm = 0;

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

// 'aguardando_myzap' | 'aguardando_credenciais' | null — pausa RECUPERAVEL
// (substitui o antigo auto-stop definitivo: a fila nunca mais morre sozinha)
let motivoPausa = null;
let notifyCallback = null;
let ultimoToastPausaAt = 0;
const PAUSA_TOAST_COOLDOWN_MS = 10 * 60 * 1000;

function setQueueNotifier(fn) {
  notifyCallback = (typeof fn === 'function') ? fn : null;
}

function notificarFila(mensagem, { comCooldown = false } = {}) {
  if (!notifyCallback) return;
  if (comCooldown) {
    const agora = Date.now();
    if (agora - ultimoToastPausaAt < PAUSA_TOAST_COOLDOWN_MS) return;
    ultimoToastPausaAt = agora;
  }
  try { notifyCallback(mensagem); } catch (_e) { /* melhor esforco */ }
}

function entrarEmPausa(motivo, mensagem) {
  if (motivoPausa === motivo) return;
  motivoPausa = motivo;
  warn(`[FilaMyZap] Fila pausada (${motivo}) — retoma sozinha quando resolver`, {
    metadata: { categoria: 'conexao', motivo, consecutiveSkips }
  });
  notificarFila(mensagem, { comCooldown: true });
}

function sairDaPausa() {
  if (!motivoPausa) return;
  motivoPausa = null;
  info('[FilaMyZap] Fila retomada automaticamente', { metadata: { categoria: 'conexao' } });
  notificarFila('Fila de mensagens retomada: MyZap respondendo novamente.');
}
const SKIP_LOG_EVERY = 5;

/**
 * Aplica backoff exponencial simples (com teto) para a proxima rodada efetiva,
 * com base na quantidade de skips consecutivos. O loop continua rodando a cada
 * 3s, mas o ciclo so volta a processar/checar apos a janela de backoff expirar
 * (recuperacao com latencia de ate BACKOFF_MAX_MS). Reusa consecutiveSkips do
 * auto-stop existente — sem contador paralelo.
 */
function aplicarBackoff() {
  const fator = Math.min(consecutiveSkips, 6); // limita o expoente
  const atraso = Math.min(BACKOFF_BASE_MS * Math.pow(2, fator), BACKOFF_MAX_MS);
  backoffAteEm = Date.now() + atraso;
  return atraso;
}

/** Limpa o backoff quando o MyZap volta a responder. */
function limparBackoff() {
  backoffAteEm = 0;
}

// Contador acumulado de falhas de envio recentes (para tooltip da tray/status).
let recentErrorCount = 0;
// Callback opcional (registrado pelo main) para notificar o operador em falha.
// Recebe ({ idfila, motivo, erro, total }). Disparado no maximo 1x por rodada.
let queueErrorNotifier = null;
// Callback opcional para refletir o contador de erros na tray (tooltip).
let trayErrorCountSetter = null;

function supportsQueuePolling() {
  return isCapabilityEnabled('supportsQueuePolling', store);
}

/** Registra o notificador de falha de envio (toast/Notification do main). */
function setQueueErrorNotifier(fn) {
  queueErrorNotifier = typeof fn === 'function' ? fn : null;
}

/** Registra o setter do contador de erros na tray (tooltip). */
function setTrayErrorCountSetter(fn) {
  trayErrorCountSetter = typeof fn === 'function' ? fn : null;
}

/** Atualiza a tray com o total de erros recentes (best-effort). */
function atualizarTrayErros() {
  if (trayErrorCountSetter) {
    try {
      trayErrorCountSetter(recentErrorCount);
    } catch (_error) {
      /* tray indisponivel: ignora */
    }
  }
}

/** Trunca a resposta crua do MyZap (objeto ou string) para ~2000 chars. */
function truncarResposta(resposta) {
  if (resposta === undefined || resposta === null) {
    return '';
  }
  let texto;
  if (typeof resposta === 'string') {
    texto = resposta;
  } else {
    try {
      texto = JSON.stringify(resposta);
    } catch (_error) {
      texto = String(resposta);
    }
  }
  if (texto.length > MAX_RESPOSTA_MYZAP_CHARS) {
    return `${texto.slice(0, MAX_RESPOSTA_MYZAP_CHARS)}...[truncado]`;
  }
  return texto;
}

/**
 * Heuristica: detecta na resposta do MyZap indicacao de numero invalido
 * (ex.: "number does not exist", "numero invalido", "not on whatsapp").
 * Exige contexto de numero/destinatario E indicacao de inexistencia, e exclui
 * termos de sessao/token/credencial/payload para nao confundir com erro de auth.
 */
function pareceNumeroInvalido(body) {
  const txt = String(
    body?.error
    || body?.message
    || body?.messages
    || body?.reason
    || body?.result
    || ''
  ).toLowerCase();
  if (!txt) {
    return false;
  }

  // Exclui falhas de sessao/credencial/payload (nao sao numero invalido).
  if (/sess(ao|ã|ion)|token|apitoken|credencial|credential|payload|sessionkey|unauthorized|n[aã]o autoriz/.test(txt)) {
    return false;
  }

  const temContextoNumero = /n[uú]mero|number|destinat|recipient|telefone|phone|chat ?id|whatsapp/.test(txt);
  const temInexistencia = /(does not exist|not exist|nao existe|n[aã]o existe|invalid|inv[aá]lid|not on whatsapp|sem whatsapp|not registered|nao registrad|n[aã]o registrad|no account)/.test(txt);

  return temContextoNumero && temInexistencia;
}

/**
 * Extrai o id real da mensagem no WhatsApp da resposta do /sendText do MyZap.
 * Cobre os 3 formatos das engines: whatsapp-web.js (body.id), WppConnect
 * (body.data.id[._serialized]) e Venom (body.messageId). Vazio se nao achar.
 * Esse id e o que casa com o ACK (entregue/lido) la no Hub.
 */
function extrairMessageId(body) {
  if (!body || typeof body !== 'object') {
    return '';
  }
  const cand =
    body.messageId
    || body.message_id
    || body.id
    || (body.data && (body.data.id || body.data.messageId || body.data.message_id))
    || (body.data && body.data.message && body.data.message.id)
    || '';
  if (!cand) {
    return '';
  }
  if (typeof cand === 'string') {
    return cand.trim();
  }
  if (typeof cand === 'object' && cand._serialized) {
    return String(cand._serialized).trim();
  }
  return String(cand).trim();
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
    // Diferencia credencial/sessao invalida (401/403) de MyZap offline: o sintoma
    // e o mesmo (res.ok=false), mas a causa e a sessao/token, nao a conexao — sem
    // isso o operador ve "MyZap indisponivel" quando o real e credencial expirada.
    if (res.status === 401 || res.status === 403) {
      warn('[FilaMyZap] Credencial/sessao invalida no MyZap (verifique session/token, nao e queda de conexao)', {
        metadata: { categoria: 'conexao', codigo_http: res.status }
      });
    }
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

  // Canal 'backend' (chamada ao Hub, nao ao MyZap local).
  backendLog.debug('[Backend] Buscando pendentes', {
    metadata: {
      categoria: 'fila',
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
  backendLog.debug('[Backend] Retorno /parametrizacao-myzap/pendentes', {
    metadata: {
      categoria: 'fila',
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

/**
 * Envia o status da fila ao backend.
 * - `payload` contem os campos base sempre enviados: { idfila, idfilial, status }
 *   (em sucesso pode trazer tambem message_id).
 * - `detalheErro` (opcional) so e incorporado quando status === 'erro', de forma
 *   RETROCOMPATIVEL: backends antigos ignoram os campos extras.
 */
async function atualizarStatusFila(apiBaseUrl, authorization, payload, detalheErro = null) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  // Monta o body final. Campos base inalterados; extras apenas em erro.
  let body = { ...payload };
  if (String(payload?.status || '').toLowerCase() === 'erro' && detalheErro) {
    body = {
      ...body,
      erro: detalheErro.erro || '',
      motivo: detalheErro.motivo || 'desconhecido',
      codigo_http: Number.isFinite(detalheErro.codigo_http) ? detalheErro.codigo_http : 0,
      resposta_myzap: truncarResposta(detalheErro.resposta_myzap),
      etapa: detalheErro.etapa || 'envio'
    };
  }

  backendLog.debug('[Backend] Atualizando status da fila', {
    metadata: { categoria: 'fila', ...body }
  });
  const res = await fetch(`${apiBaseUrl}parametrizacao-myzap/fila/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authorization
    },
    body: JSON.stringify(body),
    signal: ctrl.signal
  });

  clearTimeout(timeout);

  const data = await res.json().catch(() => ({}));
  backendLog.debug('[Backend] Retorno /parametrizacao-myzap/fila/status', {
    metadata: { categoria: 'fila', status: res.status, data }
  });
  return res.ok && !data?.error;
}

/**
 * Envia a mensagem para o MyZap local.
 * Retorna SEMPRE um shape uniforme:
 *   { ok, erro?, skipped?, endpoint?, requestBody?, body?, httpStatus?,
 *     codigo_http, resposta_myzap, motivo, etapa }
 * - etapa: 'validacao' (falhas antes do fetch) ou 'envio' (resultado do POST).
 * - motivo: timeout | sessao_caida | json_parse | myzap_http | numero_invalido
 *           | myzap_validacao | desconhecido | ok | status_enviado.
 */
async function enviarParaMyZap(mensagem, fallbackSessionKey, fallbackSessionName, fallbackApiToken) {
  if (String(mensagem?.status || '').toLowerCase() === 'enviado') {
    return { ok: true, skipped: true, motivo: 'status_enviado' };
  }

  // --- Etapa de validacao (antes de tocar no MyZap) ---
  let payloadFila = {};
  try {
    payloadFila = mensagem?.json ? JSON.parse(mensagem.json) : {};
  } catch (e) {
    return {
      ok: false,
      erro: `JSON invalido da fila: ${e.message}`,
      codigo_http: 0,
      resposta_myzap: '',
      motivo: 'json_parse',
      etapa: 'validacao'
    };
  }

  const endpoint = payloadFila?.endpoint;
  const data = payloadFila?.data;

  if (!endpoint || !data) {
    return {
      ok: false,
      erro: 'Mensagem sem endpoint ou payload para MyZap',
      codigo_http: 0,
      resposta_myzap: '',
      motivo: 'myzap_validacao',
      etapa: 'validacao'
    };
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
      erro: 'SessionKey ou APIToken do MyZap ausente',
      codigo_http: 0,
      resposta_myzap: '',
      motivo: 'myzap_validacao',
      etapa: 'validacao'
    };
  }

  debug('[FilaMyZap] Enviando para MyZap', {
    metadata: {
      categoria: 'envio',
      idfila: mensagem?.idfila,
      endpoint: endpointNormalizado,
      sessionKey
    }
  });

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  // --- Etapa de envio (POST ao MyZap) ---
  let res;
  try {
    res = await fetch(`${MYZAP_API_URL}${endpointNormalizado}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apitoken: apiToken,
        sessionkey: sessionKey
      },
      body: JSON.stringify(requestBody),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timeout);
    // Sem resposta HTTP: timeout (abort) ou MyZap fora do ar (conexao recusada).
    const isTimeout = err?.name === 'AbortError' || err?.code === 'ETIMEDOUT';
    const isConnDown = err?.code === 'ECONNREFUSED'
      || err?.code === 'ECONNRESET'
      || /ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(err?.message || '');
    const motivo = isTimeout ? 'timeout' : (isConnDown ? 'sessao_caida' : 'desconhecido');
    return {
      ok: false,
      endpoint: endpointNormalizado,
      requestBody,
      erro: err?.message || 'Falha de conexao com o MyZap',
      codigo_http: 0,
      resposta_myzap: '',
      motivo,
      etapa: 'envio'
    };
  }

  clearTimeout(timeout);

  // Corpo cru do MyZap. Se nao for JSON valido, classifica conforme o status.
  let body = {};
  let jsonParseFalhou = false;
  try {
    body = await res.json();
  } catch (_error) {
    jsonParseFalhou = true;
    body = {};
  }

  debug('[FilaMyZap] Retorno MyZap', {
    metadata: {
      categoria: 'envio',
      idfila: mensagem?.idfila,
      status: res.status,
      body
    }
  });

  if (jsonParseFalhou) {
    return {
      ok: false,
      endpoint: endpointNormalizado,
      requestBody,
      httpStatus: res.status,
      erro: `Resposta nao-JSON do MyZap (HTTP ${res.status})`,
      codigo_http: res.status,
      resposta_myzap: '',
      motivo: res.status >= 400 ? 'myzap_http' : 'json_parse',
      etapa: 'envio'
    };
  }

  if (!res.ok || body?.error || String(body?.status || '').toUpperCase() === 'FAIL') {
    const motivo = pareceNumeroInvalido(body)
      ? 'numero_invalido'
      : (res.status >= 400 ? 'myzap_http' : 'desconhecido');
    return {
      ok: false,
      endpoint: endpointNormalizado,
      requestBody,
      httpStatus: res.status,
      body,
      erro: extractMyZapError(body, res.status),
      codigo_http: res.status,
      resposta_myzap: body,
      motivo,
      etapa: 'envio'
    };
  }

  if (endpointNormalizado.toLowerCase() === 'sendtext' && body?.result !== 200) {
    return {
      ok: false,
      endpoint: endpointNormalizado,
      requestBody,
      httpStatus: res.status,
      body,
      erro: 'Retorno do sendText diferente de 200',
      codigo_http: res.status,
      resposta_myzap: body,
      motivo: 'myzap_http',
      etapa: 'envio'
    };
  }

  return {
    ok: true,
    endpoint: endpointNormalizado,
    requestBody,
    httpStatus: res.status,
    body,
    codigo_http: res.status,
    resposta_myzap: body,
    motivo: 'ok',
    etapa: 'envio'
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

  // Backoff de reconexao: enquanto o MyZap esteve indisponivel, espacamos as
  // tentativas para nao acumular skips rapido demais (adia o auto-stop e da
  // tempo de recuperacao). Durante a janela de backoff a rodada e adiada
  // (skip silencioso); a recuperacao tem latencia de ate BACKOFF_MAX_MS.
  if (backoffAteEm && Date.now() < backoffAteEm) {
    return;
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
      const atraso = aplicarBackoff();
      if (consecutiveSkips % SKIP_LOG_EVERY === 1) {
        warn(`[FilaMyZap] Credenciais ausentes (skip #${consecutiveSkips}, backoff ${atraso}ms)`, {
          metadata: { categoria: 'conexao', consecutiveSkips, backoffMs: atraso }
        });
      }
      // A fila NUNCA se auto-desliga: entra em pausa visivel e retoma sozinha.
      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        entrarEmPausa('aguardando_credenciais',
          'Fila de mensagens pausada: aguardando credenciais do MyZap. Ela retoma sozinha.');
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
      const atraso = aplicarBackoff();
      if (consecutiveSkips % SKIP_LOG_EVERY === 1) {
        warn(`[FilaMyZap] MyZap indisponivel (skip #${consecutiveSkips}, backoff ${atraso}ms)`, {
          metadata: { categoria: 'conexao', consecutiveSkips, backoffMs: atraso }
        });
      }
      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        entrarEmPausa('aguardando_myzap',
          'Fila de mensagens pausada: aguardando o MyZap voltar a responder. Ela retoma sozinha.');
      }
      return;
    }

    // MyZap ok: reset do contador de skips e do backoff -> a fila volta a
    // processar sozinha assim que o MyZap responder, sem restart manual.
    if (consecutiveSkips > 0) {
      info('[FilaMyZap] MyZap disponivel novamente, retomando processamento', {
        metadata: { categoria: 'conexao', skipsAnteriores: consecutiveSkips }
      });
    }
    consecutiveSkips = 0;
    limparBackoff();
    sairDaPausa();

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

    // Agregacao de erros desta rodada: notifica o operador no maximo 1x por
    // rodada (sem spam), com o motivo/idfila do primeiro erro e o total.
    let errosNaRodada = 0;
    let primeiroErroRodada = null;

    for (const mensagem of lote) {
      if (!ativo) break;

      let novoStatus = 'erro';
      // Detalhe rico enviado ao backend apenas em caso de erro (retrocompativel).
      let detalheErro = null;
      // id real da msg no WhatsApp (so no sucesso) -> reportado p/ casar com o ACK.
      let messageId = '';
      const filaIdfilial = String(mensagem?.idfilial || mensagem?.idempresa || idfilial || '').trim();
      try {
        info('[FilaMyZap] Enviando mensagem', {
          metadata: { categoria: 'envio', idfila: mensagem?.idfila, idfilial: filaIdfilial || null }
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
          messageId = extrairMessageId(envio.body);
          info('[FilaMyZap] Mensagem enviada com sucesso', {
            metadata: { categoria: 'envio', idfila: mensagem?.idfila, idfilial: filaIdfilial || null, messageId }
          });
        } else {
          // Monta o detalhe do erro para o backend e para o log estruturado.
          detalheErro = {
            erro: envio?.erro || 'Falha no envio',
            motivo: envio?.motivo || 'desconhecido',
            codigo_http: Number.isFinite(envio?.codigo_http) ? envio.codigo_http : 0,
            resposta_myzap: envio?.resposta_myzap ?? '',
            etapa: envio?.etapa || 'envio'
          };
          // metadata.conteudo (string) e renderizado como <pre> no logViewer.
          warn('[FilaMyZap] Falha ao enviar mensagem para MyZap', {
            metadata: {
              categoria: 'erro',
              idfila: mensagem?.idfila,
              idfilial: filaIdfilial || null,
              motivo: detalheErro.motivo,
              codigo_http: detalheErro.codigo_http,
              etapa: detalheErro.etapa,
              erro: detalheErro.erro,
              conteudo: truncarResposta(detalheErro.resposta_myzap)
            }
          });
        }
      } catch (envioError) {
        // Excecao inesperada (fora do fluxo previsto de enviarParaMyZap).
        detalheErro = {
          erro: envioError?.message || String(envioError),
          motivo: 'desconhecido',
          codigo_http: 0,
          resposta_myzap: '',
          etapa: 'envio'
        };
        registerRecentSend(buildRecentSendEntry(
          mensagem,
          null,
          'erro',
          envioError?.message || String(envioError)
        ));
        warn('Erro inesperado no envio para MyZap', {
          metadata: {
            categoria: 'erro',
            idfila: mensagem?.idfila,
            idfilial: filaIdfilial || null,
            error: envioError
          }
        });
      }

      // Contabiliza falha desta mensagem para a agregacao da rodada.
      if (novoStatus === 'erro') {
        errosNaRodada++;
        if (!primeiroErroRodada) {
          primeiroErroRodada = {
            idfila: mensagem?.idfila,
            motivo: detalheErro?.motivo || 'desconhecido',
            erro: detalheErro?.erro || 'Falha no envio'
          };
        }
      }

      const payloadStatus = {
        idfila: mensagem?.idfila,
        idfilial: filaIdfilial,
        status: novoStatus
      };
      // So no sucesso e quando o MyZap devolveu o id: backend grava p/ casar o ACK.
      if (novoStatus === 'enviado' && messageId) {
        payloadStatus.message_id = messageId;
      }

      const statusOk = await atualizarStatusFila(
        backendApiUrl,
        backendAuthorization,
        payloadStatus,
        detalheErro
      );

      if (!statusOk) {
        warn('Nao foi possivel atualizar status da fila MyZap', {
          metadata: {
            categoria: 'fila',
            idfila: mensagem?.idfila,
            idfilial: filaIdfilial || null,
            status: novoStatus
          }
        });
      }
    }

    // Notifica o operador 1x por rodada quando houve falha (agregado).
    if (errosNaRodada > 0) {
      recentErrorCount += errosNaRodada;
      ultimoErro = primeiroErroRodada?.erro || ultimoErro;
      atualizarTrayErros();
      if (queueErrorNotifier) {
        try {
          queueErrorNotifier({
            idfila: primeiroErroRodada?.idfila ?? null,
            motivo: primeiroErroRodada?.motivo || 'desconhecido',
            erro: primeiroErroRodada?.erro || 'Falha no envio',
            total: errosNaRodada
          });
        } catch (notifyErr) {
          warn('[FilaMyZap] Falha ao notificar operador sobre erro de envio', {
            metadata: { categoria: 'erro', error: notifyErr?.message || String(notifyErr) }
          });
        }
      }
    }

    info('[FilaMyZap] Ciclo de processamento concluido', {
      metadata: { categoria: 'fila', area: 'whatsappQueueWatcher', loteProcessado: lote.length, errosNaRodada }
    });

    if (errosNaRodada === 0) {
      ultimoErro = null;
    }
  } catch (e) {
    ultimoErro = e?.message || String(e);
    error('Erro no watcher da fila MyZap', {
      metadata: { categoria: 'erro', area: 'whatsappQueueWatcher', error: e }
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
  motivoPausa = null;

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
    ultimoErro,
    // Total acumulado de falhas de envio recentes (zerado em resetQueueErrorCount).
    recentErrorCount,
    // Instante (ms epoch) ate o qual a proxima rodada efetiva fica adiada (backoff).
    backoffAteEm: backoffAteEm || null,
    consecutiveSkips
  };
}

function getUltimosPendentesMyZap() {
  return Array.isArray(ultimosPendentes) ? [...ultimosPendentes] : [];
}

function getUltimosEnviosMyZap() {
  return Array.isArray(ultimosEnvios) ? [...ultimosEnvios] : [];
}

/** Zera o contador de erros recentes (ex.: quando o operador abre a fila). */
function resetQueueErrorCount() {
  recentErrorCount = 0;
  atualizarTrayErros();
}

module.exports = {
  setQueueNotifier,
  listarPendentesMyZap,
  getUltimosEnviosMyZap,
  getUltimosPendentesMyZap,
  startWhatsappQueueWatcher,
  stopWhatsappQueueWatcher,
  getWhatsappQueueWatcherStatus,
  processarFilaUmaRodada,
  setQueueErrorNotifier,
  setTrayErrorCountSetter,
  resetQueueErrorCount
};
