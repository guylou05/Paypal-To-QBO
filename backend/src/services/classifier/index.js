/**
 * Transaction classifier.
 *
 * Applies rules in priority order:
 *  1. Custom DB rules (admin-defined, support up to 3 conditions with AND/OR)
 *  2. Built-in rules
 *  3. Fallback → unknown → needs_review
 */
const db     = require('../../db/knex');
const logger = require('../../utils/logger');
const { RULES } = require('./rules');
const { deriveTransactionType } = require('../paypal/normalizer');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Test a single match condition against a transaction. */
function testOneCondition(cond, tx) {
  const rawValue = ({
    description:    tx.description    || '',
    event_code:     tx.event_code     || '',
    payer_name:     tx.payer_name     || '',
    payer_email:    tx.payer_email    || '',
    funding_source: tx.funding_source || '',
  })[cond.match_field] || '';

  const val = rawValue.toLowerCase();
  const pat = (cond.match_value || '').toLowerCase();

  switch (cond.match_type) {
    case 'contains':    return val.includes(pat);
    case 'equals':      return val === pat;
    case 'starts_with': return val.startsWith(pat);
    case 'ends_with':   return val.endsWith(pat);
    case 'regex': {
      try { return new RegExp(cond.match_value, 'i').test(rawValue); }
      catch { return false; }
    }
    default: return false;
  }
}

/**
 * Test a custom DB rule against a transaction.
 *
 * Supports the new multi-condition format (rule.conditions array) with AND/OR
 * logic, and falls back to the legacy single-condition columns for older rows
 * that haven't been migrated yet.
 */
function testCustomRule(rule, tx) {
  // Parse conditions — Postgres may return JSONB as a string or already-parsed object.
  const conditions = rule.conditions
    ? (typeof rule.conditions === 'string' ? JSON.parse(rule.conditions) : rule.conditions)
    : null;

  if (Array.isArray(conditions) && conditions.length > 0) {
    const op = (rule.conditions_operator || 'and').toLowerCase();
    return op === 'or'
      ? conditions.some(c  => testOneCondition(c, tx))
      : conditions.every(c => testOneCondition(c, tx));
  }

  // Legacy fallback: single-condition columns.
  return testOneCondition({
    match_field: rule.match_field,
    match_type:  rule.match_type,
    match_value: rule.match_value,
  }, tx);
}

async function loadCustomRules() {
  return db('classification_rules')
    .where({ is_active: true })
    .orderBy('priority', 'asc');
}

// ── Main classifier ────────────────────────────────────────────────────────
async function classify(normalizedTx) {
  // 1. Custom rules from DB first
  const customRules = await loadCustomRules();
  for (const rule of customRules) {
    if (testCustomRule(rule, normalizedTx)) {
      return {
        category:               rule.category,
        confidence:             rule.confidence || 'high',
        suggested_qbo_account_key: rule.qbo_account_key || null,
        status:                 'classified',
        matched_rule:           `custom:${rule.id}:${rule.name}`,
      };
    }
  }

  // 2. Built-in rules
  for (const rule of RULES) {
    if (rule.test(normalizedTx)) {
      const defaultStatus = rule.defaultStatus || 'classified';
      return {
        category:                  rule.category,
        confidence:                rule.confidence,
        suggested_qbo_account_key: rule.qboAccountKey,
        status:                    defaultStatus === 'ignored' ? 'ignored' : 'classified',
        matched_rule:              `builtin:${rule.priority}:${rule.category}`,
      };
    }
  }

  // 3. Unknown — send to review
  logger.debug(`Transaction ${normalizedTx.paypal_transaction_id} unclassified — needs review`);
  return {
    category:                  'unknown',
    confidence:                'low',
    suggested_qbo_account_key: 'uncategorized',
    status:                    'needs_review',
    matched_rule:              'none',
  };
}

/**
 * Classify a batch of normalized transactions.
 * Updates each row in the DB and returns the updated records.
 */
async function classifyBatch(transactionIds) {
  const txs = await db('normalized_transactions')
    .whereIn('id', transactionIds)
    .where('status', 'imported');

  const results = [];
  for (const tx of txs) {
    const result = await classify(tx);

    // Low-confidence → always needs_review
    if (result.confidence === 'low' && result.status !== 'ignored') {
      result.status = 'needs_review';
    }

    // Refine transaction_type now that we have the category.
    const transactionType = deriveTransactionType(tx.event_code, tx.description, result.category, tx.gross_amount);

    await db('normalized_transactions').where({ id: tx.id }).update({
      category:                  result.category,
      confidence:                result.confidence,
      suggested_qbo_account_key: result.suggested_qbo_account_key,
      status:                    result.status,
      transaction_type:          transactionType,
      updated_at:                new Date(),
    });

    results.push({ id: tx.id, ...result });
  }

  return results;
}

module.exports = { classify, classifyBatch };
