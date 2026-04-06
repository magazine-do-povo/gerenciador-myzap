const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { info, warn, error } = require('./myzapLogger');
const {
  SYSTEM_NODE_VERSION,
  SYSTEM_GIT_VERSION,
  SYSTEM_GIT_RELEASE_TAG,
} = require('./runtimeTools');

const MAX_REDIRECTS = 5;

function writeDebugLog(debugLog, message, metadata = {}) {
  if (!debugLog || typeof debugLog.log !== 'function') {
    return;
  }

  debugLog.log(message, metadata);
}

function getInstallersBaseDir() {
  const home = os.homedir();

  if (os.platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'gerenciador-myzap', 'installers');
  }

  if (os.platform() === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'gerenciador-myzap', 'installers');
  }

  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(xdgDataHome, 'gerenciador-myzap', 'installers');
}

function getWindowsNodeArch() {
  return process.arch === 'ia32' ? 'x86' : 'x64';
}

function getWindowsGitArch() {
  return process.arch === 'ia32' ? '32' : '64';
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
          reject(new Error('Numero maximo de redirecionamentos excedido ao baixar instalador do sistema.'));
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
        reject(new Error(`Falha ao baixar instalador do sistema (HTTP ${response.statusCode}).`));
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

function runInstallerCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      shell: false,
      windowsHide: true,
      ...options,
    });
    let stdout = '';
    let stderr = '';
    let spawnError = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ ok: code === 0 || code === 3010, exitCode: code, stdout, stderr, errorMessage: spawnError });
    });

    proc.on('error', (err) => {
      spawnError = err && err.message ? err.message : String(err);
      resolve({ ok: false, exitCode: null, stdout, stderr, errorMessage: spawnError });
    });
  });
}

async function ensureSystemNodeInstalled(options = {}) {
  if (os.platform() !== 'win32') {
    return { status: 'skipped', message: 'Instalacao automatica de Node.js normal disponivel apenas no Windows.' };
  }

  const reportProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const debugLog = options.debugLog;
  const installersDir = getInstallersBaseDir();
  const arch = getWindowsNodeArch();
  const fileName = `node-v${SYSTEM_NODE_VERSION}-${arch}.msi`;
  const archiveUrl = `https://nodejs.org/dist/v${SYSTEM_NODE_VERSION}/${fileName}`;
  const installerPath = path.join(installersDir, fileName);
  const installLogPath = path.join(installersDir, `node-install-${Date.now()}.log`);

  fs.mkdirSync(installersDir, { recursive: true });
  writeDebugLog(debugLog, 'Preparando instalacao normal do Node.js', {
    installerPath,
    archiveUrl,
    installLogPath,
  });

  reportProgress('Baixando instalador normal do Node.js...', 'download_system_node', {
    percent: 13,
    archiveUrl,
    installerPath,
  });

  if (!fs.existsSync(installerPath)) {
    await downloadFile(archiveUrl, installerPath);
  }

  writeDebugLog(debugLog, 'Executando instalador normal do Node.js', {
    installerPath,
    installLogPath,
  });

  reportProgress('Instalando Node.js normal no Windows...', 'install_system_node', {
    percent: 18,
    installerPath,
    installLogPath,
  });

  const result = await runInstallerCommand('msiexec.exe', [
    '/i',
    installerPath,
    '/qn',
    '/norestart',
    'ADDLOCAL=ALL',
    '/L*v',
    installLogPath,
  ]);

  writeDebugLog(debugLog, 'Resultado do instalador do Node.js', {
    exitCode: result.exitCode,
    errorMessage: result.errorMessage,
    stdout: result.stdout,
    stderr: result.stderr,
    installLogPath,
  });

  if (!result.ok) {
    error('Falha ao instalar Node.js normal no Windows', {
      metadata: { area: 'systemToolInstaller', archiveUrl, installerPath, installLogPath, result },
    });
    throw new Error(`Falha ao instalar Node.js normal no Windows. Exit code: ${result.exitCode || 'desconhecido'}. Log MSI: ${installLogPath}`);
  }

  info('Node.js normal instalado com sucesso', {
    metadata: { area: 'systemToolInstaller', archiveUrl, installerPath, installLogPath, exitCode: result.exitCode },
  });

  return {
    status: 'success',
    archiveUrl,
    installerPath,
    installLogPath,
    exitCode: result.exitCode,
  };
}

async function ensureSystemGitInstalled(options = {}) {
  if (os.platform() !== 'win32') {
    return { status: 'skipped', message: 'Instalacao automatica de Git normal disponivel apenas no Windows.' };
  }

  const reportProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const debugLog = options.debugLog;
  const installersDir = getInstallersBaseDir();
  const arch = getWindowsGitArch();
  const fileName = `Git-${SYSTEM_GIT_VERSION}-${arch}-bit.exe`;
  const archiveUrl = `https://github.com/git-for-windows/git/releases/download/${SYSTEM_GIT_RELEASE_TAG}/${fileName}`;
  const installerPath = path.join(installersDir, fileName);
  const installLogPath = path.join(installersDir, `git-install-${Date.now()}.log`);

  fs.mkdirSync(installersDir, { recursive: true });
  writeDebugLog(debugLog, 'Preparando instalacao normal do Git', {
    installerPath,
    archiveUrl,
    installLogPath,
  });

  reportProgress('Baixando instalador normal do Git...', 'download_system_git', {
    percent: 20,
    archiveUrl,
    installerPath,
  });

  if (!fs.existsSync(installerPath)) {
    await downloadFile(archiveUrl, installerPath);
  }

  writeDebugLog(debugLog, 'Executando instalador normal do Git', {
    installerPath,
    installLogPath,
  });

  reportProgress('Instalando Git normal no Windows...', 'install_system_git', {
    percent: 24,
    installerPath,
    installLogPath,
  });

  const result = await runInstallerCommand(installerPath, [
    '/VERYSILENT',
    '/NORESTART',
    '/NOCANCEL',
    '/SP-',
    `/LOG=${installLogPath}`,
  ]);

  writeDebugLog(debugLog, 'Resultado do instalador do Git', {
    exitCode: result.exitCode,
    errorMessage: result.errorMessage,
    stdout: result.stdout,
    stderr: result.stderr,
    installLogPath,
  });

  if (!result.ok) {
    warn('Falha ao instalar Git normal no Windows', {
      metadata: { area: 'systemToolInstaller', archiveUrl, installerPath, installLogPath, result },
    });
    throw new Error(`Falha ao instalar Git normal no Windows. Exit code: ${result.exitCode || 'desconhecido'}. Log Git: ${installLogPath}`);
  }

  info('Git normal instalado com sucesso', {
    metadata: { area: 'systemToolInstaller', archiveUrl, installerPath, installLogPath, exitCode: result.exitCode },
  });

  return {
    status: 'success',
    archiveUrl,
    installerPath,
    installLogPath,
    exitCode: result.exitCode,
  };
}

module.exports = {
  ensureSystemNodeInstalled,
  ensureSystemGitInstalled,
};
