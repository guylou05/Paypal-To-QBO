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

const MATCH_FIELD_VALUES = ['description', 'event_code', 'payer_name', 'payer_email', 'funding_source'];
const MATCH_TYPE_VALUES  = ['contains', 'equals', 'starts_with', 'ends_with', 'regex'];

// GET /api/settings/classification-rules
router.get('/classification-rules', async (req, res) => {
  const rules = await db('classification_rules').orderBy('priority');
  return res.json(rules);
});

// POST /api/settings/classification-rules
router.post('/classification-rules',
  body('name').notEmpty(),
  // New multi-condition format
  body('conditions').optional().isArray({ min: 1, max: 3 }),
  body('conditions.*.match_field').if(body('conditions').exists()).isIn(MATCH_FIELD_VALUES),
  body('conditions.*.match_type').if(body('conditions').exists()).isIn(MATCH_TYPE_VALUES),
  body('conditions.*.match_value').if(body('conditions').exists()).notEmpty(),
  body('conditions_operator').optional().isIn(['and', 'or']),
  // Legacy single-condition fallback (required when conditions not provided)
  body('match_field').if(body('conditions').not().exists()).isIn(MATCH_FIELD_VALUES),
  body('match_type').if(body('conditions').not().exists()).isIn(MATCH_TYPE_VALUES),
  body('match_value').if(body('conditions').not().exists()).notEmpty(),
  body('category').notEmpty(),
  handleValidation,
  async (req, res) => {
    const {
      name, conditions, conditions_operator,
      match_field, match_type, match_value,
      category, qbo_account_key, confidence, priority,
    } = req.body;

    // Normalise to conditions array; keep legacy columns from first condition.
    const conditionsData = conditions || [{ match_field, match_type, match_value }];
    const primary = conditionsData[0];

    // Knex 3 + PG: .returning() yields [{id:N}], not [N]
    const rows = await db('classification_rules').insert({
      name,
      match_field:         primary.match_field,
      match_type:          primary.match_type,
      match_value:         primary.match_value,
      conditions:          JSON.stringify(conditionsData),
      conditions_operator: conditions_operator || 'and',
      category,
      qbo_account_key:     qbo_account_key || null,
      confidence:          confidence || 'high',
      priority:            priority   || 50,
      is_active:           true,
      created_at:          new Date(), updated_at: new Date(),
    }).returning('id');
    const id = rows[0].id;

    const rule = await db('classification_rules').where({ id }).first();
    return res.status(201).json(rule);
  }
);

// PUT /api/settings/classification-rules/:id
router.put('/classification-rules/:id', async (req, res) => {
  const allowed = [
    'name', 'match_field', 'match_type', 'match_value', 'category',
    'qbo_account_key', 'confidence', 'priority', 'is_active',
    'conditions', 'conditions_operator',
  ];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }

  // If conditions array provided, serialise it and sync the legacy columns.
  if (updates.conditions) {
    const conds = Array.isArray(updates.conditions)
      ? updates.conditions
      : JSON.parse(updates.conditions);
    updates.conditions = JSON.stringify(conds);
    if (conds.length > 0) {
      updates.match_field = conds[0].match_field;
      updates.match_type  = conds[0].match_type;
      updates.match_value = conds[0].match_value;
    }
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
// Dry-run conditions against existing transactions — returns match count + sample.
// Body: { conditions:[{match_field,match_type,match_value}], conditions_operator, category }
//    OR legacy: { match_field, match_type, match_value, category }
router.post('/classification-rules/test',
  body('conditions').optional().isArray({ min: 1, max: 3 }),
  body('conditions.*.match_field').if(body('conditions').exists()).isIn(MATCH_FIELD_VALUES),
  body('conditions.*.match_type').if(body('conditions').exists()).isIn(MATCH_TYPE_VALUES),
  body('conditions.*.match_value').if(body('conditions').exists()).notEmpty(),
  body('conditions_operator').optional().isIn(['and', 'or']),
  body('match_field').if(body('conditions').not().exists()).isIn(MATCH_FIELD_VALUES),
  body('match_type').if(body('conditions').not().exists()).isIn(MATCH_TYPE_VALUES),
  body('match_value').if(body('conditions').not().exists()).notEmpty(),
  body('category').optional().isString(),
  handleValidation,
  async (req, res) => {
    const {
      conditions, conditions_operator = 'and',
      match_field, match_type, match_value,
      category,
    } = req.body;

    const conditionsData = conditions || [{ match_field, match_type, match_value }];

    // Validate any regex conditions before scanning.
    for (const cond of conditionsData) {
      if (cond.match_type === 'regex') {
        try { new RegExp(cond.match_value); }
        catch (e) { return res.status(400).json({ error: `Invalid regex: ${e.message}` }); }
      }
    }

    // Pull transactions (not ignored) — cap at 5000 for performance.
    const txs = await db('normalized_transactions')
      .whereNotIn('status', ['ignored'])
      .select('id', 'paypal_transaction_id', 'description', 'event_code',
              'payer_name', 'payer_email', 'funding_source',
              'category', 'override_category', 'transaction_type', 'gross_amount',
              'transaction_date')
      .limit(5000);

    function testOneCondition(cond, tx) {
      const raw = ({
        description:    tx.description    || '',
        event_code:     tx.event_code     || '',
        payer_name:     tx.payer_name     || '',
        payer_email:    tx.payer_email    || '',
        funding_source: tx.funding_source || '',
      })[cond.match_field] || '';
      const val = raw.toLowerCase();
      const pat = cond.match_value.toLowerCase();
      switch (cond.match_type) {
        case 'contains':    return val.includes(pat);
        case 'equals':      return val === pat;
        case 'starts_with': return val.startsWith(pat);
        case 'ends_with':   return val.endsWith(pat);
        case 'regex':       try { return new RegExp(cond.match_value, 'i').test(raw); } catch { return false; }
        default:            return false;
      }
    }

    function testRule(tx) {
      const op = (conditions_operator || 'and').toLowerCase();
      return op === 'or'
        ? conditionsData.some(c  => testOneCondition(c, tx))
        : conditionsData.every(c => testOneCondition(c, tx));
    }

    const matches = txs.filter(testRule);
    const sample  = matches.slice(0, 10).map(tx => ({
      id:                    tx.id,
      paypal_transaction_id: tx.paypal_transaction_id,
      date:                  tx.transaction_date,
      description:           tx.description,
      payer_name:            tx.payer_name,
      current_category:      tx.override_category || tx.category,
      new_category:          category || null,
      gross_amount:          tx.gross_amount,
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
