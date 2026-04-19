const fs = require('fs');
const path = require('path');
const Store = require('electron-store');
const { BrowserWindow } = require('electron');
const { warn, info } = require('../myzap/myzapLogger').forArea('ipc');
const { getLogDir } = require('../utils/logger');
const clonarRepositorio = require('../myzap/clonarRepositorio');
const verificarDiretorio = require('../myzap/verificarDiretorio');
const getConnectionStatus = require('../myzap/api/getConnectionStatus');
const getSessionSnapshot = require('../myzap/api/getSessionSnapshot');
const startSession = require('../myzap/api/startSession');
const deleteSession = require('../myzap/api/deleteSession');
const verifyRealStatus = require('../myzap/api/verifyRealStatus');
const sendTestMessage = require('../myzap/api/sendTestMessage');
const updateIaConfig = require('../myzap/api/updateIaConfig');
const { iniciarMyZap, onMyZapChildExit } = require('../myzap/iniciarMyZap');
const {
    prepareAutoConfig,
    getAutoConfigDebugSnapshot,
    ensureMyZapReadyAndStart
} = require('../myzap/autoConfig');
const { resetMyZapEnvironment } = require('../myzap/resetEnvironment');
const { getStateSnapshot } = require('../myzap/stateMachine');
const { getPrivilegeStatus, killProcessesOnPort } = require('../myzap/processUtils');
const {
    getUltimosEnviosMyZap,
    getUltimosPendentesMyZap,
    startWhatsappQueueWatcher,
    stopWhatsappQueueWatcher,
    getWhatsappQueueWatcherStatus,
    processarFilaUmaRodada
} = require('../api/whatsappQueueWatcher');

const envStore = new Store();

function isSetupInProgress() {
    const progress = envStore.get('myzap_progress');
    return progress && progress.active === true;
}

function parseEnvSecrets(envContent) {
    const secrets = { TOKEN: '', OPENAI_API_KEY: '', EMAIL_TOKEN: '' };
    if (!envContent) return secrets;
    const lines = String(envContent).split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const eqIdx = trimmed.indexOf('=');
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Remove aspas
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (key === 'TOKEN' || key === 'OPENAI_API_KEY' || key === 'EMAIL_TOKEN') {
            secrets[key] = val;
        }
    }
    return secrets;
}

function escapeEnvRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatEnvValue(value) {
    return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function upsertEnvKey(envContent, key, value) {
    const content = String(envContent || '');
    const line = `${key}=${formatEnvValue(value)}`;
    const pattern = new RegExp(`^${escapeEnvRegExp(key)}=.*$`, 'm');

    if (pattern.test(content)) {
        return content.replace(pattern, line);
    }

    if (!content.trim()) {
        return `${line}\n`;
    }

    const suffix = content.endsWith('\n') ? '' : '\n';
    return `${content}${suffix}${line}\n`;
}

function buildEnvContent(baseEnv, secrets = {}) {
    let content = String(baseEnv || '');
    content = upsertEnvKey(content, 'TOKEN', secrets.TOKEN || '');
    content = upsertEnvKey(content, 'OPENAI_API_KEY', secrets.OPENAI_API_KEY || '');
    content = upsertEnvKey(content, 'EMAIL_TOKEN', secrets.EMAIL_TOKEN || '');
    return content;
}

function registerMyZapHandlers(ipcMain) {
    info('IPC MyZap handlers registrados', {
        metadata: { area: 'ipcMyzap' }
    });

    // Broadcast para o renderer quando o child do MyZap finaliza, para a UI
    // poder quebrar a espera imediatamente em vez de esperar timeout.
    onMyZapChildExit((payload) => {
        try {
            for (const win of BrowserWindow.getAllWindows()) {
                if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
                    win.webContents.send('myzap:childExited', payload);
                }
            }
            info('Evento myzap:childExited propagado ao renderer', {
                metadata: { area: 'ipcMyzap', exitCode: payload && payload.exitCode },
            });
        } catch (err) {
            warn('Falha ao propagar myzap:childExited', {
                metadata: { area: 'ipcMyzap', error: err && err.message }
            });
        }
    });

    ipcMain.handle('myzap:checkDirectoryHasFiles', async (event, dirPath) => {
        try {
            const result = await verificarDiretorio(dirPath);
            return result;
        } catch (error) {
            warn('Falha ao verificar diretório via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:cloneRepository', async (event, dirPath, envContent, reinstall = false) => {
        if (isSetupInProgress()) {
            warn('Clone bloqueado: setup ja em andamento', { metadata: { area: 'ipcMyzap' } });
            return { status: 'error', message: 'Uma instalacao/atualizacao ja esta em andamento. Aguarde.' };
        }
        try {
            const result = await clonarRepositorio(dirPath, envContent, reinstall);
            return result;
        } catch (error) {
            warn('Falha ao clonar repositório via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:iniciarMyZap', async (event, dirPath) => {
        try {
            const result = await iniciarMyZap(dirPath);
            return result;
        } catch (error) {
            warn('Falha ao iniciar MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:prepareAutoConfig', async (_event, forceRemote = false) => {
        try {
            info('IPC myzap:prepareAutoConfig recebido', {
                metadata: { area: 'ipcMyzap', forceRemote }
            });
            return await prepareAutoConfig({ forceRemote });
        } catch (error) {
            warn('Falha ao preparar configuracao automatica do MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:getAutoConfigDebug', async () => {
        try {
            return getAutoConfigDebugSnapshot();
        } catch (error) {
            warn('Falha ao obter debug da configuracao automatica MyZap via IPC', {
                metadata: { error }
            });
            return {
                generatedAt: Date.now(),
                success: false,
                reason: 'ipc_error',
                error: error.message || String(error),
                attempts: []
            };
        }
    });

    ipcMain.handle('myzap:getPrivilegeStatus', async () => {
        try {
            return getPrivilegeStatus();
        } catch (error) {
            warn('Falha ao verificar privilegios do processo via IPC', {
                metadata: { error }
            });
            return {
                platform: process.platform,
                isElevated: false,
                requiresAdminForLocalInstall: false,
                needsAdminForLocalInstall: false,
                method: 'ipc_error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:ensureStarted', async (_event, forceRemote = false) => {
        try {
            info('IPC myzap:ensureStarted recebido', {
                metadata: { area: 'ipcMyzap', forceRemote }
            });
            return await ensureMyZapReadyAndStart({ forceRemote });
        } catch (error) {
            warn('Falha ao iniciar MyZap automaticamente via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    // Hard restart: mata processo na porta 5555 e reinicia o MyZap.
    // Usado quando a sessao trava em INITIALIZING (Chromium puppeteer travado).
    ipcMain.handle('myzap:hardRestart', async () => {
        try {
            info('IPC myzap:hardRestart recebido — matando porta 5555 e reiniciando', {
                metadata: { area: 'ipcMyzap' }
            });
            const killResult = killProcessesOnPort(5555);
            info('Processos finalizados na porta 5555', {
                metadata: { area: 'ipcMyzap', killed: killResult.killed, failed: killResult.failed }
            });
            // Pequena espera para o SO liberar a porta antes do re-spawn
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const startResult = await ensureMyZapReadyAndStart({ forceRemote: true });
            return {
                status: startResult?.status || 'success',
                message: startResult?.message || 'MyZap reiniciado com sucesso.',
                killed: killResult.killed,
                startResult
            };
        } catch (error) {
            warn('Falha em myzap:hardRestart', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:getConnectionStatus', async (event) => {
        try {
            const result = await getConnectionStatus();
            return result;
        } catch (error) {
            warn('Falha ao verificar conexão MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:verifyRealStatus', async (event) => {
        try {
            const result = await verifyRealStatus();
            return result;
        } catch (error) {
            warn('Falha ao verificar status real MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:getSessionSnapshot', async () => {
        try {
            const result = await getSessionSnapshot();
            return result;
        } catch (error) {
            warn('Falha ao obter snapshot de sessao MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:startSession', async (event) => {
        try {
            const result = await startSession();
            return result;
        } catch (error) {
            warn('Falha ao verificar conexão MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:deleteSession', async (event) => {
        try {
            const result = await deleteSession();
            return result;
        } catch (error) {
            warn('Falha ao verificar conexão MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:sendTestMessage', async () => {
        try {
            const result = await sendTestMessage();
            return result;
        } catch (error) {
            warn('Falha ao enviar mensagem de teste MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:updateIaConfig', async (event, mensagemPadrao) => {
        try {
            const result = await updateIaConfig(mensagemPadrao);
            return result;
        } catch (error) {
            warn('Falha ao atualizar configuracao de IA MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:startQueueWatcher', async () => {
        try {
            info('IPC myzap:startQueueWatcher recebido', {
                metadata: { area: 'ipcMyzap' }
            });
            return await startWhatsappQueueWatcher();
        } catch (error) {
            warn('Falha ao iniciar watcher de fila MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:stopQueueWatcher', async () => {
        try {
            info('IPC myzap:stopQueueWatcher recebido', {
                metadata: { area: 'ipcMyzap' }
            });
            return stopWhatsappQueueWatcher();
        } catch (error) {
            warn('Falha ao parar watcher de fila MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:getQueueWatcherStatus', async () => {
        try {
            return getWhatsappQueueWatcherStatus();
        } catch (error) {
            warn('Falha ao obter status do watcher de fila MyZap via IPC', {
                metadata: { error }
            });
            return {
                ativo: false,
                processando: false,
                ultimoLote: 0,
                ultimaExecucaoEm: null,
                ultimoErro: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:getQueuePendentes', async () => {
        try {
            return getUltimosPendentesMyZap();
        } catch (error) {
            warn('Falha ao obter pendentes da fila MyZap via IPC', {
                metadata: { error }
            });
            return [];
        }
    });

    ipcMain.handle('myzap:getQueueRecentMessages', async () => {
        try {
            return getUltimosEnviosMyZap();
        } catch (error) {
            warn('Falha ao obter historico recente da fila MyZap via IPC', {
                metadata: { error }
            });
            return [];
        }
    });

    ipcMain.handle('myzap:forceQueueCycle', async () => {
        try {
            info('IPC myzap:forceQueueCycle recebido (busca manual)', {
                metadata: { area: 'ipcMyzap' }
            });
            await processarFilaUmaRodada();
            return { status: 'success', message: 'Ciclo executado com sucesso.' };
        } catch (error) {
            warn('Falha ao forcar ciclo da fila MyZap via IPC', {
                metadata: { error }
            });
            return { status: 'error', message: error.message || String(error) };
        }
    });

    ipcMain.handle('myzap:getQueueLogs', async (_event, maxLines = 80) => {
        try {
            const logDir = getLogDir();
            const today = new Date().toISOString().split('T')[0];
            const logFile = path.join(logDir, `${today}-log-myzap.jsonl`);
            if (!fs.existsSync(logFile)) return [];
            const content = fs.readFileSync(logFile, 'utf8');
            const lines = content.trim().split('\n').filter(Boolean);
            // Filtrar apenas logs da fila (whatsappQueueWatcher / [FilaMyZap])
            const parsed = lines.map((line) => {
                try { return JSON.parse(line); } catch (_e) { return null; }
            }).filter(Boolean);
            const filaOnly = parsed.filter((e) => {
                const msg = e.message || '';
                const area = e.metadata?.area || '';
                return msg.includes('[FilaMyZap]') || area === 'whatsappQueueWatcher';
            });
            return filaOnly.slice(-maxLines);
        } catch (error) {
            warn('Falha ao ler logs da fila MyZap via IPC', {
                metadata: { error }
            });
            return [];
        }
    });

    // ── .env secrets handlers ──────────────────────────────

    ipcMain.handle('myzap:resetEnvironment', async (_event, options = {}) => {
        try {
            info('IPC myzap:resetEnvironment recebido', {
                metadata: { area: 'ipcMyzap', options }
            });
            return await resetMyZapEnvironment(options);
        } catch (error) {
            warn('Falha ao resetar ambiente MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:getStateSnapshot', async () => {
        try {
            return getStateSnapshot();
        } catch (error) {
            warn('Falha ao obter snapshot de estado MyZap via IPC', {
                metadata: { error }
            });
            return {
                state: 'error',
                label: 'Erro',
                progress: 0,
                error: error.message || String(error)
            };
        }
    });

    // ── .env secrets handlers (continuacao) ─────────────────
    ipcMain.handle('myzap:saveEnvSecrets', async (_event, secrets) => {
        try {
            const { TOKEN = '', OPENAI_API_KEY = '', EMAIL_TOKEN = '' } = secrets || {};
            const myzapDir = String(envStore.get('myzap_diretorio') || '').trim();
            const templatePath = path.join(__dirname, '..', 'myzap', 'configs', '.env');
            const localEnvPath = myzapDir ? path.join(myzapDir, '.env') : '';
            const targets = [];
            if (localEnvPath && fs.existsSync(localEnvPath)) {
                targets.push(localEnvPath);
            }

            // Sempre atualiza myzap_envContent no store para que futuras instalacoes carreguem os segredos
            const storedEnv = String(envStore.get('myzap_envContent') || '').trim();
            const templateEnv = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : '';
            const baseEnv = storedEnv || templateEnv;
            const nextEnvContent = buildEnvContent(baseEnv, {
                TOKEN,
                OPENAI_API_KEY,
                EMAIL_TOKEN
            });
            envStore.set('myzap_envContent', nextEnvContent);

            // Sincronizar myzap_apiToken com o TOKEN do .env para que as chamadas HTTP a API local usem o mesmo valor
            envStore.set('myzap_apiToken', TOKEN);
            info('myzap_apiToken sincronizado com TOKEN do .env', {
                metadata: { area: 'ipcMyzap', hasToken: Boolean(TOKEN) }
            });

            if (targets.length === 0) {
                info('Segredos salvos no store do gerenciador', {
                    metadata: {
                        area: 'ipcMyzap',
                        hasLocalEnv: false,
                        hasTemplateEnv: Boolean(templateEnv)
                    }
                });
                return { status: 'success', message: 'Segredos salvos com sucesso.' };
            }

            for (const filePath of targets) {
                const currentContent = fs.readFileSync(filePath, 'utf8');
                const nextContent = buildEnvContent(currentContent || nextEnvContent, {
                    TOKEN,
                    OPENAI_API_KEY,
                    EMAIL_TOKEN
                });
                fs.writeFileSync(filePath, nextContent, 'utf8');
            }

            info('Segredos .env salvos com sucesso', {
                metadata: { area: 'ipcMyzap', targets: targets.length, localEnvPath }
            });
            return { status: 'success', message: `Segredos salvos com sucesso.` };
        } catch (error) {
            warn('Falha ao salvar segredos .env via IPC', { metadata: { error } });
            return { status: 'error', message: error.message || String(error) };
        }
    });

    ipcMain.handle('myzap:readEnvSecrets', async () => {
        try {
            const myzapDir = String(envStore.get('myzap_diretorio') || '').trim();
            const localEnv = myzapDir ? path.join(myzapDir, '.env') : '';
            const templateEnv = path.join(__dirname, '..', 'myzap', 'configs', '.env');
            const storeEnv = String(envStore.get('myzap_envContent') || '');
            let envContent = '';
            if (localEnv && fs.existsSync(localEnv)) {
                envContent = fs.readFileSync(localEnv, 'utf8');
            } else if (storeEnv) {
                envContent = storeEnv;
            } else if (fs.existsSync(templateEnv)) {
                envContent = fs.readFileSync(templateEnv, 'utf8');
            }
            return parseEnvSecrets(envContent);
        } catch (error) {
            warn('Falha ao ler segredos .env via IPC', { metadata: { error } });
            return { TOKEN: '', OPENAI_API_KEY: '', EMAIL_TOKEN: '' };
        }
    });

    ipcMain.handle('myzap:clearUserRemovedFlag', async () => {
        try {
            envStore.delete('myzap_userRemovedLocal');
            info('Flag myzap_userRemovedLocal removida pelo usuario (re-install solicitado)', {
                metadata: { area: 'ipcMyzap' }
            });
            return { status: 'success' };
        } catch (error) {
            warn('Falha ao limpar flag userRemovedLocal via IPC', { metadata: { error } });
            return { status: 'error', message: error.message || String(error) };
        }
    });
}

module.exports = {
    registerMyZapHandlers
};
