const express = require('express');
const db = require('../db/knex');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireAdmin);

function dateFilter(q, req) {
  if (req.query.startDate) q = q.where('transaction_date', '>=', req.query.startDate);
  if (req.query.endDate)   q = q.where('transaction_date', '<=', req.query.endDate);
  return q;
}

// GET /api/reports/reconciliation — PayPal balance summary
router.get('/reconciliation', async (req, res) => {
  let q = db('normalized_transactions').whereNotIn('status', ['ignored']);
  q = dateFilter(q, req);

  const rows = await q.select(
    'category',
    'status',
    db.raw('count(*) as tx_count'),
    db.raw('sum(gross_amount) as total_gross'),
    db.raw('sum(fee_amount) as total_fees'),
    db.raw('sum(net_amount) as total_net'),
  ).groupBy('category', 'status');

  // Build structured summary
  const salesRows      = rows.filter(r => r.category === 'sale');
  const feeRows        = rows.filter(r => r.category === 'paypal_fee');
  const creditPurchase = rows.filter(r => r.category === 'paypal_credit_purchase');
  const creditRepay    = rows.filter(r => r.category === 'paypal_credit_repayment');
  const bankIn         = rows.filter(r => r.category === 'bank_transfer_in');
  const bankOut        = rows.filter(r => r.category === 'bank_transfer_out');
  const refunds        = rows.filter(r => r.category === 'refund');
  const unknown        = rows.filter(r => r.category === 'unknown' || !r.category);

  const sumGross = arr => arr.reduce((s, r) => s + parseFloat(r.total_gross || 0), 0);
  const sumFees  = arr => arr.reduce((s, r) => s + parseFloat(r.total_fees  || 0), 0);
  const sumNet   = arr => arr.reduce((s, r) => s + parseFloat(r.total_net   || 0), 0);
  const sumCount = arr => arr.reduce((s, r) => s + parseInt(r.tx_count      || 0), 0);

  return res.json({
    sales:               { count: sumCount(salesRows),      gross: sumGross(salesRows),      fees: sumFees(salesRows),      net: sumNet(salesRows)      },
    standalone_fees:     { count: sumCount(feeRows),        gross: sumGross(feeRows),        fees: sumFees(feeRows),        net: sumNet(feeRows)        },
    credit_purchases:    { count: sumCount(creditPurchase), gross: sumGross(creditPurchase), fees: sumFees(creditPurchase), net: sumNet(creditPurchase) },
    credit_repayments:   { count: sumCount(creditRepay),    gross: sumGross(creditRepay),    fees: sumFees(creditRepay),    net: sumNet(creditRepay)    },
    bank_transfers_in:   { count: sumCount(bankIn),         gross: sumGross(bankIn),         fees: sumFees(bankIn),         net: sumNet(bankIn)         },
    bank_transfers_out:  { count: sumCount(bankOut),        gross: sumGross(bankOut),        fees: sumFees(bankOut),        net: sumNet(bankOut)        },
    refunds:             { count: sumCount(refunds),        gross: sumGross(refunds),        fees: sumFees(refunds),        net: sumNet(refunds)        },
    needs_review:        { count: sumCount(unknown) },
    raw_rows:            rows,
  });
});

// GET /api/reports/paypal-credit — PayPal Credit activity
router.get('/paypal-credit', async (req, res) => {
  let q = db('normalized_transactions')
    .whereIn('category', ['paypal_credit_purchase', 'paypal_credit_repayment'])
    .whereNotIn('status', ['ignored']);
  q = dateFilter(q, req);
  const rows = await q.orderBy('transaction_date', 'desc');
  return res.json(rows);
});

// GET /api/reports/fees
router.get('/fees', async (req, res) => {
  let q = db('normalized_transactions')
    .where(function() {
      this.where('category', 'paypal_fee')
          .orWhere(function() {
            this.where('category', 'sale').where('fee_amount', '>', 0);
          });
    })
    .whereNotIn('status', ['ignored']);
  q = dateFilter(q, req);

  const rows   = await q.clone().orderBy('transaction_date', 'desc');
  const totals = await q.clone().select(
    db.raw('sum(fee_amount) as total_fees'),
    db.raw('count(*) as tx_count'),
  ).first();

  return res.json({ totals, rows });
});

// GET /api/reports/transfers
router.get('/transfers', async (req, res) => {
  let q = db('normalized_transactions')
    .whereIn('category', ['bank_transfer_in', 'bank_transfer_out'])
    .whereNotIn('status', ['ignored']);
  q = dateFilter(q, req);
  const rows = await q.orderBy('transaction_date', 'desc');
  return res.json(rows);
});

// GET /api/reports/reconciliation-detail — rich breakdown for the enhanced report UI
// Returns: status summary cards, category × status matrix, daily totals, sync coverage.
router.get('/reconciliation-detail', async (req, res) => {
  let base = db('normalized_transactions').whereNotIn('status', ['ignored']);
  if (req.query.startDate) base = base.where('transaction_date', '>=', req.query.startDate);
  if (req.query.endDate)   base = base.where('transaction_date', '<=', req.query.endDate);

  // ── 1. Status summary ─────────────────────────────────────────────────────
  const statusRows = await base.clone()
    .select(
      'status',
      db.raw('count(*) as cnt'),
      db.raw('sum(gross_amount) as gross'),
      db.raw('sum(fee_amount)   as fees'),
      db.raw('sum(net_amount)   as net'),
    )
    .groupBy('status');

  const pick = (rows, st) => {
    const r = rows.filter(x => x.status === st);
    return {
      count: r.reduce((s, x) => s + parseInt(x.cnt,   10), 0),
      gross: r.reduce((s, x) => s + parseFloat(x.gross || 0), 0),
      fees:  r.reduce((s, x) => s + parseFloat(x.fees  || 0), 0),
      net:   r.reduce((s, x) => s + parseFloat(x.net   || 0), 0),
    };
  };
  const statusSummary = {
    synced:       pick(statusRows, 'synced'),
    approved:     pick(statusRows, 'approved'),
    classified:   pick(statusRows, 'classified'),
    needs_review: pick(statusRows, 'needs_review'),
    failed:       pick(statusRows, 'failed'),
  };

  // ── 2. Category × Status matrix ───────────────────────────────────────────
  const catRows = await base.clone()
    .select(
      db.raw("COALESCE(override_category, category, 'unknown') as eff_category"),
      'status',
      db.raw('count(*) as cnt'),
      db.raw('sum(gross_amount) as gross'),
      db.raw('sum(net_amount)   as net'),
    )
    .groupBy('eff_category', 'status');

  const catMap = {};
  catRows.forEach(r => {
    const cat = r.eff_category;
    if (!catMap[cat]) catMap[cat] = { category: cat, total_count: 0, total_gross: 0 };
    catMap[cat][r.status + '_count'] = (catMap[cat][r.status + '_count'] || 0) + parseInt(r.cnt, 10);
    catMap[cat][r.status + '_gross'] = (catMap[cat][r.status + '_gross'] || 0) + parseFloat(r.gross || 0);
    catMap[cat].total_count += parseInt(r.cnt, 10);
    catMap[cat].total_gross += parseFloat(r.gross || 0);
  });
  const categoryMatrix = Object.values(catMap)
    .sort((a, b) => Math.abs(b.total_gross) - Math.abs(a.total_gross));

  // ── 3. Daily totals ────────────────────────────────────────────────────────
  const dailyRows = await base.clone()
    .select(
      'transaction_date',
      db.raw('count(*) as cnt'),
      db.raw('sum(case when gross_amount > 0 then gross_amount else 0 end) as gross_in'),
      db.raw('sum(case when gross_amount < 0 then abs(gross_amount) else 0 end) as gross_out'),
      db.raw('sum(net_amount) as net'),
      db.raw("sum(case when status = 'synced' then 1 else 0 end) as synced_count"),
    )
    .groupBy('transaction_date')
    .orderBy('transaction_date', 'desc');

  // ── 4. Sync coverage ──────────────────────────────────────────────────────
  const totalEligible = statusRows.reduce((s, r) => s + parseInt(r.cnt, 10), 0);
  const syncedCount   = statusSummary.synced.count;

  return res.json({
    statusSummary,
    categoryMatrix,
    dailyTotals: dailyRows,
    syncCoverage: {
      total_eligible: totalEligible,
      synced:         syncedCount,
      pct:            totalEligible > 0 ? Math.round((syncedCount / totalEligible) * 100) : 0,
    },
  });
});

// GET /api/reports/exceptions — anything needing review
router.get('/exceptions', async (req, res) => {
  const rows = await db('normalized_transactions')
    .whereIn('status', ['needs_review', 'failed'])
    .orderBy('transaction_date', 'desc');
  return res.json(rows);
});

module.exports = router;
