// Route-level client for the MEDRIPPLE Node API. The browser never calls the intelligence service directly:
// React -> Node API -> Python -> database. Every method returns the API envelope ({ data, meta }).

const encode = encodeURIComponent;
const LIFECYCLE_ENDPOINTS = { DISPATCH: 'dispatch', DELIVER: 'deliver', CANCEL: 'cancel' };

export function createTokenStore(storage, key = 'medripple.session') {
  let memory = '';
  const read = () => { try { return storage?.getItem(key) || ''; } catch { return ''; } };
  return {
    get: () => memory || read(),
    set(token) {
      memory = token || '';
      try { if (token) storage?.setItem(key, token); else storage?.removeItem(key); } catch { /* Keep the in-memory session. */ }
    },
    clear() { this.set(''); },
  };
}

export function createMedrippleClient(request, tokenStore) {
  return {
    async restoreSession() {
      if (!tokenStore.get()) return null;
      try {
        return (await request('/auth/me')).data.user;
      } catch (error) {
        if (error.status === 401) { tokenStore.clear(); return null; }
        throw error;
      }
    },
    async login({ email, password }) {
      const { data } = await request('/auth/login', { method: 'POST', body: { email, password }, auth: false });
      tokenStore.set(data.token);
      return data;
    },
    async register({ name, email, password }) {
      const { data } = await request('/auth/signup', { method: 'POST', body: { name, email, password }, auth: false });
      tokenStore.set(data.token);
      return data;
    },
    async logout() {
      if (tokenStore.get()) {
        try { await request('/auth/logout', { method: 'POST' }); } catch { /* Removing the local token is sufficient. */ }
      }
      tokenStore.clear();
    },
    regionSummary: () => request('/region/summary'),
    facilities: () => request('/facilities'),
    medicines: () => request('/medicines'),
    inventory: (facilityId, medicineId) => request(`/facilities/${encode(facilityId)}/inventory?medicineId=${encode(medicineId)}`),
    forecast: ({ facilityId, medicineId, horizonDays }) => request('/forecast', { method: 'POST', body: { facilityId, medicineId, horizonDays } }),
    optimize: ({ destinationFacilityId, medicineId, quantity, horizonDays }) => request('/plans/optimize', {
      method: 'POST', body: { destinationFacilityId, medicineId, quantity, horizonDays },
    }),
    plan: (planId) => request(`/plans/${encode(planId)}`),
    decide: (planId, decision, note) => request(`/plans/${encode(planId)}/approve`, { method: 'POST', body: { decision, note } }),
    transition(planId, action, note) {
      const endpoint = LIFECYCLE_ENDPOINTS[action];
      if (!endpoint) throw new Error(`Unsupported plan action ${action}.`);
      return request(`/plans/${encode(planId)}/${endpoint}`, { method: 'POST', body: { note } });
    },
    audit: () => request('/audit'),
  };
}
