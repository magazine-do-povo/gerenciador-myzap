const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const extractZip = require('extract-zip');
const { info, warn, error } = require('./myzapLogger').forArea('runtime');

const MAX_REDIRECTS = 5;
const MINIMUM_NODE_VERSION = '20.18.1';
const PORTABLE_NODE_VERSION = '20.20.2';
const SYSTEM_NODE_VERSION = '20.20.2';
const PORTABLE_GIT_VERSION = '2.45.1';
const SYSTEM_GIT_VERSION = '2.45.1';
const PORTABLE_GIT_RELEASE_TAG = 'v2.45.1.windows.1';
const SYSTEM_GIT_RELEASE_TAG = 'v2.45.1.windows.1';

let portableNodeInFlight = null;
let portableGitInFlight = null;

function normalizeVersion(version) {
  return String(version || '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0];
}

function compareVersions(leftVersion, rightVersion) {
  const left = normalizeVersion(leftVersion).split('.').map((part) => Number(part) || 0);
  const right = normalizeVersion(rightVersion).split('.').map((part) => Number(part) || 0);
  const maxLength = Math.max(left.length, right.length, 3);

  for (let idx = 0; idx < maxLength; idx += 1) {
    const leftPart = left[idx] || 0;
    const rightPart = right[idx] || 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }

  return 0;
}

function isNodeVersionCompatible(version) {
  const normalized = normalizeVersion(version);
  if (!normalized) {
    return false;
  }

  return compareVersions(normalized, MINIMUM_NODE_VERSION) >= 0;
}

function readNodeVersion(nodePath) {
  if (!nodePath || !fs.existsSync(nodePath)) {
    return '';
  }

  try {
    const { spawnSync } = require('child_process');
    const result = spawnSync(nodePath, ['--version'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 5000,
    });

    if (result.error || result.status !== 0) {
      return '';
    }

    return normalizeVersion(String(result.stdout || '').trim());
  } catch (_err) {
    return '';
  }
}

function writeDebugLog(debugLog, message, metadata = {}) {
  if (!debugLog || typeof debugLog.log !== 'function') {
    return;
  }

  debugLog.log(message, metadata);
}

function getPortableToolsBaseDir() {
  const home = os.homedir();

  if (os.platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'gerenciador-myzap', 'runtime-tools');
  }

  if (os.platform() === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'gerenciador-myzap', 'runtime-tools');
  }

  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(xdgDataHome, 'gerenciador-myzap', 'runtime-tools');
}

function getPortableWindowsArch() {
  return process.arch === 'ia32' ? 'x86' : 'x64';
}

function getPortableGitAssetArch() {
  return process.arch === 'ia32' ? '32' : '64';
}

function getPortableNodeInstallDir() {
  return path.join(getPortableToolsBaseDir(), 'node');
}

function getPortableGitInstallDir() {
  return path.join(getPortableToolsBaseDir(), 'git');
}

function resolvePortableNodePathFromBase(baseDir) {
  if (!baseDir || !fs.existsSync(baseDir)) {
    return null;
  }

  const expectedDir = path.join(baseDir, `node-v${PORTABLE_NODE_VERSION}-win-${getPortableWindowsArch()}`);
  const expectedPath = path.join(expectedDir, 'node.exe');
  if (fs.existsSync(expectedPath) && isNodeVersionCompatible(readNodeVersion(expectedPath))) {
    return expectedPath;
  }

  const entries = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^node-v.+-win-(x64|x86)$/i.test(name));

  const compatibleCandidates = entries
    .map((entryName) => ({
      entryName,
      candidate: path.join(baseDir, entryName, 'node.exe'),
    }))
    .filter((entry) => fs.existsSync(entry.candidate))
    .map((entry) => ({
      ...entry,
      version: readNodeVersion(entry.candidate),
    }))
    .filter((entry) => isNodeVersionCompatible(entry.version))
    .sort((left, right) => compareVersions(right.version, left.version));

  if (compatibleCandidates.length > 0) {
    return compatibleCandidates[0].candidate;
  }

  return null;
}

function resolvePortableGitPathFromBase(baseDir) {
  if (!baseDir || !fs.existsSync(baseDir)) {
    return null;
  }

  const candidates = [
    path.join(baseDir, 'cmd', 'git.exe'),
    path.join(baseDir, 'bin', 'git.exe'),
    path.join(baseDir, 'mingw64', 'bin', 'git.exe'),
    path.join(baseDir, 'mingw32', 'bin', 'git.exe'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function getPortableNodePath() {
  if (os.platform() !== 'win32') {
    return null;
  }
  return resolvePortableNodePathFromBase(getPortableNodeInstallDir());
}

function getPortableGitPath() {
  if (os.platform() !== 'win32') {
    return null;
  }
  return resolvePortableGitPathFromBase(getPortableGitInstallDir());
}

function downloadFile(url, destinationPath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': 'gerenciador-myzap',
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();

        if (redirectCount >= MAX_REDIRECTS) {
          reject(new Error('Numero maximo de redirecionamentos excedido ao baixar runtime interno.'));
          return;
        }

        const redirectUrl = new URL(response.headers.location, url).toString();
        downloadFile(redirectUrl, destinationPath, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Falha ao baixar runtime interno (HTTP ${response.statusCode}).`));
        return;
      }

      const fileStream = fs.createWriteStream(destinationPath);

      fileStream.on('error', (err) => {
        response.destroy(err);
      });

      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(resolve);
      });

      fileStream.on('error', (err) => {
        try {
          fs.rmSync(destinationPath, { force: true });
        } catch (_cleanupError) { /* melhor esforco */ }
        reject(err);
      });
    });

    request.on('error', (err) => {
      try {
        fs.rmSync(destinationPath, { force: true });
      } catch (_cleanupError) { /* melhor esforco */ }
      reject(err);
    });
  });
}

function copyDirectoryContents(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  entries.forEach((entry) => {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
  });
}

async function installPortableZip(options = {}) {
  const {
    toolName,
    archiveUrl,
    installDir,
    resolvePathFromBase,
    onProgress,
    downloadMessage,
    extractMessage,
    downloadPhase,
    extractPhase,
    downloadPercent,
    extractPercent,
    debugLog,
  } = options;

  const existingPath = resolvePathFromBase(installDir);
  if (existingPath) {
    writeDebugLog(debugLog, `Runtime interno de ${toolName} ja disponivel`, {
      toolName,
      installDir,
      existingPath,
    });
    return {
      path: existingPath,
      downloaded: false,
      installDir,
      archiveUrl,
    };
  }

  const reportProgress = (typeof onProgress === 'function') ? onProgress : () => {};
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${toolName}-runtime-`));
  const archivePath = path.join(tempDir, `${toolName}.zip`);
  const stagingDir = path.join(tempDir, 'staging');

  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(path.dirname(installDir), { recursive: true });

    writeDebugLog(debugLog, `Preparando runtime interno de ${toolName}`, {
      toolName,
      archiveUrl,
      installDir,
      stagingDir,
    });

    reportProgress(downloadMessage, downloadPhase, {
      percent: downloadPercent,
      archiveUrl,
      installDir,
    });
    await downloadFile(archiveUrl, archivePath);
    writeDebugLog(debugLog, `Download concluido para runtime interno de ${toolName}`, {
      toolName,
      archiveUrl,
      archivePath,
    });

    reportProgress(extractMessage, extractPhase, {
      percent: extractPercent,
      archiveUrl,
      installDir,
    });
    await extractZip(archivePath, { dir: stagingDir });
    writeDebugLog(debugLog, `Extracao concluida para runtime interno de ${toolName}`, {
      toolName,
      archivePath,
      stagingDir,
    });

    const stagedPath = resolvePathFromBase(stagingDir);
    if (!stagedPath) {
      throw new Error(`Runtime interno de ${toolName} baixado, mas a extracao gerou estrutura invalida.`);
    }

    fs.rmSync(installDir, { recursive: true, force: true });
    fs.mkdirSync(installDir, { recursive: true });
    copyDirectoryContents(stagingDir, installDir);

    const installedPath = resolvePathFromBase(installDir);
    if (!installedPath) {
      throw new Error(`Runtime interno de ${toolName} extraido, mas o executavel nao foi localizado.`);
    }

    info(`Runtime interno de ${toolName} preparado com sucesso`, {
      metadata: {
        area: 'runtimeTools',
        toolName,
        archiveUrl,
        installDir,
        installedPath,
      },
    });

    return {
      path: installedPath,
      downloaded: true,
      installDir,
      archiveUrl,
    };
  } catch (err) {
    writeDebugLog(debugLog, `Falha ao preparar runtime interno de ${toolName}`, {
      toolName,
      archiveUrl,
      installDir,
      error: err && err.message ? err.message : String(err),
    });
    error(`Falha ao preparar runtime interno de ${toolName}`, {
      metadata: {
        area: 'runtimeTools',
        toolName,
        archiveUrl,
        installDir,
        error: err,
      },
    });
    throw err;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_cleanupError) { /* melhor esforco */ }
  }
}

async function ensurePortableNodeRuntime(options = {}) {
  if (os.platform() !== 'win32') {
    return null;
  }

  const existingPath = getPortableNodePath();
  if (existingPath) {
    return { path: existingPath, downloaded: false };
  }

  if (portableNodeInFlight) {
    return portableNodeInFlight;
  }

  const archiveUrl = `https://nodejs.org/dist/v${PORTABLE_NODE_VERSION}/node-v${PORTABLE_NODE_VERSION}-win-${getPortableWindowsArch()}.zip`;
  portableNodeInFlight = installPortableZip({
    toolName: 'nodejs',
    archiveUrl,
    installDir: getPortableNodeInstallDir(),
    resolvePathFromBase: resolvePortableNodePathFromBase,
    onProgress: options.onProgress,
    downloadMessage: 'Baixando runtime interno do Node.js...',
    extractMessage: 'Extraindo runtime interno do Node.js...',
    downloadPhase: 'download_portable_node',
    extractPhase: 'extract_portable_node',
    downloadPercent: 15,
    extractPercent: 22,
    debugLog: options.debugLog,
  }).finally(() => {
    portableNodeInFlight = null;
  });

  return portableNodeInFlight;
}

async function ensurePortableGitRuntime(options = {}) {
  if (os.platform() !== 'win32') {
    return null;
  }

  const existingPath = getPortableGitPath();
  if (existingPath) {
    return { path: existingPath, downloaded: false };
  }

  if (portableGitInFlight) {
    return portableGitInFlight;
  }

  const archiveUrl = `https://github.com/git-for-windows/git/releases/download/${PORTABLE_GIT_RELEASE_TAG}/MinGit-${PORTABLE_GIT_VERSION}-${getPortableGitAssetArch()}-bit.zip`;
  portableGitInFlight = installPortableZip({
    toolName: 'git',
    archiveUrl,
    installDir: getPortableGitInstallDir(),
    resolvePathFromBase: resolvePortableGitPathFromBase,
    onProgress: options.onProgress,
    downloadMessage: 'Baixando Git interno do gerenciador...',
    extractMessage: 'Extraindo Git interno do gerenciador...',
    downloadPhase: 'download_portable_git',
    extractPhase: 'extract_portable_git',
    downloadPercent: 24,
    extractPercent: 30,
    debugLog: options.debugLog,
  }).finally(() => {
    portableGitInFlight = null;
  });

  return portableGitInFlight;
}

module.exports = {
  MINIMUM_NODE_VERSION,
  SYSTEM_NODE_VERSION,
  SYSTEM_GIT_VERSION,
  SYSTEM_GIT_RELEASE_TAG,
  isNodeVersionCompatible,
  readNodeVersion,
  getPortableToolsBaseDir,
  getPortableNodePath,
  getPortableGitPath,
  ensurePortableNodeRuntime,
  ensurePortableGitRuntime,
};
