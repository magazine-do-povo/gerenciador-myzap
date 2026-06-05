const Store = require('electron-store');
const store = new Store();
const { debug } = require('../myzapLogger').forArea('api');

/**
 * Busca o QR Code direto do endpoint dedicado do MyZap (GET /getQrCode/:session),
 * que responde uma IMAGEM PNG (mesmo QR que a UI web do MyZap exibe).
 *
 * O snapshot de status (verifyRealStatus/getConnectionStatus) nem sempre carrega
 * o QR durante a inicializacao, o que fazia o painel travar em "aguardando QR".
 * Este fallback resolve isso.
 *
 * @returns {Promise<string|null>} data URL ("data:image/png;base64,...") ou null
 *   quando ainda nao ha QR (404) ou em qualquer falha (best-effort).
 */
async function getQrCode() {
  const token = store.get('myzap_apiToken');
  const session = store.get('myzap_sessionKey');
  if (!token || !session) {
    return null;
  }

  const api = 'http://localhost:5555/';
  // Timeout obrigatorio: sem ele, se o /getQrCode pendurar (ex.: sessao travando
  // na inicializacao), o fetch ficava preso e segurava o getSessionSnapshot ->
  // o botao de reload e o polling do "Iniciar instancia" travavam.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${api}getQrCode/${encodeURIComponent(session)}`, {
      method: 'GET',
      headers: {
        apitoken: token,
        sessionkey: session
      },
      signal: ctrl.signal
    });

    // 404 = sessao ainda sem QR (normal no inicio); qualquer nao-2xx -> sem QR.
    if (!res.ok) {
      return null;
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('image')) {
      // Erro estruturado (ex.: {response:false}) vem como JSON, nao imagem.
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) {
      return null;
    }

    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (e) {
    debug('getQrCode: falha/timeout ao buscar QR direto do MyZap', {
      metadata: { area: 'getQrCode', error: (e && e.message) || String(e) }
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = getQrCode;
