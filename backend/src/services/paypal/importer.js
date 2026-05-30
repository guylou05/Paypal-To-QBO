/**
 * Shared PayPal import runner.
 *
 * Used by:
 *   • POST /api/paypal/import          (manual, triggered by a reviewer)
 *   • scheduler.js executeScheduledImport()  (automated, cron-driven)
 *
 * Creates an import_batch record, fetches transactions from PayPal, normalises,
 * deduplicates against existing normalized_transactions, classifies new rows,
 * and finalises the batch status.
 */
const db           = require('../../db/knex');
const paypalClient = require('./client');
const { normalize }     = require('./normalizer');
const { classifyBatch } = require('../classifier');
const logger = require('../../utils/logger');

/**
 * Run a single import for [startDate, endDate].
 *
 * @param {string}      startDate     YYYY-MM-DD
 * @param {string}      endDate       YYYY-MM-DD
 * @param {number|null} userId        null for automated/scheduled runs
 * @param {number|null} existingBatchId  if provided, update this batch instead of creating one
 * @returns {Promise<{batchId, totalFetched, totalNew, totalDuplicate}>}
 */
async function runImport(startDate, endDate, userId = null, existingBatchId = null) {
  let batchId = existingBatchId;

  if (!batchId) {
    const batchRows = await db('import_batches').insert({
      user_id:    userId,
      start_date: startDate,
      end_date:   endDate,
      status:     'running',
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');
    batchId = batchRows[0].id;
  }

  try {
    // PayPal API requires full ISO-8601 timestamps with timezone offset.
    const startISO = new Date(startDate).toISOString().replace('Z', '+0000').slice(0, 23) + '+0000';
    const endISO   = new Date(endDate + 'T23:59:59').toISOString().replace('Z', '+0000').slice(0, 23) + '+0000';

    const rawTxs = await paypalClient.fetchAllTransactions({ startDate: startISO, endDate: endISO });

    let totalNew       = 0;
    let totalDuplicate = 0;
    const newIds       = [];

    for (const rawTx of rawTxs) {
      const txId = rawTx.transaction_info && rawTx.transaction_info.transaction_id;
      if (!txId) continue;

      // Skip duplicates — paypal_transaction_id is a unique key.
      const existing = await db('normalized_transactions').where({ paypal_transaction_id: txId }).first();
      if (existing) { totalDuplicate++; continue; }

      const rawRows = await db('raw_paypal_transactions').insert({
        batch_id:              batchId,
        paypal_transaction_id: txId,
        raw_payload:           JSON.stringify(rawTx),
        created_at:            new Date(),
        updated_at:            new Date(),
      }).returning('id');
      const rawId = rawRows[0].id;

      const norm = normalize(rawTx);
      const normRows = await db('normalized_transactions').insert({
        ...norm,
        raw_transaction_id: rawId,
        batch_id:           batchId,
        created_at:         new Date(),
        updated_at:         new Date(),
      }).returning('id');

      newIds.push(normRows[0].id);
      totalNew++;
    }

    if (newIds.length) {
      await classifyBatch(newIds);
      // Detect and suppress split-funding detail sub-transactions so they don't
      // pollute the review queue.  Must run AFTER classifyBatch so the parent's
      // category is already known.
      await markFundingDetails(newIds, { requireParentInBatch: true });
    }

    const summary = await db('normalized_transactions')
      .where({ batch_id: batchId })
      .select('category', 'status', db.raw('count(*) as cnt'))
      .groupBy('category', 'status');

    await db('import_batches').where({ id: batchId }).update({
      status:          'complete',
      total_fetched:   rawTxs.length,
      total_new:       totalNew,
      total_duplicate: totalDuplicate,
      summary:         JSON.stringify(summary),
      updated_at:      new Date(),
    });

    logger.info(`Import batch ${batchId} complete`, { totalNew, totalDuplicate });
    return { batchId, totalFetched: rawTxs.length, totalNew, totalDuplicate };

  } catch (err) {
    logger.error(`Import batch ${batchId} failed`, { error: err.message });
    await db('import_batches').where({ id: batchId }).update({
      status:        'failed',
      error_message: err.message,
      updated_at:    new Date(),
    });
    throw err;
  }
}

/**
 * After classifying a set of transactions, identify PayPal split-funding detail
 * records and mark them as `funding_detail` / `ignored`.
 *
 * Background: when a single PayPal payment is funded by multiple sources (e.g.
 * $30 from PayPal balance + $70 from a linked bank account), PayPal writes one
 * parent record for the full amount PLUS one sub-record per funding source.
 * These sub-records carry a `related_transaction_id` that points to the parent
 * and represent **internal bookkeeping only** — they should never appear in the
 * QBO review queue.
 *
 * Safe heuristics used to distinguish funding details from genuine refunds
 * (which also carry `related_paypal_transaction_id`):
 *   1. The sub-record has `related_paypal_transaction_id` set.
 *   2. The parent record is in the same set of IDs (same API response window)
 *      when `requireParentInBatch=true`, or anywhere in the DB when false.
 *   3. The parent's category is a sale/purchase type (positive inbound payment).
 *   4. The sub-record itself is negative (a debit representing the funding draw).
 *
 * A genuine refund also satisfies (1) and (3)+(4) but typically arrives in a
 * *different* import run, days/weeks after the original sale, so it fails (2)
 * when requireParentInBatch is true.
 *
 * @param {number[]} ids                  Normalized-transaction IDs to examine.
 * @param {boolean}  requireParentInBatch When true (default, used during normal
 *                                        imports) the parent must also be within
 *                                        `ids`.  Set false for retroactive runs
 *                                        where the parent may already be in the DB.
 */
async function markFundingDetails(ids, { requireParentInBatch = true } = {}) {
  if (!ids.length) return 0;

  // Find transactions in this set that reference another transaction
  const linked = await db('normalized_transactions')
    .whereIn('id', ids)
    .whereNotNull('related_paypal_transaction_id')
    .select('id', 'related_paypal_transaction_id', 'category', 'gross_amount');

  if (!linked.length) return 0;

  const relatedIds = [...new Set(linked.map(t => t.related_paypal_transaction_id))];

  // Find the parent records
  let parentQuery = db('normalized_transactions')
    .whereIn('paypal_transaction_id', relatedIds)
    .select('paypal_transaction_id', 'category', 'gross_amount');

  if (requireParentInBatch) {
    // Parent must also be in this import batch — key safety guard vs. refunds
    parentQuery = parentQuery.whereIn('id', ids);
  }

  const parents = await parentQuery;
  if (!parents.length) return 0;

  const parentMap = new Map(parents.map(p => [p.paypal_transaction_id, p]));

  // These parent categories indicate the child is a funding-detail sub-record,
  // not a genuine reversal/refund of a separate event.
  const SALE_LIKE = new Set([
    'sale', 'subscription', 'donation_received', 'purchase',
    'paypal_credit_purchase',
  ]);

  const toIgnore = [];
  for (const tx of linked) {
    const parent = parentMap.get(tx.related_paypal_transaction_id);
    if (!parent) continue;

    // Parent must be a sale-like inbound payment and this sub-record must be a debit
    if (SALE_LIKE.has(parent.category) && parseFloat(tx.gross_amount) < 0) {
      toIgnore.push(tx.id);
    }
  }

  if (toIgnore.length) {
    await db('normalized_transactions')
      .whereIn('id', toIgnore)
      .update({
        category:   'funding_detail',
        status:     'ignored',
        confidence: 'high',
        updated_at: new Date(),
      });
    logger.info(`Marked ${toIgnore.length} split-funding sub-transaction(s) as ignored (funding_detail)`);
  }

  return toIgnore.length;
}

module.exports = { runImport, markFundingDetails };
