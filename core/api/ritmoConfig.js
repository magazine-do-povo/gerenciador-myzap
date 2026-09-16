// Ritmo de envio (humanizacao) sincronizado do backend (Hub).
//
// O backend, exposto em GET /parametrizacao-myzap/config/{idfilial} dentro de
// "ritmo", e a FONTE DA VERDADE. Este modulo busca esses valores periodicamente e
// os cacheia no electron-store, para o watcher da fila aplicar o espacamento
// humano entre mensagens (rajadas sub-segundo bloqueiam o numero no WhatsApp).
//
// Portado do gerenciadorMyzap da JZTech, com DUAS adaptacoes para esta base:
//   1. escopo e `idfilial` (la e `idempresa`);
//   2. os DEFAULTS sao NEUTROS (0s de intervalo, sem janela, sem teto). Na JZTech
//      o default e conservador (10-45s), mas aqui o ritmo sempre foi decidido
//      server-side pelo Hub e o gerenciador enviava na velocidade que recebia.
//      Estrear com 10-45s estrangularia o disparo atual sem ninguem pedir. Assim o
//      comportamento so muda quando o Hub passar a mandar o bloco "ritmo".
const Store = require('electron-store');
const { getBackendApiConfig } = require('../myzap/capabilities');
const backendLog = require('../myzap/myzapLogger').forArea('backend');

const store = new Store();

const STORE_KEY = 'myzap_ritmo';
const REFRESH_TTL_MS = 60000; // revalida o ritmo no maximo 1x/min
const FETCH_TIMEOUT_MS = 12000;

// NEUTRO de proposito (ver cabecalho): preserva o comportamento atual ate o
// backend mandar a configuracao de ritmo.
const DEFAULTS = {
  intervaloMsgMinSeg: 0,
  intervaloMsgMaxSeg: 0,
  horarioInicio: '', // '' = sem restricao de horario
  horarioFim: '',
  tetoDiario: 0, // 0 = sem limite diario
};

let ultimaTentativa = 0;
let buscando = false;

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = toInt(value, fallback);
  return Math.min(max, Math.max(min, n));
}

// 'HH:MM:SS' | 'HH:MM' | null -> 'HH:MM' (ou '' se invalido/vazio).
function normalizarHora(value) {
  const s = String(value ?? '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// Le o ritmo cacheado, sempre normalizado e com defaults seguros.
function getRitmo() {
  const cache = store.get(STORE_KEY);
  const raw = cache && typeof cache === 'object' ? cache : {};

  const minSeg = clampInt(raw.intervaloMsgMinSeg, 0, 3600, DEFAULTS.intervaloMsgMinSeg);
  let maxSeg = clampInt(raw.intervaloMsgMaxSeg, 0, 3600, DEFAULTS.intervaloMsgMaxSeg);
  if (maxSeg < minSeg) maxSeg = minSeg;

  return {
    intervaloMsgMinSeg: minSeg,
    intervaloMsgMaxSeg: maxSeg,
    horarioInicio: normalizarHora(raw.horarioInicio),
    horarioFim: normalizarHora(raw.horarioFim),
    tetoDiario: clampInt(raw.tetoDiario, 0, 1000000, DEFAULTS.tetoDiario),
  };
}

// Busca o ritmo no backend se o cache estiver "velho" (TTL). Nunca lanca:
// em qualquer falha mantem o cache anterior (ou os defaults). Retorna o ritmo atual.
async function refreshRitmoIfStale(force = false) {
  const agora = Date.now();
  if (!force && (buscando || agora - ultimaTentativa < REFRESH_TTL_MS)) {
    return getRitmo();
  }
  buscando = true;
  ultimaTentativa = agora; // marca a tentativa: sucesso OU falha so retenta apos o TTL

  try {
    const { backendApiUrl, backendApiToken } = getBackendApiConfig(store);
    // Escopo desta base e a FILIAL (idempresa fica como fallback legado).
    const idfilial = String(store.get('idfilial') || store.get('idempresa') || '').trim();
    if (!backendApiUrl || !idfilial) {
      return getRitmo();
    }

    const base = backendApiUrl.endsWith('/') ? backendApiUrl : `${backendApiUrl}/`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let body = {};
    try {
      const res = await fetch(
        `${base}parametrizacao-myzap/config/${encodeURIComponent(idfilial)}`,
        {
          method: 'GET',
          headers: backendApiToken ? { Authorization: `Bearer ${backendApiToken}` } : {},
          signal: ctrl.signal,
        }
      );
      body = await res.json().catch(() => ({}));
      if (!res.ok) {
        backendLog.warn('[Ritmo] Falha ao buscar ritmo no backend', {
          metadata: { categoria: 'fila', status: res.status },
        });
        return getRitmo();
      }
    } finally {
      clearTimeout(timeout);
    }

    const ritmo = body?.result?.ritmo || body?.ritmo || null;
    if (ritmo && typeof ritmo === 'object') {
      store.set(STORE_KEY, {
        intervaloMsgMinSeg: toInt(ritmo.intervalo_msg_min_seg, DEFAULTS.intervaloMsgMinSeg),
        intervaloMsgMaxSeg: toInt(ritmo.intervalo_msg_max_seg, DEFAULTS.intervaloMsgMaxSeg),
        horarioInicio: normalizarHora(ritmo.horario_inicio),
        horarioFim: normalizarHora(ritmo.horario_fim),
        tetoDiario: toInt(ritmo.teto_diario, DEFAULTS.tetoDiario),
      });
      backendLog.debug('[Ritmo] Ritmo atualizado a partir do backend', {
        metadata: { categoria: 'fila', ...getRitmo() },
      });
    }
  } catch (err) {
    backendLog.warn('[Ritmo] Erro ao atualizar ritmo', {
      metadata: { categoria: 'fila', error: err?.message || String(err) },
    });
  } finally {
    buscando = false;
  }

  return getRitmo();
}

module.exports = { getRitmo, refreshRitmoIfStale, DEFAULTS };
