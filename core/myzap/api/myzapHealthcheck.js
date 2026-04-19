const Store = require('electron-store');
const { debug } = require('../myzapLogger').forArea('api');

const store = new Store();

const DEFAULT_BASE_URLS = ['http://127.0.0.1:5555/', 'http://localhost:5555/'];
const PROBE_PATHS = ['getConnectionStatus', 'verifyRealStatus'];

function buildUrls() {
  const configured = String(store.get('myzap_localApiUrl') || store.get('myzap_apiUrlLocal') || '').trim();
  const base = configured
    ? [configured.endsWith('/') ? configured : `${configured}/`, ...DEFAULT_BASE_URLS]
    : DEFAULT_BASE_URLS;
  const seen = new Set();
  return base.filter((u) => {
    const k = u.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Heuristica para decidir se a resposta veio do servidor MyZap (e nao de outro
 * software qualquer rodando na 5555).
 * O MyZap responde JSON contendo, em geral, alguma das chaves:
 *   result, status, state, session, qrCode, statuscode, message
 * em rotas como /getConnectionStatus e /verifyRealStatus.
 */
function looksLikeMyZapPayload(payload) {
  if (payload == null) return false;
  if (typeof payload !== 'object') return false;
  const keys = Object.keys(payload).map((k) => k.toLowerCase());
  if (!keys.length) return false;
  const knownKeys = [
    'result', 'status', 'state', 'session', 'sessionstatus',
    'qrcode', 'statuscode', 'message', 'realstatus', 'connectionstatus',
  ];
  return keys.some((k) => knownKeys.includes(k));
}

async function fetchJsonWithTimeout(url, init, timeoutMs) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: abort.signal });
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    let payload = null;
    if (contentType.includes('application/json')) {
      try { payload = await res.json(); } catch (_e) { payload = null; }
    } else {
      const text = await res.text().catch(() => '');
      try { payload = JSON.parse(text); } catch (_e) { payload = text ? { raw: text } : null; }
    }
    return { ok: true, status: res.status, payload, contentType };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tenta descobrir a identidade do servidor escutando na 5555.
 *
 * Retorna:
 *   {
 *     alive: boolean,        // algum endpoint HTTP respondeu (mesmo 4xx/5xx)
 *     isMyZap: boolean,      // resposta tem cara de MyZap
 *     status: number|null,   // ultimo HTTP status
 *     payloadSample: any,    // amostra do payload
 *     attempts: [...],       // detalhes por URL
 *     error: string|null,    // ultimo erro (se nao alive)
 *   }
 */
async function probeMyZapIdentity(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2500;
  const token = String(options.token || store.get('myzap_apiToken') || '').trim();
  const sessionKey = String(options.sessionKey || store.get('myzap_sessionKey') || '').trim();

  const urls = buildUrls();
  const attempts = [];
  let alive = false;
  let isMyZap = false;
  let lastStatus = null;
  let lastPayload = null;
  let lastError = null;

  for (const baseUrl of urls) {
    for (const probePath of PROBE_PATHS) {
      const url = `${baseUrl}${probePath}`;
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.apitoken = token;
      if (sessionKey) headers.sessionkey = sessionKey;
      const body = JSON.stringify({ session: sessionKey || '' });

      try {
        const result = await fetchJsonWithTimeout(url, { method: 'POST', headers, body }, timeoutMs);
        alive = true;
        lastStatus = result.status;
        lastPayload = result.payload;
        const myzapShape = looksLikeMyZapPayload(result.payload);
        attempts.push({ url, status: result.status, isMyZap: myzapShape, contentType: result.contentType });
        if (myzapShape) {
          isMyZap = true;
          break;
        }
      } catch (err) {
        const msg = (err && err.message) || String(err);
        attempts.push({ url, error: msg });
        lastError = msg;
      }
    }
    if (isMyZap) break;
  }

  // Fallback: se nada respondeu nas rotas com payload, tentar GET na raiz
  // so para confirmar que a porta esta servindo HTTP (alive sem identidade).
  if (!alive) {
    for (const baseUrl of urls) {
      try {
        const result = await fetchJsonWithTimeout(baseUrl, { method: 'GET' }, timeoutMs);
        alive = true;
        lastStatus = result.status;
        lastPayload = result.payload;
        if (looksLikeMyZapPayload(result.payload)) {
          isMyZap = true;
        }
        attempts.push({ url: baseUrl, status: result.status, isMyZap, fallback: true });
        break;
      } catch (err) {
        const msg = (err && err.message) || String(err);
        attempts.push({ url: baseUrl, error: msg, fallback: true });
        lastError = msg;
      }
    }
  }

  debug('probeMyZapIdentity concluido', {
    metadata: {
      area: 'myzapHealthcheck',
      alive,
      isMyZap,
      status: lastStatus,
      attemptsCount: attempts.length,
    },
  });

  return {
    alive,
    isMyZap,
    status: lastStatus,
    payloadSample: lastPayload,
    attempts,
    error: alive ? null : lastError,
  };
}

module.exports = { probeMyZapIdentity, looksLikeMyZapPayload };
