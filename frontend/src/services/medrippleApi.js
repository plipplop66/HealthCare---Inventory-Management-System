import { createApiClient } from './apiClient';
import { createMedrippleClient, createTokenStore } from './medrippleClient';
import { createMockTransport } from './mockTransport';

const apiBase = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.PROD ? '/api' : '')).replace(/\/$/, '');

// Mock mode serves labelled MOCK DATA in the API's own envelope shape; it is never mixed with live data.
export const usingMockData = import.meta.env.VITE_USE_MOCKS === 'true' || !apiBase;

let browserStorage;
try { browserStorage = typeof window === 'undefined' ? undefined : window.localStorage; } catch { /* Storage may be disabled. */ }
const tokenStore = createTokenStore(browserStorage);

const request = usingMockData
  ? createMockTransport()
  : createApiClient({ baseUrl: apiBase, tokenStore, onUnauthorized: () => tokenStore.clear() });

export const medrippleApi = createMedrippleClient(request, tokenStore);
