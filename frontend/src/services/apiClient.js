// The only place the browser talks HTTP to the MEDRIPPLE Node API. Every call returns the API envelope unchanged
// ({ data, meta }), so screens can show where a result came from and whether it is a fallback.

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', details = null, requestId = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export function normaliseMeta(meta = {}) {
  return {
    ...meta,
    source: meta.source || '',
    fallback: meta.fallback === true,
    decisionSupportOnly: meta.decisionSupportOnly === true,
    requestId: meta.requestId || '',
  };
}

export function createApiClient({ baseUrl, fetchImpl = (...args) => fetch(...args), tokenStore, timeoutMs = 45000, onUnauthorized = () => {} }) {
  const root = String(baseUrl || '').replace(/\/$/, '');
  return async function request(path, { method = 'GET', body, auth = true } = {}) {
    const token = auth ? tokenStore?.get() : '';
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        cache: 'no-store',
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new ApiError(timedOut ? 'The MEDRIPPLE API did not respond in time.' : 'The MEDRIPPLE API could not be reached.', {
        code: timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
      });
    }
    const payload = await response.json().catch(() => null);
    const requestId = payload?.meta?.requestId || response.headers?.get?.('x-request-id') || '';
    if (response.status === 401 && auth) onUnauthorized();
    if (!response.ok) {
      const error = payload?.error;
      throw new ApiError(error?.message || `The MEDRIPPLE API returned ${response.status}.`, {
        status: response.status,
        code: error?.code || 'HTTP_ERROR',
        details: error?.details ?? null,
        requestId,
      });
    }
    if (!payload || typeof payload !== 'object' || !('data' in payload)) {
      throw new ApiError('The MEDRIPPLE API returned an unreadable response.', { status: response.status, code: 'INVALID_API_RESPONSE', requestId });
    }
    return { data: payload.data, meta: normaliseMeta({ ...payload.meta, requestId }) };
  };
}
