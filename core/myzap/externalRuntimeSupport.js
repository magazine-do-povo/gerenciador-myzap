const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { app } = require('electron');
const { info, warn } = require('./myzapLogger');
const { isPortInUse, isLocalHttpServiceReachable } = require('./processUtils');

const DEFAULT_EXTERNAL_START_TASK_NAME = 'GerenciadorMyZap-MyZapDev';
const DEFAULT_EXTERNAL_START_COMMAND = 'npm run dev';
const EXTERNAL_START_COOLDOWN_MS = 15000;

let externalStartPromise = null;
let lastExternalStartAt = 0;

function isWindows() {
  return process.platform === 'win32';
}

function normalizeExternalCommand(command) {
  const raw = String(command || '').trim().toLowerCase();
  if (raw === 'npm start' || raw === 'start') return 'npm start';
  return DEFAULT_EXTERNAL_START_COMMAND;
}

function getSupportScriptsDirectory() {
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, 'support-scripts');
  }

  return path.join(__dirname, '..', '..', 'scripts');
}

function getSupportScriptPath(fileName) {
  return path.join(getSupportScriptsDirectory(), fileName);
}

function ensureSupportScript(fileName) {
  const scriptPath = getSupportScriptPath(fileName);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Script de suporte nao encontrado: ${scriptPath}`);
  }
  return scriptPath;
}

function ensureMyZapDirectory(dirPath) {
  const resolvedDir = path.resolve(String(dirPath || '').trim());
  if (!resolvedDir || !fs.existsSync(resolvedDir)) {
    throw new Error('Diretorio do MyZap nao encontrado.');
  }

  const packageJsonPath = path.join(resolvedDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json nao encontrado em ${resolvedDir}.`);
  }

  return resolvedDir;
}

function quoteCmdArgument(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

function buildCmdInvocation(scriptPath, args = []) {
  return [scriptPath].concat(args).map(quoteCmdArgument).join(' ');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      resolve({
        ok: false,
        exitCode: -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error,
      });
    });

    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: null,
      });
    });
  });
}

async function isLocalMyZapAvailable() {
  const status = await Promise.all([
    isPortInUse(5555),
    isLocalHttpServiceReachable({ timeoutMs: 3000 }),
  ]);

  return Boolean(status[0] || status[1]);
}

async function startExternalMyZapNow(dirPath, command = DEFAULT_EXTERNAL_START_COMMAND, reason = 'manual_external_start') {
  if (!isWindows()) {
    return {
      status: 'error',
      message: 'O start externo do MyZap foi implementado apenas para Windows.',
    };
  }

  const resolvedDir = ensureMyZapDirectory(dirPath);
  const normalizedCommand = normalizeExternalCommand(command);

  if (await isLocalMyZapAvailable()) {
    return {
      status: 'success',
      alreadyRunning: true,
      message: 'MyZap externo ja esta disponivel na porta local.',
      dirPath: resolvedDir,
      command: normalizedCommand,
    };
  }

  if (externalStartPromise) {
    return externalStartPromise;
  }

  if ((Date.now() - lastExternalStartAt) < EXTERNAL_START_COOLDOWN_MS) {
    return {
      status: 'success',
      requestedRecently: true,
      message: 'Disparo externo ja solicitado recentemente. Aguarde alguns segundos.',
      dirPath: resolvedDir,
      command: normalizedCommand,
    };
  }

  const scriptPath = ensureSupportScript('start-myzap-background.ps1');
  lastExternalStartAt = Date.now();

  info('Solicitando start externo do MyZap', {
    metadata: {
      area: 'externalRuntimeSupport',
      reason,
      dirPath: resolvedDir,
      command: normalizedCommand,
      scriptPath,
    }
  });

  externalStartPromise = runCommand('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-MyZapDir',
    resolvedDir,
    '-Command',
    normalizedCommand,
  ]).then((result) => {
    externalStartPromise = null;

    if (!result.ok) {
      return {
        status: 'error',
        message: result.stderr || result.stdout || 'Falha ao solicitar o start externo do MyZap.',
        dirPath: resolvedDir,
        command: normalizedCommand,
      };
    }

    return {
      status: 'success',
      message: `Disparo externo solicitado com ${normalizedCommand}. Aguarde a API local subir.`,
      dirPath: resolvedDir,
      command: normalizedCommand,
    };
  }).catch((error) => {
    externalStartPromise = null;
    return {
      status: 'error',
      message: error && error.message ? error.message : String(error),
      dirPath: resolvedDir,
      command: normalizedCommand,
    };
  });

  return externalStartPromise;
}

async function installExternalMyZapAutoStart(dirPath, command = DEFAULT_EXTERNAL_START_COMMAND, taskName = DEFAULT_EXTERNAL_START_TASK_NAME) {
  if (!isWindows()) {
    return {
      status: 'error',
      message: 'O auto inicio externo do MyZap foi implementado apenas para Windows.',
    };
  }

  const resolvedDir = ensureMyZapDirectory(dirPath);
  const normalizedCommand = normalizeExternalCommand(command);
  const installerScript = ensureSupportScript('install-myzap-dev-autostart.cmd');
  const invocation = buildCmdInvocation(installerScript, [resolvedDir, normalizedCommand, taskName]);
  const result = await runCommand('cmd.exe', ['/d', '/s', '/c', invocation]);

  if (!result.ok) {
    return {
      status: 'error',
      message: result.stderr || result.stdout || 'Falha ao criar a tarefa agendada do MyZap.',
      taskName,
      dirPath: resolvedDir,
      command: normalizedCommand,
    };
  }

  return {
    status: 'success',
    message: 'Auto inicio externo do MyZap ativado com sucesso.',
    taskName,
    dirPath: resolvedDir,
    command: normalizedCommand,
    output: result.stdout,
  };
}

async function removeExternalMyZapAutoStart(taskName = DEFAULT_EXTERNAL_START_TASK_NAME) {
  if (!isWindows()) {
    return {
      status: 'error',
      message: 'A remocao do auto inicio externo do MyZap foi implementada apenas para Windows.',
    };
  }

  const removerScript = ensureSupportScript('remove-myzap-dev-autostart.cmd');
  const invocation = buildCmdInvocation(removerScript, [taskName]);
  const result = await runCommand('cmd.exe', ['/d', '/s', '/c', invocation]);

  if (!result.ok) {
    return {
      status: 'error',
      message: result.stderr || result.stdout || 'Falha ao remover a tarefa agendada do MyZap.',
      taskName,
    };
  }

  return {
    status: 'success',
    message: 'Auto inicio externo do MyZap removido com sucesso.',
    taskName,
    output: result.stdout,
  };
}

function isExternalMyZapAutoStartInstalled(taskName = DEFAULT_EXTERNAL_START_TASK_NAME) {
  if (!isWindows()) {
    return false;
  }

  const queryResult = spawnSync('schtasks', ['/Query', '/TN', taskName], {
    windowsHide: true,
    stdio: 'ignore',
  });

  return queryResult.status === 0;
}

function getExternalMyZapSupportState(taskName = DEFAULT_EXTERNAL_START_TASK_NAME) {
  return {
    available: isWindows(),
    taskName,
    autoStartInstalled: isExternalMyZapAutoStartInstalled(taskName),
  };
}

module.exports = {
  DEFAULT_EXTERNAL_START_COMMAND,
  DEFAULT_EXTERNAL_START_TASK_NAME,
  getExternalMyZapSupportState,
  installExternalMyZapAutoStart,
  isExternalMyZapAutoStartInstalled,
  normalizeExternalCommand,
  removeExternalMyZapAutoStart,
  startExternalMyZapNow,
};
