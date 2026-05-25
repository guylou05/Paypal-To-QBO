const express = require('express');
const db = require('../db/knex');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireAdmin);

// GET /api/logs/audit
router.get('/audit', async (req, res) => {
  const page     = parseInt(req.query.page     || '1', 10);
  const pageSize = parseInt(req.query.pageSize || '50', 10);
  const offset   = (page - 1) * pageSize;

  // Use SEPARATE count and data queries.
  // Cloning a query that has SELECT * and then calling .count() appends the
  // aggregate to the existing column list, which PostgreSQL rejects unless
  // every non-aggregate column is in a GROUP BY clause.
  let countQ = db('audit_logs');
  let dataQ  = db('audit_logs')
    .leftJoin('users', 'audit_logs.user_id', 'users.id')
    .select('audit_logs.*', 'users.email as user_email');

  if (req.query.action) {
    countQ = countQ.where('action',             req.query.action);
    dataQ  = dataQ.where('audit_logs.action',   req.query.action);
  }

  const total = await countQ.count('id as cnt').first();
  const rows  = await dataQ.orderBy('audit_logs.created_at', 'desc').limit(pageSize).offset(offset);

  return res.json({
    data:       rows,
    total:      parseInt(total.cnt, 10),
    page,
    pageSize,
    totalPages: Math.ceil(parseInt(total.cnt, 10) / pageSize),
  });
});

// GET /api/logs/sync
router.get('/sync', async (req, res) => {
  const page     = parseInt(req.query.page     || '1', 10);
  const pageSize = parseInt(req.query.pageSize || '50', 10);
  const offset   = (page - 1) * pageSize;

  let countQ = db('qbo_sync_logs');
  let dataQ  = db('qbo_sync_logs');

  if (req.query.status) {
    countQ = countQ.where('status', req.query.status);
    dataQ  = dataQ.where('status',  req.query.status);
  }

  const total = await countQ.count('id as cnt').first();
  const rows  = await dataQ.orderBy('created_at', 'desc').limit(pageSize).offset(offset);

  return res.json({
    data:       rows,
    total:      parseInt(total.cnt, 10),
    page,
    pageSize,
    totalPages: Math.ceil(parseInt(total.cnt, 10) / pageSize),
  });
});

// GET /api/logs/rollbacks
router.get('/rollbacks', async (req, res) => {
  const rows = await db('rollback_logs').orderBy('created_at', 'desc').limit(200);
  return res.json(rows);
});

// GET /api/logs/sync/:id — payload viewer
router.get('/sync/:id', async (req, res) => {
  const row = await db('qbo_sync_logs').where({ id: req.params.id }).first();
  if (!row) return res.status(404).json({ error: 'Log entry not found' });
  return res.json(row);
});

module.exports = router;
