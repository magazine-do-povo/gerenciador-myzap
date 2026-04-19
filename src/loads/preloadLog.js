const fs = require('fs');
const path = require('path');
const { clipboard, contextBridge } = require('electron');
const { getLogDir } = require('../../core/utils/logger');

const LOG_DIR = getLogDir();
const TEXT_LEVEL_MAP = {
  erro: 'error',
  aviso: 'warn',
  info: 'info',
  debug: 'debug'
};

Zap - API',
  'log-myzap-watcher': 'MyZap - Watchers',
  'log-myzap-backend': 'MyZap - Backend',
  'log-myzap-ipc': 'MyZap - IPC',
  'log-myzap': 'MyZap (legado)'
};

function buildLogLabel(filename) {
  // formato: YYYY-MM-DD-<prefixo>.jsonl
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.jsonl$/);
  if (!match) return filename;
  const [, date, prefix] = match;
  const label = CHANNEL_LABELS[prefix] || prefix.replace(/^log-/, '').replace(/-/g, ' ');
  return `${date} - ${label}`;
}

function listLogFiles() {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => {
        const stats = fs.statSync(path.join(LOG_DIR, file));
        return {
          name: file,
          label: buildLogLabel(file),
          size: stats.size,
          mtime: stats.mtimeMs
        };
      });
  } catch (err) {
    console.error('Erro ao listar logs', err);
    return [];
  }
}

async function readLogTail({ filename, maxBytes = 128 * 1024, levelFilters = [], search = '' }) {
  if (!filename) {
    return {
      display: ['Selecione um arquivo válido'],
      meta: { size: 0, mtime: Date.now() },
      truncated: false
    };
  }

  const filePath = path.join(LOG_DIR, filename);
  try {
    const stats = fs.statSync(filePath);
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    await handle.close();
    const raw = buffer.toString('utf8');

    const lines = raw.split('\n').filter(Boolean);
    const isJson = filename.endsWith('.jsonl');
    const display = lines.filter((line) => matchesFilters(line, levelFilters, search, isJson));

    return {
      display,
      meta: { size: stats.size, mtime: stats.mtimeMs },
      truncated: start > 0
    };
  } catch (err) {
    console.error('Erro ao ler log', err);
    return {
      display: ['Erro ao carregar o log: ' + err.message],
      meta: { size: 0, mtime: Date.now() },
      truncated: false
    };
  }
}

function matchesFilters(line, levelFilters, search, isJson) {
  const sanitizedSearch = (search || '').trim().toLowerCase();
  let levelPass = true;

  if (levelFilters.length) {
