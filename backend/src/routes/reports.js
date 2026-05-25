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

// GET /api/reports/exceptions — anything needing review
router.get('/exceptions', async (req, res) => {
  const rows = await db('normalized_transactions')
    .whereIn('status', ['needs_review', 'failed'])
    .orderBy('transaction_date', 'desc');
  return res.json(rows);
});

module.exports = router;
