const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const Store = require('electron-store');
const { info, warn, error } = require('./myzapLogger').forArea('install');
const { killProcessesOnPort, commandExists, isPortInUse } = require('./processUtils');
const { getDefaultMyZapDirectory } = require('./autoConfig');
const { killMyZapProcess } = require('./iniciarMyZap');
const { transition, forceTransition } = require('./stateMachine');
const { clearProgress } = require('./progress');

const store = new Store();
const KILL_RETRY_ATTEMPTS = 3;
const KILL_RETRY_DELAY_MS = 1000;

function unique(values = []) {
    return [...new Set(values.filter(Boolean).map((item) => String(item).trim()).filter(Boolean))];
}

function isSafeResetPath(targetPath) {
    if (!targetPath) return false;
    const normalized = path.resolve(String(targetPath));
    const lowered = normalized.toLowerCase();
    const base = path.basename(normalized).toLowerCase();

    if (base === 'myzap') return true;
    if (lowered.endsWith(`${path.sep}myzap`)) return true;
    if (lowered.includes(`${path.sep}myzap${path.sep}`)) return true;
    return false;
}

function pathExists(targetPath) {
    try {
        return fs.existsSync(targetPath);
    } catch (_err) {
        return false;
    }
}

function getRemainingEntriesPreview(targetPath) {
    try {
        if (!pathExists(targetPath)) {
            return [];
        }

        return fs.readdirSync(targetPath).slice(0, 10);
    } catch (err) {
        return [`[erro_ao_listar:${err?.message || String(err)}]`];
    }
}

function runWindowsDirectoryRemovalFallback(targetPath) {
    const normalized = path.resolve(String(targetPath));
    const safePowerShellPath = normalized.replace(/'/g, "''");
    const commandLine = `attrib -r -h -s "${normalized}\\*" /s /d 2>nul & rmdir /s /q "${normalized}"`;
    const attempts = [];
    const commands = [
        {
            label: 'cmd-rmdir',
            command: 'cmd.exe',
            args: ['/d', '/s', '/c', commandLine]
        },
        {
            label: 'powershell-removeitem',
            command: 'powershell.exe',
            args: [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                `$ErrorActionPreference='Stop'; $path='${safePowerShellPath}'; if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop; }`
            ]
        }
    ];

    for (const attempt of commands) {
        if (!pathExists(normalized)) {
            break;
        }

        const result = spawnSync(attempt.command, attempt.args, {
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
            timeout: 15000
        });

        attempts.push({
            label: attempt.label,
            status: typeof result.status === 'number' ? result.status : null,
            stdout: String(result.stdout || '').trim(),
            stderr: String(result.stderr || '').trim(),
            error: result.error?.message || null
        });
    }

    return attempts;
}

function removeDirectory(targetPath) {
    const normalized = path.resolve(String(targetPath));

    if (!isSafeResetPath(normalized)) {
        return {
            path: normalized,
            removed: false,
            skipped: true,
            reason: 'caminho_unsafe'
        };
    }

    if (!fs.existsSync(normalized)) {
        return {
            path: normalized,
            removed: false,
            skipped: true,
            reason: 'nao_existe'
        };
    }

    const attempts = [];

    try {
        fs.rmSync(normalized, {
            recursive: true,
            force: true,
            maxRetries: 8,
            retryDelay: 250
        });
        attempts.push({
            label: 'fs-rmSync',
            ok: !pathExists(normalized)
        });
    } catch (err) {
        attempts.push({
            label: 'fs-rmSync',
            ok: false,
            error: err?.message || String(err)
        });
    }

    if (pathExists(normalized) && process.platform === 'win32') {
        attempts.push(...runWindowsDirectoryRemovalFallback(normalized));
    }

    if (!pathExists(normalized)) {
        return {
            path: normalized,
            removed: true,
            skipped: false,
            attempts
        };
    }

    const remainingEntries = getRemainingEntriesPreview(normalized);
    const lastError = attempts
        .map((attempt) => attempt?.error || attempt?.stderr || null)
        .filter(Boolean)
        .pop();

    return {
        path: normalized,
        removed: false,
        skipped: false,
        reason: lastError || 'diretorio_persistiu_apos_tentativas',
        remainingEntries,
        attempts
    };
}

function runCommand(command, args = [], options = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            shell: false,
            windowsHide: true,
            ...options
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('error', (err) => {
            resolve({
                ok: false,
                code: null,
                stdout,
                stderr,
                error: err?.message || String(err)
            });
        });

        child.on('close', (code) => {
            resolve({
                ok: code === 0,
                code,
                stdout,
                stderr,
                error: null
            });
        });
    });
}

async function tryUninstallToolsWindows() {
    if (!(await commandExists('winget'))) {
        return {
            attempted: false,
            status: 'warning',
            message: 'winget nao encontrado. Remocao de Git/Node nao executada.'
        };
    }

    const packageIds = [
        'Git.Git',
        'OpenJS.NodeJS.LTS',
        'OpenJS.NodeJS'
    ];

    const results = [];
    for (const pkg of packageIds) {
        const result = await runCommand('winget', [
            'uninstall',
            '--id',
            pkg,
            '-e',
            '--silent',
            '--disable-interactivity'
        ]);
        results.push({
            packageId: pkg,
            ...result
        });
    }

    const successCount = results.filter((item) => item.ok).length;
    const hasAnySuccess = successCount > 0;
    return {
        attempted: true,
        status: hasAnySuccess ? 'success' : 'warning',
        message: hasAnySuccess
            ? 'Tentativa de remocao de Git/Node concluida no Windows (verifique resultados).'
            : 'Nao foi possivel remover Git/Node automaticamente no Windows.',
        results
    };
}

async function tryUninstallToolsLinux() {
    if (!(await commandExists('sudo')) || !(await commandExists('apt'))) {
        return {
            attempted: false,
            status: 'warning',
            message: 'Remocao automatica de Git/Node no Linux requer sudo+apt.'
        };
    }

    const result = await runCommand('sudo', ['-n', 'apt', 'remove', '-y', 'git', 'nodejs', 'npm']);
    return {
        attempted: true,
        status: result.ok ? 'success' : 'warning',
        message: result.ok
            ? 'Git/Node removidos via apt.'
            : 'Nao foi possivel remover Git/Node no Linux sem interacao (sudo -n).',
        results: [result]
    };
}

async function tryUninstallToolsMac() {
    if (!(await commandExists('brew'))) {
        return {
            attempted: false,
            status: 'warning',
            message: 'Homebrew nao encontrado. Remocao de Git/Node nao executada.'
        };
    }

    const commands = [
        ['brew', ['uninstall', 'git']],
        ['brew', ['uninstall', 'node']]
    ];

    const results = [];
    for (const [command, args] of commands) {
        const result = await runCommand(command, args);
        results.push(result);
    }

    const hasAnySuccess = results.some((item) => item.ok);
    return {
        attempted: true,
        status: hasAnySuccess ? 'success' : 'warning',
        message: hasAnySuccess
            ? 'Tentativa de remocao de Git/Node concluida no macOS (verifique resultados).'
            : 'Nao foi possivel remover Git/Node automaticamente no macOS.',
        results
    };
}

async function tryUninstallToolsByPlatform() {
    const platform = os.platform();
    if (platform === 'win32') {
        return tryUninstallToolsWindows();
    }
    if (platform === 'darwin') {
        return tryUninstallToolsMac();
    }
    return tryUninstallToolsLinux();
}

function clearMyZapStoreKeys() {
    const keys = [
        'myzap_diretorio',
        'myzap_sessionKey',
        'myzap_sessionName',
        'myzap_apiToken',
        'myzap_envContent',
        'myzap_promptId',
        'myzap_iaAtiva',
        'myzap_mensagemPadrao',
        'myzap_modoIntegracao',
        'myzap_rodarLocal',
        'myzap_remoteConfigOk',
        'myzap_remoteConfigCheckedAt',
        'myzap_lastRemoteConfigSyncAt',
        'myzap_backendProfileKey',
        'myzap_backendApiUrl',
        'myzap_backendApiToken',
        'myzap_capabilityIaConfigMode',
        'myzap_capabilityTokenSyncMode',
        'myzap_capabilityPassiveStatusMode',
        'myzap_capabilityQueuePollingMode',
        'myzap_capabilitySnapshot',
        'myzap_capabilityRemoteHints',
        'myzap_progress',
        'clickexpress_apiUrl',
        'clickexpress_queueToken'
    ];

    keys.forEach((key) => store.delete(key));
    return keys;
}

async function resetMyZapEnvironment(options = {}) {
    const removeTools = Boolean(options.removeTools);
    const confirmToolRemoval = Boolean(options.confirmToolRemoval);
    const storedPath = String(store.get('myzap_diretorio') || '').trim();
    const defaultPath = getDefaultMyZapDirectory();
    const directories = unique([storedPath, defaultPath]);

    // Transitar para estado 'resetting'
    transition('resetting', { message: 'Resetando ambiente local do MyZap...', removeTools });

    info('Reset do ambiente local MyZap solicitado', {
        metadata: {
            area: 'resetEnvironment',
            removeTools,
            confirmToolRemoval,
            directories
        }
    });

    const warnings = [];
    const fatalErrors = [];

    try {
        // 1. Matar child process rastreado
        try {
            killMyZapProcess();
        } catch (err) {
            warnings.push(`killMyZapProcess: ${err?.message || String(err)}`);
        }

        // 2. Kill processos nas portas com retry
        const portsResult = [];
        for (const port of [5555, 3333]) {
            let result;
            for (let attempt = 1; attempt <= KILL_RETRY_ATTEMPTS; attempt++) {
                result = killProcessesOnPort(port);
                portsResult.push({ port, attempt, ...result });

                if (result.failed.length === 0) break;

                if (attempt < KILL_RETRY_ATTEMPTS) {
                    await new Promise((resolve) => setTimeout(resolve, KILL_RETRY_DELAY_MS));
                }
            }

            // Verificar se porta foi realmente liberada
            const stillInUse = await isPortInUse(port);
            if (stillInUse) {
                const msg = `Porta ${port} ainda em uso apos ${KILL_RETRY_ATTEMPTS} tentativas de kill`;
                warn(msg, { metadata: { area: 'resetEnvironment', port } });
                fatalErrors.push(msg);
            }
        }

        // 2b. Aguardar liberacao de file locks no Windows antes de remover diretorios
        if (process.platform === 'win32') {
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }

        // 3. Remover diretorios
        const directoryResults = directories.map((dir) => removeDirectory(dir));
        directoryResults.forEach((result) => {
            if (result.removed) {
                return;
            }

            if (result.skipped && result.reason === 'nao_existe') {
                return;
            }

            const remainingInfo = result.remainingEntries?.length
                ? ` Itens restantes: ${result.remainingEntries.join(', ')}`
                : '';
            const message = result.skipped
                ? `Diretorio ignorado no reset: ${result.path} (${result.reason || 'motivo_desconhecido'})`
                : `Falha ao remover diretorio ${result.path}: ${result.reason || 'motivo_desconhecido'}.${remainingInfo}`;

            warn(message, {
                metadata: {
                    area: 'resetEnvironment',
                    directoryResult: result
                }
            });
            fatalErrors.push(message.trim());
        });

        // 4. Limpar store
        const clearedKeys = clearMyZapStoreKeys();

        // 4b. Limpar progresso ativo (evita stale)
        clearProgress();

        // 4c. Marcar que usuario removeu explicitamente (impede auto-install)
        store.set('myzap_userRemovedLocal', true);

        // 5. Desinstalar ferramentas (apenas se confirmado)
        let toolsResult = null;
        if (removeTools && confirmToolRemoval) {
            toolsResult = await tryUninstallToolsByPlatform();
        } else if (removeTools && !confirmToolRemoval) {
            toolsResult = {
                attempted: false,
                status: 'warning',
                message: 'Remocao de ferramentas solicitada mas nao confirmada pelo usuario.'
            };
        }
        if (toolsResult?.status === 'warning' && toolsResult?.message) {
            warnings.push(toolsResult.message);
        }

        // Transitar para idle
        forceTransition('idle', { reason: 'reset_completo' });

        const allWarnings = [...warnings, ...fatalErrors];
        const status = fatalErrors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'success';

        const response = {
            status,
            message: fatalErrors.length > 0
                ? 'Falha ao remover completamente o ambiente local do MyZap.'
                : warnings.length > 0
                    ? `Reset executado com avisos: ${warnings.join('; ')}`
                : removeTools
                    ? 'Reset completo executado. Verifique remocao de Git/Node nos detalhes.'
                    : 'Ambiente local do MyZap resetado com sucesso.',
            data: {
                directories: directoryResults,
                ports: portsResult,
                clearedKeys,
                tools: toolsResult,
                warnings: allWarnings,
                fatalErrors
            }
        };

        info('Reset do ambiente local MyZap concluido', {
            metadata: {
                area: 'resetEnvironment',
                removeTools,
                directoryResults,
                portsResult,
                toolsStatus: toolsResult?.status || null,
                warnings,
                fatalErrors,
                finalStatus: status
            }
        });

        return response;
    } catch (err) {
        // Em caso de erro critico, transitar para error
        forceTransition('error', { message: err?.message || String(err), phase: 'reset' });

        error('Erro ao resetar ambiente local MyZap', {
            metadata: {
                area: 'resetEnvironment',
                error: err,
                error_message: err?.message || String(err),
                error_stack: err?.stack || null
            }
        });
        return {
            status: 'error',
            message: err?.message || String(err)
        };
    }
}

module.exports = {
    resetMyZapEnvironment
};
