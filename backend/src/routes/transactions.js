/**
 * Transaction review queue and sync routes.
 */
const express  = require('express');
const { body, query, param } = require('express-validator');
const db       = require('../db/knex');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { handleValidation } = require('../middleware/validate');
const { syncTransaction, rollbackTransaction } = require('../services/quickbooks/syncer');
const { classifyBatch } = require('../services/classifier');
const logger   = require('../utils/logger');

const router = express.Router();
router.use(authenticate, requireAdmin);

const VALID_STATUSES = ['imported', 'classified', 'needs_review', 'approved', 'synced', 'ignored', 'failed'];
const VALID_CATEGORIES = [
  'sale', 'paypal_fee', 'paypal_credit_purchase', 'paypal_credit_repayment',
  'bank_transfer_in', 'bank_transfer_out', 'refund', 'noise', 'unknown',
];
const VALID_TRANSACTION_TYPES = [
  'Payment', 'Invoice', 'Transfer', 'Refund', 'Purchase', 'Bank Payout', 'Other',
];

// Whitelist of sortable columns → DB column name
const SORTABLE_COLUMNS = {
  transaction_date: 'transaction_date',
  transaction_type: 'transaction_type',
  payer_name:       'payer_name',
  description:      'description',
  gross_amount:     'gross_amount',
  fee_amount:       'fee_amount',
  net_amount:       'net_amount',
  category:         'category',
  confidence:       'confidence',
  status:           'status',
};

// ── List transactions ──────────────────────────────────────────────────────
// GET /api/transactions
router.get('/',
  query('status').optional().isIn([...VALID_STATUSES, 'all']),
  query('category').optional(),
  query('transaction_type').optional().isIn([...VALID_TRANSACTION_TYPES, 'all']),
  query('page').optional().isInt({ min: 1 }),
  query('pageSize').optional().isInt({ min: 1, max: 500 }),
  query('search').optional().isString(),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
  query('sortBy').optional().isIn(Object.keys(SORTABLE_COLUMNS)),
  query('sortDir').optional().isIn(['asc', 'desc']),
  handleValidation,
  async (req, res) => {
    const page     = parseInt(req.query.page     || '1', 10);
    const pageSize = parseInt(req.query.pageSize || '50', 10);
    const offset   = (page - 1) * pageSize;

    // Build base query WITHOUT orderBy — adding ORDER BY to the count query
    // causes PostgreSQL to reject it ("must appear in GROUP BY or aggregate").
    // Apply orderBy only to the rows fetch below.
    let q = db('normalized_transactions');

    if (req.query.status && req.query.status !== 'all') {
      q = q.where('status', req.query.status);
    }
    if (req.query.category) {
      q = q.where('category', req.query.category);
    }
    if (req.query.transaction_type && req.query.transaction_type !== 'all') {
      q = q.where('transaction_type', req.query.transaction_type);
    }
    if (req.query.startDate) {
      q = q.where('transaction_date', '>=', req.query.startDate);
    }
    if (req.query.endDate) {
      q = q.where('transaction_date', '<=', req.query.endDate);
    }
    if (req.query.search) {
      const s = `%${req.query.search}%`;
      q = q.where(function () {
        this.where('payer_name', 'ilike', s)
            .orWhere('payer_email', 'ilike', s)
            .orWhere('description', 'ilike', s)
            .orWhere('paypal_transaction_id', 'ilike', s);
      });
    }

    const sortCol = SORTABLE_COLUMNS[req.query.sortBy] || 'transaction_date';
    const sortDir = req.query.sortDir === 'asc' ? 'asc' : 'desc';

    const total = await q.clone().count('id as cnt').first();
    const rows  = await q.clone().orderBy(sortCol, sortDir).limit(pageSize).offset(offset);

    return res.json({
      data:       rows,
      total:      parseInt(total.cnt, 10),
      page,
      pageSize,
      totalPages: Math.ceil(parseInt(total.cnt, 10) / pageSize),
    });
  }
);

// GET /api/transactions/summary — counts by status and category
router.get('/summary', async (req, res) => {
  const byCat = await db('normalized_transactions')
    .select('category', 'status', db.raw('count(*) as cnt'))
    .groupBy('category', 'status');

  const byStatus = await db('normalized_transactions')
    .select('status', db.raw('count(*) as cnt'))
    .groupBy('status');

  return res.json({ byCategory: byCat, byStatus });
});

// GET /api/transactions/:id
router.get('/:id', async (req, res) => {
  const tx = await db('normalized_transactions').where({ id: req.params.id }).first();
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });

  // Fetch raw payload
  const raw = await db('raw_paypal_transactions')
    .where({ id: tx.raw_transaction_id }).first();

  return res.json({ ...tx, raw_payload: raw && raw.raw_payload });
});

// PATCH /api/transactions/:id — update classification / approval
router.patch('/:id',
  body('status').optional().isIn(VALID_STATUSES),
  body('override_category').optional().isIn(VALID_CATEGORIES),
  body('override_qbo_account_key').optional().isString(),
  body('transaction_type').optional().isIn(VALID_TRANSACTION_TYPES),
  body('reviewer_notes').optional().isString(),
  body('qbo_metadata').optional(),
  handleValidation,
  async (req, res) => {
    const tx = await db('normalized_transactions').where({ id: req.params.id }).first();
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    const before = { ...tx };
    const updates = {};

    if (req.body.status !== undefined) {
      // Prevent downgrading synced transactions
      if (tx.status === 'synced' && req.body.status !== 'synced') {
        return res.status(409).json({ error: 'Cannot change status of a synced transaction. Rollback first.' });
      }
      updates.status = req.body.status;
    }
    if (req.body.override_category !== undefined) {
      updates.override_category = req.body.override_category;
      updates.status = updates.status || 'classified';
    }
    if (req.body.override_qbo_account_key !== undefined) {
      updates.override_qbo_account_key = req.body.override_qbo_account_key;
    }
    if (req.body.transaction_type !== undefined) {
      updates.transaction_type = req.body.transaction_type;
    }
    if (req.body.qbo_metadata !== undefined) {
      // Accept object or JSON string; store as JSONB
      updates.qbo_metadata = typeof req.body.qbo_metadata === 'string'
        ? JSON.parse(req.body.qbo_metadata)
        : req.body.qbo_metadata;
    }
    if (req.body.reviewer_notes !== undefined) {
      updates.reviewer_notes = req.body.reviewer_notes;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.reviewed_by = req.user.id;
    updates.reviewed_at = new Date();
    updates.updated_at  = new Date();

    await db('normalized_transactions').where({ id: tx.id }).update(updates);

    await db('audit_logs').insert({
      user_id:     req.user.id,
      action:      'classify',
      entity_type: 'transaction',
      entity_id:   String(tx.id),
      before_state: JSON.stringify(before),
      after_state:  JSON.stringify({ ...tx, ...updates }),
      created_at:   new Date(), updated_at: new Date(),
    });

    const updated = await db('normalized_transactions').where({ id: tx.id }).first();
    return res.json(updated);
  }
);

// POST /api/transactions/bulk-approve — approve multiple transactions
router.post('/bulk-approve',
  body('ids').isArray({ min: 1 }),
  handleValidation,
  async (req, res) => {
    const { ids } = req.body;

    // Only classified or needs_review → approved
    const updated = await db('normalized_transactions')
      .whereIn('id', ids)
      .whereIn('status', ['classified', 'needs_review'])
      .update({
        status:      'approved',
        reviewed_by: req.user.id,
        reviewed_at: new Date(),
        updated_at:  new Date(),
      });

    await db('audit_logs').insert({
      user_id:    req.user.id,
      action:     'approve',
      entity_type:'transaction',
      details:    `Bulk approved ${updated} transactions`,
      created_at: new Date(), updated_at: new Date(),
    });

    return res.json({ updated });
  }
);

// POST /api/transactions/bulk-update — apply shared fields to a set of transactions
router.post('/bulk-update',
  body('ids').isArray({ min: 1 }),
  body('updates').isObject(),
  handleValidation,
  async (req, res) => {
    const { ids, updates } = req.body;

    // Whitelist updatable fields
    const allowed = {};
    if (updates.override_category !== undefined) {
      if (updates.override_category === null || VALID_CATEGORIES.includes(updates.override_category)) {
        allowed.override_category = updates.override_category || null;
      }
    }
    if (updates.status !== undefined && VALID_STATUSES.includes(updates.status)) {
      allowed.status = updates.status;
    }
    if (updates.qbo_metadata !== undefined) {
      allowed.qbo_metadata = typeof updates.qbo_metadata === 'string'
        ? JSON.parse(updates.qbo_metadata)
        : updates.qbo_metadata;
    }
    if (updates.reviewer_notes !== undefined) {
      allowed.reviewer_notes = updates.reviewer_notes;
    }

    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Never touch synced transactions via bulk-update
    const count = await db('normalized_transactions')
      .whereIn('id', ids)
      .whereNot('status', 'synced')
      .update({
        ...allowed,
        reviewed_by: req.user.id,
        reviewed_at: new Date(),
        updated_at:  new Date(),
      });

    await db('audit_logs').insert({
      user_id:     req.user.id,
      action:      'bulk_update',
      entity_type: 'transaction',
      details:     `Bulk updated ${count} of ${ids.length} transactions: ${Object.keys(allowed).join(', ')}`,
      created_at:  new Date(),
      updated_at:  new Date(),
    });

    return res.json({ updated: count, skipped: ids.length - count });
  }
);

// POST /api/transactions/bulk-ignore
router.post('/bulk-ignore',
  body('ids').isArray({ min: 1 }),
  handleValidation,
  async (req, res) => {
    const { ids } = req.body;

    const updated = await db('normalized_transactions')
      .whereIn('id', ids)
      .whereNotIn('status', ['synced'])
      .update({
        status:      'ignored',
        reviewed_by: req.user.id,
        reviewed_at: new Date(),
        updated_at:  new Date(),
      });

    return res.json({ updated });
  }
);

// POST /api/transactions/:id/sync — sync a single approved transaction to QBO
router.post('/:id/sync', async (req, res) => {
  const tx = await db('normalized_transactions').where({ id: req.params.id }).first();
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });

  try {
    const result = await syncTransaction(tx, req.user.id);
    return res.json({ message: 'Synced to QuickBooks', ...result });
  } catch (err) {
    logger.error('Sync error', { txId: tx.id, error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/transactions/sync-batch — sync all approved transactions
router.post('/sync-batch', async (req, res) => {
  const approved = await db('normalized_transactions').where({ status: 'approved' });

  if (approved.length === 0) {
    return res.json({ message: 'No approved transactions to sync', synced: 0, failed: 0 });
  }

  res.json({ message: `Syncing ${approved.length} transactions`, total: approved.length });

  setImmediate(async () => {
    let synced = 0;
    let failed = 0;
    for (const tx of approved) {
      try {
        await syncTransaction(tx, req.user.id);
        synced++;
      } catch (err) {
        failed++;
        logger.error('Batch sync item failed', { txId: tx.id, error: err.message });
      }
    }
    logger.info(`Batch sync complete: ${synced} synced, ${failed} failed`);
  });
});

// POST /api/transactions/:id/rollback — delete from QBO and reset to approved
router.post('/:id/rollback', async (req, res) => {
  const tx = await db('normalized_transactions').where({ id: req.params.id }).first();
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });

  try {
    await rollbackTransaction(tx, req.user.id);
    return res.json({ message: 'Rolled back successfully' });
  } catch (err) {
    logger.error('Rollback error', { txId: tx.id, error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/transactions/recompute-types — re-run transaction_type backfill SQL on all rows
router.post('/recompute-types', async (req, res) => {
  try {
    await db.raw(`
      UPDATE normalized_transactions
      SET transaction_type = CASE
        WHEN category = 'paypal_fee'              THEN 'Other'
        WHEN category = 'paypal_credit_repayment' THEN 'Transfer'
        WHEN category = 'bank_transfer_in'        THEN 'Transfer'
        WHEN category = 'bank_transfer_out'       THEN 'Bank Payout'
        WHEN event_code LIKE 'T17%' OR event_code LIKE 'T18%' THEN 'Bank Payout'
        WHEN event_code LIKE 'T15%'                            THEN 'Transfer'
        WHEN event_code = 'T1602'                              THEN 'Transfer'
        WHEN event_code LIKE 'T08%' AND gross_amount >= 0      THEN 'Transfer'
        WHEN event_code LIKE 'T08%' AND gross_amount <  0      THEN 'Bank Payout'
        WHEN event_code LIKE 'T11%'                            THEN 'Refund'
        WHEN event_code LIKE 'T04%'                            THEN 'Purchase'
        WHEN event_code LIKE 'T16%' AND gross_amount >= 0      THEN 'Payment'
        WHEN event_code LIKE 'T16%' AND gross_amount <  0      THEN 'Purchase'
        WHEN event_code LIKE 'T02%'                            THEN 'Other'
        WHEN event_code LIKE 'T07%'                            THEN 'Other'
        WHEN event_code LIKE 'T06%'                            THEN 'Other'
        WHEN event_code LIKE 'T09%' AND gross_amount >= 0      THEN 'Payment'
        WHEN event_code LIKE 'T09%'                            THEN 'Other'
        WHEN event_code LIKE 'T10%' AND gross_amount >= 0      THEN 'Payment'
        WHEN event_code LIKE 'T10%'                            THEN 'Refund'
        WHEN event_code = 'T0301'                              THEN 'Refund'
        WHEN event_code = 'T0302'                              THEN 'Payment'
        WHEN event_code LIKE 'T03%' AND gross_amount >= 0      THEN 'Payment'
        WHEN event_code LIKE 'T03%'                            THEN 'Refund'
        WHEN (event_code LIKE 'T12%' OR event_code LIKE 'T13%') AND gross_amount >= 0 THEN 'Payment'
        WHEN (event_code LIKE 'T12%' OR event_code LIKE 'T13%')                       THEN 'Refund'
        WHEN event_code = 'T0004'                                      THEN 'Invoice'
        WHEN event_code LIKE 'T00%' AND description ILIKE '%invoice%'  THEN 'Invoice'
        WHEN event_code LIKE 'T00%' AND gross_amount >= 0              THEN 'Payment'
        WHEN event_code LIKE 'T00%'                                    THEN 'Purchase'
        WHEN category = 'sale' AND description ILIKE '%invoice%'       THEN 'Invoice'
        WHEN category = 'sale'                                         THEN 'Payment'
        WHEN category = 'refund'                                       THEN 'Refund'
        WHEN category = 'paypal_credit_purchase'                       THEN 'Purchase'
        WHEN category = 'noise'                                        THEN 'Other'
        WHEN category = 'unknown' AND gross_amount >= 0                THEN 'Payment'
        WHEN category = 'unknown'                                      THEN 'Purchase'
        WHEN description ILIKE '%invoice%'                             THEN 'Invoice'
        WHEN gross_amount < 0                                          THEN 'Purchase'
        ELSE 'Payment'
      END,
      updated_at = NOW()
    `);

    const count = await db('normalized_transactions').count('id as cnt').first();
    return res.json({ message: 'Transaction types recomputed', count: parseInt(count.cnt, 10) });
  } catch (err) {
    logger.error('recompute-types error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/transactions/reclassify-batch — re-run classifier on imported transactions
router.post('/reclassify-batch', async (req, res) => {
  const ids = await db('normalized_transactions')
    .whereIn('status', ['imported', 'classified', 'needs_review'])
    .pluck('id');

  if (!ids.length) return res.json({ message: 'Nothing to reclassify', count: 0 });

  // Reset to imported so classifier picks them up
  await db('normalized_transactions')
    .whereIn('id', ids)
    .update({ status: 'imported', category: null, confidence: null, updated_at: new Date() });

  await classifyBatch(ids);
  return res.json({ message: `Reclassified ${ids.length} transactions`, count: ids.length });
});

module.exports = router;
