const fs = require('fs');
const path = require('path');
const os = require('os');

const RETENCAO_DIAS = 7;
const MAX_FILE_BYTES = 3 * 1024 * 1024; // 3 MB por arquivo antes de rotacionar
const LOG_DIR = path.join(os.tmpdir(), 'gerenciador-myzap', 'logs');
const WRITE_PLAIN_LOG = false;

// Canais conhecidos: cada canal vira um arquivo separado por dia
// (formato: YYYY-MM-DD-<prefixo>.jsonl).
const LOG_CHANNELS = {
  system: 'log-sistema',
  updater: 'log-updater',
  'myzap-runtime': 'log-myzap-runtime',
  'myzap-install': 'log-myzap-install',
  'myzap-api': 'log-myzap-api',
  'myzap-watcher': 'log-myzap-watcher',
  'myzap-backend': 'log-myzap-backend',
  'myzap-ipc': 'log-myzap-ipc',
  // Compatibilidade com canal antigo (modulos nao migrados):
  myzap: 'log-myzap'
};

const LEVEL_LABEL = {
  error: 'ERRO',
  warn: 'AVISO',
  info: 'INFO',
  debug: 'DEBUG'
};

function sanitizeChannelName(channel) {
  return String(channel || 'system')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'system';
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function formatTimestamp(date = new Date()) {
  return date.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function getLogFilePath(channel = 'system', extension = 'log') {
  ensureLogDir();
  const prefix = LOG_CHANNELS[channel] || `log-${sanitizeChannelName(channel)}`;
  const date = new Date().toISOString().split('T')[0];
  return path.join(LOG_DIR, `${date}-${prefix}.${extension}`);
}

function rotateFileIfNeeded(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size >= MAX_FILE_BYTES) {
      const rotated = `${filePath}.${Date.now()}`;
      fs.renameSync(filePath, rotated);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Falha ao rotacionar log', err);
    }
  }
}

function sanitizeMetadata(metadata = {}) {
  const entries = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    if (value instanceof Error) {
      entries.push(`${key}: ${value.message}`);
      entries.push(`${key}_stack: ${value.stack || 'sem stack'}`);
    } else if (typeof value === 'object') {
      try {
        entries.push(`${key}: ${JSON.stringify(value)}`);
      } catch {
        entries.push(`${key}: [object]`);
      }
    } else {
      entries.push(`${key}: ${value}`);
    }
  }
  return entries.join(' | ');
}

function appendLine(filePath, line) {
  rotateFileIfNeeded(filePath);
  fs.promises.appendFile(filePath, line, 'utf8').catch((err) => {
    console.error('Não foi possível gravar o log', filePath, err.message);
  });
}

function log(message, options = {}) {
  const level = options.level || 'info';
  const metadata = options.metadata || {};
  const channel = options.channel || 'system';
  const timestamp = new Date();
  const jsonLine = JSON.stringify({
    timestamp: timestamp.toISOString(),
    level,
    message,
    channel,
    metadata
  }) + os.EOL;

  if (WRITE_PLAIN_LOG) {
    const levelName = (LEVEL_LABEL[level] || level || 'INFO').toUpperCase();
    const metaText = sanitizeMetadata(metadata);
    const textLine = `[${formatTimestamp(timestamp)}] [${levelName}] ${message}${metaText ? ' | ' + metaText : ''}${os.EOL}`;
    appendLine(getLogFilePath(channel, 'log'), textLine);
  }
  appendLine(getLogFilePath(channel, 'jsonl'), jsonLine);
}

const info = (message, options = {}) => log(message, { ...options, level: 'info' });
const warn = (message, options = {}) => log(message, { ...options, level: 'warn' });
const error = (message, options = {}) => log(message, { ...options, level: 'error' });
const debug = (message, options = {}) => log(message, { ...options, level: 'debug' });

/**
 * Cria um logger preso a um canal especifico. Cada canal vira um arquivo
 * separado por dia, evitando misturar eventos de areas diferentes.
 *   const log = createLogger('myzap-install');
 *   log.info('Clonando repositorio', { metadata: { ... } });
 */
function createLogger(channel) {
  const safe = LOG_CHANNELS[channel] ? channel : sanitizeChannelName(channel);
  return {
    info: (message, options = {}) => log(message, { ...options, channel: safe, level: 'info' }),
    warn: (message, options = {}) => log(message, { ...options, channel: safe, level: 'warn' }),
    error: (message, options = {}) => log(message, { ...options, channel: safe, level: 'error' }),
    debug: (message, options = {}) => log(message, { ...options, channel: safe, level: 'debug' })
  };
}

function limparLogsAntigos() {
  const limite = Date.now() - RETENCAO_DIAS * 24 * 60 * 60 * 1000;
  ensureLogDir();
  fs.readdir(LOG_DIR, (err, arquivos) => {
    if (err) return;
    arquivos.forEach((arquivo) => {
      const fullPath = path.join(LOG_DIR, arquivo);
      fs.stat(fullPath, (statErr, stats) => {
        if (!statErr && stats.mtimeMs < limite) {
          fs.unlink(fullPath, () => {});
        }
      });
    });
  });
}

function abrirPastaLogs() {
  const { shell } = require('electron');
  ensureLogDir();
  shell.openPath(LOG_DIR);
}

function getCaminhoLogs() {
  ensureLogDir();
  return LOG_DIR;
}

/** Alias para compatibilidade com preloadLog.js */
function getLogDir() {
  return getCaminhoLogs();
}

module.exports = {
  info,
  warn,
  error,
  debug,
  createLogger,
  abrirPastaLogs,
  getCaminhoLogs,
  getLogDir,
  limparLogsAntigos
};
