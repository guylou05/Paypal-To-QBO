/**
 * Re-backfill transaction_type for all existing normalized transactions
 * using the improved logic that factors in gross_amount sign.
 *
 * Priority order mirrors deriveTransactionType() in normalizer.js:
 *  1. High-confidence category signals
 *  2. Unambiguous event-code families
 *  3. Ambiguous codes resolved by gross_amount sign
 *  4. T00xx resolved by gross_amount sign
 *  5. Category fallbacks
 *  6. Pure gross_amount sign
 */

exports.up = async function (knex) {
  await knex.raw(`
    UPDATE normalized_transactions
    SET transaction_type = CASE
      -- 1. High-confidence category signals
      WHEN category = 'paypal_fee'              THEN 'Other'
      WHEN category = 'paypal_credit_repayment' THEN 'Transfer'
      WHEN category = 'bank_transfer_in'        THEN 'Transfer'
      WHEN category = 'bank_transfer_out'       THEN 'Bank Payout'

      -- 2. Unambiguous event-code families
      WHEN event_code LIKE 'T17%' OR event_code LIKE 'T18%' THEN 'Bank Payout'
      WHEN event_code LIKE 'T15%'                            THEN 'Transfer'
      WHEN event_code = 'T1602'                              THEN 'Transfer'
      WHEN event_code LIKE 'T08%' AND gross_amount >= 0      THEN 'Transfer'
      WHEN event_code LIKE 'T08%' AND gross_amount <  0      THEN 'Bank Payout'
      WHEN event_code LIKE 'T11%'                            THEN 'Refund'
      WHEN event_code LIKE 'T04%'                            THEN 'Purchase'
      WHEN event_code LIKE 'T16%' AND gross_amount >= 0      THEN 'Payment'
      WHEN event_code LIKE 'T16%' AND gross_amount <  0      THEN 'Purchase'

      -- 3. Ambiguous codes resolved by gross_amount sign
      WHEN event_code LIKE 'T02%'                            THEN 'Other'
      WHEN event_code LIKE 'T07%'                            THEN 'Other'
      WHEN event_code LIKE 'T06%'                            THEN 'Other'
      WHEN event_code LIKE 'T09%' AND gross_amount >= 0      THEN 'Payment'
      WHEN event_code LIKE 'T09%'                            THEN 'Other'
      WHEN event_code LIKE 'T10%' AND gross_amount >= 0      THEN 'Payment'
      WHEN event_code LIKE 'T10%'                            THEN 'Refund'
      WHEN event_code = 'T0301'                              THEN 'Refund'
      WHEN event_code = 'T0302'                              THEN 'Payment'
      WHEN event_code LIKE 'T03%' AND gross_amount >= 0      THEN 'Payment'
      WHEN event_code LIKE 'T03%'                            THEN 'Refund'
      WHEN (event_code LIKE 'T12%' OR event_code LIKE 'T13%') AND gross_amount >= 0 THEN 'Payment'
      WHEN (event_code LIKE 'T12%' OR event_code LIKE 'T13%')                       THEN 'Refund'

      -- 4. T00xx — direction is the only reliable signal
      WHEN event_code = 'T0004'                                      THEN 'Invoice'
      WHEN event_code LIKE 'T00%' AND description ILIKE '%invoice%'  THEN 'Invoice'
      WHEN event_code LIKE 'T00%' AND gross_amount >= 0              THEN 'Payment'
      WHEN event_code LIKE 'T00%'                                    THEN 'Purchase'

      -- 5. Category fallbacks (no event code or unrecognised prefix)
      WHEN category = 'sale' AND description ILIKE '%invoice%'       THEN 'Invoice'
      WHEN category = 'sale'                                         THEN 'Payment'
      WHEN category = 'refund'                                       THEN 'Refund'
      WHEN category = 'paypal_credit_purchase'                       THEN 'Purchase'
      WHEN category = 'noise'                                        THEN 'Other'
      WHEN category = 'unknown' AND gross_amount >= 0                THEN 'Payment'
      WHEN category = 'unknown'                                      THEN 'Purchase'

      -- 6. Pure gross_amount sign (last resort)
      WHEN description ILIKE '%invoice%'                             THEN 'Invoice'
      WHEN gross_amount < 0                                          THEN 'Purchase'
      ELSE 'Payment'
    END,
    updated_at = NOW()
  `);
};

exports.down = async function (knex) {
  // Revert to the old simple logic (no gross_amount awareness)
  await knex.raw(`
    UPDATE normalized_transactions
    SET transaction_type = CASE
      WHEN event_code LIKE 'T11%'                       THEN 'Refund'
      WHEN event_code LIKE 'T04%'                       THEN 'Purchase'
      WHEN event_code LIKE 'T17%' OR event_code LIKE 'T18%' THEN 'Bank Payout'
      WHEN event_code LIKE 'T15%' OR event_code LIKE 'T08%' THEN 'Transfer'
      WHEN category = 'paypal_fee'                      THEN 'Other'
      WHEN category = 'bank_transfer_out'               THEN 'Bank Payout'
      WHEN category = 'bank_transfer_in'                THEN 'Transfer'
      WHEN category = 'paypal_credit_repayment'         THEN 'Transfer'
      WHEN category = 'paypal_credit_purchase'          THEN 'Purchase'
      WHEN category = 'refund'                          THEN 'Refund'
      WHEN description ILIKE '%invoice%'                THEN 'Invoice'
      ELSE 'Payment'
    END,
    updated_at = NOW()
  `);
};
