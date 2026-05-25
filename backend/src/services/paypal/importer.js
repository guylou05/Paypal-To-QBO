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

    if (newIds.length) await classifyBatch(newIds);

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

module.exports = { runImport };
