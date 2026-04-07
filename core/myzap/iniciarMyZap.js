const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { error: logError, info, warn } = require('./myzapLogger');
const {
  isPortInUse,
  isLocalHttpServiceReachable,
  getPnpmCommand,
  getGitCommand,
  findSystemNodePath,
  buildCleanEnvForChild,
} = require('./processUtils');
const { transition } = require('./stateMachine');

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function resolveDirectMyZapStartRunner(dirPath) {
  try {
    const packageJsonPath = path.join(dirPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const startScript = String(packageJson?.scripts?.start || '').trim();
    const directNodeMatch = startScript.match(/^node(?:\.exe)?\s+"?([^"\s]+\.js)"?$/i);

    if (!directNodeMatch) {
      return null;
    }

    const entryFile = path.resolve(dirPath, directNodeMatch[1]);
    if (!fs.existsSync(entryFile)) {
      return null;
    }

    // Preferir Node.js real do sistema — Puppeteer/Chrome nao funciona bem
    // quando o processo pai e o Electron com ELECTRON_RUN_AS_NODE=1
    const systemNode = findSystemNodePath();
    if (systemNode) {
      info('Usando Node.js real do sistema para iniciar MyZap (direct-node)', {
        metadata: { area: 'iniciarMyZap', nodePath: systemNode, entryFile },
      });
      return {
        command: systemNode,
        prefixArgs: [entryFile],
        shell: false,
        env: buildCleanEnvForChild(),
        source: 'direct-node-start',
      };
    }

    // NAO usar Electron como fallback — Puppeteer/Chrome falha com ELECTRON_RUN_AS_NODE.
    // Retornar null para cair no getPnpmCommand() que tem mais opcoes de fallback.
    warn('Node.js real nao encontrado para direct-node; delegando para getPnpmCommand', {
      metadata: { area: 'iniciarMyZap', electronPath: process.execPath },
    });
    return null;
  } catch (_err) {
    return null;
  }
}

/** Referencia ao child process ativo do MyZap (pnpm start) */
let myzapChildProcess = null;

/**
 * Mata o child process rastreado do MyZap, se existir.
 */
function killMyZapProcess() {
  if (!myzapChildProcess) {
    info('killMyZapProcess: nenhum child process rastreado para matar', {
      metadata: { area: 'iniciarMyZap' },
    });
    return;
  }

  try {
    const { pid } = myzapChildProcess;
    if (process.platform === 'win32' && pid) {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: ['ignore', 'pipe', 'pipe'] });
      info('killMyZapProcess: taskkill /T /F executado para a arvore do MyZap', {
        metadata: { area: 'iniciarMyZap', pid },
      });
    } else {
      myzapChildProcess.kill('SIGTERM');
      info('killMyZapProcess: SIGTERM enviado ao child process do MyZap', {
        metadata: { area: 'iniciarMyZap', pid },
      });
    }
  } catch (err) {
    try {
      myzapChildProcess.kill('SIGKILL');
    } catch (_killErr) {
      // melhor esforco
    }
    warn('killMyZapProcess: falha ao matar child process', {
      metadata: { area: 'iniciarMyZap', error: getErrorMessage(err) },
    });
  } finally {
    myzapChildProcess = null;
  }
}

function executarComando(executor, args, cwd) {
  return new Promise((resolve, reject) => {
    const runner = (typeof executor === 'string')
      ? {
        command: executor,
        prefixArgs: [],
        shell: false,
        env: process.env,
      }
      : {
        prefixArgs: [],
        shell: false,
        env: process.env,
        ...executor,
      };
    const child = spawn(runner.command, [...runner.prefixArgs, ...args], {
      cwd,
      shell: runner.shell,
      env: runner.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const commandLabel = runner.source || runner.command;

    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `Comando "${commandLabel}" finalizou com codigo ${code}.`));
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function aguardarPorta(porta, timeoutMs = 20000, intervalMs = 500, options = {}) {
  const inicio = Date.now();
  const getChildError = options.getChildError || (() => null);
  const isChildAlive = options.isChildAlive || (() => true);

  async function verificarNovamente() {
    // Falhar rapido se o child process ja morreu com erro
    const childErr = getChildError();
    if (childErr) {
      info('aguardarPorta: child process finalizou com erro, abortando espera', {
        metadata: { area: 'iniciarMyZap', porta, error: childErr.message },
      });
      return false;
    }

    if (!isChildAlive()) {
      info('aguardarPorta: child process nao esta mais ativo, abortando espera', {
        metadata: { area: 'iniciarMyZap', porta },
      });
      return false;
    }

    const [portaAtiva, httpAtivo] = await Promise.all([
      isPortInUse(porta),
      isLocalHttpServiceReachable({ timeoutMs: Math.min(intervalMs, 3000) }),
    ]);

    if (portaAtiva || httpAtivo) {
      return true;
    }

    const elapsed = Date.now() - inicio;
    if (elapsed >= timeoutMs) {
      warn('aguardarPorta: timeout atingido esperando porta', {
        metadata: { area: 'iniciarMyZap', porta, elapsed, timeoutMs },
      });
      return false;
    }

    // Log periodico a cada 15 segundos para acompanhamento
    if (elapsed > 0 && elapsed % 15000 < intervalMs) {
      info(`aguardarPorta: ainda aguardando porta ${porta} (${Math.round(elapsed / 1000)}s/${Math.round(timeoutMs / 1000)}s)`, {
        metadata: { area: 'iniciarMyZap', porta, elapsed, timeoutMs },
      });
    }

    await wait(intervalMs);
    return verificarNovamente();
  }

  return verificarNovamente();
}

async function iniciarMyZap(dirPath, options = {}) {
  try {
    const reportProgress = (typeof options.onProgress === 'function')
      ? options.onProgress
      : () => {};
    const porta = 5555;

    info('=== Iniciando fluxo de start do MyZap ===', {
      metadata: { area: 'iniciarMyZap', dirPath, porta },
    });

    transition('starting_service', { message: 'Validando se o MyZap ja esta em execucao...', dirPath });

    reportProgress('Validando se o MyZap ja esta em execucao...', 'check_runtime', {
      percent: 86,
      dirPath,
      porta,
    });
    const [portaAtiva, httpAtivo] = await Promise.all([
      isPortInUse(porta),
      isLocalHttpServiceReachable({ timeoutMs: 3000 }),
    ]);
    const estaRodando = portaAtiva || httpAtivo;

    if (estaRodando) {
      transition('running', {
        message: 'MyZap ja estava em execucao local.',
        dirPath,
        porta,
        detectadoVia: portaAtiva ? 'porta' : 'http',
      });
      reportProgress('MyZap ja estava em execucao local.', 'already_running', {
        percent: 95,
        dirPath,
        porta,
        detectadoVia: portaAtiva ? 'porta' : 'http',
      });
      return {
        status: 'success',
        message: 'O MyZap ja esta em execucao.',
      };
    }

    const gitDir = path.join(dirPath, '.git');
    const gitRunner = await getGitCommand();
    if (fs.existsSync(gitDir) && gitRunner) {
      reportProgress('Atualizando codigo local do MyZap...', 'git_pull', {
        percent: 90,
        dirPath,
      });
      try {
        await executarComando(gitRunner, ['pull', 'origin', 'main'], dirPath);
      } catch (gitErr) {
        info('git pull falhou (nao-critico, continuando)', {
          metadata: { area: 'iniciarMyZap', error: getErrorMessage(gitErr) },
        });
      }
    } else if (fs.existsSync(gitDir)) {
      info('Diretorio .git encontrado, mas Git nao esta disponivel. Pulando git pull.', {
        metadata: { area: 'iniciarMyZap', dirPath },
      });
    } else {
      info('Diretorio .git nao encontrado, pulando git pull', {
        metadata: { area: 'iniciarMyZap', dirPath },
      });
    }

    const startRunner = resolveDirectMyZapStartRunner(dirPath) || await getPnpmCommand();
    if (!startRunner) {
      logError('Nenhum runner disponivel para iniciar MyZap (nem direct-node nem pnpm/npm)', {
        metadata: { area: 'iniciarMyZap', dirPath },
      });
      return {
        status: 'error',
        message: 'Nao foi possivel carregar o executor interno de inicializacao do MyZap.',
      };
    }

    info(`Runner selecionado para iniciar MyZap: ${startRunner.source || startRunner.command}`, {
      metadata: {
        area: 'iniciarMyZap',
        source: startRunner.source,
        command: startRunner.command,
        dirPath,
      },
    });

    reportProgress('Subindo processo local do MyZap...', 'run_start', {
      percent: 93,
      dirPath,
    });
    const childArgs = startRunner.source && startRunner.source.startsWith('direct-node-start')
      ? [...startRunner.prefixArgs]
      : [...startRunner.prefixArgs, 'start'];
    const child = spawn(startRunner.command, childArgs, {
      cwd: dirPath,
      shell: startRunner.shell,
      env: startRunner.env,
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Rastrear child process para kill posterior
    myzapChildProcess = child;

    info('Child process do MyZap criado', {
      metadata: {
        area: 'iniciarMyZap',
        pid: child.pid,
        command: startRunner.command,
        args: childArgs,
        dirPath,
      },
    });

    child.stdout.on('data', (data) => {
      info('MyZap runtime stdout', {
        metadata: {
          area: 'iniciarMyZap',
          output: String(data).trim(),
        },
      });
    });
    let stderrOutput = '';

    child.stderr.on('data', (data) => {
      const text = String(data).trim();
      stderrOutput += (stderrOutput ? '\n' : '') + text;
      info('MyZap runtime stderr', {
        metadata: {
          area: 'iniciarMyZap',
          output: text,
        },
      });
    });

    let childError = null;

    child.on('error', (err) => {
      childError = err;
      logError('Erro ao criar/executar child process do MyZap', {
        metadata: { area: 'iniciarMyZap', error: err.message, pid: child.pid },
      });
    });

    child.on('exit', (code, signal) => {
      info('Child process do MyZap finalizou', {
        metadata: { area: 'iniciarMyZap', exitCode: code, signal, pid: child.pid },
      });
      if (typeof code === 'number' && code !== 0) {
        // Extrair primeira linha util do stderr (sem stack trace)
        const firstLine = stderrOutput
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('at ') && !l.startsWith('node:'));
        const detail = firstLine || stderrOutput.slice(0, 200);
        const msg = detail
          ? `MyZap finalizou com codigo ${code}: ${detail}`
          : `MyZap finalizou com codigo ${code} (signal: ${signal || 'nenhum'})`;
        childError = new Error(msg);
      }
      // Limpar referencia do child ao sair
      if (myzapChildProcess === child) {
        myzapChildProcess = null;
      }
    });

    reportProgress('Aguardando MyZap abrir a porta local...', 'wait_port', {
      percent: 96,
      dirPath,
      porta,
    });
    const abriuPorta = await aguardarPorta(porta, 180000, 1500, {
      getChildError: () => childError,
      isChildAlive: () => myzapChildProcess !== null,
    });

    if (!abriuPorta) {
      transition('error', {
        message: childError
          ? `Falha ao iniciar: ${childError.message}`
          : `MyZap nao abriu a porta ${porta} dentro do tempo esperado.`,
        phase: 'start_service',
      });
      return {
        status: 'error',
        message: childError
          ? `Falha ao iniciar: ${childError.message}`
          : `MyZap nao abriu a porta ${porta} dentro do tempo esperado.`,
      };
    }

    transition('running', { message: 'MyZap iniciado e porta confirmada.', dirPath, porta });

    info('MyZap iniciado e porta confirmada', {
      metadata: { porta, dirPath, runner: startRunner.source || startRunner.command },
    });
    reportProgress('MyZap iniciado e porta confirmada.', 'ready', {
      percent: 98,
      dirPath,
      porta,
    });

    return {
      status: 'success',
      message: 'MyZap iniciado com sucesso!',
    };
  } catch (err) {
    transition('error', { message: getErrorMessage(err), phase: 'start_service' });
    logError('Erro ao gerenciar inicio do MyZap', { metadata: { error: err } });
    return {
      status: 'error',
      message: `Erro: ${err.message}`,
    };
  }
}

module.exports = { iniciarMyZap, killMyZapProcess };
