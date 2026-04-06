const fs = require('fs');
const path = require('path');
const { getLogDir } = require('../utils/logger');

function formatTimestamp(date = new Date()) {
  return date.toISOString();
}

function stringifyMetadata(metadata = {}) {
  try {
    return JSON.stringify(metadata);
  } catch (_err) {
    return '[metadata_unserializable]';
  }
}

function appendLine(filePath, line) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${line}\n`, 'utf8');
}

function createInstallDebugLogContext(options = {}) {
  const dirPath = String(options.dirPath || '');
  const reinstall = Boolean(options.reinstall);
  const stamp = formatTimestamp().replace(/[:.]/g, '-');
  const filePath = path.join(getLogDir(), `${stamp}-myzap-install-debug.log`);

  appendLine(filePath, `=== MYZAP INSTALL DEBUG START ${formatTimestamp()} ===`);
  appendLine(filePath, `dirPath=${dirPath}`);
  appendLine(filePath, `reinstall=${reinstall}`);
  appendLine(filePath, `pid=${process.pid}`);

  return {
    filePath,
    log(message, metadata = {}) {
      const line = `[${formatTimestamp()}] ${String(message || '').trim()}${Object.keys(metadata).length ? ` | ${stringifyMetadata(metadata)}` : ''}`;
      appendLine(filePath, line);
    },
    section(title) {
      appendLine(filePath, `--- ${String(title || '').trim()} ---`);
    },
  };
}

module.exports = {
  createInstallDebugLogContext,
};
