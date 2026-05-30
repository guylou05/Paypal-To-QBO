import axios from 'axios';

const api = axios.create({
  baseURL:         '/api',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

// Redirect to login on 401
api.interceptors.response.use(
  r => r,
  err => {
    if (err.response && err.response.status === 401) {
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;

// ── Auth ───────────────────────────────────────────────────────────────────
export const authApi = {
  login:          (email, password) => api.post('/auth/login', { email, password }),
  logout:         ()                => api.post('/auth/logout'),
  me:             ()                => api.get('/auth/me'),
  changePassword: (currentPassword, newPassword) =>
                  api.post('/auth/change-password', { currentPassword, newPassword }),
  updateProfile:  (email)           => api.patch('/auth/profile', { email }),
};

// ── PayPal ─────────────────────────────────────────────────────────────────
export const paypalApi = {
  status:         ()              => api.get('/paypal/status'),
  saveCredentials:(clientId, clientSecret) =>
                  api.post('/paypal/credentials', { clientId, clientSecret }),
  check:          (startDate, endDate) =>
                  api.get('/paypal/import/check', { params: { startDate, endDate } }),
  import:         (startDate, endDate) =>
                  api.post('/paypal/import', { startDate, endDate }),
  batches:        ()              => api.get('/paypal/batches'),
  batchDetail:    (id)            => api.get(`/paypal/batches/${id}`),
};

// ── QuickBooks ─────────────────────────────────────────────────────────────
export const qboApi = {
  status:         ()             => api.get('/quickbooks/status'),
  connect:        ()             => api.get('/quickbooks/connect'),
  disconnect:     ()             => api.post('/quickbooks/disconnect'),
  accounts:       ()             => api.get('/quickbooks/accounts'),
  customers:      ()             => api.get('/quickbooks/customers'),
  createCustomer: (DisplayName)  => api.post('/quickbooks/customers', { DisplayName }),
  vendors:        ()             => api.get('/quickbooks/vendors'),
  createVendor:   (DisplayName)  => api.post('/quickbooks/vendors',   { DisplayName }),
  classes:        ()             => api.get('/quickbooks/classes'),
  items:          ()             => api.get('/quickbooks/items'),
  getMappings:    ()             => api.get('/quickbooks/mappings'),
  saveMappings:   (mappings)     => api.put('/quickbooks/mappings', { mappings }),
  bankMatches:    (params)       => api.get('/quickbooks/bank-matches', { params }),
};

// ── Transactions ───────────────────────────────────────────────────────────
export const txApi = {
  list:          (params)    => api.get('/transactions', { params }),
  summary:       ()          => api.get('/transactions/summary'),
  get:           (id)        => api.get(`/transactions/${id}`),
  update:        (id, data)  => api.patch(`/transactions/${id}`, data),
  bulkApprove:   (ids)       => api.post('/transactions/bulk-approve', { ids }),
  bulkIgnore:    (ids)       => api.post('/transactions/bulk-ignore', { ids }),
  bulkUpdate:    (ids, updates) => api.post('/transactions/bulk-update', { ids, updates }),
  sync:          (id)        => api.post(`/transactions/${id}/sync`),
  syncBatch:     ()          => api.post('/transactions/sync-batch'),
  rollback:      (id)        => api.post(`/transactions/${id}/rollback`),
  reclassify:          ()    => api.post('/transactions/reclassify-batch'),
  recomputeTypes:      ()    => api.post('/transactions/recompute-types'),
  fixFundingDetails:   ()    => api.post('/transactions/fix-funding-details'),
  customerMatch: (params)    => api.get('/transactions/customer-match', { params }),
  enqueueSyncBatch: (ids)    => api.post('/transactions/sync-queue', { ids }),
  syncBatchStatus:  (batchId)=> api.get(`/transactions/sync-queue/${batchId}`),
  cancelSyncBatch:  (batchId)=> api.delete(`/transactions/sync-queue/${batchId}`),
};

// ── Settings ───────────────────────────────────────────────────────────────
export const settingsApi = {
  get:               ()       => api.get('/settings'),
  getRules:          ()       => api.get('/settings/classification-rules'),
  createRule:        (data)   => api.post('/settings/classification-rules', data),
  updateRule:        (id, d)  => api.put(`/settings/classification-rules/${id}`, d),
  deleteRule:        (id)     => api.delete(`/settings/classification-rules/${id}`),
  testRule:          (data)   => api.post('/settings/classification-rules/test', data),
  // Auto-import schedule
  getAutoImport:     ()       => api.get('/settings/auto-import'),
  saveAutoImport:    (data)   => api.put('/settings/auto-import', data),
  runAutoImport:     ()       => api.post('/settings/auto-import/run-now'),
};

// ── Reports ────────────────────────────────────────────────────────────────
export const reportsApi = {
  reconciliation: (params) => api.get('/reports/reconciliation',        { params }),
  detail:         (params) => api.get('/reports/reconciliation-detail', { params }),
  paypalCredit:   (params) => api.get('/reports/paypal-credit',         { params }),
  fees:           (params) => api.get('/reports/fees',                  { params }),
  transfers:      (params) => api.get('/reports/transfers',             { params }),
  exceptions:     ()       => api.get('/reports/exceptions'),
};

// ── Logs ───────────────────────────────────────────────────────────────────
export const logsApi = {
  audit:     (params) => api.get('/logs/audit', { params }),
  sync:      (params) => api.get('/logs/sync',  { params }),
  rollbacks: ()       => api.get('/logs/rollbacks'),
  syncDetail:(id)     => api.get(`/logs/sync/${id}`),
};
