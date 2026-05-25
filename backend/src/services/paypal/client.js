/**
 * PayPal REST API client.
 * Credentials are stored encrypted in the DB via Settings.
 * Each call auto-refreshes the access token when needed.
 */
const axios  = require('axios');
const config = require('../../config');
const db     = require('../../db/knex');
const { encrypt, decrypt } = require('../../utils/encryption');
const logger = require('../../utils/logger');

const TOKEN_BUFFER_SECS = 120; // refresh 2 min before expiry

async function getStoredCredentials() {
  const clientIdRow     = await db('settings').where({ key: 'paypal_client_id' }).first();
  const clientSecretRow = await db('settings').where({ key: 'paypal_client_secret' }).first();

  if (!clientIdRow || !clientSecretRow) {
    throw new Error('PayPal credentials not configured. Please complete setup.');
  }

  return {
    clientId:     decrypt(clientIdRow.value),
    clientSecret: decrypt(clientSecretRow.value),
  };
}

async function fetchNewToken(clientId, clientSecret) {
  const url = `${config.paypal.baseUrl}/v1/oauth2/token`;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const resp = await axios.post(url, 'grant_type=client_credentials', {
    headers: {
      Authorization:  `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  return {
    accessToken: resp.data.access_token,
    expiresIn:   resp.data.expires_in, // seconds
    appId:       resp.data.app_id,
  };
}

async function getAccessToken() {
  const existing = await db('oauth_tokens').where({ provider: 'paypal' }).first();
  const now = new Date();

  if (existing && existing.access_token_expires_at) {
    const expiresAt = new Date(existing.access_token_expires_at);
    const secondsLeft = (expiresAt - now) / 1000;
    if (secondsLeft > TOKEN_BUFFER_SECS) {
      return decrypt(existing.access_token_encrypted);
    }
  }

  // Fetch a fresh token
  const { clientId, clientSecret } = await getStoredCredentials();
  const { accessToken, expiresIn } = await fetchNewToken(clientId, clientSecret);
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  const row = {
    provider:               'paypal',
    access_token_encrypted: encrypt(accessToken),
    refresh_token_encrypted: null,
    access_token_expires_at: expiresAt,
    refresh_token_expires_at: null,
    token_metadata: JSON.stringify({ app_id: '' }),
  };

  if (existing) {
    await db('oauth_tokens').where({ id: existing.id }).update({ ...row, updated_at: now });
  } else {
    await db('oauth_tokens').insert({ ...row, created_at: now, updated_at: now });
  }

  return accessToken;
}

/**
 * Fetch a page of transactions from the PayPal Transaction Search API.
 * date params are ISO 8601 strings (e.g. "2024-01-01T00:00:00-0000").
 */
async function fetchTransactions({ startDate, endDate, page = 1, pageSize = 100 }) {
  const token = await getAccessToken();

  const params = {
    start_date: startDate,
    end_date:   endDate,
    fields:     'all',
    page_size:  pageSize,
    page,
  };

  const resp = await axios.get(`${config.paypal.baseUrl}/v1/reporting/transactions`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });

  return resp.data; // { transaction_details, total_items, total_pages, ... }
}

/**
 * Fetch ALL pages for a date range (auto-paginate).
 */
async function fetchAllTransactions({ startDate, endDate }) {
  const firstPage = await fetchTransactions({ startDate, endDate, page: 1 });
  const { total_pages, transaction_details: firstBatch } = firstPage;

  let all = [...(firstBatch || [])];

  for (let p = 2; p <= total_pages; p++) {
    logger.info(`PayPal: fetching page ${p} of ${total_pages}`);
    const page = await fetchTransactions({ startDate, endDate, page: p });
    all = all.concat(page.transaction_details || []);
    // Polite delay to avoid rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  return all;
}

/**
 * Test that stored credentials are valid.
 */
async function testConnection() {
  const { clientId, clientSecret } = await getStoredCredentials();
  await fetchNewToken(clientId, clientSecret);
  return true;
}

module.exports = { fetchAllTransactions, fetchTransactions, testConnection, getAccessToken };
