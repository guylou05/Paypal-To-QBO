const express  = require('express');
const { body, query } = require('express-validator');
const db       = require('../db/knex');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { handleValidation } = require('../middleware/validate');
const { encrypt } = require('../utils/encryption');
const paypalClient  = require('../services/paypal/client');
const { runImport } = require('../services/paypal/importer');
const logger   = require('../utils/logger');

const router = express.Router();
router.use(authenticate, requireAdmin);

// GET /api/paypal/status
router.get('/status', async (req, res) => {
  const sandbox = (require('../config').paypal.environment || 'sandbox') !== 'live';
  try {
    await paypalClient.testConnection();
    return res.json({ connected: true, sandbox });
  } catch (err) {
    return res.json({ connected: false, sandbox, error: err.message });
  }
});

// POST /api/paypal/credentials — save encrypted PayPal credentials
router.post('/credentials',
  body('clientId').notEmpty(),
  body('clientSecret').notEmpty(),
  handleValidation,
  async (req, res) => {
    const { clientId, clientSecret } = req.body;

    // Test before saving
    try {
      const resp = await require('axios').post(
        `${require('../config').paypal.baseUrl}/v1/oauth2/token`,
        'grant_type=client_credentials',
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );
      if (!resp.data.access_token) throw new Error('No access token returned');
    } catch (err) {
      return res.status(400).json({ error: 'Invalid PayPal credentials: ' + err.message });
    }

    const upsert = async (key, value) => {
      const existing = await db('settings').where({ key }).first();
      const encrypted = encrypt(value);
      if (existing) {
        await db('settings').where({ key }).update({ value: encrypted, updated_at: new Date() });
      } else {
        await db('settings').insert({ key, value: encrypted, value_type: 'encrypted', created_at: new Date(), updated_at: new Date() });
      }
    };

    await upsert('paypal_client_id',     clientId);
    await upsert('paypal_client_secret', clientSecret);

    await db('audit_logs').insert({
      user_id:    req.user.id,
      action:     'settings_update',
      entity_type:'settings',
      entity_id:  'paypal_credentials',
      created_at: new Date(), updated_at: new Date(),
    });

    return res.json({ message: 'PayPal credentials saved and verified.' });
  }
);

// POST /api/paypal/import — pull transactions for a date range
router.post('/import',
  body('startDate').isISO8601(),
  body('endDate').isISO8601(),
  handleValidation,
  async (req, res) => {
    const { startDate, endDate } = req.body;

    // Optimistically create the batch so we can return an ID immediately,
    // then run the actual import async in the background.
    const batchRows = await db('import_batches').insert({
      user_id:    req.user.id,
      start_date: startDate,
      end_date:   endDate,
      status:     'running',
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');
    const batchId = batchRows[0].id;

    res.json({ batchId, message: 'Import started' });

    setImmediate(async () => {
      try {
        await runImport(startDate, endDate, req.user.id, batchId);
      } catch (err) {
        logger.error('Manual import failed', { error: err.message });
      }
    });
  }
);

// GET /api/paypal/batches — list import batches
router.get('/batches', async (req, res) => {
  const batches = await db('import_batches')
    .orderBy('created_at', 'desc')
    .limit(50);
  return res.json(batches);
});

// GET /api/paypal/batches/:id — batch detail
router.get('/batches/:id', async (req, res) => {
  const batch = await db('import_batches').where({ id: req.params.id }).first();
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  return res.json(batch);
});

module.exports = router;
