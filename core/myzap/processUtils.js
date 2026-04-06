const { execSync, spawn, spawnSync } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { info: logInfo, warn: logWarn, debug: logDebug } = require('./myzapLogger');
const {
  getPortableNodePath,
  getPortableGitPath,
  ensurePortableNodeRuntime,
  ensurePortableGitRuntime,
} = require('./runtimeTools');

const DEFAULT_LOCAL_HTTP_URLS = ['http://127.0.0.1:5555/', 'http://localhost:5555/'];

/**
 * Cria um env limpo para child processes do MyZap.
 * Remove ELECTRON_RUN_AS_NODE que contamina sub-processos (ex: Chrome/Puppeteer).
 */
function buildCleanEnvForChild() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;

  const separator = os.platform() === 'win32' ? ';' : ':';
  const existingEntries = String(env.PATH || '')
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const prependedEntries = [];

  const portableNodePath = getPortableNodePath();
  if (portableNodePath) {
    prependedEntries.push(path.dirname(portableNodePath));
  }

  const portableGitPath = getPortableGitPath();
  if (portableGitPath) {
    prependedEntries.push(path.dirname(portableGitPath));
  }

  const mergedEntries = [...new Set([...prependedEntries, ...existingEntries])];
  env.PATH = mergedEntries.join(separator);

  return env;
}

/** Cache do caminho do Node.js real (evita buscar repetidamente) */
let _cachedSystemNodePath = undefined;

/**
 * Tenta encontrar o Node.js real do sistema (nao o binario do Electron).
 * Retorna o path absoluto ou null se nao encontrado.
 */
function findSystemNodePath() {
  if (_cachedSystemNodePath !== undefined) return _cachedSystemNodePath;

  const isWin = os.platform() === 'win32';

  // Atualizar PATH do Windows via registro ANTES de buscar node.
  // Sem isso, o Electron pode herdar um PATH defasado do Explorer
  // e nao encontrar o Node.js instalado pelo usuario.
  if (isWin) {
    refreshPathWindows();
  }

  const checker = isWin ? 'where' : 'which';
  const electronBin = process.execPath.toLowerCase();

  try {
    const result = spawnSync(checker, ['node'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 5000,
    });

    if (!result.error && result.status === 0) {
      const candidates = String(result.stdout || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      for (const candidate of candidates) {
        if (candidate.toLowerCase() === electronBin) continue;
        const check = spawnSync(candidate, ['--version'], {
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          timeout: 5000,
        });
        if (!check.error && check.status === 0 && String(check.stdout).trim().startsWith('v')) {
          logInfo('Node.js real do sistema encontrado via PATH', {
            metadata: { area: 'processUtils', nodePath: candidate, version: String(check.stdout).trim() },
          });
          _cachedSystemNodePath = candidate;
          return candidate;
        }
      }
    }
  } catch (_err) { /* melhor esforco */ }

  // Fallback: verificar caminhos conhecidos de instalacao no Windows
  if (isWin) {
    const knownPath = getKnownCommandPath('node');
    if (knownPath && knownPath.toLowerCase() !== electronBin) {
      const check = spawnSync(knownPath, ['--version'], {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 5000,
      });
      if (!check.error && check.status === 0 && String(check.stdout).trim().startsWith('v')) {
        logInfo('Node.js real encontrado em caminho conhecido do Windows', {
          metadata: { area: 'processUtils', nodePath: knownPath, version: String(check.stdout).trim() },
        });
        _cachedSystemNodePath = knownPath;
        return knownPath;
      }
    }

    const portableNodePath = getPortableNodePath();
    if (portableNodePath && portableNodePath.toLowerCase() !== electronBin) {
      const check = spawnSync(portableNodePath, ['--version'], {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 5000,
      });
      if (!check.error && check.status === 0 && String(check.stdout).trim().startsWith('v')) {
        logInfo('Node.js portatil do gerenciador encontrado', {
          metadata: { area: 'processUtils', nodePath: portableNodePath, version: String(check.stdout).trim() },
        });
        _cachedSystemNodePath = portableNodePath;
        return portableNodePath;
      }
    }
  }

  logWarn('Nenhum Node.js compativel encontrado (sistema ou portatil)', {
    metadata: { area: 'processUtils', platform: os.platform(), electronPath: process.execPath },
  });
  _cachedSystemNodePath = null;
  return null;
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(false);
    });

    server.listen(port);
  });
}

function parsePids(text) {
  const pids = new Set();
  const matches = String(text || '').match(/\b\d+\b/g) || [];
  for (const match of matches) {
    const pid = Number(match);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

function parsePidsByLine(text) {
  const pids = new Set();
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^\d+$/.test(line)) {
      const pid = Number(line);
      if (pid > 0) {
        pids.add(pid);
      }
    }
  }
  return [...pids];
}

function getPidsOnPortWindows(port) {
  try {
    const stdout = execSync(`netstat -ano | findstr :${port}`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const pids = new Set();
    const ownPid = process.pid;
    for (const line of lines) {
      const parts = line.split(/\s+/);
      // Estrutura esperada do netstat:
      // Proto  EnderecoLocal  EnderecoRemoto  Estado  PID
      // Somente matar o processo que POSSUI a porta (endereco local),
      // nao processos com conexoes de SAIDA para essa porta.
      // Ex. de linha invalida: "TCP 127.0.0.1:62345 127.0.0.1:5555 ESTABLISHED 1001"
      //   onde 127.0.0.1:62345 e o lado do cliente (Electron) — nao deve ser morto.
      const localAddr = parts[1] || '';
      if (!localAddr.endsWith(`:${port}`)) {
        continue; // ignorar conexoes de saida para a porta
      }
      const pid = Number(parts[parts.length - 1]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (pid === ownPid) continue; // nunca matar o proprio processo
      pids.add(pid);
    }
    return [...pids];
  } catch (_e) {
    return [];
  }
}

function getPidsOnPortUnix(port) {
  const ownPid = process.pid;

  // Tenta lsof com filtro TCP:LISTEN (evita retornar clientes conectados a porta,
  // como o proprio Electron fazendo requisicoes HTTP ao MyZap)
  try {
    const stdout = execSync(
      `lsof -ti "TCP:${port}" -sTCP:LISTEN`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const pids = parsePidsByLine(stdout).filter((pid) => pid !== ownPid);
    if (pids.length > 0) return pids;
  } catch (_e) {
    // tenta fuser
  }

  // Tenta fuser (retorna apenas processos usando a porta TCP, lado servidor)
  try {
    const stdout = execSync(
      `fuser ${port}/tcp 2>/dev/null`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const afterColon = stdout.includes(':') ? stdout.split(':').pop() : stdout;
    const pids = parsePids(afterColon).filter((pid) => pid !== ownPid);
    if (pids.length > 0) return pids;
  } catch (_e) {
    // tenta ss
  }

  // Tenta ss — disponivel em praticamente todos os Linux modernos sem lsof/fuser
  // (Ubuntu 22+, Debian 12+, Alpine, etc.)
  try {
    const stdout = execSync(
      `ss -tlnp 2>/dev/null | grep ' :${port} '`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const pids = new Set();
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      const matches = line.match(/pid=(\d+)/g) || [];
      for (const m of matches) {
        const pid = Number(m.replace('pid=', ''));
        if (pid > 0 && pid !== ownPid) pids.add(pid);
      }
    }
    if (pids.size > 0) return [...pids];
  } catch (_e) {
    // sem pids
  }

  return [];
}

function getPidsOnPort(port) {
  return os.platform() === 'win32'
    ? getPidsOnPortWindows(port)
    : getPidsOnPortUnix(port);
}

function killPid(pid) {
  if (!pid || pid <= 0) {
    return false;
  }

  // Nunca matar o proprio processo (segurança contra netstat falso-positivo)
  if (pid === process.pid) {
    return false;
  }

  try {
    if (os.platform() === 'win32') {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    return true;
  } catch (_e) {
    return false;
  }
}

function killProcessesOnPort(port) {
  const pids = getPidsOnPort(port);
  const killed = [];
  const failed = [];

  for (const pid of pids) {
    if (killPid(pid)) {
      killed.push(pid);
    } else {
      failed.push(pid);
    }
  }

  return {
    pids,
    killed,
    failed,
  };
}

/**
 * Caminhos conhecidos de instalacao no Windows.
 * Usado como fallback quando `where` falha (PATH desatualizado).
 */
const KNOWN_PATHS_WIN = {
  git: [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
  ],
  node: [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
  ],
};

function isElectronPackagedApp() {
  return Boolean(
    process.versions
    && process.versions.electron
    && !process.defaultApp
    && process.resourcesPath,
  );
}

function ensureDirectoryInPath(filePath) {
  if (!filePath) {
    return;
  }

  const dir = path.dirname(filePath);
  const separator = os.platform() === 'win32' ? ';' : ':';
  const currentPath = String(process.env.PATH || '');
  const currentEntries = currentPath.split(separator).filter(Boolean);

  if (!currentEntries.includes(dir)) {
    process.env.PATH = currentPath ? `${dir}${separator}${currentPath}` : dir;
  }
}

function getKnownCommandPath(command) {
  if (os.platform() !== 'win32') {
    return null;
  }

  const knownPaths = KNOWN_PATHS_WIN[command] || [];
  const existingPath = knownPaths.find((filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch (_err) {
      return false;
    }
  });

  if (existingPath) {
    ensureDirectoryInPath(existingPath);
  }

  return existingPath || null;
}

function normalizeBaseUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  return value.endsWith('/') ? value : `${value}/`;
}

function uniqueUrls(urls = []) {
  const output = [];
  const seen = new Set();

  urls.forEach((rawUrl) => {
    const normalized = normalizeBaseUrl(rawUrl);
    if (!normalized) {
      return;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    output.push(normalized);
  });

  return output;
}

function runSyncCommand(command, args = []) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });

    return {
      ok: !result.error && result.status === 0,
      status: result.status,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
      error: result.error || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: '',
      error,
    };
  }
}

function detectWindowsElevation() {
  const powershellResult = runSyncCommand('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    '[Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent() | ForEach-Object { $_.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }',
  ]);

  if (/^true$/i.test(powershellResult.stdout)) {
    return { isElevated: true, method: 'powershell' };
  }

  if (/^false$/i.test(powershellResult.stdout)) {
    return { isElevated: false, method: 'powershell' };
  }

  const fltmcResult = runSyncCommand('fltmc');
  if (fltmcResult.ok) {
    return { isElevated: true, method: 'fltmc' };
  }

  const fltmcOutput = `${fltmcResult.stdout}\n${fltmcResult.stderr}`.toLowerCase();
  if (
    fltmcOutput.includes('access is denied')
    || fltmcOutput.includes('acesso negado')
    || fltmcOutput.includes('privilege')
  ) {
    return { isElevated: false, method: 'fltmc' };
  }

  const netSessionResult = runSyncCommand('net', ['session']);
  if (netSessionResult.ok) {
    return { isElevated: true, method: 'net-session' };
  }

  const netOutput = `${netSessionResult.stdout}\n${netSessionResult.stderr}`.toLowerCase();
  if (
    netOutput.includes('access is denied')
    || netOutput.includes('acesso negado')
    || netOutput.includes('privilege')
  ) {
    return { isElevated: false, method: 'net-session' };
  }

  return { isElevated: false, method: 'fallback_unknown' };
}

function buildAdminRequiredMessage(action = 'instalar ou reinstalar o MyZap local') {
  return `Para ${action}, feche o Gerenciador MyZap e abra novamente como Administrador.`;
}

function getPrivilegeStatus() {
  const platform = os.platform();

  if (platform === 'win32') {
    // Em dev mode (app nao empacotado), nao exigir admin
    const packaged = isElectronPackagedApp();
    const detected = detectWindowsElevation();
    const requiresAdmin = packaged;
    const needsAdminForLocalInstall = requiresAdmin && !detected.isElevated;

    return {
      platform,
      isElevated: Boolean(detected.isElevated),
      requiresAdminForLocalInstall: requiresAdmin,
      needsAdminForLocalInstall,
      method: detected.method || 'unknown',
      message: needsAdminForLocalInstall ? buildAdminRequiredMessage() : '',
    };
  }

  if (typeof process.getuid === 'function') {
    return {
      platform,
      isElevated: process.getuid() === 0,
      requiresAdminForLocalInstall: false,
      needsAdminForLocalInstall: false,
      method: 'getuid',
      message: '',
    };
  }

  return {
    platform,
    isElevated: false,
    requiresAdminForLocalInstall: false,
    needsAdminForLocalInstall: false,
    method: 'unsupported',
    message: '',
  };
}

function resolveCommandPath(command) {
  return new Promise((resolve) => {
    const checker = os.platform() === 'win32' ? 'where' : 'which';
    const child = spawn(checker, [command], {
      shell: false,
      windowsHide: true,
    });
    let stdout = '';

    const resolveKnownPath = () => {
      resolve(getKnownCommandPath(command));
    };

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('error', resolveKnownPath);
    child.on('close', (code) => {
      if (code === 0) {
        const resolvedPath = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean);

        if (resolvedPath) {
          ensureDirectoryInPath(resolvedPath);
          resolve(resolvedPath);
          return;
        }
      }

      resolveKnownPath();
    });
  });
}

async function isLocalHttpServiceReachable(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2500;
  const baseUrls = uniqueUrls([...(options.baseUrls || []), ...DEFAULT_LOCAL_HTTP_URLS]);
  let index = 0;

  while (index < baseUrls.length) {
    const baseUrl = baseUrls[index];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    try {
      await fetch(baseUrl, {
        method: 'GET',
        signal: abort.signal,
      });
      clearTimeout(timer);
      return true;
    } catch (_err) {
      clearTimeout(timer);
      index += 1;
    }
  }

  return false;
}

function resolveAsarUnpackedPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return filePath;
  }

  const asarSegment = `${path.sep}app.asar${path.sep}`;
  if (!filePath.includes(asarSegment)) {
    return filePath;
  }

  const unpackedPath = filePath.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpackedPath) ? unpackedPath : filePath;
}

function getBundledPnpmCommand() {
  try {
    const packageJsonPath = require.resolve('pnpm');
    const cliPath = resolveAsarUnpackedPath(path.join(path.dirname(packageJsonPath), 'bin', 'pnpm.cjs'));
    if (isElectronPackagedApp() && cliPath.includes(`${path.sep}app.asar${path.sep}`)) {
      return null;
    }

    if (!fs.existsSync(cliPath)) {
      return null;
    }

    // Preferir Node.js real do sistema ou runtime portatil do gerenciador.
    const preferredNode = findSystemNodePath();
    if (preferredNode) {
      return {
        command: preferredNode,
        prefixArgs: [cliPath],
        shell: false,
        env: buildCleanEnvForChild(),
        source: 'bundled-pnpm',
      };
    }

    return null;
  } catch (_err) {
    return null;
  }
}

async function commandExists(command) {
  return Boolean(await resolveCommandPath(command));
}

/**
 * Atualiza o PATH do processo atual lendo o registro do Windows.
 * Expande variaveis de ambiente (%SystemRoot%, %ProgramFiles% etc.)
 */
function refreshPathWindows() {
  try {
    const systemPath = execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path',
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();

    const userPath = execSync(
      'reg query "HKCU\\Environment" /v Path',
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();

    const extractValue = (regOutput) => {
      const match = regOutput.match(/REG_(?:EXPAND_)?SZ\s+(.+)/i);
      return match ? match[1].trim() : '';
    };

    const expandVars = (str) => str.replace(/%([^%]+)%/g, (_, varName) => process.env[varName] || `%${varName}%`);

    const newPathStr = [extractValue(systemPath), extractValue(userPath)]
      .filter(Boolean)
      .map(expandVars)
      .join(';');

    if (newPathStr) {
      process.env.PATH = newPathStr;
    }
  } catch (_err) { /* melhor esforco */ }
}

/**
 * Valida se um comando encontrado realmente funciona executando --version.
 * Retorna true se o comando executou com sucesso, false caso contrario.
 */
function validateCommand(commandPath, args = ['--version']) {
  try {
    const result = spawnSync(commandPath, args, {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 10000,
    });
    const ok = !result.error && result.status === 0;
    const version = String(result.stdout || '').trim().split('\n')[0];
    logDebug(`Validacao de comando: ${commandPath}`, {
      metadata: {
        area: 'processUtils',
        commandPath,
        ok,
        version: ok ? version : undefined,
        error: result.error ? result.error.message : undefined,
        exitCode: result.status,
      },
    });
    return ok;
  } catch (err) {
    logWarn(`Falha ao validar comando: ${commandPath}`, {
      metadata: { area: 'processUtils', commandPath, error: err.message },
    });
    return false;
  }
}

async function getPnpmCommand() {
  logInfo('Iniciando deteccao do gerenciador de pacotes (pnpm/npm)...', {
    metadata: { area: 'processUtils', fase: 'getPnpmCommand' },
  });

  let bundledRunner = getBundledPnpmCommand();
  if (bundledRunner) {
    logInfo('Usando pnpm empacotado (bundled)', {
      metadata: { area: 'processUtils', source: 'bundled-pnpm' },
    });
    return bundledRunner;
  }

  if (os.platform() === 'win32' && !findSystemNodePath()) {
    try {
      const portableNode = await ensurePortableNodeRuntime();
      if (portableNode && portableNode.path) {
        _cachedSystemNodePath = portableNode.path;
        bundledRunner = getBundledPnpmCommand();
        if (bundledRunner) {
          logInfo('Usando pnpm empacotado com Node.js portatil do gerenciador', {
            metadata: { area: 'processUtils', nodePath: portableNode.path },
          });
          return bundledRunner;
        }
      }
    } catch (err) {
      logWarn('Falha ao baixar/preparar Node.js portatil do gerenciador', {
        metadata: { area: 'processUtils', error: err.message },
      });
    }
  }

  logDebug('pnpm empacotado nao disponivel', { metadata: { area: 'processUtils' } });

  if (isElectronPackagedApp()) {
    logWarn('App empacotado sem pnpm bundled ou Node.js compativel — nenhum runner disponivel', {
      metadata: { area: 'processUtils' },
    });
    return null;
  }

  // Atualizar PATH no Windows antes de buscar comandos
  if (os.platform() === 'win32') {
    refreshPathWindows();
    logDebug('PATH do Windows atualizado via registro', { metadata: { area: 'processUtils' } });
  }

  const pnpmPath = await resolveCommandPath('pnpm');
  if (pnpmPath) {
    if (validateCommand(pnpmPath, ['--version'])) {
      logInfo('pnpm do sistema detectado e validado', {
        metadata: { area: 'processUtils', source: 'system-pnpm', path: pnpmPath },
      });
      return {
        command: pnpmPath,
        prefixArgs: [],
        shell: false,
        env: buildCleanEnvForChild(),
        source: 'system-pnpm',
      };
    }
    logWarn('pnpm encontrado no PATH mas falhou na validacao (--version)', {
      metadata: { area: 'processUtils', path: pnpmPath },
    });
  } else {
    logDebug('pnpm nao encontrado no PATH do sistema', { metadata: { area: 'processUtils' } });
  }

  // npx vem com o npm e e a forma mais comum de rodar pnpm sem instalar globalmente
  const npxPath = await resolveCommandPath('npx');
  if (npxPath) {
    if (validateCommand(npxPath, ['--version'])) {
      logInfo('npx do sistema detectado e validado (sera usado para rodar pnpm)', {
        metadata: { area: 'processUtils', source: 'system-npx', path: npxPath },
      });
      return {
        command: npxPath,
        prefixArgs: ['pnpm'],
        shell: false,
        env: buildCleanEnvForChild(),
        source: 'system-npx',
      };
    }
    logWarn('npx encontrado no PATH mas falhou na validacao', {
      metadata: { area: 'processUtils', path: npxPath },
    });
  } else {
    logDebug('npx nao encontrado no PATH do sistema', { metadata: { area: 'processUtils' } });
  }

  // npm disponivel mas npx nao (npm < 5.2) — tenta via npm exec
  const npmPath = await resolveCommandPath('npm');
  if (npmPath) {
    if (validateCommand(npmPath, ['--version'])) {
      logInfo('npm do sistema detectado e validado (sera usado via npm exec pnpm)', {
        metadata: { area: 'processUtils', source: 'system-npm-exec', path: npmPath },
      });
      return {
        command: npmPath,
        prefixArgs: ['exec', 'pnpm', '--'],
        shell: false,
        env: buildCleanEnvForChild(),
        source: 'system-npm-exec',
      };
    }
    logWarn('npm encontrado no PATH mas falhou na validacao', {
      metadata: { area: 'processUtils', path: npmPath },
    });
  } else {
    logDebug('npm nao encontrado no PATH do sistema', { metadata: { area: 'processUtils' } });
  }

  if (os.platform() === 'win32') {
    try {
      const portableNode = await ensurePortableNodeRuntime();
      if (portableNode && portableNode.path) {
        _cachedSystemNodePath = portableNode.path;
        bundledRunner = getBundledPnpmCommand();
        if (bundledRunner) {
          logInfo('Fallback final: usando pnpm empacotado com Node.js portatil', {
            metadata: { area: 'processUtils', nodePath: portableNode.path },
          });
          return bundledRunner;
        }
      }
    } catch (err) {
      logWarn('Falha no fallback do Node.js portatil ao obter pnpm', {
        metadata: { area: 'processUtils', error: err.message },
      });
    }
  }

  logWarn('Nenhum gerenciador de pacotes (pnpm/npx/npm) encontrado ou funcional no sistema', {
    metadata: { area: 'processUtils', platform: os.platform() },
  });
  return null;
}

async function getGitCommand() {
  logDebug('Verificando disponibilidade do git...', { metadata: { area: 'processUtils' } });

  // Atualizar PATH no Windows antes de buscar git
  if (os.platform() === 'win32') {
    refreshPathWindows();
  }

  const gitPath = await resolveCommandPath('git');
  if (gitPath && validateCommand(gitPath, ['--version'])) {
    logInfo('Git detectado e validado', {
      metadata: { area: 'processUtils', source: 'system-git', path: gitPath },
    });
    return {
      command: gitPath,
      prefixArgs: [],
      shell: false,
      env: buildCleanEnvForChild(),
      source: 'system-git',
    };
  }

  if (gitPath) {
    logWarn('Git encontrado no PATH mas falhou na validacao (--version)', {
      metadata: { area: 'processUtils', path: gitPath },
    });
  }

  const portableGitPath = getPortableGitPath();
  if (portableGitPath && validateCommand(portableGitPath, ['--version'])) {
    logInfo('Git portatil do gerenciador detectado e validado', {
      metadata: { area: 'processUtils', source: 'portable-git', path: portableGitPath },
    });
    return {
      command: portableGitPath,
      prefixArgs: [],
      shell: false,
      env: buildCleanEnvForChild(),
      source: 'portable-git',
    };
  }

  if (os.platform() === 'win32') {
    try {
      const portableGit = await ensurePortableGitRuntime();
      if (portableGit && portableGit.path && validateCommand(portableGit.path, ['--version'])) {
        logInfo('Git portatil baixado e validado com sucesso', {
          metadata: { area: 'processUtils', source: 'portable-git', path: portableGit.path },
        });
        return {
          command: portableGit.path,
          prefixArgs: [],
          shell: false,
          env: buildCleanEnvForChild(),
          source: 'portable-git',
        };
      }
    } catch (err) {
      logWarn('Falha ao baixar/preparar Git portatil do gerenciador', {
        metadata: { area: 'processUtils', error: err.message },
      });
    }
  }

  logInfo('Git nao encontrado no PATH nem no cache portatil do gerenciador', {
    metadata: { area: 'processUtils', platform: os.platform() },
  });
  return null;
}

module.exports = {
  isPortInUse,
  isLocalHttpServiceReachable,
  killProcessesOnPort,
  getPrivilegeStatus,
  buildAdminRequiredMessage,
  commandExists,
  resolveCommandPath,
  getPnpmCommand,
  getGitCommand,
  refreshPathWindows,
  findSystemNodePath,
  buildCleanEnvForChild,
};
