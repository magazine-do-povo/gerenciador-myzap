const fs = require('fs');
const path = require('path');
const { warn, debug } = require('./myzapLogger').forArea('runtime');

const INSTALL_OK_MARKER_FILE = '.gerenciador-myzap-install-ok';
const PNPM_STORE_MARKER = '.modules.yaml';
const PNPM_VIRTUAL_STORE = '.pnpm';

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

/**
 * Lista as dependencias declaradas em package.json.dependencies do MyZap.
 * Ignora devDependencies e optionalDependencies.
 */
function listDeclaredDependencies(dirPath) {
  const pkg = readJsonSafe(path.join(dirPath, 'package.json'));
  if (!pkg || typeof pkg !== 'object') {
    return [];
  }
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object'
    ? Object.keys(pkg.dependencies)
    : [];
  return deps;
}

/**
 * Verifica se o node_modules do MyZap esta saudavel:
 *   - existe a pasta node_modules
 *   - existe .modules.yaml e .pnpm (markers do pnpm)
 *   - existe pasta para CADA dependencia declarada em package.json
 *   - cada pasta de dependencia possui package.json
 *
 * Retorna { ok, reason, missing: [...] }
 */
function assertDependenciesHealthy(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return { ok: false, reason: 'dir_missing', missing: [] };
  }

  const nodeModulesPath = path.join(dirPath, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    return { ok: false, reason: 'node_modules_missing', missing: [] };
  }

  const pnpmMarker = path.join(nodeModulesPath, PNPM_STORE_MARKER);
  if (!fs.existsSync(pnpmMarker)) {
    return { ok: false, reason: 'pnpm_marker_missing', missing: [PNPM_STORE_MARKER] };
  }

  const pnpmStore = path.join(nodeModulesPath, PNPM_VIRTUAL_STORE);
  if (!fs.existsSync(pnpmStore)) {
    return { ok: false, reason: 'pnpm_store_missing', missing: [PNPM_VIRTUAL_STORE] };
  }

  const declared = listDeclaredDependencies(dirPath);
  if (declared.length === 0) {
    debug('assertDependenciesHealthy: package.json sem dependencies declaradas', {
      metadata: { area: 'dependencyHealth', dirPath },
    });
  }

  const missing = [];
  for (const depName of declared) {
    const depDir = path.join(nodeModulesPath, ...depName.split('/'));
    const depPkg = path.join(depDir, 'package.json');
    if (!fs.existsSync(depPkg)) {
      missing.push(depName);
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'dependencies_missing',
      missing,
    };
  }

  return { ok: true, reason: 'healthy', missing: [] };
}

function getInstallOkMarkerPath(dirPath) {
  return path.join(dirPath, 'node_modules', INSTALL_OK_MARKER_FILE);
}

function readInstallOkMarker(dirPath) {
  try {
    const file = getInstallOkMarkerPath(dirPath);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function writeInstallOkMarker(dirPath, payload = {}) {
  try {
    const file = getInstallOkMarkerPath(dirPath);
    const data = {
      at: new Date().toISOString(),
      ...payload,
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return file;
  } catch (err) {
    warn('Falha ao gravar marker de instalacao concluida', {
      metadata: { area: 'dependencyHealth', dirPath, error: err.message },
    });
    return null;
  }
}

function clearInstallOkMarker(dirPath) {
  try {
    const file = getInstallOkMarkerPath(dirPath);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (_err) { /* melhor esforco */ }
}

module.exports = {
  assertDependenciesHealthy,
  listDeclaredDependencies,
  readInstallOkMarker,
  writeInstallOkMarker,
  clearInstallOkMarker,
  getInstallOkMarkerPath,
  INSTALL_OK_MARKER_FILE,
};
