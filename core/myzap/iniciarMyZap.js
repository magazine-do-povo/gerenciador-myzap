const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { error: logError, info, warn } = require('./myzapLogger').forArea('runtime');
const {
  isPortInUse,
  isLocalHttpServiceReachable,
  killProcessesOnPort,
  getPnpmCommand,
  getGitCommand,
  findSystemNodePath,
  buildCleanEnvForChild,
} = require('./processUtils');
const { transition } = require('./stateMachine');
const { probeMyZapIdentity } = require('./api/myzapHealthcheck');

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function readMyZapPackageJson(dirPath) {
  try {
    const packageJsonPath = path.join(dirPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function resolveDirectMyZapStartRunner(dirPath, packageJson = null) {
  try {
    const pkg = packageJson || readMyZapPackageJson(dirPath);
    if (!pkg) {
      return null;
    }

    const startScript = String((pkg && pkg.scripts && pkg.scripts.start) || '').trim();
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
        args: [entryFile],
        shell: false,
        env: buildCleanEnvForChild(),
        source: 'direct-node-start',
        scriptName: 'start',
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

function buildPackageScriptRunner(baseRunner, scriptName) {
  const args = scriptName === 'start'
    ? [...baseRunner.prefixArgs, 'start']
    : [...baseRunner.prefixArgs, 'run', scriptName];

  return {
    command: baseRunner.command,
    args,
    shell: baseRunner.shell,
    env: baseRunner.env,
    source: `${baseRunner.source || baseRunner.command}:${scriptName}`,
    scriptName,
  };
}

async function resolveMyZapStartRunners(dirPath, options = {}) {
  const packageJson = readMyZapPackageJson(dirPath);
  const scripts = (packageJson && packageJson.scripts) || {};
  const preferredOrder = ['start', 'dev'];
  const scriptCandidates = preferredOrder.filter((scriptName) => typeof scripts[scriptName] === 'string' && scripts[scriptName].trim());

  if (!scriptCandidates.length) {
    return [];
  }

  const runners = [];
  if (scriptCandidates.includes('start')) {
    const directRunner = resolveDirectMyZapStartRunner(dirPath, packageJson);
    if (directRunner) {
      runners.push(directRunner);
    }
  }

  const packageRunner = await getPnpmCommand();
  if (!packageRunner) {
    return runners;
  }

  scriptCandidates.forEach((scriptName) => {
    runners.push(buildPackageScriptRunner(packageRunner, scriptName));
  });

  return runners;
}

/** Referencia ao child process ativo do MyZap (pnpm start) */
let myzapChildProcess = null;

/** Listeners externos que querem ser notificados quando o child do MyZap finaliza. */
const childExitListeners = new Set();

function onMyZapChildExit(listener) {
  if (typeof listener !== 'function') return () => {};
  childExitListeners.add(listener);
  return () => childExitListeners.delete(listener);
}

function emitChildExit(payload) {
  for (const listener of childExitListeners) {
    try { listener(payload); } catch (_e) { /* nao propagar */ }
  }
}

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
  const requireMyZapIdentity = options.requireMyZapIdentity !== false; // default: true

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
      // Confirmar que e o MyZap respondendo, nao outro app na 5555
      if (requireMyZapIdentity) {
        const identity = await probeMyZapIdentity({ timeoutMs: 2500 });
        if (identity.isMyZap) {
          return true;
        }
        if (identity.alive) {
          // Algo HTTP esta na porta mas nao parece MyZap; manter polling — o MyZap
          // pode estar levantando ainda. Logar warning periodico.
          const elapsed = Date.now() - inicio;
          if (elapsed % 15000 < intervalMs) {
            warn('aguardarPorta: porta ocupada por servico HTTP que nao parece o MyZap (ainda subindo?)', {
              metadata: {
                area: 'iniciarMyZap',
                porta,
                elapsed,
                status: identity.status,
              },
            });
          }
        }
      } else {
        return true;
      }
    }

    const elapsed = Date.now() - inicio;
    if (elapsed >= timeoutMs) {
      warn('aguardarPorta: timeout atingido esperando porta', {
        metadata: {
          area: 'iniciarMyZap',
          porta,
          elapsed,
          timeoutMs,
          requireMyZapIdentity,
        },
      });
      return false;
    }

    // Log periodico a cada 15 segundos para acompanhamento
    if (elapsed > 0 && elapsed % 15000 < intervalMs) {
      info(`aguardarPorta: ainda aguardando porta ${porta} (${Math.round(elapsed / 1000)}s/${Math.round(timeoutMs / 1000)}s)`, {
        metadata: {
          area: 'iniciarMyZap',
          porta,
          elapsed,
          timeoutMs,
        },
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

    const portaOcupada = await isPortInUse(porta);
    if (portaOcupada) {
      const identity = await probeMyZapIdentity({ timeoutMs: 3000 });

      if (identity.alive && identity.isMyZap) {
        transition('running', {
          message: 'MyZap ja estava em execucao local.',
          dirPath,
          porta,
          detectadoVia: 'identity-probe',
        });
        reportProgress('MyZap ja estava em execucao local.', 'already_running', {
          percent: 95,
          dirPath,
          porta,
          detectadoVia: 'identity-probe',
        });
        return {
          status: 'success',
          message: 'O MyZap ja esta em execucao.',
        };
      }

      if (identity.alive && !identity.isMyZap) {
        const msg = `Porta ${porta} esta ocupada por outro servico HTTP que NAO parece o MyZap. Libere a porta e tente novamente.`;
        warn(msg, {
          metadata: {
            area: 'iniciarMyZap',
            porta,
            httpStatus: identity.status,
            attempts: identity.attempts,
          },
        });
        transition('error', { message: msg, phase: 'check_runtime' });
        return {
          status: 'error',
          code: 'PORT_OCCUPIED_BY_OTHER',
          message: msg,
        };
      }

      // Porta ocupada mas sem HTTP respondendo: processo zumbi (provavelmente MyZap antigo).
      // Matar e seguir o fluxo normal de start.
      warn('Porta 5555 ocupada por processo zumbi (sem HTTP). Matando antes de iniciar MyZap.', {
        metadata: { area: 'iniciarMyZap', porta, probeError: identity.error },
      });
      const killResult = killProcessesOnPort(porta);
      info('Resultado do kill de processo zumbi na porta 5555', {
        metadata: { area: 'iniciarMyZap', porta, ...killResult },
      });
      // Esperar liberar
      const tInicio = Date.now();
      while (await isPortInUse(porta)) {
        if (Date.now() - tInicio > 5000) {
          const msg = `Nao foi possivel liberar a porta ${porta} apos matar processos zumbi.`;
          logError(msg, { metadata: { area: 'iniciarMyZap', porta } });
          transition('error', { message: msg, phase: 'check_runtime' });
          return { status: 'error', code: 'PORT_BUSY_AFTER_KILL', message: msg };
        }
        await wait(250);
      }
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

    const startRunners = await resolveMyZapStartRunners(dirPath, options);
    if (!startRunners.length) {
      logError('Nenhum runner disponivel para iniciar MyZap (nem direct-node nem pnpm/npm)', {
        metadata: {
          area: 'iniciarMyZap',
          dirPath,
        },
      });
      return {
        status: 'error',
        message: 'Nao foi possivel carregar o executor interno de inicializacao do MyZap.',
      };
    }
    const tentarStartRunner = async (index, previousError = null) => {
      if (index >= startRunners.length) {
        transition('error', {
          message: previousError || `MyZap nao abriu a porta ${porta} dentro do tempo esperado.`,
          phase: 'start_service',
        });
        return {
          status: 'error',
          message: previousError || `MyZap nao abriu a porta ${porta} dentro do tempo esperado.`,
        };
      }

      const startRunner = startRunners[index];

      info(`Runner selecionado para iniciar MyZap: ${startRunner.source || startRunner.command}`, {
        metadata: {
          area: 'iniciarMyZap',
          source: startRunner.source,
          command: startRunner.command,
          args: startRunner.args,
          dirPath,
          attempt: index + 1,
          totalAttempts: startRunners.length,
          scriptName: startRunner.scriptName || 'start',
        },
      });

      reportProgress(`Subindo processo local do MyZap (${startRunner.scriptName || 'start'})...`, 'run_start', {
        percent: 93,
        dirPath,
        scriptName: startRunner.scriptName || 'start',
      });

      const child = spawn(startRunner.command, startRunner.args, {
        cwd: dirPath,
        shell: startRunner.shell,
        env: startRunner.env,
        detached: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      myzapChildProcess = child;

      info('Child process do MyZap criado', {
        metadata: {
          area: 'iniciarMyZap',
          pid: child.pid,
          command: startRunner.command,
          args: startRunner.args,
          dirPath,
          scriptName: startRunner.scriptName || 'start',
        },
      });

      child.stdout.on('data', (data) => {
        info('MyZap runtime stdout', {
          metadata: {
            area: 'iniciarMyZap',
            output: String(data).trim(),
            scriptName: startRunner.scriptName || 'start',
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
            scriptName: startRunner.scriptName || 'start',
          },
        });
      });

      let childError = null;

      child.on('error', (err) => {
        childError = err;
        logError('Erro ao criar/executar child process do MyZap', {
          metadata: {
            area: 'iniciarMyZap',
            error: err.message,
            pid: child.pid,
            scriptName: startRunner.scriptName || 'start',
          },
        });
      });

      child.on('exit', (code, signal) => {
        info('Child process do MyZap finalizou', {
          metadata: {
            area: 'iniciarMyZap',
            exitCode: code,
            signal,
            pid: child.pid,
            scriptName: startRunner.scriptName || 'start',
          },
        });
        if (typeof code === 'number' && code !== 0) {
          const firstLine = stderrOutput
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l && !l.startsWith('at ') && !l.startsWith('node:'));
          const detail = firstLine || stderrOutput.slice(0, 200);
          const msg = detail
            ? `MyZap (${startRunner.scriptName || 'start'}) finalizou com codigo ${code}: ${detail}`
            : `MyZap (${startRunner.scriptName || 'start'}) finalizou com codigo ${code} (signal: ${signal || 'nenhum'})`;
          childError = new Error(msg);
        }
        emitChildExit({
          exitCode: code,
          signal,
          pid: child.pid,
          stderrTail: stderrOutput.slice(-500),
          scriptName: startRunner.scriptName || 'start',
        });
        if (myzapChildProcess === child) {
          myzapChildProcess = null;
        }
      });

      reportProgress(`Aguardando MyZap abrir a porta local via ${startRunner.scriptName || 'start'}...`, 'wait_port', {
        percent: 96,
        dirPath,
        porta,
        scriptName: startRunner.scriptName || 'start',
      });
      const abriuPorta = await aguardarPorta(porta, 180000, 1500, {
        getChildError: () => childError,
        isChildAlive: () => myzapChildProcess !== null,
        requireMyZapIdentity: true,
      });

      if (abriuPorta) {
        transition('running', {
          message: 'MyZap iniciado e porta confirmada.',
          dirPath,
          porta,
          scriptName: startRunner.scriptName || 'start',
        });

        info('MyZap iniciado e porta confirmada', {
          metadata: {
            porta,
            dirPath,
            runner: startRunner.source || startRunner.command,
            scriptName: startRunner.scriptName || 'start',
          },
        });
        reportProgress('MyZap iniciado e porta confirmada.', 'ready', {
          percent: 98,
          dirPath,
          porta,
          scriptName: startRunner.scriptName || 'start',
        });

        return {
          status: 'success',
          message: 'MyZap iniciado com sucesso!',
          runner: startRunner.source || startRunner.command,
          scriptName: startRunner.scriptName || 'start',
        };
      }

      const nextError = childError
        ? `Falha ao iniciar com ${startRunner.scriptName || 'start'}: ${childError.message}`
        : `MyZap nao abriu a porta ${porta} com ${startRunner.scriptName || 'start'} dentro do tempo esperado.`;

      warn('Tentativa de start do MyZap falhou; avaliando fallback', {
        metadata: {
          area: 'iniciarMyZap',
          dirPath,
          attempt: index + 1,
          totalAttempts: startRunners.length,
          scriptName: startRunner.scriptName || 'start',
          error: nextError,
        },
      });

      if (myzapChildProcess) {
        killMyZapProcess();
      }

      return tentarStartRunner(index + 1, nextError);
    };

    return tentarStartRunner(0);
  } catch (err) {
    transition('error', {
      message: getErrorMessage(err),
      phase: 'start_service',
    });
    logError('Erro ao gerenciar inicio do MyZap', {
      metadata: { error: err },
    });
    return {
      status: 'error',
      message: `Erro: ${err.message}`,
    };
  }
}

module.exports = { iniciarMyZap, killMyZapProcess, onMyZapChildExit };
