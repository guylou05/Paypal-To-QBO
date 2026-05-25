const express = require('express');
const { body } = require('express-validator');
const db = require('../db/knex');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { handleValidation } = require('../middleware/validate');
const cron = require('node-cron');

const router = express.Router();
router.use(authenticate, requireAdmin);

// GET /api/settings
router.get('/', async (req, res) => {
  const rows = await db('settings').select('key', 'value_type', 'updated_at');
  // Never return encrypted values to the client
  const safe = rows.map(r => ({
    key:        r.key,
    has_value:  true,
    value_type: r.value_type,
    updated_at: r.updated_at,
  }));
  return res.json(safe);
});

// GET /api/settings/classification-rules
router.get('/classification-rules', async (req, res) => {
  const rules = await db('classification_rules').orderBy('priority');
  return res.json(rules);
});

// POST /api/settings/classification-rules
router.post('/classification-rules',
  body('name').notEmpty(),
  body('match_field').isIn(['description', 'event_code', 'payer_name', 'payer_email', 'funding_source']),
  body('match_type').isIn(['contains', 'equals', 'starts_with', 'ends_with', 'regex']),
  body('match_value').notEmpty(),
  body('category').notEmpty(),
  handleValidation,
  async (req, res) => {
    // Knex 3 + PG: .returning() yields [{id:N}], not [N]
    const rows = await db('classification_rules').insert({
      name:          req.body.name,
      match_field:   req.body.match_field,
      match_type:    req.body.match_type,
      match_value:   req.body.match_value,
      category:      req.body.category,
      qbo_account_key: req.body.qbo_account_key || null,
      confidence:    req.body.confidence || 'high',
      priority:      req.body.priority   || 50,
      is_active:     true,
      created_at:    new Date(), updated_at: new Date(),
    }).returning('id');
    const id = rows[0].id;

    const rule = await db('classification_rules').where({ id }).first();
    return res.status(201).json(rule);
  }
);

// PUT /api/settings/classification-rules/:id
router.put('/classification-rules/:id', async (req, res) => {
  const allowed = ['name', 'match_field', 'match_type', 'match_value', 'category',
                   'qbo_account_key', 'confidence', 'priority', 'is_active'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  updates.updated_at = new Date();

  await db('classification_rules').where({ id: req.params.id }).update(updates);
  const rule = await db('classification_rules').where({ id: req.params.id }).first();
  return res.json(rule);
});

// DELETE /api/settings/classification-rules/:id
router.delete('/classification-rules/:id', async (req, res) => {
  await db('classification_rules').where({ id: req.params.id }).delete();
  return res.json({ message: 'Rule deleted' });
});

// POST /api/settings/classification-rules/test
// Dry-run a rule definition against existing transactions and return a preview
// of how many would match and a sample of affected rows.
// Body: { match_field, match_type, match_value, category }
router.post('/classification-rules/test',
  body('match_field').isIn(['description', 'event_code', 'payer_name', 'payer_email', 'funding_source']),
  body('match_type').isIn(['contains', 'equals', 'starts_with', 'ends_with', 'regex']),
  body('match_value').notEmpty(),
  body('category').optional().isString(),
  handleValidation,
  async (req, res) => {
    const { match_field, match_type, match_value, category } = req.body;

    // Validate regex before running
    if (match_type === 'regex') {
      try { new RegExp(match_value); }
      catch (e) { return res.status(400).json({ error: `Invalid regex: ${e.message}` }); }
    }

    // Pull all transactions (not ignored/noise) — we test against a reasonable set
    const txs = await db('normalized_transactions')
      .whereNotIn('status', ['ignored'])
      .select('id', 'paypal_transaction_id', 'description', 'event_code',
              'payer_name', 'payer_email', 'funding_source',
              'category', 'override_category', 'transaction_type', 'gross_amount',
              'transaction_date')
      .limit(5000); // cap for performance

    // Apply the same matching logic as classifier/index.js testCustomRule
    function testRule(tx) {
      const raw = ({
        description:    tx.description    || '',
        event_code:     tx.event_code     || '',
        payer_name:     tx.payer_name     || '',
        payer_email:    tx.payer_email    || '',
        funding_source: tx.funding_source || '',
      })[match_field] || '';

      const val = raw.toLowerCase();
      const pat = match_value.toLowerCase();

      switch (match_type) {
        case 'contains':    return val.includes(pat);
        case 'equals':      return val === pat;
        case 'starts_with': return val.startsWith(pat);
        case 'ends_with':   return val.endsWith(pat);
        case 'regex':       try { return new RegExp(match_value, 'i').test(raw); } catch { return false; }
        default:            return false;
      }
    }

    const matches = txs.filter(testRule);
    const sample  = matches.slice(0, 10).map(tx => ({
      id:                   tx.id,
      paypal_transaction_id:tx.paypal_transaction_id,
      date:                 tx.transaction_date,
      description:          tx.description,
      payer_name:           tx.payer_name,
      current_category:     tx.override_category || tx.category,
      new_category:         category || null,
      gross_amount:         tx.gross_amount,
    }));

    return res.json({
      total_scanned: txs.length,
      match_count:   matches.length,
      sample,
    });
  }
);

// ── Auto-import schedule endpoints ────────────────────────────────────────

const AUTO_IMPORT_KEYS = [
  'auto_import_enabled',
  'auto_import_cron',
  'auto_import_lookback_hours',
  'auto_import_last_run_at',
  'auto_import_last_batch_id',
  'auto_import_last_run_status',
  'auto_import_last_run_error',
];

async function upsertSetting(key, value) {
  const existing = await db('settings').where({ key }).first();
  const str = value === null ? null : String(value);
  if (existing) {
    await db('settings').where({ key }).update({ value: str, updated_at: new Date() });
  } else {
    await db('settings').insert({
      key, value: str, value_type: 'string',
      created_at: new Date(), updated_at: new Date(),
    });
  }
}

// GET /api/settings/auto-import — read current schedule config + last run status
router.get('/auto-import', async (req, res) => {
  const rows = await db('settings').whereIn('key', AUTO_IMPORT_KEYS);
  const map  = {};
  for (const r of rows) map[r.key] = r.value;

  return res.json({
    enabled:          map.auto_import_enabled           === 'true',
    cron:             map.auto_import_cron              || '0 2 * * *',
    lookback_hours:   parseInt(map.auto_import_lookback_hours || '48', 10),
    last_run_at:      map.auto_import_last_run_at       || null,
    last_batch_id:    map.auto_import_last_batch_id
                        ? parseInt(map.auto_import_last_batch_id, 10)
                        : null,
    last_run_status:  map.auto_import_last_run_status   || null,
    last_run_error:   map.auto_import_last_run_error    || null,
  });
});

// PUT /api/settings/auto-import — update schedule config and reschedule live cron task
router.put('/auto-import',
  body('enabled').isBoolean(),
  body('cron').optional().isString(),
  body('lookback_hours').optional().isInt({ min: 1, max: 720 }),
  handleValidation,
  async (req, res) => {
    const { enabled, cron: cronExpr, lookback_hours } = req.body;

    // Validate cron expression if provided
    if (cronExpr && !cron.validate(cronExpr)) {
      return res.status(400).json({ error: `Invalid cron expression: "${cronExpr}"` });
    }

    await upsertSetting('auto_import_enabled', enabled);
    if (cronExpr      !== undefined) await upsertSetting('auto_import_cron',           cronExpr);
    if (lookback_hours !== undefined) await upsertSetting('auto_import_lookback_hours', lookback_hours);

    // Reschedule the live cron task immediately
    const { reconfigureScheduler } = require('../services/scheduler');
    const activeCron = cronExpr
      || (await db('settings').where({ key: 'auto_import_cron' }).first())?.value
      || '0 2 * * *';
    await reconfigureScheduler({ enabled, cron: activeCron });

    return res.json({ message: 'Auto-import settings saved' });
  }
);

// POST /api/settings/auto-import/run-now — trigger an immediate import run
router.post('/auto-import/run-now', async (req, res) => {
  // Respond immediately; run async in background
  res.json({ message: 'Auto-import triggered' });
  setImmediate(async () => {
    const { executeScheduledImport } = require('../services/scheduler');
    await executeScheduledImport();
  });
});

module.exports = router;
