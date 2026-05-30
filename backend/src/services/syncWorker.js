/**
 * Server-side sync worker.
 *
 * Processes pending sync_jobs one at a time using an atomic
 * SELECT … FOR UPDATE SKIP LOCKED claim pattern so no job is
 * ever picked up twice, even if multiple server instances run.
 *
 * Lifecycle:
 *   pending  → running (claimed)
 *   running  → completed  (sync succeeded)
 *            → pending    (sync failed, attempts < max_attempts — retry)
 *            → failed     (sync failed, attempts >= max_attempts — exhausted)
 *
 * Rate limiting: the worker sleeps WORKER_INTERVAL_MS between ticks
 * so QBO's API rate limits are not hammered even during large batches.
 */
const db     = require('../db/knex');
const logger = require('../utils/logger');
const { syncTransaction } = require('./quickbooks/syncer');

const WORKER_INTERVAL_MS = 1500; // ms between ticks
let   workerTimer        = null;
let   workerBusy         = false;

// ── Batch completion helper ────────────────────────────────────────────────
async function checkBatchDone(batchId) {
  const stats = await db('sync_jobs')
    .where({ batch_id: batchId })
    .select(
      db.raw('count(*) as total'),
      db.raw("sum(case when status = 'completed'                    then 1 else 0 end) as completed"),
      db.raw("sum(case when status = 'failed'                       then 1 else 0 end) as failed"),
      db.raw("sum(case when status in ('pending','running')         then 1 else 0 end) as active"),
    )
    .first();

  const total     = parseInt(stats.total,     10);
  const completed = parseInt(stats.completed, 10);
  const failed    = parseInt(stats.failed,    10);
  const active    = parseInt(stats.active,    10);

  if (active > 0) return; // still in flight

  const batchStatus = failed === 0       ? 'complete'
                    : completed === 0    ? 'failed'
                    :                      'partial';

  await db('sync_batches').where({ id: batchId }).update({
    status:         batchStatus,
    completed_jobs: completed,
    failed_jobs:    failed,
    completed_at:   new Date(),
    updated_at:     new Date(),
  });

  logger.info(`Sync batch #${batchId} ${batchStatus}: ${completed} ok, ${failed} failed of ${total}`);
}

// ── Single-tick processor ──────────────────────────────────────────────────
async function processTick() {
  // Atomically claim the next available pending job (SKIP LOCKED avoids deadlocks
  // if a second process ever joins, and prevents re-claiming a running job).
  const result = await db.raw(`
    UPDATE sync_jobs
    SET    status     = 'running',
           started_at  = NOW(),
           attempts    = attempts + 1,
           updated_at  = NOW()
    WHERE  id = (
      SELECT id
      FROM   sync_jobs
      WHERE  status = 'pending'
        AND  attempts < max_attempts
      ORDER  BY created_at ASC
      LIMIT  1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  const job = result.rows[0];
  if (!job) return; // nothing to do

  logger.info(`SyncWorker: processing job #${job.id} tx#${job.transaction_id} (attempt ${job.attempts}/${job.max_attempts})`);

  try {
    const tx = await db('normalized_transactions').where({ id: job.transaction_id }).first();

    if (!tx) {
      throw new Error(`Transaction #${job.transaction_id} not found — may have been deleted.`);
    }
    if (tx.status === 'synced') {
      // Already synced by a direct single-tx sync — mark as skipped, don't re-sync.
      await db('sync_jobs').where({ id: job.id }).update({
        status:       'completed',
        error_message:'Already synced (skipped duplicate job)',
        completed_at: new Date(),
        updated_at:   new Date(),
      });
      await checkBatchDone(job.batch_id);
      return;
    }

    const syncResult = await syncTransaction(tx, job.created_by);

    await db('sync_jobs').where({ id: job.id }).update({
      status:         'completed',
      result_payload: JSON.stringify({
        qboId:         syncResult.qboId,
        qboObjectType: syncResult.qboObjectType,
      }),
      completed_at:   new Date(),
      updated_at:     new Date(),
    });

    logger.info(`SyncWorker: job #${job.id} completed → QBO ${syncResult.qboObjectType} #${syncResult.qboId}`);

  } catch (err) {
    const exhausted = job.attempts >= job.max_attempts;

    await db('sync_jobs').where({ id: job.id }).update({
      status:        exhausted ? 'failed' : 'pending', // pending = retry
      error_message: err.message,
      updated_at:    new Date(),
    });

    if (exhausted) {
      logger.warn(`SyncWorker: job #${job.id} failed permanently after ${job.attempts} attempts — ${err.message}`);
    } else {
      logger.warn(`SyncWorker: job #${job.id} failed (attempt ${job.attempts}) — will retry: ${err.message}`);
    }
  }

  await checkBatchDone(job.batch_id);
}

// ── Public interface ───────────────────────────────────────────────────────

/** Start the background polling loop. Call once from index.js after DB is ready. */
function startWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(async () => {
    if (workerBusy) return;
    workerBusy = true;
    try {
      await processTick();
    } catch (err) {
      logger.error('SyncWorker unexpected error', { error: err.message });
    } finally {
      workerBusy = false;
    }
  }, WORKER_INTERVAL_MS);
  logger.info(`SyncWorker started — polling every ${WORKER_INTERVAL_MS}ms`);
}

function stopWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

module.exports = { startWorker, stopWorker };
