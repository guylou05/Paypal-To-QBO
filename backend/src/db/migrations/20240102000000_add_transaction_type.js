exports.up = async function (knex) {
  // 1. Add the column
  await knex.schema.table('normalized_transactions', t => {
    t.string('transaction_type', 50);
    // Payment | Invoice | Transfer | Refund | Purchase | Bank Payout | Other
  });

  // 2. Backfill existing rows using PayPal event_code prefix + category fallback.
  //    The WHEN clauses are ordered so the most-specific event codes win.
  await knex.raw(`
    UPDATE normalized_transactions
    SET transaction_type = CASE
      WHEN event_code LIKE 'T17%' OR event_code LIKE 'T18%'
        THEN 'Bank Payout'
      WHEN event_code LIKE 'T08%' OR event_code LIKE 'T15%'
        THEN 'Transfer'
      WHEN event_code LIKE 'T10%' OR event_code LIKE 'T11%'
        THEN 'Refund'
      WHEN event_code LIKE 'T04%' OR event_code LIKE 'T16%'
        THEN 'Purchase'
      WHEN event_code LIKE 'T00%' AND description ILIKE '%invoice%'
        THEN 'Invoice'
      WHEN event_code LIKE 'T00%'
        THEN 'Payment'
      WHEN category = 'sale' AND description ILIKE '%invoice%'
        THEN 'Invoice'
      WHEN category = 'sale'
        THEN 'Payment'
      WHEN category = 'refund'
        THEN 'Refund'
      WHEN category IN ('bank_transfer_in','bank_transfer_out','paypal_credit_repayment')
        THEN 'Transfer'
      WHEN category = 'paypal_credit_purchase'
        THEN 'Purchase'
      ELSE 'Other'
    END
    WHERE transaction_type IS NULL
  `);
};

exports.down = async function (knex) {
  await knex.schema.table('normalized_transactions', t => {
    t.dropColumn('transaction_type');
  });
};
