const Store = require('electron-store');
const { info, warn } = require('./myzapLogger');
const { normalizeBaseUrl, sanitizeBackendApiUrl } = require('./capabilities');

const store = new Store();
const AUTH_TIMEOUT_MS = 15000;
const AUTH_EXPIRY_SKEW_MS = 60000;

function normalizeFilialId(value) {
    const normalized = String(value ?? '').trim();
    if (!/^\d+$/.test(normalized)) {
        return '';
    }

    return Number(normalized) > 0 ? normalized : '';
}

function getBaseBackendConfig(storeLike = store) {
    const rawApiUrl = String(storeLike.get('apiUrl') || '').trim();
    return {
        apiUrl: sanitizeBackendApiUrl(rawApiUrl, rawApiUrl),
        login: String(storeLike.get('apiLogin') || '').trim(),
        password: String(storeLike.get('apiPassword') || ''),
        idfilial: normalizeFilialId(storeLike.get('idfilial') || storeLike.get('idempresa'))
    };
}

function normalizeAuthorization(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    if (/^bearer\s+/i.test(raw)) {
        const token = raw.replace(/^bearer\s+/i, '').trim();
        return token ? `Bearer ${token}` : '';
    }

    return `Bearer ${raw}`;
}

function extractJwtFromAuthorization(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    if (/^bearer\s+/i.test(raw)) {
        return raw.replace(/^bearer\s+/i, '').trim();
    }

    return raw;
}

function decodeJwtPayloadUnsafe(authorization) {
    try {
        const token = extractJwtFromAuthorization(authorization);
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const payloadSegment = parts[1]
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const paddingLength = payloadSegment.length % 4;
        const paddedPayload = paddingLength === 0
            ? payloadSegment
            : `${payloadSegment}${'='.repeat(4 - paddingLength)}`;

        return JSON.parse(Buffer.from(paddedPayload, 'base64').toString('utf8'));
    } catch (_error) {
        return null;
    }
}

function computeExpiresAt({ authorization, expiresInSeconds }) {
    const jwtPayload = decodeJwtPayloadUnsafe(authorization);
    const jwtExpMs = Number(jwtPayload?.exp || 0) * 1000;
    if (Number.isFinite(jwtExpMs) && jwtExpMs > 0) {
        return jwtExpMs;
    }

    const normalizedTtl = Number(expiresInSeconds || 0);
    if (Number.isFinite(normalizedTtl) && normalizedTtl > 0) {
        return Date.now() + (normalizedTtl * 1000);
    }

    return 0;
}

function readStoredAuthSession(storeLike = store) {
    return {
        authorization: String(
            storeLike.get('backendAuthToken')
            || storeLike.get('myzap_backendApiToken')
            || storeLike.get('clickexpress_queueToken')
            || ''
        ).trim(),
        expiresAt: Number(storeLike.get('backendAuthExpiresAt') || 0),
        authenticatedAt: Number(storeLike.get('backendAuthAuthenticatedAt') || 0),
        apiUrl: sanitizeBackendApiUrl(
            String(storeLike.get('backendAuthApiUrl') || storeLike.get('apiUrl') || '').trim(),
            String(storeLike.get('apiUrl') || '').trim()
        ),
        login: String(storeLike.get('backendAuthLogin') || storeLike.get('apiLogin') || '').trim(),
        idfilial: normalizeFilialId(
            storeLike.get('idfilial')
            || storeLike.get('idempresa')
            || storeLike.get('backendAuthFilial')?.idfilial
            || storeLike.get('backendAuthUser')?.idfilial
        ),
        usuario: storeLike.get('backendAuthUser') || null,
        filial: storeLike.get('backendAuthFilial') || null,
        payload: storeLike.get('backendAuthPayload') || null
    };
}

function isAuthSessionValid(session, baseConfig, skewMs = AUTH_EXPIRY_SKEW_MS) {
    if (!session?.authorization || !session?.expiresAt) {
        return false;
    }

    const normalizedApiUrl = normalizeBaseUrl(baseConfig?.apiUrl);
    const sessionApiUrl = normalizeBaseUrl(session?.apiUrl);
    if (normalizedApiUrl && sessionApiUrl && normalizedApiUrl !== sessionApiUrl) {
        return false;
    }

    const normalizedLogin = String(baseConfig?.login || '').trim().toLowerCase();
    const sessionLogin = String(session?.login || '').trim().toLowerCase();
    if (normalizedLogin && sessionLogin && normalizedLogin !== sessionLogin) {
        return false;
    }

    return Number(session.expiresAt) > (Date.now() + skewMs);
}

function clearBackendAuthSession(storeLike = store) {
    [
        'backendAuthToken',
        'backendAuthExpiresAt',
        'backendAuthAuthenticatedAt',
        'backendAuthApiUrl',
        'backendAuthLogin',
        'backendAuthUser',
        'backendAuthFilial',
        'backendAuthPayload',
        'myzap_backendApiToken',
        'clickexpress_queueToken'
    ].forEach((key) => storeLike.delete(key));
}

function normalizeLoginResult(result = {}, fallbackIdfilial = '') {
    const authorization = normalizeAuthorization(result?.token);
    const usuario = (result?.usuario && typeof result.usuario === 'object') ? result.usuario : null;
    const filial = (result?.filial && typeof result.filial === 'object') ? result.filial : null;
    const idfilial = normalizeFilialId(
        result?.idfilial
        || filial?.idfilial
        || usuario?.idfilial
        || fallbackIdfilial
    );

    return {
        authorization,
        expiresAt: computeExpiresAt({
            authorization,
            expiresInSeconds: result?.expires_in
        }),
        idfilial,
        usuario,
        filial,
        payload: result,
        ip: String(result?.ip || '').trim(),
        expiresIn: Number(result?.expires_in || 0)
    };
}

function buildHeaders(headers = {}) {
    const merged = {};

    const appendEntries = (source) => {
        if (!source) return;

        if (source instanceof Headers) {
            source.forEach((value, key) => {
                merged[key] = value;
            });
            return;
        }

        if (Array.isArray(source)) {
            source.forEach(([key, value]) => {
                merged[key] = value;
            });
            return;
        }

        if (typeof source === 'object') {
            Object.entries(source).forEach(([key, value]) => {
                merged[key] = value;
            });
        }
    };

    appendEntries(headers);
    return merged;
}

async function parseHttpResponse(response) {
    const contentType = String(response?.headers?.get('content-type') || '').toLowerCase();
    const rawBody = await response.text().catch(() => '');
    let body = {};
    let parseError = null;

    if (rawBody && rawBody.trim()) {
        try {
            body = JSON.parse(rawBody);
        } catch (err) {
            parseError = err?.message || String(err);
        }
    }

    return {
        body,
        rawBody,
        contentType,
        parseError
    };
}

async function rawJsonRequest(url, init = {}, timeoutMs = AUTH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...init,
            signal: controller.signal
        });
        const parsed = await parseHttpResponse(response);
        return {
            ok: response.ok,
            status: response.status,
            ...parsed
        };
    } catch (error) {
        return {
            ok: false,
            status: 0,
            body: {},
            rawBody: '',
            contentType: '',
            parseError: null,
            error: error?.message || String(error)
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function loginBackend(storeLike = store) {
    const baseConfig = getBaseBackendConfig(storeLike);
    if (!baseConfig.apiUrl || !baseConfig.login || !baseConfig.password) {
        throw new Error('Configure URL da API, usuario e senha antes de usar o Hub da Magazine do Povo.');
    }

    info('Hub: autenticando usuario no backend', {
        metadata: {
            area: 'backendAuth',
            apiUrl: baseConfig.apiUrl,
            login: baseConfig.login,
            hasIdfilialSalvo: !!baseConfig.idfilial
        }
    });

    const response = await rawJsonRequest(`${baseConfig.apiUrl}login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            login: baseConfig.login,
            senha: baseConfig.password
        })
    });

    if (!response.ok || response.body?.error) {
        throw new Error(response.body?.error || response.error || `Falha no login HTTP ${response.status}`);
    }

    const result = normalizeLoginResult(response.body?.result || {}, baseConfig.idfilial);
    if (!result.authorization) {
        throw new Error('Resposta de login sem token JWT valido.');
    }

    if (!result.idfilial) {
        throw new Error('Resposta de login sem idfilial.');
    }

    storeLike.set({
        backendAuthToken: result.authorization,
        backendAuthExpiresAt: result.expiresAt,
        backendAuthAuthenticatedAt: Date.now(),
        backendAuthApiUrl: baseConfig.apiUrl,
        backendAuthLogin: baseConfig.login,
        backendAuthUser: result.usuario,
        backendAuthFilial: result.filial || { idfilial: Number(result.idfilial) },
        backendAuthPayload: result.payload,
        idfilial: result.idfilial,
        idempresa: result.idfilial,
        myzap_backendApiToken: result.authorization,
        clickexpress_queueToken: result.authorization
    });

    return {
        ...result,
        apiUrl: baseConfig.apiUrl,
        login: baseConfig.login
    };
}

async function ensureBackendSession(options = {}) {
    const storeLike = options.storeLike || store;
    const baseConfig = getBaseBackendConfig(storeLike);
    if (!baseConfig.apiUrl || !baseConfig.login || !baseConfig.password) {
        throw new Error('Configure URL da API, usuario e senha antes de usar o Hub da Magazine do Povo.');
    }

    const currentSession = readStoredAuthSession(storeLike);
    if (!options.forceRefresh && isAuthSessionValid(currentSession, baseConfig)) {
        return {
            ...currentSession,
            apiUrl: baseConfig.apiUrl,
            login: baseConfig.login
        };
    }

    return loginBackend(storeLike);
}

function buildBackendUrl(apiUrl, resourcePath) {
    const normalizedBaseUrl = normalizeBaseUrl(apiUrl);
    const normalizedPath = String(resourcePath || '').replace(/^\/+/, '');
    return `${normalizedBaseUrl}${normalizedPath}`;
}

function isAuthFailure(response) {
    if (Number(response?.status) === 401) {
        return true;
    }

    const bodyError = String(response?.body?.error || '').trim().toLowerCase();
    const bodyResult = String(response?.body?.result || '').trim().toLowerCase();
    const responseText = `${bodyError} ${bodyResult}`;

    return responseText.includes('token')
        && (
            responseText.includes('inválido')
            || responseText.includes('invalido')
            || responseText.includes('sem permissão')
            || responseText.includes('sem permissao')
            || responseText.includes('expir')
        );
}

async function fetchBackendJson(resourcePath, init = {}, options = {}) {
    const storeLike = options.storeLike || store;
    const retryOnUnauthorized = options.retryOnUnauthorized !== false;
    let authRefreshed = false;

    for (let attempt = 0; attempt < 2; attempt++) {
        const session = await ensureBackendSession({
            storeLike,
            forceRefresh: attempt > 0
        });
        const url = buildBackendUrl(session.apiUrl, resourcePath);
        const headers = buildHeaders(init.headers);
        headers.Authorization = session.authorization;

        const response = await rawJsonRequest(url, {
            ...init,
            headers
        }, options.timeoutMs || AUTH_TIMEOUT_MS);

        const result = {
            ...response,
            url,
            authorization: session.authorization,
            session,
            authRefreshed
        };

        if (attempt === 0 && retryOnUnauthorized && isAuthFailure(result)) {
            warn('Hub: token JWT expirado ou invalido, renovando autenticacao automaticamente', {
                metadata: {
                    area: 'backendAuth',
                    url,
                    status: result.status,
                    error: result.body?.error || result.error || null
                }
            });
            clearBackendAuthSession(storeLike);
            authRefreshed = true;
            continue;
        }

        return result;
    }

    throw new Error('Nao foi possivel autenticar novamente no Hub da Magazine do Povo.');
}

module.exports = {
    AUTH_EXPIRY_SKEW_MS,
    normalizeFilialId,
    getBaseBackendConfig,
    readStoredAuthSession,
    clearBackendAuthSession,
    ensureBackendSession,
    fetchBackendJson
};
