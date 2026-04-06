const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const extractZip = require('extract-zip');
const { info, warn, error } = require('./myzapLogger');

const MAX_REDIRECTS = 5;
const PORTABLE_NODE_VERSION = '20.11.1';
const PORTABLE_GIT_VERSION = '2.45.1';
const PORTABLE_GIT_RELEASE_TAG = 'v2.45.1.windows.1';

let portableNodeInFlight = null;
let portableGitInFlight = null;

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
  if (fs.existsSync(expectedPath)) {
    return expectedPath;
  }

  const entries = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^node-v.+-win-(x64|x86)$/i.test(name));

  for (const entryName of entries) {
    const candidate = path.join(baseDir, entryName, 'node.exe');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
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
  } = options;

  const existingPath = resolvePathFromBase(installDir);
  if (existingPath) {
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

    reportProgress(downloadMessage, downloadPhase, {
      percent: downloadPercent,
      archiveUrl,
      installDir,
    });
    await downloadFile(archiveUrl, archivePath);

    reportProgress(extractMessage, extractPhase, {
      percent: extractPercent,
      archiveUrl,
      installDir,
    });
    await extractZip(archivePath, { dir: stagingDir });

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
  }).finally(() => {
    portableGitInFlight = null;
  });

  return portableGitInFlight;
}

module.exports = {
  getPortableToolsBaseDir,
  getPortableNodePath,
  getPortableGitPath,
  ensurePortableNodeRuntime,
  ensurePortableGitRuntime,
};
