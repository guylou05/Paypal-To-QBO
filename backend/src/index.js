require('dotenv').config();
const app       = require('./app');
const config    = require('./config');
const db        = require('./db/knex');
const logger    = require('./utils/logger');
const { initScheduler, initQboTokenRefresh } = require('./services/scheduler');
const { startWorker }   = require('./services/syncWorker');

async function start() {
  // Verify DB connection
  try {
    await db.raw('SELECT 1');
    logger.info('Database connected');
  } catch (err) {
    logger.error('Database connection failed', { error: err.message });
    process.exit(1);
  }

  app.listen(config.port, () => {
    logger.info(`Server running on port ${config.port} [${config.env}]`);
  });

  // Start auto-import scheduler (reads enabled/cron from DB settings).
  await initScheduler();

  // Proactively keep QBO access token warm (refreshes every 45 min).
  // Prevents mid-request token expiry and the null-overwrite bug on idle servers.
  initQboTokenRefresh();

  // Start server-side sync worker (processes sync_jobs queue).
  startWorker();
}

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', { error: err && err.message });
});

start();
