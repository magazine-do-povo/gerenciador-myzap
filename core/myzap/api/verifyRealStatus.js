const Store = require("electron-store");
const store = new Store();
const { warn, error, debug } = require('../myzapLogger').forArea('api');
const { getMyZapApiBaseUrls } = require('./requestMyZapApi');

const REQUEST_TIMEOUT_MS = 8000;

async function verifyRealStatus() {
    const token = store.get('myzap_apiToken');
    const session = store.get("myzap_sessionKey");
    // 127.0.0.1 primeiro, localhost como fallback: "localhost" pode resolver para
    // ::1 no Windows e dar timeout num MyZap que escuta so IPv4.
    const baseUrls = getMyZapApiBaseUrls();

    if (!token) {
        warn("Token não encontrado", {
            metadata: { area: 'verifyRealStatus', missing: 'token' }
        });
        return null;
    }

    if (!session) {
        warn("Session não encontrada", {
            metadata: { area: 'verifyRealStatus', missing: 'session' }
        });
        return null;
    }

    let lastError = null;

    for (const api of baseUrls) {
        // Timeout: evita travar o reload/poll quando o MyZap aceita a conexao mas
        // nao responde (ex.: sessao pendurada na inicializacao).
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            debug("Verificando status real MyZap", {
                metadata: { area: 'verifyRealStatus', session, api }
            });

            const res = await fetch(`${api}verifyRealStatus`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    apitoken: token,
                    sessionkey: session
                },
                body: JSON.stringify({ session }),
                signal: ctrl.signal
            });

            if (!res.ok) {
                // 401/403 = credencial/sessao invalida (acao: reconfigurar/reconectar).
                // NUNCA tratar como sucesso, mesmo que venha com corpo JSON.
                if (res.status === 401 || res.status === 403) {
                    error("Credencial recusada ao verificar status real MyZap (verifyRealStatus)", {
                        metadata: { area: 'verifyRealStatus', categoria: 'conexao', httpStatus: res.status, api }
                    });
                    return null;
                }

                // 404 do MyZap moderno e INFORMACAO, nao erro: vem com corpo util
                // {"status":"NOT FOUND","messages":"A session (x) informada nao existe."}
                // quando a sessao ainda nao foi criada. Devolver o corpo deixa o painel
                // mostrar "Sessao nao iniciada" em vez de um erro generico.
                if (res.status === 404) {
                    const body = await res.json().catch(() => null);
                    if (body && typeof body === 'object') {
                        debug("Sessao ainda nao criada no MyZap (404 com corpo util)", {
                            metadata: { area: 'verifyRealStatus', api, httpStatus: res.status, body }
                        });
                        return body;
                    }
                }

                warn("Resposta HTTP de erro ao verificar status real MyZap", {
                    metadata: { area: 'verifyRealStatus', httpStatus: res.status, api }
                });
                return null;
            }

            const data = await res.json();
            return data;

        } catch (e) {
            // Falha de rede nesta URL: tenta a proxima antes de desistir.
            lastError = e;
            warn("Falha ao verificar status real MyZap", {
                metadata: { area: 'verifyRealStatus', api, error: (e && e.message) || String(e) }
            });
        } finally {
            clearTimeout(timer);
        }
    }

    error("Erro ao verificar status real MyZap (todas as URLs falharam)", {
        metadata: { area: 'verifyRealStatus', error: (lastError && lastError.message) || String(lastError) }
    });
    return null;
}

module.exports = verifyRealStatus;
