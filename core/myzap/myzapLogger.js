const { createLogger } = require('../utils/logger');

const DEFAULT_CHANNEL = 'myzap-runtime';

const defaultLogger = createLogger(DEFAULT_CHANNEL);

function forArea(area) {
    if (!area) return defaultLogger;
    const normalized = String(area).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    return createLogger(`myzap-${normalized}`);
}

module.exports = {
    info: defaultLogger.info,
    warn: defaultLogger.warn,
    error: defaultLogger.error,
    debug: defaultLogger.debug,
    forArea
};
