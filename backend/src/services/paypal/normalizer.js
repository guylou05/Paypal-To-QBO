/**
 * Converts raw PayPal transaction_detail objects into a flat
 * normalized_transaction record ready for the DB and classifier.
 */

function parseAmount(obj) {
  if (!obj || !obj.value) return 0;
  return parseFloat(obj.value) || 0;
}

// ── Transaction-type derivation ────────────────────────────────────────────
//
// Types: Payment | Invoice | Transfer | Refund | Purchase | Bank Payout | Other
//
// Called at normalization time (category=null) and again by the classifier
// once the category is known. Priority:
//   1. High-confidence category signals (paypal_fee, bank_transfer_*, repayment)
//   2. Unambiguous event-code families (T04, T11, T15, T17…)
//   3. Ambiguous event codes resolved by gross_amount sign
//   4. Remaining category fallbacks
//   5. Pure gross_amount sign
//
// The gross_amount sign is the most reliable direction indicator:
//   gross >= 0 → money came IN  (Payment / Transfer in / Refund received)
//   gross <  0 → money went OUT (Purchase / Payout / Refund issued)
//
function deriveTransactionType(eventCode, description, category, grossAmount) {
  const code    = (eventCode   || '').toUpperCase().trim();
  const desc    = (description || '').toLowerCase();
  const gross   = parseFloat(grossAmount || 0);
  const moneyIn = gross >= 0;

  // ── 1. High-confidence category signals ─────────────────────────────
  // These are set by the classifier from PayPal's own instrument/event data
  // and are more semantically precise than the event-code prefix alone.
  if (category === 'paypal_fee')              return 'Other';     // Fee charge
  if (category === 'paypal_credit_repayment') return 'Transfer';  // Paying back credit line
  if (category === 'bank_transfer_in')        return 'Transfer';  // Bank → PayPal funding
  if (category === 'bank_transfer_out')       return 'Bank Payout'; // PayPal → Bank withdrawal

  // ── 2. Unambiguous event-code families ──────────────────────────────

  // Withdrawals to bank (always money out)
  if (code.startsWith('T17') || code.startsWith('T18')) return 'Bank Payout';

  // Neutral balance / account transfers
  if (code.startsWith('T15')) return 'Transfer';
  if (code === 'T1602')       return 'Transfer'; // PayPal Credit repayment

  // Bank ↔ PayPal — direction indicates sub-type
  if (code.startsWith('T08')) return moneyIn ? 'Transfer' : 'Bank Payout';

  // Reversals / refunds (T11xx are all reversal events)
  if (code.startsWith('T11')) return 'Refund';

  // Purchases you made (T04xx always = you paid someone)
  if (code.startsWith('T04')) return 'Purchase';

  // PayPal Credit transactions — direction determines if you received or spent
  if (code.startsWith('T16')) return moneyIn ? 'Payment' : 'Purchase';

  // ── 3. Ambiguous codes resolved by gross_amount sign ────────────────

  // Currency conversions (administrative)
  if (code.startsWith('T02')) return 'Other';

  // Fee events — any direction (fee charge = Other, fee reversal = Other too)
  if (code.startsWith('T07')) return 'Other';

  // Dispute / hold events (T06xx) — administrative, no business activity
  if (code.startsWith('T06')) return 'Other';

  // Account adjustments / credits (T09xx)
  if (code.startsWith('T09')) return moneyIn ? 'Payment' : 'Other';

  // Debit / correction events (T10xx)
  if (code.startsWith('T10')) return moneyIn ? 'Payment' : 'Refund';

  // Chargebacks and dispute resolutions (T03xx)
  if (code === 'T0301') return 'Refund';  // Chargeback filed → money held/out
  if (code === 'T0302') return 'Payment'; // Chargeback reversal → money returned
  if (code.startsWith('T03')) return moneyIn ? 'Payment' : 'Refund';

  // Chargeback settlement / escrow (T12xx, T13xx)
  if (code.startsWith('T12') || code.startsWith('T13')) {
    return moneyIn ? 'Payment' : 'Refund';
  }

  // ── 4. T00xx — the most common category; MUST use gross sign ─────────
  // T00xx events can represent either payments you received OR payments you
  // made (e.g. T0003 pre-approved, T0006 Express Checkout can be either
  // direction). The original code returned "Payment" for all T00xx, which
  // was wrong for outbound transactions.
  if (code.startsWith('T00')) {
    if (code === 'T0004') return 'Invoice'; // eBay auction billing
    if (desc.includes('invoice') || desc.includes('bill payment')) return 'Invoice';
    return moneyIn ? 'Payment' : 'Purchase'; // ← direction is the only reliable signal
  }

  // ── 5. Category-based fallbacks (no event code or unrecognised prefix) ─
  if (category === 'funding_detail')         return 'Other';  // internal split-funding bookkeeping
  if (category === 'sale')                   return desc.includes('invoice') ? 'Invoice' : 'Payment';
  if (category === 'refund')                 return 'Refund';
  if (category === 'paypal_credit_purchase') return 'Purchase';
  if (category === 'noise')                  return 'Other';
  if (category === 'unknown') return moneyIn ? 'Payment' : 'Purchase';

  // ── 6. Pure gross_amount sign (last resort) ──────────────────────────
  if (desc.includes('invoice')) return 'Invoice';
  return moneyIn ? 'Payment' : 'Purchase';
}

/**
 * Convert a raw PayPal transaction_detail into a normalized record.
 * Does NOT classify — that is the classifier's job.
 */
function normalize(raw) {
  const ti   = raw.transaction_info    || {};
  const pi   = raw.payer_info          || {};
  const name = pi.payer_name           || {};
  const cart = raw.cart_info           || {};

  const gross   = parseAmount(ti.transaction_amount);
  const fee     = parseAmount(ti.fee_amount);          // usually negative
  const net     = gross + fee;                          // fee is negative, so net < gross

  const dateStr = ti.transaction_initiation_date || ti.transaction_updated_date || '';
  const date    = dateStr ? new Date(dateStr) : null;

  // Build description from available fields
  const parts = [
    ti.transaction_subject,
    ti.transaction_note,
    cart.item_details && cart.item_details.length
      ? cart.item_details.map(i => i.item_name).join(', ')
      : null,
  ].filter(Boolean);
  const description = parts.join(' | ') || ti.transaction_event_code || '';

  // Determine funding instrument
  const instrumentType    = ti.instrument_type    || '';
  const instrumentSubType = ti.instrument_sub_type || '';

  return {
    paypal_transaction_id:         ti.transaction_id,
    transaction_date:              date ? date.toISOString().slice(0, 10) : null,
    transaction_datetime:          date ? date.toISOString() : null,
    payer_name:                    name.full_name || name.alternate_full_name || null,
    payer_email:                   pi.email_address || null,
    description:                   description.slice(0, 1000),
    event_code:                    ti.transaction_event_code   || null,
    status_code:                   ti.transaction_status       || null,
    gross_amount:                  gross,
    fee_amount:                    Math.abs(fee),  // store as positive; direction implied by raw sign
    net_amount:                    net,
    currency:                      (ti.transaction_amount && ti.transaction_amount.currency_code) || 'USD',
    instrument_type:               instrumentType,
    instrument_sub_type:           instrumentSubType,
    funding_source:                deriveFundingSource(ti, instrumentType, instrumentSubType),
    // Links this record to its parent transaction (set by PayPal for split-funded
    // payments and refunds). Used post-import to detect funding-detail sub-transactions.
    related_paypal_transaction_id: ti.related_transaction_id || null,
    // Derive type from event_code + gross sign (category=null at this stage;
    // the classifier will refine it once the category is known).
    transaction_type:              deriveTransactionType(ti.transaction_event_code, description, null, gross),
    status:                        'imported',
    category:                      null,
    confidence:                    null,
  };
}

function deriveFundingSource(ti, instrumentType, instrumentSubType) {
  if (
    instrumentType    === 'CREDIT' ||
    instrumentSubType === 'CREDIT' ||
    instrumentSubType === 'BML'
  ) return 'paypal_credit';

  if (instrumentType === 'BANK') return 'bank';

  return 'paypal_balance';
}

module.exports = { normalize, deriveTransactionType };
