const Store = require('electron-store');
const store = new Store();
const { warn, error, debug, info } = require('../myzapLogger');
const getSessionSnapshot = require('./getSessionSnapshot');

/** Intervalo entre tentativas de buscar QR apos /start (ms) */
const WAIT_QR_POLL_MS = 3000;
/** Tempo maximo para aguardar o QR aparecer (ms) — 4 minutos */
const WAIT_QR_TIMEOUT_MS = 240000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startSession() {
    const token = store.get('myzap_apiToken');
    const api = 'http://localhost:5555/';
    const session = store.get('myzap_sessionKey');
    const sessionName = store.get('myzap_sessionName') || session;

    if (!token) {
        warn('Token nao encontrado ao iniciar sessao', {
            metadata: { area: 'startSession', missing: 'token' }
        });
        return null;
    }

    if (!session) {
        warn('Session key nao encontrada ao iniciar sessao', {
            metadata: { area: 'startSession', missing: 'session' }
        });
        return null;
    }

    try {
        debug('Iniciando sessao MyZap', {
            metadata: { area: 'startSession', session, sessionName }
        });

        const res = await fetch(api + 'start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apitoken: token,
                sessionkey: session
            },
            body: JSON.stringify({
                session,
                sessionName: sessionName || session,
                waitQrCode: true
            })
        });

        const data = await res.json();
        debug('Resposta startSession', {
            metadata: { area: 'startSession', status: res.status, data }
        });

        // Se /start ja retornou QR (session existente com QR no banco), retornar direto
        const immediateQr = data && (data.qrCode || data.qr_code || data.qrcode || data.base64Qrimg || '');
        if (immediateQr) {
            info('startSession: QR recebido imediatamente do /start', {
                metadata: { area: 'startSession', session }
            });
            return data;
        }

        // MyZap nao implementa waitQrCode — o /start retorna imediato com INITIALIZING.
        // Fazer polling local ate o QR aparecer ou timeout.
        const startedOk = data && (data.result === 'success' || data.result === 200);
        if (!startedOk) {
            return data;
        }

        info('startSession: /start retornou sem QR, aguardando Chrome inicializar...', {
            metadata: { area: 'startSession', session, state: data.state, status: data.status }
        });

        const deadline = Date.now() + WAIT_QR_TIMEOUT_MS;
        let attempts = 0;

        while (Date.now() < deadline) {
            await sleep(WAIT_QR_POLL_MS);
            attempts++;

            try {
                const snapshot = await getSessionSnapshot();

                if (snapshot && snapshot.session_status === 'connected') {
                    info('startSession: sessao conectou durante espera do QR', {
                        metadata: { area: 'startSession', session, attempts }
                    });
                    return {
                        ...data,
                        session_status: 'connected',
                        state: 'CONNECTED',
                        status: 'CONNECTED'
                    };
                }

                const qr = snapshot && snapshot.qr_base64;
                if (qr) {
                    info('startSession: QR obtido via polling interno', {
                        metadata: { area: 'startSession', session, attempts }
                    });
                    return {
                        ...data,
                        qrCode: qr,
                        state: 'QRCODE',
                        status: 'qrCode'
                    };
                }

                if (attempts % 5 === 0) {
                    debug('startSession: ainda aguardando QR...', {
                        metadata: {
                            area: 'startSession',
                            session,
                            attempts,
                            snapshotStatus: snapshot && snapshot.session_status,
                            elapsed: Math.round((Date.now() - (deadline - WAIT_QR_TIMEOUT_MS)) / 1000) + 's'
                        }
                    });
                }
            } catch (pollErr) {
                debug('startSession: erro transiente no polling de QR', {
                    metadata: { area: 'startSession', error: (pollErr && pollErr.message) || String(pollErr) }
                });
            }
        }

        info('startSession: timeout aguardando QR, retornando resposta original do /start', {
            metadata: { area: 'startSession', session, attempts, timeoutMs: WAIT_QR_TIMEOUT_MS }
        });
        return data;

    } catch (e) {
        error('Erro ao iniciar sessao MyZap', {
            metadata: { area: 'startSession', error: (e && e.message) || String(e) }
        });
        return null;
    }
}

module.exports = startSession;
