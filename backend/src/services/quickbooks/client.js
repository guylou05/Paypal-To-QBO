/**
 * QuickBooks Online API client.
 *
 * OAuth flow uses intuit-oauth; actual API calls go through axios
 * so we have full control over headers and error handling.
 */
const OAuthClient = require('intuit-oauth');
const axios       = require('axios');
const config      = require('../../config');
const db          = require('../../db/knex');
const { encrypt, decrypt } = require('../../utils/encryption');
const logger      = require('../../utils/logger');

// ── OAuth client instance ──────────────────────────────────────────────────
function makeOAuthClient() {
  return new OAuthClient({
    clientId:     config.qbo.clientId,
    clientSecret: config.qbo.clientSecret,
    environment:  config.qbo.environment,
    redirectUri:  config.qbo.redirectUri,
    logging:      false,
  });
}

// ── Token storage helpers ──────────────────────────────────────────────────
async function saveToken(tokenResponse) {
  const raw = tokenResponse.token || tokenResponse;
  const existing = await db('oauth_tokens').where({ provider: 'quickbooks' }).first();

  const row = {
    provider:                'quickbooks',
    realm_id:                raw.realmId || (existing && existing.realm_id),
    access_token_encrypted:  encrypt(raw.access_token),
    refresh_token_encrypted: raw.refresh_token ? encrypt(raw.refresh_token) : null,
    access_token_expires_at: raw.expires_in
      ? new Date(Date.now() + raw.expires_in * 1000)
      : null,
    refresh_token_expires_at: raw.x_refresh_token_expires_in
      ? new Date(Date.now() + raw.x_refresh_token_expires_in * 1000)
      : null,
    token_metadata: JSON.stringify({
      token_type: raw.token_type,
    }),
    updated_at: new Date(),
  };

  if (existing) {
    await db('oauth_tokens').where({ id: existing.id }).update(row);
  } else {
    await db('oauth_tokens').insert({ ...row, created_at: new Date() });
  }
}

async function getStoredToken() {
  return db('oauth_tokens').where({ provider: 'quickbooks' }).first();
}

// ── Token refresh ──────────────────────────────────────────────────────────
const TOKEN_BUFFER_SECS = 120;

async function getValidAccessToken() {
  const stored = await getStoredToken();
  if (!stored) throw new Error('QuickBooks not connected. Please complete OAuth setup.');

  const now       = new Date();
  const expiresAt = stored.access_token_expires_at ? new Date(stored.access_token_expires_at) : null;
  const secsLeft  = expiresAt ? (expiresAt - now) / 1000 : 0;

  if (secsLeft > TOKEN_BUFFER_SECS) {
    return { accessToken: decrypt(stored.access_token_encrypted), realmId: stored.realm_id };
  }

  // Try refresh
  const refreshToken = stored.refresh_token_encrypted
    ? decrypt(stored.refresh_token_encrypted)
    : null;
  if (!refreshToken) throw new Error('QuickBooks refresh token missing. Please reconnect.');

  logger.info('QBO: refreshing access token');
  const oauthClient = makeOAuthClient();
  oauthClient.setToken({ refresh_token: refreshToken });

  try {
    const resp = await oauthClient.refresh();
    const newToken = resp.getJson();
    newToken.realmId = stored.realm_id; // refresh doesn't return realmId
    await saveToken(newToken);
    return { accessToken: newToken.access_token, realmId: stored.realm_id };
  } catch (err) {
    logger.error('QBO token refresh failed', { error: err.message });
    throw new Error('QuickBooks token refresh failed. Please reconnect.');
  }
}

// ── Raw API call ───────────────────────────────────────────────────────────
async function apiCall(method, path, data = null) {
  const { accessToken, realmId } = await getValidAccessToken();
  const url = `${config.qbo.baseUrl}/v3/company/${realmId}${path}`;

  try {
    const resp = await axios({
      method,
      url,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept:        'application/json',
        'Content-Type': 'application/json',
      },
      params: method === 'GET' ? data : undefined,
      data:   method !== 'GET' ? data : undefined,
    });
    return resp.data;
  } catch (err) {
    const body = err.response && err.response.data;
    logger.error('QBO API error', { method, path, status: err.response && err.response.status, body });
    throw new Error(
      `QBO API ${method} ${path} failed: ` +
      (body && body.Fault ? body.Fault.Error[0].Detail : err.message)
    );
  }
}

// ── OAuth flow helpers (used by routes) ───────────────────────────────────
function getAuthorizationUrl(state) {
  const oauthClient = makeOAuthClient();
  return oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state,
  });
}

async function handleCallback(callbackUrl) {
  // callbackUrl must be an absolute URL (e.g. http://localhost:3001/api/quickbooks/callback?code=...)
  // intuit-oauth's createToken() and new URL() both require it.
  if (!callbackUrl.startsWith('http')) {
    throw new Error(`handleCallback received a relative URL: "${callbackUrl}". Pass the full absolute URL.`);
  }

  const oauthClient = makeOAuthClient();
  const resp = await oauthClient.createToken(callbackUrl);
  const token = resp.getJson();

  // realmId is in the callback query string
  const url = new URL(callbackUrl);
  token.realmId = url.searchParams.get('realmId');

  await saveToken(token);
  return token;
}

// ── QBO entity queries ─────────────────────────────────────────────────────
async function getRealmId() {
  const stored = await getStoredToken();
  return stored && stored.realm_id;
}

async function queryAccounts() {
  const resp = await apiCall('GET', '/query', {
    query: "SELECT * FROM Account WHERE Active = true MAXRESULTS 1000",
    minorversion: 65,
  });
  return (resp.QueryResponse && resp.QueryResponse.Account) || [];
}

async function queryCustomers() {
  const resp = await apiCall('GET', '/query', {
    query: "SELECT * FROM Customer WHERE Active = true MAXRESULTS 1000",
    minorversion: 65,
  });
  return (resp.QueryResponse && resp.QueryResponse.Customer) || [];
}

async function queryVendors() {
  const resp = await apiCall('GET', '/query', {
    query: "SELECT * FROM Vendor WHERE Active = true MAXRESULTS 1000",
    minorversion: 65,
  });
  return (resp.QueryResponse && resp.QueryResponse.Vendor) || [];
}

async function queryClasses() {
  const resp = await apiCall('GET', '/query', {
    query: "SELECT * FROM Class WHERE Active = true MAXRESULTS 500",
    minorversion: 65,
  });
  return (resp.QueryResponse && resp.QueryResponse.Class) || [];
}

// ── Bank transaction queries (for transfer matching) ──────────────────────

/**
 * Fetch QBO Transfer objects in a date range.
 * These represent explicit account-to-account transfers entered in QBO.
 */
async function queryTransfersInRange(startDate, endDate) {
  const resp = await apiCall('GET', '/query', {
    query: `SELECT * FROM Transfer WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 200`,
    minorversion: 65,
  });
  return (resp.QueryResponse && resp.QueryResponse.Transfer) || [];
}

/**
 * Fetch QBO Deposit objects in a date range.
 * PayPal → Bank transfers appear as Deposits in the bank account.
 */
async function queryDepositsInRange(startDate, endDate) {
  const resp = await apiCall('GET', '/query', {
    query: `SELECT * FROM Deposit WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 200`,
    minorversion: 65,
  });
  return (resp.QueryResponse && resp.QueryResponse.Deposit) || [];
}

/**
 * Fetch QBO Purchase objects in a date range.
 * Bank → PayPal funding transfers may appear as Purchases/checks from the bank.
 */
async function queryPurchasesInRange(startDate, endDate) {
  const resp = await apiCall('GET', '/query', {
    query: `SELECT * FROM Purchase WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 200`,
    minorversion: 65,
  });
  return (resp.QueryResponse && resp.QueryResponse.Purchase) || [];
}

async function getCompanyInfo() {
  const realmId = await getRealmId();
  const resp = await apiCall('GET', `/companyinfo/${realmId}`, { minorversion: 65 });
  return resp.CompanyInfo;
}

// ── Transaction creators ───────────────────────────────────────────────────

async function createJournalEntry(payload) {
  const resp = await apiCall('POST', '/journalentry?minorversion=65', payload);
  return resp.JournalEntry;
}

async function createTransfer(payload) {
  const resp = await apiCall('POST', '/transfer?minorversion=65', payload);
  return resp.Transfer;
}

async function createPurchase(payload) {
  const resp = await apiCall('POST', '/purchase?minorversion=65', payload);
  return resp.Purchase;
}

async function createRefundReceipt(payload) {
  const resp = await apiCall('POST', '/refundreceipt?minorversion=65', payload);
  return resp.RefundReceipt;
}

async function createSalesReceipt(payload) {
  const resp = await apiCall('POST', '/salesreceipt?minorversion=65', payload);
  return resp.SalesReceipt;
}

// ── Fetch + update existing objects ───────────────────────────────────────

/**
 * Fetch a single QBO object by type and ID.
 * objectType must match QBO entity names exactly: 'Transfer', 'Deposit', 'Purchase', etc.
 * Returns the unwrapped entity object (with Id, SyncToken, etc.) or null if not found.
 */
async function getObject(objectType, id) {
  const path = `/${objectType.toLowerCase()}/${id}?minorversion=65`;
  const resp = await apiCall('GET', path);
  return resp[objectType] || null;
}

/**
 * Sparse-update the PrivateNote on an existing QBO object without touching any
 * accounting fields. Requires the current SyncToken (fetch first with getObject).
 * objectType: 'Transfer' | 'Deposit' | 'Purchase'
 */
async function sparseUpdateNote(objectType, id, syncToken, note) {
  const path = `/${objectType.toLowerCase()}?minorversion=65`;
  const resp = await apiCall('POST', path, {
    Id:          id,
    SyncToken:   String(syncToken),
    sparse:      true,
    PrivateNote: note,
  });
  return resp[objectType];
}

// ── Delete / rollback ──────────────────────────────────────────────────────
async function deleteObject(objectType, id, syncToken) {
  const body = { Id: id, SyncToken: syncToken };
  const path = `/${objectType.toLowerCase()}?operation=delete&minorversion=65`;
  const resp = await apiCall('POST', path, body);
  return resp;
}

async function isConnected() {
  try {
    const stored = await getStoredToken();
    if (!stored) return false;
    await getValidAccessToken();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  queryTransfersInRange,
  queryDepositsInRange,
  queryPurchasesInRange,
  getAuthorizationUrl,
  handleCallback,
  saveToken,
  getValidAccessToken,
  apiCall,
  getRealmId,
  queryAccounts,
  queryCustomers,
  queryVendors,
  queryClasses,
  getCompanyInfo,
  createJournalEntry,
  createTransfer,
  createPurchase,
  createRefundReceipt,
  createSalesReceipt,
  getObject,
  sparseUpdateNote,
  deleteObject,
  isConnected,
};
