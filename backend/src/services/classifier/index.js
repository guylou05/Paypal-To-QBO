/**
 * Transaction classifier.
 *
 * Applies rules in priority order:
 *  1. Custom DB rules (admin-defined)
 *  2. Built-in rules
 *  3. Fallback → unknown → needs_review
 */
const db     = require('../../db/knex');
const logger = require('../../utils/logger');
const { RULES } = require('./rules');
const { deriveTransactionType } = require('../paypal/normalizer');

// ── Helpers ────────────────────────────────────────────────────────────────
function testCustomRule(rule, tx) {
  const rawValue = (() => {
    switch (rule.match_field) {
      case 'description': return tx.description || '';
      case 'event_code':  return tx.event_code  || '';
      case 'payer_name':  return tx.payer_name  || '';
      case 'payer_email': return tx.payer_email || '';
      case 'funding_source': return tx.funding_source || '';
      default: return '';
    }
  })();

  const val = rawValue.toLowerCase();
  const pat = (rule.match_value || '').toLowerCase();

  switch (rule.match_type) {
    case 'contains':    return val.includes(pat);
    case 'equals':      return val === pat;
    case 'starts_with': return val.startsWith(pat);
    case 'ends_with':   return val.endsWith(pat);
    case 'regex': {
      try { return new RegExp(rule.match_value, 'i').test(rawValue); }
      catch { return false; }
    }
    default: return false;
  }
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
    // deriveTransactionType prefers event_code but falls back to category,
    // so calling it again with the newly-known category gives the best result.
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
