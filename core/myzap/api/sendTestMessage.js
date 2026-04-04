const { requestMyZapApi } = require('./requestMyZapApi');
const getConnectionStatus = require('./getConnectionStatus');
const verifyRealStatus = require('./verifyRealStatus');
const { debug, info, warn, error } = require('../myzapLogger');

const MIN_PHONE_DIGITS = 10;
const MAX_PHONE_DIGITS = 15;
const PRIORITY_PATHS = [
    'wid.user',
    'wid._serialized',
    'me.id.user',
    'me.id._serialized',
    'me._serialized',
    'id.user',
    'id._serialized',
    'number',
    'phone',
    'result.wid.user',
    'result.wid._serialized',
    'result.me.id.user',
    'result.me.id._serialized',
    'result.number',
    'result.phone',
    'data.wid.user',
    'data.wid._serialized',
    'data.me.id.user',
    'data.me.id._serialized',
    'data.number',
    'data.phone',
    'owner.number',
    'owner.phone',
    'contact.number',
    'contact.phone'
];

function readPath(obj, path) {
    const segments = String(path || '').split('.').filter(Boolean);
    let current = obj;

    for (const segment of segments) {
        if (!current || typeof current !== 'object') {
            return undefined;
        }
        current = current[segment];
    }

    return current;
}

function normalizePhoneCandidate(raw) {
    if (raw === undefined || raw === null) return '';

    if (typeof raw === 'number') {
        return normalizePhoneCandidate(String(raw));
    }

    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return '';

        const serializedMatch = trimmed.match(/(\d{10,15})@(?:c\.us|s\.whatsapp\.net|lid)/i);
        if (serializedMatch) {
            return serializedMatch[1];
        }

        const digits = trimmed.replace(/\D+/g, '');
        if (digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS) {
            return digits;
        }

        return '';
    }

    if (Array.isArray(raw)) {
        for (const item of raw) {
            const candidate = normalizePhoneCandidate(item);
            if (candidate) return candidate;
        }
        return '';
    }

    if (typeof raw === 'object') {
        return normalizePhoneCandidate(
            raw.user
            || raw.number
            || raw.phone
            || raw.id
            || raw._serialized
            || ''
        );
    }

    return '';
}

function collectPhoneCandidates(payload) {
    const matches = [];
    const queue = [payload];
    const visited = new Set();

    while (queue.length > 0 && visited.size < 160) {
        const current = queue.shift();
        if (!current || typeof current !== 'object') continue;
        if (visited.has(current)) continue;
        visited.add(current);

        if (Array.isArray(current)) {
            current.forEach((item) => queue.push(item));
            continue;
        }

        for (const [key, value] of Object.entries(current)) {
            if (
                typeof value === 'string'
                && /@(?:c\.us|s\.whatsapp\.net|lid)/i.test(value)
            ) {
                const serializedCandidate = normalizePhoneCandidate(value);
                if (serializedCandidate) {
                    matches.push(serializedCandidate);
                }
            }

            if (/(^|_)(wid|waid|number|phone|owner|contact|user|id|me|serialized)($|_)/i.test(key)) {
                const candidate = normalizePhoneCandidate(value);
                if (candidate) {
                    matches.push(candidate);
                }
            }

            if (value && typeof value === 'object') {
                queue.push(value);
            }
        }
    }

    return matches;
}

function extractOwnNumber(payloads = []) {
    for (const payload of payloads) {
        for (const path of PRIORITY_PATHS) {
            const candidate = normalizePhoneCandidate(readPath(payload, path));
            if (candidate) {
                return candidate;
            }
        }
    }

    for (const payload of payloads) {
        const candidates = collectPhoneCandidates(payload);
        if (candidates.length > 0) {
            return candidates[0];
        }
    }

    return '';
}

function summarizeSessionState(payloads = []) {
    const combined = payloads.map((payload) => {
        try {
            return JSON.stringify(payload);
        } catch (_error) {
            return String(payload || '');
        }
    }).join(' ').toLowerCase();

    return {
        hasConnected: /(connected|authenticated|islogged|open|online|ativo)/.test(combined),
        hasQrWaiting: /(qrcode|qr code|qr_code|waiting qr|awaiting qr|aguardando qr)/.test(combined),
        hasNotFound: /(not found|not_found|session not found|sessao nao iniciada|sessao nao encontrada|nao encontrada)/.test(combined)
    };
}

function mapRequestError(result) {
    const code = String(result?.error || '').trim();

    if (code === 'MISSING_APITOKEN') {
        return 'TOKEN local do MyZap nao encontrado.';
    }

    if (code === 'MISSING_SESSIONKEY') {
        return 'Session Key do MyZap nao encontrada.';
    }

    if (code.startsWith('HTTP_')) {
        return `Falha ao enviar mensagem de teste (${code.replace('_', ' ')}).`;
    }

    if (code) {
        return `Falha ao enviar mensagem de teste: ${code}.`;
    }

    return 'Falha ao enviar mensagem de teste.';
}

function formatDateTimeBR(value) {
    const date = value instanceof Date ? value : new Date(value);
    return date.toLocaleString('pt-BR', { hour12: false });
}

async function sendTestMessage() {
    try {
        const statusResults = await Promise.allSettled([
            verifyRealStatus(),
            getConnectionStatus()
        ]);
        const payloads = statusResults
            .filter((entry) => entry.status === 'fulfilled' && entry.value)
            .map((entry) => entry.value);
        const summary = summarizeSessionState(payloads);
        const number = extractOwnNumber(payloads);

        if (!number) {
            const message = (summary.hasQrWaiting || summary.hasNotFound || !summary.hasConnected)
                ? 'Conecte o WhatsApp local antes de enviar a mensagem de teste.'
                : 'Nao foi possivel identificar o proprio numero da sessao conectada.';

            warn('Nao foi possivel resolver o numero da sessao para o teste MyZap', {
                metadata: {
                    area: 'sendTestMessage',
                    hasConnected: summary.hasConnected,
                    hasQrWaiting: summary.hasQrWaiting,
                    hasNotFound: summary.hasNotFound
                }
            });

            return {
                status: 'error',
                message
            };
        }

        const sentAt = Date.now();
        const sentAtLabel = formatDateTimeBR(sentAt);
        const text = `teste ${sentAtLabel}`;

        debug('Enviando mensagem de teste para o proprio numero no MyZap', {
            metadata: {
                area: 'sendTestMessage',
                number,
                sentAt: sentAtLabel
            }
        });

        const result = await requestMyZapApi('sendText', {
            body: {
                number,
                text
            }
        });

        if (!result.ok || result?.data?.error) {
            const message = String(
                result?.data?.error
                || result?.data?.message
                || mapRequestError(result)
            );

            warn('Falha ao enviar mensagem de teste no MyZap', {
                metadata: {
                    area: 'sendTestMessage',
                    number,
                    status: result?.status || 0,
                    error: message
                }
            });

            return {
                status: 'error',
                message,
                number,
                response: result?.data || null
            };
        }

        if (Number(result?.data?.result) !== 200) {
            warn('MyZap nao confirmou o envio da mensagem de teste', {
                metadata: {
                    area: 'sendTestMessage',
                    number,
                    response: result?.data || null
                }
            });

            return {
                status: 'error',
                message: 'MyZap nao confirmou o envio da mensagem de teste.',
                number,
                response: result?.data || null
            };
        }

        info('Mensagem de teste enviada com sucesso no MyZap', {
            metadata: {
                area: 'sendTestMessage',
                number
            }
        });

        return {
            status: 'success',
            message: 'Mensagem de teste enviada com sucesso.',
            number,
            text,
            sentAt,
            sentAtLabel,
            response: result.data
        };
    } catch (err) {
        error('Erro ao enviar mensagem de teste MyZap', {
            metadata: {
                area: 'sendTestMessage',
                error: err?.message || String(err)
            }
        });

        return {
            status: 'error',
            message: err?.message || String(err)
        };
    }
}

module.exports = sendTestMessage;
