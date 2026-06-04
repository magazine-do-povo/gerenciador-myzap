const Store = require("electron-store");
const store = new Store();
const { warn, error, debug } = require('../myzapLogger').forArea('api');

async function getConnectionStatus() {
    const token = store.get('myzap_apiToken');
    const api = "http://localhost:5555/";
    const session = store.get("myzap_sessionKey");

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

    try {
        const res = await fetch(`${api}getConnectionStatus`, {
            method: "POST",
            body: JSON.stringify({ session }),
            headers: {
                "Content-Type": "application/json",
                apitoken: token,
                sessionkey: session
            }
        });

        // Nao tratar 401/403/erro HTTP com corpo JSON como sucesso (preserva shape: []).
        // 401/403 = credencial/sessao invalida (acao: reconfigurar/reconectar), distinto
        // de falha de rede (MyZap offline) que cai no catch abaixo.
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                error("Credencial recusada ao consultar status de conexão MyZap (getConnectionStatus)", {
                    metadata: { area: 'getConnectionStatus', categoria: 'conexao', httpStatus: res.status }
                });
            } else {
                warn("Resposta HTTP de erro ao consultar status de conexão MyZap", {
                    metadata: { area: 'getConnectionStatus', httpStatus: res.status }
                });
            }
            return [];
        }

        const data = await res.json();
        return data;

    } catch (e) {
        error("Erro ao consultar API", {
            metadata: { area: 'getConnectionStatus', error: (e && e.message) || String(e) }
        });
        return [];
    }
}

module.exports = getConnectionStatus;
