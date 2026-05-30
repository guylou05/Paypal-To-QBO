const express = require('express');
const crypto  = require('crypto');
const db      = require('../db/knex');
const { authenticate, requireAdmin } = require('../middleware/auth');
const qboClient = require('../services/quickbooks/client');
const logger  = require('../utils/logger');

const router = express.Router();

// OAuth start — NOT protected so the browser redirect works cleanly
// We store state in a short-lived cookie to validate the callback
router.get('/connect', authenticate, requireAdmin, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('qbo_oauth_state', state, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   10 * 60 * 1000, // 10 min
  });

  const url = qboClient.getAuthorizationUrl(state);
  return res.json({ authUrl: url });
});

// OAuth callback — Intuit redirects here
router.get('/callback', async (req, res) => {
  const config     = require('../config');
  const frontendUrl = config.frontendUrl;

  try {
    const storedState = req.cookies && req.cookies.qbo_oauth_state;
    if (!storedState || storedState !== req.query.state) {
      return res.redirect(`${frontendUrl}/setup?qbo_error=invalid_state`);
    }

    res.clearCookie('qbo_oauth_state');

    // intuit-oauth's createToken() and new URL() both need an absolute URL.
    // req.url is only the path+query string (/api/quickbooks/callback?code=...).
    // Build the full URL from the configured redirect URI + the incoming query string.
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const fullCallbackUrl = config.qbo.redirectUri + qs;

    await qboClient.handleCallback(fullCallbackUrl);

    logger.info('QBO OAuth connected');
    return res.redirect(`${frontendUrl}/setup?qbo_connected=1`);
  } catch (err) {
    logger.error('QBO OAuth callback error', { error: err.message });
    return res.redirect(`${frontendUrl}/setup?qbo_error=${encodeURIComponent(err.message)}`);
  }
});

router.use(authenticate, requireAdmin);

// GET /api/quickbooks/status
router.get('/status', async (req, res) => {
  const config      = require('../config');
  const environment = config.qbo.environment || 'production';
  const connected   = await qboClient.isConnected();

  // Read token expiry from DB regardless of connection state
  let tokenExpiry = null;
  try {
    const tokenRow = await db('oauth_tokens')
      .where({ provider: 'quickbooks' })
      .orderBy('updated_at', 'desc')
      .select('refresh_token_expires_at')
      .first();
    if (tokenRow && tokenRow.refresh_token_expires_at) {
      const expiresAt = new Date(tokenRow.refresh_token_expires_at);
      const now       = new Date();
      const msLeft    = expiresAt - now;
      tokenExpiry = {
        expires_at:    expiresAt.toISOString(),
        days_remaining: Math.floor(msLeft / (1000 * 60 * 60 * 24)),
      };
    }
  } catch (_) { /* non-fatal */ }

  if (!connected) return res.json({ connected: false, environment, tokenExpiry });

  try {
    const info = await qboClient.getCompanyInfo();
    return res.json({ connected: true, company: info, environment, tokenExpiry });
  } catch (err) {
    return res.json({ connected: true, error: err.message, environment, tokenExpiry });
  }
});

// GET /api/quickbooks/accounts — fetch Chart of Accounts from QBO
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await qboClient.queryAccounts();
    return res.json(accounts);
  } catch (err) {
    logger.error('QBO accounts fetch error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/quickbooks/customers
router.get('/customers', async (req, res) => {
  try {
    const customers = await qboClient.queryCustomers();
    return res.json(customers);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/quickbooks/vendors
router.get('/vendors', async (req, res) => {
  try {
    const vendors = await qboClient.queryVendors();
    return res.json(vendors);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/quickbooks/vendors — create a new QBO Vendor on the fly
// Used by EditModal when the reviewer types a vendor name that doesn't exist yet.
router.post('/vendors',
  require('express-validator').body('DisplayName').notEmpty().withMessage('DisplayName is required'),
  require('../middleware/validate').handleValidation,
  async (req, res) => {
    try {
      const vendor = await qboClient.createVendor({ DisplayName: req.body.DisplayName.trim() });
      logger.info('QBO vendor created', { id: vendor.Id, name: vendor.DisplayName });
      await db('audit_logs').insert({
        user_id:    req.user.id,
        action:     'qbo_create',
        entity_type:'vendor',
        entity_id:  vendor.Id,
        details:    `Created QBO Vendor: ${vendor.DisplayName}`,
        created_at: new Date(), updated_at: new Date(),
      });
      return res.json(vendor);
    } catch (err) {
      logger.error('QBO vendor create failed', { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/quickbooks/customers — create a new QBO Customer on the fly
router.post('/customers',
  require('express-validator').body('DisplayName').notEmpty().withMessage('DisplayName is required'),
  require('../middleware/validate').handleValidation,
  async (req, res) => {
    try {
      const customer = await qboClient.createCustomer({ DisplayName: req.body.DisplayName.trim() });
      logger.info('QBO customer created', { id: customer.Id, name: customer.DisplayName });
      await db('audit_logs').insert({
        user_id:    req.user.id,
        action:     'qbo_create',
        entity_type:'customer',
        entity_id:  customer.Id,
        details:    `Created QBO Customer: ${customer.DisplayName}`,
        created_at: new Date(), updated_at: new Date(),
      });
      return res.json(customer);
    } catch (err) {
      logger.error('QBO customer create failed', { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  }
);

// GET /api/quickbooks/classes
router.get('/classes', async (req, res) => {
  try {
    const classes = await qboClient.queryClasses();
    return res.json(classes);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/quickbooks/items
// Returns active Service/Non-Inventory items — used as line-item refs on
// SalesReceipts and RefundReceipts (required by QBO API for those object types).
router.get('/items', async (req, res) => {
  try {
    const items = await qboClient.queryItems();
    return res.json(items);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/quickbooks/bank-matches
// Query QBO for bank transactions that could match a PayPal transfer.
//
// Query params:
//   date      — PayPal transaction date (YYYY-MM-DD)  [required]
//   amount    — absolute gross amount (number)         [required]
//   direction — 'out' (PayPal→Bank) | 'in' (Bank→PayPal) [required]
//   dayRange  — days ±  to search (default 5)
//
// We read bank_account_1/2/3 + paypal_bank from account_mappings and
// query QBO Transfer, Deposit, and Purchase objects in the date window.
// Results are filtered by account ID and ranked by date proximity.
router.get('/bank-matches', async (req, res) => {
  const { date, amount, direction, dayRange = 5 } = req.query;
  if (!date || !amount || !direction) {
    return res.status(400).json({ error: 'date, amount, and direction are required' });
  }

  const targetDate   = new Date(date);
  const targetAmount = parseFloat(amount);
  const range        = parseInt(dayRange, 10);

  const startDate = new Date(targetDate); startDate.setDate(startDate.getDate() - range);
  const endDate   = new Date(targetDate); endDate.setDate(endDate.getDate()   + range);
  const fmt = d => d.toISOString().slice(0, 10);

  try {
    // Load mapped bank account IDs
    const bankMappings = await db('account_mappings')
      .whereIn('mapping_key', ['bank_account_1', 'bank_account_2', 'bank_account_3', 'paypal_bank'])
      .select('mapping_key', 'qbo_account_id', 'qbo_account_name');

    const bankRows = bankMappings.filter(m =>
      m.mapping_key.startsWith('bank_account') && m.qbo_account_id
    );
    const paypalRow = bankMappings.find(m => m.mapping_key === 'paypal_bank');
    const paypalAccId = paypalRow?.qbo_account_id;

    if (bankRows.length === 0) {
      return res.json({ matches: [], searched_accounts: [], note: 'No bank accounts mapped in Setup.' });
    }

    const bankAccountIds = bankRows.map(r => r.qbo_account_id);

    // Fetch QBO transactions in date window (all types in parallel)
    const [transfers, deposits, purchases] = await Promise.all([
      qboClient.queryTransfersInRange(fmt(startDate), fmt(endDate)),
      qboClient.queryDepositsInRange(fmt(startDate),  fmt(endDate)),
      qboClient.queryPurchasesInRange(fmt(startDate), fmt(endDate)),
    ]);

    // Normalize candidates into a common shape, filtering by bank account
    const candidates = [];

    // QBO Transfer objects — explicit account-to-account moves
    for (const t of transfers) {
      const fromId = t.FromAccountRef?.value;
      const toId   = t.ToAccountRef?.value;
      const amt    = parseFloat(t.Amount || 0);
      const txDate = new Date(t.TxnDate);

      // direction=out: PayPal → Bank → Deposit arrives at bank account
      //   QBO Transfer: From=PayPal, To=Bank
      // direction=in: Bank → PayPal → Withdrawal leaves bank account
      //   QBO Transfer: From=Bank, To=PayPal
      const isRelevant = direction === 'out'
        ? bankAccountIds.includes(toId)
        : bankAccountIds.includes(fromId);

      if (!isRelevant) continue;

      const relevantAccId   = direction === 'out' ? toId   : fromId;
      const relevantAccName = bankRows.find(r => r.qbo_account_id === relevantAccId)?.qbo_account_name || 'Bank Account';

      candidates.push({
        qbo_id:       t.Id,
        qbo_type:     'Transfer',
        qbo_date:     t.TxnDate,
        qbo_amount:   amt,
        qbo_memo:     t.PrivateNote || '',
        account_id:   relevantAccId,
        account_name: relevantAccName,
        _date:        txDate,
      });
    }

    // QBO Deposit objects — money arriving at bank (matches PayPal→Bank = 'out')
    if (direction === 'out') {
      for (const d of deposits) {
        const toId  = d.DepositToAccountRef?.value;
        if (!bankAccountIds.includes(toId)) continue;

        const amt    = parseFloat(d.TotalAmt || 0);
        const txDate = new Date(d.TxnDate);
        const memo   = (d.Line || []).map(l => l.Description).filter(Boolean).join('; ') || '';
        const accName = bankRows.find(r => r.qbo_account_id === toId)?.qbo_account_name || 'Bank Account';

        candidates.push({
          qbo_id:       d.Id,
          qbo_type:     'Deposit',
          qbo_date:     d.TxnDate,
          qbo_amount:   amt,
          qbo_memo:     memo,
          account_id:   toId,
          account_name: accName,
          _date:        txDate,
        });
      }
    }

    // QBO Purchase objects — money leaving bank (matches Bank→PayPal = 'in')
    if (direction === 'in') {
      for (const p of purchases) {
        const fromId = p.AccountRef?.value;
        if (!bankAccountIds.includes(fromId)) continue;

        const amt    = parseFloat(p.TotalAmt || 0);
        const txDate = new Date(p.TxnDate);
        const memo   = p.PrivateNote || p.Memo || '';
        const accName = bankRows.find(r => r.qbo_account_id === fromId)?.qbo_account_name || 'Bank Account';

        candidates.push({
          qbo_id:       p.Id,
          qbo_type:     'Purchase',
          qbo_date:     p.TxnDate,
          qbo_amount:   amt,
          qbo_memo:     memo,
          account_id:   fromId,
          account_name: accName,
          _date:        txDate,
        });
      }
    }

    // Score: require exact amount (±$0.01), rank by date proximity
    const AMOUNT_TOLERANCE = 0.01;
    const matches = candidates
      .filter(c => Math.abs(c.qbo_amount - targetAmount) <= AMOUNT_TOLERANCE)
      .map(c => {
        const daysDiff = Math.round(Math.abs((c._date - targetDate) / 86400000));
        return { ...c, days_diff: daysDiff, confidence: Math.max(0, 100 - daysDiff * 12) };
      })
      .sort((a, b) => b.confidence - a.confidence || a.days_diff - b.days_diff)
      .slice(0, 10)
      .map(({ _date, ...rest }) => rest); // strip internal _date field

    return res.json({
      matches,
      searched_accounts: bankRows.map(r => r.qbo_account_name).filter(Boolean),
      date_range: { start: fmt(startDate), end: fmt(endDate) },
      target: { date, amount: targetAmount, direction },
    });
  } catch (err) {
    logger.error('bank-matches error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/quickbooks/mappings — get current account mappings
router.get('/mappings', async (req, res) => {
  const mappings = await db('account_mappings').orderBy('mapping_key');
  return res.json(mappings);
});

// PUT /api/quickbooks/mappings — save account mappings
router.put('/mappings', async (req, res) => {
  const { mappings } = req.body; // [{ mapping_key, qbo_account_id, qbo_account_name, qbo_account_type }]
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings must be an array' });

  for (const m of mappings) {
    if (!m.mapping_key) continue;
    const existing = await db('account_mappings').where({ mapping_key: m.mapping_key }).first();
    if (existing) {
      await db('account_mappings').where({ id: existing.id }).update({
        qbo_account_id:   m.qbo_account_id   || null,
        qbo_account_name: m.qbo_account_name || null,
        qbo_account_type: m.qbo_account_type || null,
        updated_at:       new Date(),
      });
    } else {
      await db('account_mappings').insert({
        mapping_key:      m.mapping_key,
        qbo_account_id:   m.qbo_account_id   || null,
        qbo_account_name: m.qbo_account_name || null,
        qbo_account_type: m.qbo_account_type || null,
        created_at:       new Date(),
        updated_at:       new Date(),
      });
    }
  }

  await db('audit_logs').insert({
    user_id:    req.user.id,
    action:     'settings_update',
    entity_type:'account_mappings',
    details:    `Updated ${mappings.length} account mapping(s)`,
    created_at: new Date(), updated_at: new Date(),
  });

  return res.json({ message: 'Mappings saved' });
});

// POST /api/quickbooks/disconnect
router.post('/disconnect', async (req, res) => {
  await db('oauth_tokens').where({ provider: 'quickbooks' }).delete();
  logger.info('QBO disconnected');
  return res.json({ message: 'QuickBooks disconnected' });
});

module.exports = router;
