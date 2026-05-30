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
const { markFundingDetails } = require('../services/paypal/importer');
const logger   = require('../utils/logger');

const router = express.Router();
router.use(authenticate, requireAdmin);

const VALID_STATUSES = ['imported', 'classified', 'needs_review', 'approved', 'synced', 'ignored', 'failed'];
const VALID_CATEGORIES = [
  // Income
  'sale', 'subscription', 'donation_received',
  // Outflows
  'purchase', 'paypal_fee', 'international_fee', 'payout',
  // PayPal Credit
  'paypal_credit_purchase', 'paypal_credit_repayment',
  // Transfers
  'bank_transfer_in', 'bank_transfer_out',
  // Reversals & adjustments
  'refund', 'chargeback', 'adjustment', 'currency_conversion',
  // Internal / suppressed
  'noise', 'unknown', 'funding_detail',
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

// GET /api/transactions/customer-match — look up stored payer → QBO customer mapping
// Used by EditModal to auto-populate the customer field from previous reviewer choices.
router.get('/customer-match',
  query('payer_email').optional().isString(),
  query('payer_name').optional().isString(),
  handleValidation,
  async (req, res) => {
    const email = (req.query.payer_email || '').trim().toLowerCase();
    const name  = (req.query.payer_name  || '').trim().toLowerCase();

    let match = null;

    // Email key takes precedence (more unique identifier)
    if (email) {
      match = await db('payer_customer_matches').where({ match_key: email }).first();
    }
    // Fall back to name key
    if (!match && name) {
      match = await db('payer_customer_matches').where({ match_key: name }).first();
    }

    return res.json({ match: match || null });
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

    // ── Customer auto-match memory ────────────────────────────────────────────
    // When the reviewer explicitly assigns a QBO customer, remember the mapping
    // payer_email (or payer_name as fallback) → customer_id so future transactions
    // from the same payer can be auto-populated without re-reviewing.
    const savedMeta  = updates.qbo_metadata;
    const custId     = savedMeta?.customer_id;
    const custName   = savedMeta?.customer_name;

    if (custId) {
      const email  = (tx.payer_email || '').trim().toLowerCase();
      const name   = (tx.payer_name  || '').trim().toLowerCase();
      const key    = email || name;
      const mtype  = email ? 'email' : 'name';

      if (key) {
        try {
          const existing = await db('payer_customer_matches').where({ match_key: key }).first();
          if (existing) {
            await db('payer_customer_matches').where({ match_key: key }).update({
              qbo_customer_id:   custId,
              qbo_customer_name: custName || existing.qbo_customer_name,
              match_count:       existing.match_count + 1,
              last_matched_at:   new Date(),
              updated_at:        new Date(),
            });
          } else {
            await db('payer_customer_matches').insert({
              match_key:         key,
              match_type:        mtype,
              qbo_customer_id:   custId,
              qbo_customer_name: custName || '',
              match_count:       1,
              last_matched_at:   new Date(),
              created_at:        new Date(),
              updated_at:        new Date(),
            });
          }
        } catch (err) {
          // Non-fatal — don't block the save if the memory upsert fails
          logger.warn('Failed to upsert payer_customer_matches', { error: err.message });
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

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

// ── Server-side sync queue ─────────────────────────────────────────────────

// POST /api/transactions/sync-queue — create a server-side sync batch
// Body: { ids: [txId, ...] }   — the transaction IDs to enqueue.
// Returns: { batchId, total }
router.post('/sync-queue',
  body('ids').isArray({ min: 1 }),
  handleValidation,
  async (req, res) => {
    const { ids } = req.body;

    // Resolve only approved transactions — skip any that are already synced/invalid
    const txs = await db('normalized_transactions')
      .whereIn('id', ids)
      .where('status', 'approved')
      .select('id', 'paypal_transaction_id');

    if (txs.length === 0) {
      return res.status(422).json({ error: 'No approved transactions found for the given IDs.' });
    }

    // Create the batch record
    const batchRows = await db('sync_batches').insert({
      status:         'running',
      total_jobs:     txs.length,
      completed_jobs: 0,
      failed_jobs:    0,
      created_by:     req.user.id,
      created_at:     new Date(),
      updated_at:     new Date(),
    }).returning('id');
    const batchId = batchRows[0].id;

    // Enqueue one job per transaction
    const jobs = txs.map(tx => ({
      batch_id:              batchId,
      transaction_id:        tx.id,
      paypal_transaction_id: tx.paypal_transaction_id,
      status:                'pending',
      attempts:              0,
      max_attempts:          3,
      created_by:            req.user.id,
      created_at:            new Date(),
      updated_at:            new Date(),
    }));
    await db('sync_jobs').insert(jobs);

    logger.info(`Sync queue batch #${batchId} created with ${txs.length} jobs`);
    return res.json({ batchId, total: txs.length, queued: txs.length });
  }
);

// GET /api/transactions/sync-queue/:batchId — poll batch + per-job status
router.get('/sync-queue/:batchId', async (req, res) => {
  const batchId = parseInt(req.params.batchId, 10);
  const batch   = await db('sync_batches').where({ id: batchId }).first();
  if (!batch) return res.status(404).json({ error: 'Sync batch not found' });

  const jobs = await db('sync_jobs')
    .where({ batch_id: batchId })
    .select('id', 'transaction_id', 'paypal_transaction_id', 'status', 'attempts', 'max_attempts', 'error_message', 'result_payload', 'started_at', 'completed_at')
    .orderBy('id', 'asc');

  return res.json({ batch, jobs });
});

// DELETE /api/transactions/sync-queue/:batchId — cancel all pending jobs in a batch
router.delete('/sync-queue/:batchId', async (req, res) => {
  const batchId = parseInt(req.params.batchId, 10);
  const batch   = await db('sync_batches').where({ id: batchId }).first();
  if (!batch) return res.status(404).json({ error: 'Sync batch not found' });

  await db('sync_jobs')
    .where({ batch_id: batchId, status: 'pending' })
    .update({ status: 'cancelled', updated_at: new Date() });

  // Check if anything is still running; if not, mark batch cancelled/partial
  const remaining = await db('sync_jobs')
    .where({ batch_id: batchId })
    .whereIn('status', ['pending', 'running'])
    .count('id as cnt')
    .first();

  if (parseInt(remaining.cnt, 10) === 0) {
    const stats = await db('sync_jobs').where({ batch_id: batchId })
      .select(
        db.raw("sum(case when status='completed' then 1 else 0 end) as completed"),
        db.raw("sum(case when status='failed'    then 1 else 0 end) as failed"),
      ).first();
    await db('sync_batches').where({ id: batchId }).update({
      status:         'cancelled',
      completed_jobs: parseInt(stats.completed, 10) || 0,
      failed_jobs:    parseInt(stats.failed,    10) || 0,
      completed_at:   new Date(),
      updated_at:     new Date(),
    });
  }

  return res.json({ cancelled: true });
});

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

  // Re-detect funding-detail sub-transactions.
  // Use requireParentInBatch=false so the check spans the whole DB — the parent
  // may already be approved/synced and therefore not in `ids`.
  await markFundingDetails(ids, { requireParentInBatch: false });

  return res.json({ message: `Reclassified ${ids.length} transactions`, count: ids.length });
});

// POST /api/transactions/fix-funding-details
// Retroactively detects split-funding detail records that were imported before
// this feature was added, and marks them ignored.  Safe to run multiple times.
router.post('/fix-funding-details', async (req, res) => {
  try {
    // Candidates: not yet ignored, not synced, and linked to another transaction
    const candidates = await db('normalized_transactions')
      .whereNotNull('related_paypal_transaction_id')
      .whereNotIn('status', ['ignored', 'synced'])
      .select('id', 'related_paypal_transaction_id', 'category', 'gross_amount', 'transaction_date');

    if (!candidates.length) return res.json({ fixed: 0, message: 'No candidates found.' });

    const relatedIds = [...new Set(candidates.map(t => t.related_paypal_transaction_id))];
    const parents    = await db('normalized_transactions')
      .whereIn('paypal_transaction_id', relatedIds)
      .select('paypal_transaction_id', 'category', 'gross_amount', 'transaction_date');

    const parentMap  = new Map(parents.map(p => [p.paypal_transaction_id, p]));

    const SALE_LIKE  = new Set([
      'sale', 'subscription', 'donation_received', 'purchase',
      'paypal_credit_purchase',
    ]);

    const toIgnore = [];
    for (const tx of candidates) {
      const parent = parentMap.get(tx.related_paypal_transaction_id);
      if (!parent) continue;

      // Must be: parent is a sale-like, this record is a debit, AND they share the
      // same calendar date (guards against confusing same-day refunds — edge case,
      // but a safer heuristic than date-less matching).
      const sameDayOrClose = (() => {
        if (!tx.transaction_date || !parent.transaction_date) return true; // no date → allow
        const diff = Math.abs(new Date(tx.transaction_date) - new Date(parent.transaction_date));
        return diff <= 24 * 60 * 60 * 1000; // ≤ 1 day apart
      })();

      if (SALE_LIKE.has(parent.category) && parseFloat(tx.gross_amount) < 0 && sameDayOrClose) {
        toIgnore.push(tx.id);
      }
    }

    if (toIgnore.length) {
      await db('normalized_transactions')
        .whereIn('id', toIgnore)
        .update({ category: 'funding_detail', status: 'ignored', confidence: 'high', updated_at: new Date() });
    }

    logger.info(`fix-funding-details: marked ${toIgnore.length} of ${candidates.length} candidates`);
    return res.json({
      fixed:      toIgnore.length,
      candidates: candidates.length,
      message:    `Marked ${toIgnore.length} transaction(s) as funding_detail / ignored.`,
    });
  } catch (err) {
    logger.error('fix-funding-details error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
