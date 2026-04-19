const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { error: logError, warn, info } = require('./myzapLogger').forArea('install');
const {
  killProcessesOnPort,
  getPnpmCommand,
  findSystemNodePath,
  findInstalledSystemNodePath,
  resetSystemNodePathCache,
  refreshPathWindows,
  getSystemGitCommand,
  getPrivilegeStatus,
  buildAdminRequiredMessage,
} = require('./processUtils');
const { ensureSystemNodeInstalled, ensureSystemGitInstalled } = require('./systemToolInstaller');
const { iniciarMyZap } = require('./iniciarMyZap');
const { syncMyZapConfigs } = require('./syncConfigs');
const { transition } = require('./stateMachine');
const { downloadRepositoryArchive } = require('./repositoryArchive');
const { createInstallDebugLogContext } = require('./installDebugLog');
const {
  assertDependenciesHealthy,
  writeInstallOkMarker,
  clearInstallOkMarker,
} = require('./dependencyHealth');

const MYZAP_GIT_URL = 'https://github.com/JZ-TECH-SYS/myzap.git';

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function getCommandFailureDetail(commandResult) {
  if (!commandResult) {
    return '';
  }

  const lines = [
    String(commandResult.errorMessage || '').trim(),
    ...String(commandResult.stderr || '').split(/\r?\n/),
    ...String(commandResult.stdout || '').split(/\r?\n/),
  ]
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^>/i.test(line))
    .filter((line) => !/^at\s+/i.test(line))
    .filter((line) => !/^Lockfile is up to date/i.test(line))
    .filter((line) => !/resolution step is skipped/i.test(line));

  const detail = lines.find((line) => /ERR_PNPM|npm ERR!|unsupported|error|failed/i.test(line))
    || lines.find(Boolean)
    || '';
  return detail.slice(0, 220);
}

function attachDebugLog(result, debugLog) {
  if (!debugLog || !debugLog.filePath || !result || typeof result !== 'object') {
    return result;
  }

  return {
    ...result,
    debugLogPath: debugLog.filePath,
  };
}

function hasValidMyZapFiles(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return false;
  }

  return fs.existsSync(path.join(dirPath, 'package.json'));
}

async function obterCodigoMyZap(dirPath, reportProgress, debugLog) {
  const gitRunner = await getSystemGitCommand();
  fs.mkdirSync(path.dirname(dirPath), { recursive: true });

  if (gitRunner) {
    reportProgress('Clonando codigo do MyZap via Git...', 'git_clone', {
      percent: 35,
      dirPath,
      repositoryUrl: MYZAP_GIT_URL,
    });

    if (debugLog && typeof debugLog.log === 'function') {
      debugLog.log('Iniciando git clone do MyZap', {
        dirPath,
        repositoryUrl: MYZAP_GIT_URL,
        gitCommand: gitRunner.command,
      });
    }

    const cloneEnv = {
      ...gitRunner.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    };
    const cloneResult = await rodarComando(
      {
        ...gitRunner,
        env: cloneEnv,
        source: 'system-git-clone',
      },
      ['clone', '--depth', '1', '--branch', 'main', MYZAP_GIT_URL, dirPath],
      {
        cwd: path.dirname(dirPath),
        debugLog,
      },
    );

    if (cloneResult.ok && hasValidMyZapFiles(dirPath)) {
      if (process.platform === 'win32') {
        await rodarComando(
          {
            ...gitRunner,
            env: cloneEnv,
            source: 'system-git-config-longpaths',
          },
          ['config', 'core.longpaths', 'true'],
          {
            cwd: dirPath,
            debugLog,
          },
        );
      }

      info('Codigo do MyZap obtido com sucesso via git clone', {
        metadata: {
          area: 'clonarRepositorio',
          dirPath,
          source: 'git-clone',
          repositoryUrl: MYZAP_GIT_URL,
        },
      });

      if (debugLog && typeof debugLog.log === 'function') {
        debugLog.log('Git clone do MyZap concluido com sucesso', {
          dirPath,
          repositoryUrl: MYZAP_GIT_URL,
        });
      }

      return {
        status: 'success',
        source: 'git-clone',
      };
    }

    const cloneDetail = getCommandFailureDetail(cloneResult);
    warn('git clone do MyZap falhou, tentando fallback via ZIP', {
      metadata: {
        area: 'clonarRepositorio',
        dirPath,
        repositoryUrl: MYZAP_GIT_URL,
        exitCode: cloneResult.exitCode,
        errorMessage: cloneResult.errorMessage,
        detail: cloneDetail,
      },
    });

    if (debugLog && typeof debugLog.log === 'function') {
      debugLog.log('git clone do MyZap falhou, iniciando fallback via ZIP', {
        dirPath,
        repositoryUrl: MYZAP_GIT_URL,
        exitCode: cloneResult.exitCode,
        errorMessage: cloneResult.errorMessage,
        detail: cloneDetail,
      });
    }

    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (_cleanupErr) { /* melhor esforco */ }
  }

  reportProgress('Baixando pacote compactado do MyZap...', 'download_archive', {
    percent: 35,
    dirPath,
  });

  await downloadRepositoryArchive(dirPath, {
    onProgress: reportProgress,
    debugLog,
  });

  return {
    status: 'success',
    source: 'zip-download',
  };
}

function rodarComando(executor, args, opcoes = {}) {
  return new Promise((resolve) => {
    const debugLog = opcoes.debugLog;
    const spawnOptions = { ...opcoes };
    delete spawnOptions.debugLog;
    const runner = (typeof executor === 'string')
      ? {
        command: executor,
        prefixArgs: [],
        shell: true,
        env: process.env,
        source: executor,
      }
      : {
        prefixArgs: [],
        shell: false,
        env: process.env,
        source: executor && executor.command ? executor.command : undefined,
        ...executor,
      };
    const proc = spawn(runner.command, [...runner.prefixArgs, ...args], {
      shell: runner.shell,
      env: runner.env,
      windowsHide: true,
      ...spawnOptions,
    });
    const commandLabel = runner.source || runner.command;
    let stdout = '';
    let stderr = '';
    let spawnErrorMessage = '';

    if (debugLog && typeof debugLog.log === 'function') {
      debugLog.log('Executando comando do instalador MyZap', {
        comando: runner.command,
        args: [...runner.prefixArgs, ...args],
        cwd: spawnOptions.cwd,
        source: runner.source,
        shell: runner.shell,
      });
    }

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      if (debugLog && typeof debugLog.log === 'function') {
        debugLog.log('STDOUT do comando do instalador', {
          comando: commandLabel,
          output: text.trim(),
        });
      }
      info('MyZap comando stdout', {
        metadata: {
          area: 'clonarRepositorio',
          comando: commandLabel,
          output: String(data).trim(),
        },
      });
    });
    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (debugLog && typeof debugLog.log === 'function') {
        debugLog.log('STDERR do comando do instalador', {
          comando: commandLabel,
          output: text.trim(),
        });
      }
      warn('MyZap comando stderr', {
        metadata: {
          area: 'clonarRepositorio',
          comando: commandLabel,
          output: String(data).trim(),
        },
      });
    });

    proc.on('close', (code) => resolve({
      ok: code === 0,
      exitCode: code,
      stdout,
      stderr,
      errorMessage: spawnErrorMessage,
    }));
    proc.on('error', (err) => {
      spawnErrorMessage = getErrorMessage(err);
      if (debugLog && typeof debugLog.log === 'function') {
        debugLog.log('Erro ao spawnar comando do instalador', {
          comando: commandLabel,
          error: spawnErrorMessage,
        });
      }
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr,
        errorMessage: spawnErrorMessage,
      });
    });
  });
}

/**
 * Remove lockfiles que conflitam com pnpm (ex.: package-lock.json residual de npm).
 * Mantem pnpm-lock.yaml.
 */
function limparLockfilesConflitantes(dirPath, debugLog) {
  const npmLock = path.join(dirPath, 'package-lock.json');
  const yarnLock = path.join(dirPath, 'yarn.lock');
  const removed = [];
  for (const file of [npmLock, yarnLock]) {
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
        removed.push(path.basename(file));
      } catch (_err) { /* melhor esforco */ }
    }
  }
  if (removed.length && debugLog && typeof debugLog.log === 'function') {
    debugLog.log('Lockfiles conflitantes removidos antes do pnpm install', { removed });
  }
}

function removerNodeModules(dirPath, debugLog) {
  const nm = path.join(dirPath, 'node_modules');
  if (!fs.existsSync(nm)) return false;
  try {
    fs.rmSync(nm, { recursive: true, force: true });
    if (debugLog && typeof debugLog.log === 'function') {
      debugLog.log('node_modules removido para reinstalacao limpa', { nm });
    }
    return true;
  } catch (err) {
    if (debugLog && typeof debugLog.log === 'function') {
      debugLog.log('Falha ao remover node_modules', { nm, error: getErrorMessage(err) });
    }
    return false;
  }
}

/**
 * Instala dependencias do MyZap com pnpm, com retry/repair idempotente.
 * Estrategia (ate 3 tentativas):
 *   1) pnpm install --prefer-offline --frozen-lockfile (se pnpm-lock.yaml existir),
 *      senao pnpm install --prefer-offline.
 *   2) pnpm install (sem frozen).
 *   3) pnpm store prune (best-effort) + remove node_modules + pnpm install.
 *
 * Apos cada tentativa bem-sucedida do pnpm, valida com assertDependenciesHealthy.
 * Se sucesso, escreve marker .gerenciador-myzap-install-ok.
 * Logs estruturados via debugLog.section / debugLog.log em CADA tentativa.
 */
async function installDependencies(pnpmRunner, dirPath, debugLog, gitCommit = null) {
  clearInstallOkMarker(dirPath);
  limparLockfilesConflitantes(dirPath, debugLog);

  const hasPnpmLock = fs.existsSync(path.join(dirPath, 'pnpm-lock.yaml'));
  const tentativas = [
    {
      label: 'frozen-lockfile + prefer-offline',
      args: hasPnpmLock
        ? ['install', '--prefer-offline', '--frozen-lockfile']
        : ['install', '--prefer-offline'],
      pre: null,
    },
    {
      label: 'install sem frozen',
      args: ['install'],
      pre: null,
    },
    {
      label: 'store prune + nuke node_modules + install',
      args: ['install'],
      pre: async () => {
        if (debugLog && typeof debugLog.log === 'function') {
          debugLog.log('Executando pnpm store prune (best-effort) antes do reinstall total');
        }
        await rodarComando(pnpmRunner, ['store', 'prune'], { cwd: dirPath, debugLog });
        removerNodeModules(dirPath, debugLog);
      },
    },
  ];

  let lastResult = null;
  let lastHealth = null;

  for (let i = 0; i < tentativas.length; i += 1) {
    const t = tentativas[i];
    const headerTitle = `tentativa ${i + 1}/${tentativas.length} (${t.label})`;
    if (debugLog && typeof debugLog.section === 'function') {
      debugLog.section(headerTitle);
    }
    info(`pnpm install — ${headerTitle}`, {
      metadata: {
        area: 'clonarRepositorio',
        tentativa: i + 1,
        modo: t.label,
        runner: pnpmRunner.source || pnpmRunner.command,
        pnpmVersion: pnpmRunner.version || null,
        dirPath,
      },
    });

    if (typeof t.pre === 'function') {
      try { await t.pre(); } catch (_e) { /* best-effort */ }
    }

    lastResult = await rodarComando(pnpmRunner, t.args, { cwd: dirPath, debugLog });

    if (!lastResult.ok) {
      warn('pnpm install falhou nesta tentativa', {
        metadata: {
          area: 'clonarRepositorio',
          tentativa: i + 1,
          modo: t.label,
          exitCode: lastResult.exitCode,
        },
      });
      continue;
    }

    lastHealth = assertDependenciesHealthy(dirPath);
    if (lastHealth.ok) {
      const markerPath = writeInstallOkMarker(dirPath, {
        pnpmVersion: pnpmRunner.version || null,
        runnerSource: pnpmRunner.source || pnpmRunner.command,
        gitCommit: gitCommit || null,
        attempts: i + 1,
        mode: t.label,
      });
      info('Dependencias instaladas e validadas com sucesso', {
        metadata: {
          area: 'clonarRepositorio',
          dirPath,
          tentativa: i + 1,
          modo: t.label,
          markerPath,
        },
      });
      if (debugLog && typeof debugLog.log === 'function') {
        debugLog.log('Marker de instalacao concluida gravado', {
          markerPath,
          attempts: i + 1,
          mode: t.label,
        });
      }
      return { ok: true, attempts: i + 1, mode: t.label, lastResult, health: lastHealth };
    }

    warn('pnpm install retornou ok=true mas dependencyHealth falhou', {
      metadata: {
        area: 'clonarRepositorio',
        tentativa: i + 1,
        modo: t.label,
        reason: lastHealth.reason,
        missingCount: (lastHealth.missing || []).length,
      },
    });
  }

  return {
    ok: false,
    attempts: tentativas.length,
    lastResult,
    health: lastHealth,
  };
}

/**
 * Faz backup dos arquivos do usuario que NAO devem ser perdidos em reinstall:
 *   - .env
 *   - database/ (db.sqlite e afins)
 *   - tokens/ (sessao WhatsApp do MyZap)
 * Retorna o caminho do diretorio de backup, ou null se nao havia nada.
 */
function backupUserDataAntesDeReinstall(dirPath, debugLog) {
  if (!fs.existsSync(dirPath)) return null;

  const candidatos = ['.env', 'database', 'tokens', '.wwebjs_auth'];
  const existentes = candidatos.filter((nome) => fs.existsSync(path.join(dirPath, nome)));
  if (!existentes.length) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(path.dirname(dirPath), `_backup-${path.basename(dirPath)}-${stamp}`);
  try {
    fs.mkdirSync(backupRoot, { recursive: true });
  } catch (err) {
    warn('Nao foi possivel criar pasta de backup antes do reinstall', {
      metadata: { area: 'clonarRepositorio', backupRoot, error: getErrorMessage(err) },
    });
    return null;
  }

  for (const nome of existentes) {
    const src = path.join(dirPath, nome);
    const dst = path.join(backupRoot, nome);
    try {
      // fs.cpSync existe no Node >= 16.7
      fs.cpSync(src, dst, { recursive: true, force: true, errorOnExist: false });
    } catch (err) {
      warn('Falha ao copiar item para backup do reinstall', {
        metadata: { area: 'clonarRepositorio', nome, src, dst, error: getErrorMessage(err) },
      });
    }
  }

  if (debugLog && typeof debugLog.log === 'function') {
    debugLog.log('Backup de dados do usuario realizado antes do reinstall', {
      backupRoot,
      itens: existentes,
    });
  }
  info('Backup de dados do MyZap realizado antes do reinstall', {
    metadata: { area: 'clonarRepositorio', backupRoot, itens: existentes },
  });

  return backupRoot;
}

function restaurarBackupAposReinstall(backupRoot, dirPath, debugLog) {
  if (!backupRoot || !fs.existsSync(backupRoot) || !fs.existsSync(dirPath)) {
    return;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(backupRoot);
  } catch (_err) { return; }

  const restaurados = [];
  for (const nome of entries) {
    const src = path.join(backupRoot, nome);
    const dst = path.join(dirPath, nome);
    try {
      // .env e database voltam por padrao; tokens/.wwebjs_auth tambem
      // (preservar sessao WhatsApp evita re-escanear QR sem motivo)
      if (fs.existsSync(dst)) {
        // Se ja existe (ex.: .env recriado pelo syncConfigs), nao sobrescrever
        // sessao/database — mas restaurar se nao existir.
        if (nome === '.env') continue;
      }
      fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
      restaurados.push(nome);
    } catch (err) {
      warn('Falha ao restaurar item do backup', {
        metadata: { area: 'clonarRepositorio', nome, error: getErrorMessage(err) },
      });
    }
  }

  if (debugLog && typeof debugLog.log === 'function') {
    debugLog.log('Restauracao de backup apos reinstall concluida', { backupRoot, restaurados });
  }
}

async function clonarRepositorio(dirPath, envContent, reinstall = false, options = {}) {  let debugLog = null;
  try {
    try {
      debugLog = createInstallDebugLogContext({ dirPath, reinstall });
      debugLog.section('inicio');
      debugLog.log('Fluxo de instalacao do MyZap iniciado', { dirPath, reinstall });
      info('Arquivo de debug da instalacao do MyZap criado', {
        metadata: { area: 'clonarRepositorio', dirPath, reinstall, debugLogPath: debugLog.filePath },
      });
    } catch (_debugLogErr) {
      debugLog = null;
    }

    const reportProgressBase = (typeof options.onProgress === 'function')
      ? options.onProgress
      : () => {};
    const reportProgress = (message, phase, metadata = {}) => {
      if (debugLog && typeof debugLog.log === 'function') {
        debugLog.log('Progresso da instalacao', { message, phase, ...metadata });
      }
      reportProgressBase(message, phase, metadata);
    };

    const privilegeStatus = getPrivilegeStatus();
    if (debugLog && typeof debugLog.log === 'function') {
      debugLog.log('Privilegios verificados', { privilegeStatus });
    }
    if (privilegeStatus.requiresAdminForLocalInstall && !privilegeStatus.isElevated) {
      const message = buildAdminRequiredMessage(
        reinstall ? 'reinstalar o MyZap local' : 'instalar o MyZap local',
      );

      warn('Instalacao local do MyZap bloqueada por falta de privilegios de administrador', {
        metadata: {
          area: 'clonarRepositorio',
          dirPath,
          reinstall,
          privilegeStatus,
        },
      });

      reportProgress(message, 'admin_required', {
        dirPath,
        reinstall,
        privilegeStatus,
        percent: 100,
      });
      transition('error', {
        message,
        dirPath,
        reinstall,
        privilegeStatus,
      });

      return attachDebugLog({
        status: 'error',
        requiresAdmin: true,
        privilegeStatus,
        message,
      }, debugLog);
    }

    reportProgress('Preparando instalacao automatica do MyZap...', 'precheck', {
      percent: 10,
      dirPath,
    });

    info('=== Inicio do fluxo de instalacao/clonagem do MyZap ===', {
      metadata: { area: 'clonarRepositorio', dirPath, reinstall },
    });

    transition('checking_config', { message: 'Preparando instalacao automatica do MyZap...', dirPath });

    info('Detectando gerenciador de pacotes para instalacao...', {
      metadata: { area: 'clonarRepositorio', dirPath },
    });

    reportProgress('Preparando ferramentas internas do gerenciador...', 'prepare_internal_runtimes', {
      percent: 12,
      dirPath,
    });

    const currentSystemNode = findInstalledSystemNodePath();
    if (!currentSystemNode && process.platform === 'win32') {
      try {
        await ensureSystemNodeInstalled({ onProgress: reportProgress, debugLog });
        resetSystemNodePathCache();
        refreshPathWindows();
      } catch (nodeInstallErr) {
        logError('Falha ao instalar Node.js normal para o MyZap.', {
          metadata: {
            area: 'clonarRepositorio',
            dirPath,
            error: getErrorMessage(nodeInstallErr),
          },
        });
        return attachDebugLog({
          status: 'error',
          message: `Nao foi possivel instalar o Node.js necessario para o MyZap: ${getErrorMessage(nodeInstallErr)}`,
        }, debugLog);
      }
    }

    const confirmedSystemNode = findInstalledSystemNodePath();
    if (!confirmedSystemNode) {
      return attachDebugLog({
        status: 'error',
        message: 'Node.js compativel nao foi encontrado nem instalado. A instalacao do MyZap foi interrompida.',
      }, debugLog);
    }

    if (process.platform === 'win32') {
      const gitRunnerBeforeInstall = await getSystemGitCommand();
      if (!gitRunnerBeforeInstall) {
        try {
          await ensureSystemGitInstalled({ onProgress: reportProgress, debugLog });
          refreshPathWindows();
        } catch (gitInstallErr) {
          warn('Nao foi possivel instalar o Git normal no Windows. O MyZap continuara sem atualizacao via git.', {
            metadata: {
              area: 'clonarRepositorio',
              dirPath,
              error: getErrorMessage(gitInstallErr),
            },
          });
          if (debugLog && typeof debugLog.log === 'function') {
            debugLog.log('Falha ao instalar Git normal, seguindo sem git', {
              error: getErrorMessage(gitInstallErr),
            });
          }
        }
      }
    }

    if (debugLog && typeof debugLog.log === 'function') {
      debugLog.log('Node.js compativel confirmado antes do pnpm install', {
        nodePath: confirmedSystemNode,
      });
    }

    if (confirmedSystemNode && debugLog && typeof debugLog.log === 'function') {
      debugLog.log('Git/Node do sistema preparados para instalacao do MyZap', {
        nodePath: confirmedSystemNode,
      });
    }

    if (debugLog && typeof debugLog.log === 'function') {
      debugLog.log('Preparacao de dependencias do sistema concluida', {
        nodePath: confirmedSystemNode,
      });
    }

    const pnpmRunner = await getPnpmCommand();
    if (!pnpmRunner) {
      logError('Nenhum gerenciador de pacotes disponivel (pnpm/npx/npm) mesmo apos preparar runtime interno.', {
        metadata: {
          area: 'clonarRepositorio',
          dirPath,
          dica: 'Verificar internet, permissao de escrita em LOCALAPPDATA e logs do gerenciador.',
        },
      });
      return attachDebugLog({
        status: 'error',
        message: 'Nao foi possivel preparar o instalador interno de dependencias do MyZap. Verifique sua conexao com a internet e tente novamente.',
      }, debugLog);
    }

    if (debugLog && typeof debugLog.log === 'function') {
      debugLog.log('Runner de dependencias selecionado', {
        runnerSource: pnpmRunner.source || pnpmRunner.command,
        command: pnpmRunner.command,
        prefixArgs: pnpmRunner.prefixArgs,
      });
    }

    info('Runner de dependencias selecionado para instalacao do MyZap', {
      metadata: {
        area: 'clonarRepositorio',
        runnerSource: pnpmRunner.source || pnpmRunner.command,
        dirPath,
      },
    });

    if (reinstall) {
      reportProgress('Reinstalacao solicitada. Limpando instalacao anterior...', 'reinstall_cleanup', {
        percent: 20,
        dirPath,
      });
      info('Iniciando modo de reinstalacao do MyZap', { metadata: { dirPath } });

      const killResult = killProcessesOnPort(5555);
      if (killResult.failed.length > 0) {
        warn('Nao foi possivel finalizar alguns processos na porta 5555', {
          metadata: { failed: killResult.failed },
        });
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      // Backup nao-destrutivo de .env, database e sessao WhatsApp antes do nuke
      const backupRoot = backupUserDataAntesDeReinstall(dirPath, debugLog);
      options.__reinstallBackupRoot = backupRoot || null;

      if (fs.existsSync(dirPath)) {
        try {
          fs.rmSync(dirPath, { recursive: true, force: true });
        } catch (err) {
          logError('Erro ao remover pasta do MyZap na reinstalacao', { metadata: { err, dirPath } });
          return attachDebugLog({
            status: 'error',
            message: `Falha ao remover diretorio atual do MyZap: ${err.message}`,
          }, debugLog);
        }
      }
    }

    transition('cloning_repo', { message: 'Obtendo codigo do MyZap...', dirPath });

    try {
      const sourceResult = await obterCodigoMyZap(dirPath, reportProgress, debugLog);
      if (debugLog && typeof debugLog.log === 'function') {
        debugLog.log('Codigo do MyZap preparado para instalacao', sourceResult);
      }
    } catch (archiveErr) {
      logError('Falha ao obter o codigo do MyZap para instalacao local', {
        metadata: {
          area: 'clonarRepositorio',
          dirPath,
          error: archiveErr,
        },
      });
      return attachDebugLog({
        status: 'error',
        message: getErrorMessage(archiveErr) || 'Erro ao obter o codigo do MyZap para instalacao local.',
      }, debugLog);
    }

    transition('installing_dependencies', { message: 'Instalando dependencias do MyZap...', dirPath });

    info('Iniciando installDependencies (com retry/repair) para instalar dependencias...', {
      metadata: {
        area: 'clonarRepositorio',
        runner: pnpmRunner.source || pnpmRunner.command,
        pnpmVersion: pnpmRunner.version || null,
        dirPath,
      },
    });

    reportProgress('Instalando dependencias do MyZap...', 'install_dependencies', {
      percent: 55,
      dirPath,
    });
    const installDepsResult = await installDependencies(pnpmRunner, dirPath, debugLog);

    if (!installDepsResult.ok) {
      const installDetail = getCommandFailureDetail(installDepsResult.lastResult);
      const healthReason = installDepsResult.health && installDepsResult.health.reason;
      const missingCount = installDepsResult.health && (installDepsResult.health.missing || []).length;
      logError('Falha ao instalar dependencias com pnpm install (todas as tentativas)', {
        metadata: {
          area: 'clonarRepositorio',
          runner: pnpmRunner.source || pnpmRunner.command,
          pnpmVersion: pnpmRunner.version || null,
          dirPath,
          attempts: installDepsResult.attempts,
          exitCode: installDepsResult.lastResult && installDepsResult.lastResult.exitCode,
          errorMessage: installDepsResult.lastResult && installDepsResult.lastResult.errorMessage,
          stderr: installDepsResult.lastResult && installDepsResult.lastResult.stderr,
          stdout: installDepsResult.lastResult && installDepsResult.lastResult.stdout,
          healthReason,
          missingCount,
          dica: 'Detalhe util registrado em stderr/stdout para diagnostico da instalacao.',
        },
      });
      const motivo = installDetail
        || (healthReason === 'dependencies_missing' && `${missingCount} pacote(s) nao instalado(s) apos pnpm install`)
        || healthReason
        || 'erro desconhecido';
      return attachDebugLog({
        status: 'error',
        code: 'INSTALL_DEPS_FAILED',
        attempts: installDepsResult.attempts,
        message: `Pacote do MyZap baixado, mas houve erro ao instalar as dependencias locais: ${motivo}`,
      }, debugLog);
    }

    info('Dependencias instaladas com sucesso', {
      metadata: {
        area: 'clonarRepositorio',
        dirPath,
        attempts: installDepsResult.attempts,
        mode: installDepsResult.mode,
      },
    });

    // Restaurar backup do reinstall (se houve), antes do syncMyZapConfigs
    if (options.__reinstallBackupRoot) {
      restaurarBackupAposReinstall(options.__reinstallBackupRoot, dirPath, debugLog);
    }

    reportProgress('Aplicando configuracoes locais (.env e banco base)...', 'sync_configs', {
      percent: 75,
      dirPath,
    });
    const syncResult = syncMyZapConfigs(dirPath, {
      envContent,
      overwriteDb: true,
    });

    if (syncResult.status === 'error') {
      return attachDebugLog(syncResult, debugLog);
    }

    reportProgress('Iniciando servico local do MyZap...', 'start_service', {
      percent: 88,
      dirPath,
    });
    const startResult = await iniciarMyZap(dirPath, {
      onProgress: reportProgress,
    });
    if (startResult && startResult.status === 'error') {
      return attachDebugLog(startResult, debugLog);
    }

    reportProgress('MyZap local iniciado. Finalizando ajustes...', 'start_confirmed', {
      percent: 95,
      dirPath,
    });
    return attachDebugLog({
      status: 'success',
      message: 'MyZap instalado, configurado e iniciado com sucesso!',
    }, debugLog);
  } catch (err) {
    transition('error', { message: getErrorMessage(err), phase: 'clone_install' });
    logError('Erro critico no processo de instalacao', { metadata: { error: err } });
    return attachDebugLog({ status: 'error', message: `Erro: ${err.message}` }, debugLog);
  }
}

module.exports = clonarRepositorio;
