/**
 * Auto-import scheduler.
 *
 * Uses node-cron to run scheduled PayPal imports.  Configuration is persisted
 * in the `settings` table so it survives container restarts.
 *
 * Lifecycle:
 *   initScheduler()          — called once on server startup
 *   reconfigureScheduler()   — called after settings are changed via the API
 *   executeScheduledImport() — the actual import logic (also callable for "Run Now")
 */
const cron      = require('node-cron');
const db        = require('../db/knex');
const { runImport } = require('./paypal/importer');
const logger    = require('../utils/logger');

// Currently running cron task (null if disabled).
let currentTask = null;

// ── Settings helpers ───────────────────────────────────────────────────────

async function getSetting(key, defaultValue = null) {
  const row = await db('settings').where({ key }).first();
  return row ? row.value : defaultValue;
}

async function setSetting(key, value) {
  const existing = await db('settings').where({ key }).first();
  const str = value === null ? null : String(value);
  if (existing) {
    await db('settings').where({ key }).update({ value: str, updated_at: new Date() });
  } else {
    await db('settings').insert({
      key,
      value:      str,
      value_type: 'string',
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
}

// ── Import execution ───────────────────────────────────────────────────────

/**
 * Execute one scheduled import run.
 * Computes date window from auto_import_lookback_hours, calls runImport,
 * and writes result/error back to settings for the UI to display.
 */
async function executeScheduledImport() {
  logger.info('Auto-import: starting scheduled run');

  await setSetting('auto_import_last_run_at',     new Date().toISOString());
  await setSetting('auto_import_last_run_status', 'running');
  await setSetting('auto_import_last_run_error',  '');

  try {
    const lookbackHours = parseInt(await getSetting('auto_import_lookback_hours', '48'), 10);

    const endDate   = new Date();
    const startDate = new Date(endDate.getTime() - lookbackHours * 60 * 60 * 1000);

    // Format as YYYY-MM-DD
    const fmt = d => d.toISOString().slice(0, 10);

    const result = await runImport(fmt(startDate), fmt(endDate), null);

    await setSetting('auto_import_last_run_status', 'success');
    await setSetting('auto_import_last_batch_id',   result.batchId);
    await setSetting('auto_import_last_run_error',  '');

    logger.info('Auto-import: run complete', {
      batchId:        result.batchId,
      totalNew:       result.totalNew,
      totalDuplicate: result.totalDuplicate,
    });
  } catch (err) {
    await setSetting('auto_import_last_run_status', 'failed');
    await setSetting('auto_import_last_run_error',  err.message);
    logger.error('Auto-import: run failed', { error: err.message });
  }
}

// ── Cron task management ───────────────────────────────────────────────────

function stopCurrentTask() {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
    logger.info('Scheduler: stopped cron task');
  }
}

function startTask(cronExpr) {
  if (!cron.validate(cronExpr)) {
    logger.error(`Scheduler: invalid cron expression "${cronExpr}" — not scheduling`);
    return false;
  }

  currentTask = cron.schedule(cronExpr, async () => {
    await executeScheduledImport();
  }, { timezone: 'UTC' });

  logger.info(`Scheduler: cron task started — "${cronExpr}" (UTC)`);
  return true;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Read schedule config from DB and start the cron task if enabled.
 * Call once on server startup after the DB connection is verified.
 */
async function initScheduler() {
  try {
    const enabled  = await getSetting('auto_import_enabled', 'false');
    const cronExpr = await getSetting('auto_import_cron',    '0 2 * * *');

    if (enabled === 'true') {
      startTask(cronExpr);
    } else {
      logger.info('Scheduler: auto-import disabled — cron task not started');
    }
  } catch (err) {
    logger.error('Scheduler: init failed', { error: err.message });
  }
}

/**
 * Stop any running task and restart with new config.
 * Call this immediately after saving updated settings to the DB.
 *
 * @param {{ enabled: boolean, cron: string }} config
 */
async function reconfigureScheduler(config) {
  stopCurrentTask();
  if (config.enabled) {
    startTask(config.cron);
  } else {
    logger.info('Scheduler: auto-import disabled — cron task stopped');
  }
}

module.exports = {
  initScheduler,
  reconfigureScheduler,
  executeScheduledImport,
};
