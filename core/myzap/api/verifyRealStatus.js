const Store = require("electron-store");
const store = new Store();
const { warn, error, debug } = require('../myzapLogger').forArea('api');

async function verifyRealStatus() {
    const token = store.get('myzap_apiToken');
    const api = "http://localhost:5555/";
    const session = store.get("myzap_sessionKey");

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

    try {
        debug("Verificando status real MyZap", {
            metadata: { area: 'verifyRealStatus', session }
        });

        const res = await fetch(`${api}verifyRealStatus`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                apitoken: token,
                sessionkey: session
            },
            body: JSON.stringify({ session })
        });

        // Nao tratar 401/403/erro HTTP com corpo JSON como sucesso. 401/403 =
        // credencial/sessao invalida (acao: reconfigurar/reconectar), distinto de
        // falha de rede (MyZap offline) que cai no catch abaixo.
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                error("Credencial recusada ao verificar status real MyZap (verifyRealStatus)", {
                    metadata: { area: 'verifyRealStatus', categoria: 'conexao', httpStatus: res.status }
                });
            } else {
                warn("Resposta HTTP de erro ao verificar status real MyZap", {
                    metadata: { area: 'verifyRealStatus', httpStatus: res.status }
                });
            }
            return null;
        }

        const data = await res.json();
        return data;

    } catch (e) {
        error("Erro ao verificar status real MyZap", {
            metadata: { area: 'verifyRealStatus', error: (e && e.message) || String(e) }
        });
        return null;
    }
}

module.exports = verifyRealStatus;
