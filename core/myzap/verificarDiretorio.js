const fs = require('fs');
const path = require('path');
const { error, debug, warn } = require('./myzapLogger').forArea('install');
const {
  assertDependenciesHealthy,
  readInstallOkMarker,
} = require('./dependencyHealth');

/**
 * Resolve o entry point do MyZap a partir do package.json.
 * Retorna o nome do arquivo (ex: 'index.js') ou null.
 */
function resolveEntryPoint(dirPath) {
  try {
    const pkgPath = path.join(dirPath, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const startScript = String(pkg?.scripts?.start || '').trim();
    // Extrair entry de scripts como "node index.js" ou "nodemon ... index.js"
    const nodeMatch = startScript.match(/(?:node|nodemon)\b.*?\s+([^\s]+\.js)\b/i);
    if (nodeMatch) return nodeMatch[1];
    // Fallback para campo main do package.json
    if (pkg.main) return pkg.main;
    return null;
  } catch (_err) {
    return null;
  }
}

async function verificarDiretorio(dirPath) {
  try {
    debug('Verificando diretorio do MyZap', {
      metadata: { area: 'verificarDiretorio', dirPath }
    });

    if (!dirPath || !fs.existsSync(dirPath)) {
      return {
        status: 'error',
        message: 'MyZap nao se encontra no diretorio configurado!'
      };
    }

    const packageJsonPath = path.join(dirPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return {
        status: 'error',
        message: 'Diretorio existe mas nao contem uma instalacao valida do MyZap!'
      };
    }

    // Verificar se o entry point existe
    const entryPoint = resolveEntryPoint(dirPath);
    if (entryPoint) {
      const entryPath = path.join(dirPath, entryPoint);
      if (!fs.existsSync(entryPath)) {
        warn('Instalacao incompleta: entry point nao encontrado', {
          metadata: { area: 'verificarDiretorio', dirPath, entryPoint, entryPath }
        });
        return {
          status: 'error',
          needsReinstall: true,
          message: `Instalacao incompleta: arquivo principal "${entryPoint}" nao encontrado. Reinstalacao necessaria.`
        };
      }
    }

    // Verificar se node_modules esta saudavel (deps instaladas e completas)
    const health = assertDependenciesHealthy(dirPath);
    if (!health.ok) {
      warn('Instalacao incompleta detectada por dependencyHealth', {
        metadata: {
          area: 'verificarDiretorio',
          dirPath,
          reason: health.reason,
          missingCount: (health.missing || []).length,
          missingSample: (health.missing || []).slice(0, 8),
        },
      });
      const detail = health.reason === 'dependencies_missing'
        ? `${(health.missing || []).length} pacote(s) ausente(s)`
        : health.reason;
      return {
        status: 'error',
        needsReinstall: true,
        code: 'DEPS_HEALTH_FAILED',
        healthReason: health.reason,
        missing: health.missing || [],
        message: `Instalacao incompleta: ${detail}. Reinstalacao necessaria.`,
      };
    }

    const marker = readInstallOkMarker(dirPath);
    if (!marker) {
      warn('Instalacao sem marker de conclusao (.gerenciador-myzap-install-ok)', {
        metadata: { area: 'verificarDiretorio', dirPath },
      });
      return {
        status: 'error',
        needsReinstall: true,
        code: 'INSTALL_MARKER_MISSING',
        message: 'Instalacao anterior nao foi finalizada corretamente. Reinstalacao necessaria.',
      };
    }

    return {
      status: 'success',
      installMarker: marker,
      message: 'MyZap se encontra no diretorio configurado!'
    };
  } catch (err) {
    error('Erro ao verificar diretorio do MyZap', {
      metadata: { error: err, area: 'verificarDiretorio', dirPath }
    });
    return {
      status: 'error',
      message: err.message || err
    };
  }
}

module.exports = verificarDiretorio;
