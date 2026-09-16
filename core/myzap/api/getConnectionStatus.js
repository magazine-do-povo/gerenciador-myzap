const Store = require("electron-store");
const store = new Store();
const { warn, error, debug } = require('../myzapLogger').forArea('api');
const { getMyZapApiBaseUrls } = require('./requestMyZapApi');

const REQUEST_TIMEOUT_MS = 8000;

async function getConnectionStatus() {
    const token = store.get('myzap_apiToken');
    const session = store.get("myzap_sessionKey");
    // 127.0.0.1 primeiro, localhost como fallback: "localhost" pode resolver para
    // ::1 no Windows e dar timeout num MyZap que escuta so IPv4.
    const baseUrls = getMyZapApiBaseUrls();

    if (!token) {
        warn("Token não encontrado", {
            metadata: { area: 'getConnectionStatus', missing: 'token' }
        });
        return [];
    }

    if (!session) {
        warn("Session da API não encontrada", {
            metadata: { area: 'getConnectionStatus', missing: 'apiUrl' }
        });
        return [];
    }

    let lastError = null;

    for (const api of baseUrls) {
        // Timeout: evita travar o reload/poll quando o MyZap aceita a conexao mas
        // nao responde (ex.: sessao pendurada na inicializacao).
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            debug("Consultando status de conexão MyZap", {
                metadata: { area: 'getConnectionStatus', session, api }
            });

            const res = await fetch(`${api}getConnectionStatus`, {
                method: "POST",
                body: JSON.stringify({ session }),
                headers: {
                    "Content-Type": "application/json",
                    apitoken: token,
                    sessionkey: session
                },
                signal: ctrl.signal
            });

            if (!res.ok) {
                // 401/403 = credencial/sessao invalida (acao: reconfigurar/reconectar).
                // NUNCA tratar como sucesso, mesmo com corpo JSON (preserva shape: []).
                if (res.status === 401 || res.status === 403) {
                    error("Credencial recusada ao consultar status de conexão MyZap (getConnectionStatus)", {
                        metadata: { area: 'getConnectionStatus', categoria: 'conexao', httpStatus: res.status, api }
                    });
                    return [];
                }

                // 404 do MyZap moderno e INFORMACAO, nao erro: a sessao ainda nao foi
                // criada. Devolver o corpo deixa o painel dizer "Sessao nao iniciada"
                // em vez de um erro generico.
                if (res.status === 404) {
                    const body = await res.json().catch(() => null);
                    if (body && typeof body === 'object') {
                        debug("Sessao ainda nao criada no MyZap (404 com corpo util)", {
                            metadata: { area: 'getConnectionStatus', api, httpStatus: res.status, body }
                        });
                        return body;
                    }
                }

                warn("Resposta HTTP de erro ao consultar status de conexão MyZap", {
                    metadata: { area: 'getConnectionStatus', httpStatus: res.status, api }
                });
                return [];
            }

            const data = await res.json();
            return data;

        } catch (e) {
            // Falha de rede nesta URL: tenta a proxima antes de desistir.
            lastError = e;
            warn("Falha ao consultar status de conexão MyZap", {
                metadata: { area: 'getConnectionStatus', api, error: (e && e.message) || String(e) }
            });
        } finally {
            clearTimeout(timer);
        }
    }

    error("Erro ao consultar API (todas as URLs falharam)", {
        metadata: { area: 'getConnectionStatus', error: (lastError && lastError.message) || String(lastError) }
    });
    return [];
}

module.exports = getConnectionStatus;
