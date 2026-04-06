const fs = require('fs');
const path = require('path');
const { error, debug, warn } = require('./myzapLogger');

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

    // Verificar se node_modules existe (deps instaladas)
    const nodeModulesPath = path.join(dirPath, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
      warn('Instalacao incompleta: node_modules nao encontrado', {
        metadata: { area: 'verificarDiretorio', dirPath }
      });
      return {
        status: 'error',
        needsReinstall: true,
        message: 'Instalacao incompleta: dependencias nao instaladas. Reinstalacao necessaria.'
      };
    }

    return {
      status: 'success',
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
