/**
 * Built-in classification rules for PayPal transactions.
 *
 * Rules are evaluated in priority order (lower number = higher priority).
 * The first matching rule wins.
 *
 * Each rule: { priority, category, confidence, qboAccountKey, test(tx) }
 *   tx = normalized_transaction record (before category is set)
 */

// Helpers
const contains   = (str, pattern) => str && pattern && str.toLowerCase().includes(pattern.toLowerCase());
const matchesAny = (str, patterns) => patterns.some(p => contains(str, p));

// ── Keyword lists ──────────────────────────────────────────────────────────

// PayPal Credit / BML keywords
const CREDIT_PURCHASE_KEYWORDS = [
  'bill me later',
  'buyer credit',
  'paypal credit',
  'paypal_credit',
  'bml',
  'transfer from bml',
];

const CREDIT_REPAYMENT_KEYWORDS = [
  'buyer credit payment',
  'paypal credit payment',
  'transfer to bml',
  'bml payment',
  'buyer credit payment withdrawal',
];

const NOISE_KEYWORDS = [
  'general authorization',
  'account hold',
  'open authorization',
  'reversal of general account hold',
  'general account hold',
];

// NOTE: 'chargeback' and 'dispute' are intentionally excluded here —
// they are handled by their own higher-priority chargeback rule below.
const REFUND_KEYWORDS = [
  'refund',
  'reversal',
];

const CHARGEBACK_KEYWORDS = [
  'chargeback',
  'dispute',
  'chargeback settlement',
  'dispute resolution',
];

const SUBSCRIPTION_KEYWORDS = [
  'subscription',
  'recurring payment',
  'recurring billing',
  'membership fee',
  'monthly subscription',
  'annual subscription',
];

const DONATION_KEYWORDS = [
  'donation',
  'donate',
  'charitable contribution',
  'fundraiser',
  'crowdfunding',
];

const PAYOUT_KEYWORDS = [
  'mass payment',
  'masspay',
  'payout',
  'payroll',
  'disbursement',
  'send money',
];

const INTERNATIONAL_FEE_KEYWORDS = [
  'cross-border fee',
  'international fee',
  'fx fee',
  'exchange rate fee',
  'currency conversion fee',
  'foreign transaction fee',
  'cross border',
];

const ADJUSTMENT_KEYWORDS = [
  'adjustment',
  'account adjustment',
  'credit adjustment',
  'debit adjustment',
  'account credit',
  'promotional credit',
  'goodwill credit',
  'hold reversal',
  'hold release',
  'reserve release',
  'bonus',
];

const CONVERSION_KEYWORDS = [
  'currency conversion',
  'exchange rate',
  'fx conversion',
  'foreign exchange',
  'currency exchange',
];

// ── PayPal event code families ─────────────────────────────────────────────

// T0001 (mass payment/payout) and T0002 (subscription) removed from SALE_EVENT_CODES
// because they have their own dedicated rules below.
// T0016 (donation) removed; handled by donation_received rule.
const SALE_EVENT_CODES = [
  'T0000', 'T0003', 'T0004', 'T0005', 'T0006',
  'T0008', 'T0009', 'T0010', 'T0011', 'T0012', 'T0013',
  'T0014', 'T0015', 'T0017', 'T0018', 'T0019',
  'T2001', 'T2002',
];

const SUBSCRIPTION_EVENT_CODES  = ['T0002', 'T5000', 'T5001'];
const DONATION_EVENT_CODES       = ['T0016'];
const PAYOUT_EVENT_CODES         = ['T0001'];    // Mass payment / Payouts API
const REFUND_EVENT_CODES         = ['T1106', 'T1107', 'T1108', 'T1109', 'T0020'];
const CHARGEBACK_EVENT_CODES     = ['T1700', 'T1701', 'T1702'];
const REVERSAL_EVENT_CODES       = ['T1110', 'T3500'];
const HOLD_EVENT_CODES           = ['T2101', 'T3000', 'T3001', 'T3002'];
const BANK_IN_EVENT_CODES        = ['T1201'];
const BANK_OUT_EVENT_CODES       = ['T1202'];
const CREDIT_EVENT_CODES         = ['T1601', 'T1602', 'T1603'];
const FEE_EVENT_CODES            = ['T0007'];
const CONVERSION_EVENT_CODES     = ['T1000', 'T1001'];
const ADJUSTMENT_EVENT_CODES     = ['T1400', 'T2102'];   // fee reversal, hold released

// ── Rules ──────────────────────────────────────────────────────────────────

const RULES = [

  // ── 1. Noise / authorizations / holds ─────────────────────────────────────
  {
    priority:    10,
    category:   'noise',
    confidence: 'high',
    qboAccountKey: null,
    defaultStatus: 'ignored',
    test: tx =>
      matchesAny(tx.description, NOISE_KEYWORDS) ||
      matchesAny(tx.event_code, HOLD_EVENT_CODES) ||
      REVERSAL_EVENT_CODES.includes(tx.event_code),
  },

  // ── 2. PayPal Credit repayment (must come before credit purchase) ──────────
  {
    priority:    20,
    category:   'paypal_credit_repayment',
    confidence: 'high',
    qboAccountKey: 'paypal_credit',
    test: tx =>
      matchesAny(tx.description, CREDIT_REPAYMENT_KEYWORDS) ||
      (tx.event_code === 'T1603' && tx.gross_amount < 0),
  },

  // ── 3a. PayPal Credit draw (T1601) — suppress as funding detail ──────────
  // T1601 is generated whenever PayPal Credit funds a purchase. It always
  // appears alongside a T00xx outbound payment record and represents the
  // internal credit draw, NOT a separate economic event. Marking it ignored
  // prevents a duplicate from cluttering the review queue.
  // (T1602 = credit repayment, T1603 = credit transfer — those are kept.)
  {
    priority:    24,
    category:   'funding_detail',
    confidence: 'high',
    qboAccountKey: null,
    defaultStatus: 'ignored',
    test: tx => tx.event_code === 'T1601',
  },

  // ── 3b. PayPal Credit purchase ────────────────────────────────────────────
  {
    priority:    25,
    category:   'paypal_credit_purchase',
    confidence: 'high',
    qboAccountKey: 'paypal_credit',
    test: tx =>
      tx.funding_source === 'paypal_credit' ||
      matchesAny(tx.description, CREDIT_PURCHASE_KEYWORDS) ||
      CREDIT_EVENT_CODES.includes(tx.event_code),
  },

  // ── 4. Chargeback / dispute (before refund — chargebacks are NOT refunds) ──
  {
    priority:    27,
    category:   'chargeback',
    confidence: 'high',
    qboAccountKey: 'paypal_bank',
    test: tx =>
      CHARGEBACK_EVENT_CODES.includes(tx.event_code) ||
      matchesAny(tx.description, CHARGEBACK_KEYWORDS),
  },

  // ── 5. Refunds ─────────────────────────────────────────────────────────────
  {
    priority:    30,
    category:   'refund',
    confidence: 'high',
    qboAccountKey: 'paypal_bank',
    test: tx =>
      REFUND_EVENT_CODES.includes(tx.event_code) ||
      matchesAny(tx.description, REFUND_KEYWORDS),
  },

  // ── 6. Account adjustment / credit (before fee rule) ─────────────────────
  {
    priority:    33,
    category:   'adjustment',
    confidence: 'medium',
    qboAccountKey: 'paypal_bank',
    test: tx =>
      ADJUSTMENT_EVENT_CODES.includes(tx.event_code) ||
      matchesAny(tx.description, ADJUSTMENT_KEYWORDS),
  },

  // ── 7. Currency conversion / FX ──────────────────────────────────────────
  {
    priority:    35,
    category:   'currency_conversion',
    confidence: 'high',
    qboAccountKey: 'paypal_bank',
    test: tx =>
      CONVERSION_EVENT_CODES.includes(tx.event_code) ||
      matchesAny(tx.description, CONVERSION_KEYWORDS),
  },

  // ── 8. Bank → PayPal funding transfer ─────────────────────────────────────
  {
    priority:    40,
    category:   'bank_transfer_in',
    confidence: 'high',
    qboAccountKey: 'paypal_bank',
    test: tx =>
      BANK_IN_EVENT_CODES.includes(tx.event_code) ||
      (tx.funding_source === 'bank' && tx.gross_amount > 0 &&
       matchesAny(tx.description, ['add funds', 'bank transfer', 'bank deposit', 'transfer from bank'])),
  },

  // ── 9. PayPal → bank withdrawal ─────────────────────────────────────────
  {
    priority:    45,
    category:   'bank_transfer_out',
    confidence: 'high',
    qboAccountKey: 'paypal_bank',
    test: tx =>
      BANK_OUT_EVENT_CODES.includes(tx.event_code) ||
      (tx.gross_amount < 0 &&
       matchesAny(tx.description, ['transfer to bank', 'withdrawal', 'withdraw funds'])),
  },

  // ── 10. Payout / mass payment sent (before paypal_fee) ───────────────────
  {
    priority:    47,
    category:   'payout',
    confidence: 'high',
    qboAccountKey: 'paypal_bank',
    test: tx =>
      (PAYOUT_EVENT_CODES.includes(tx.event_code) && tx.gross_amount < 0) ||
      (tx.gross_amount < 0 && matchesAny(tx.description, PAYOUT_KEYWORDS)),
  },

  // ── 11. International / cross-border fee (before generic paypal_fee) ──────
  {
    priority:    48,
    category:   'international_fee',
    confidence: 'high',
    qboAccountKey: 'paypal_fees',
    test: tx =>
      tx.gross_amount < 0 && matchesAny(tx.description, INTERNATIONAL_FEE_KEYWORDS),
  },

  // ── 12. Standalone PayPal fee ────────────────────────────────────────────
  {
    priority:    50,
    category:   'paypal_fee',
    confidence: 'high',
    qboAccountKey: 'paypal_fees',
    test: tx =>
      FEE_EVENT_CODES.includes(tx.event_code) ||
      (tx.gross_amount < 0 &&
       matchesAny(tx.description, ['fee', 'service charge', 'transaction fee', 'billing fee'])),
  },

  // ── 13. Donation received ────────────────────────────────────────────────
  {
    priority:    56,
    category:   'donation_received',
    confidence: 'high',
    qboAccountKey: 'paypal_bank',
    test: tx =>
      (DONATION_EVENT_CODES.includes(tx.event_code) && tx.gross_amount > 0) ||
      (tx.gross_amount > 0 && matchesAny(tx.description, DONATION_KEYWORDS)),
  },

  // ── 14. Subscription / recurring payment ─────────────────────────────────
  {
    priority:    58,
    category:   'subscription',
    confidence: 'high',
    qboAccountKey: 'paypal_bank',
    test: tx =>
      (SUBSCRIPTION_EVENT_CODES.includes(tx.event_code) && tx.gross_amount > 0) ||
      (tx.gross_amount > 0 && matchesAny(tx.description, SUBSCRIPTION_KEYWORDS)),
  },

  // ── 15. Customer payment / sale ──────────────────────────────────────────
  {
    priority:    60,
    category:   'sale',
    confidence: 'high',
    qboAccountKey: 'paypal_bank',
    test: tx =>
      (SALE_EVENT_CODES.includes(tx.event_code) && tx.gross_amount > 0) ||
      (tx.gross_amount > 0 && tx.status_code === 'S' && !tx.event_code),
  },

  // ── 16. General purchase / expense payment ────────────────────────────────
  // Catches outbound payments not already claimed by fee, payout, or transfer rules.
  {
    priority:    65,
    category:   'purchase',
    confidence: 'medium',
    qboAccountKey: 'paypal_bank',
    test: tx =>
      tx.gross_amount < 0 && tx.status_code === 'S',
  },
];

RULES.sort((a, b) => a.priority - b.priority);

module.exports = { RULES };
