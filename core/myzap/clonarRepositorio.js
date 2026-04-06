const { spawn } = require('child_process');
const fs = require('fs');
const { error: logError, warn, info } = require('./myzapLogger');
const {
  killProcessesOnPort,
  getPnpmCommand,
  findSystemNodePath,
  getPrivilegeStatus,
  buildAdminRequiredMessage,
} = require('./processUtils');
const {
  ensurePortableNodeRuntime,
  ensurePortableGitRuntime,
} = require('./runtimeTools');
const { iniciarMyZap } = require('./iniciarMyZap');
const { syncMyZapConfigs } = require('./syncConfigs');
const { transition } = require('./stateMachine');
const { downloadRepositoryArchive } = require('./repositoryArchive');
const { createInstallDebugLogContext } = require('./installDebugLog');

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
    .filter((line) => !/^at\s+/i.test(line));

  const detail = lines.find(Boolean) || '';
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

async function clonarRepositorio(dirPath, envContent, reinstall = false, options = {}) {
  let debugLog = null;
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

    try {
      await ensurePortableGitRuntime({ onProgress: reportProgress, debugLog });
    } catch (gitRuntimeErr) {
      warn('Nao foi possivel preparar o Git interno. O fluxo continuara e usara ZIP para instalacao.', {
        metadata: {
          area: 'clonarRepositorio',
          dirPath,
          error: getErrorMessage(gitRuntimeErr),
        },
      });
    }

    try {
      await ensurePortableNodeRuntime({ onProgress: reportProgress, debugLog });
    } catch (nodeRuntimeErr) {
      if (!findSystemNodePath()) {
        logError('Falha ao preparar Node.js interno e nenhum Node.js compativel foi encontrado no sistema.', {
          metadata: {
            area: 'clonarRepositorio',
            dirPath,
            error: getErrorMessage(nodeRuntimeErr),
          },
        });
        return attachDebugLog({
          status: 'error',
          message: 'Nao foi possivel preparar o runtime interno do Node.js para instalar o MyZap. Verifique sua conexao com a internet e tente novamente.',
        }, debugLog);
      }

      warn('Falha ao preparar Node.js interno, mas um Node.js compativel ja existe no sistema. Continuando com o runtime do sistema.', {
        metadata: {
          area: 'clonarRepositorio',
          dirPath,
          error: getErrorMessage(nodeRuntimeErr),
        },
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

    transition('cloning_repo', { message: 'Baixando pacote do MyZap...', dirPath });

    try {
      await downloadRepositoryArchive(dirPath, {
        onProgress: reportProgress,
        debugLog,
      });
    } catch (archiveErr) {
      logError('Falha ao baixar o pacote do MyZap para instalacao local', {
        metadata: {
          area: 'clonarRepositorio',
          dirPath,
          error: archiveErr,
        },
      });
      return attachDebugLog({
        status: 'error',
        message: getErrorMessage(archiveErr) || 'Erro ao baixar o pacote do MyZap para instalacao local.',
      }, debugLog);
    }

    transition('installing_dependencies', { message: 'Instalando dependencias do MyZap...', dirPath });

    info('Executando pnpm install para instalar dependencias...', {
      metadata: {
        area: 'clonarRepositorio',
        runner: pnpmRunner.source || pnpmRunner.command,
        dirPath,
      },
    });

    reportProgress('Instalando dependencias do MyZap...', 'install_dependencies', {
      percent: 55,
      dirPath,
    });
    const installDepsResult = await rodarComando(
      pnpmRunner,
      ['install'],
      { cwd: dirPath, debugLog },
    );

    if (!installDepsResult.ok) {
      const installDetail = getCommandFailureDetail(installDepsResult);
      logError('Falha ao instalar dependencias com pnpm install', {
        metadata: {
          area: 'clonarRepositorio',
          runner: pnpmRunner.source || pnpmRunner.command,
          dirPath,
          exitCode: installDepsResult.exitCode,
          errorMessage: installDepsResult.errorMessage,
          stderr: installDepsResult.stderr,
          stdout: installDepsResult.stdout,
          dica: 'Detalhe util registrado em stderr/stdout para diagnostico da instalacao.',
        },
      });
      return attachDebugLog({
        status: 'error',
        message: installDetail
          ? `Pacote do MyZap baixado, mas houve erro ao instalar as dependencias locais: ${installDetail}`
          : 'Pacote do MyZap baixado, mas houve erro ao instalar as dependencias locais.',
      }, debugLog);
    }

    info('Dependencias instaladas com sucesso', {
      metadata: { area: 'clonarRepositorio', dirPath },
    });

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
