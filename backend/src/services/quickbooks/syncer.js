/**
 * QuickBooks Online transaction syncer.
 *
 * All transaction types are posted as Journal Entries (most universal —
 * works regardless of the customer's QBO Items / A/R / A/P setup).
 * When the reviewer has matched a customer or vendor via qbo_metadata,
 * we attach an Entity reference on the relevant JE line so the entry
 * appears in their activity center and sub-ledger.
 *
 * Accounting logic:
 *
 *  sale / Payment / Invoice (income):
 *    Dr  PayPal Bank                    (net_amount)
 *    Dr  PayPal Fees                    (fee_amount)   [if fee > 0]
 *    Cr  Income Account                 (gross_amount) {EntityRef: Customer}
 *        ↳ Income Account = override or qbo_metadata.income_account_id or paypal_sales mapping
 *
 *  paypal_fee (standalone processing fee):
 *    Dr  Expense Account / PayPal Fees  (|gross|)      {EntityRef: Vendor if set}
 *    Cr  PayPal Bank                    (|gross|)
 *
 *  paypal_credit_purchase (Purchase / expense via PayPal Credit):
 *    Dr  Expense Account                (|gross|)      {EntityRef: Vendor if set}
 *    Cr  PayPal Credit (liability)      (|gross|)
 *
 *  paypal_credit_repayment:
 *    Dr  PayPal Credit (liability)      (|gross|)
 *    Cr  PayPal Bank                    (|gross|)
 *
 *  bank_transfer_in:
 *    QBO Transfer: bank_account_1 → paypal_bank
 *
 *  bank_transfer_out (includes Bank Payout):
 *    QBO Transfer: paypal_bank → bank_account_1
 *
 *  subscription / donation_received:
 *    Same JE as sale — user can pick a different income account.
 *
 *  international_fee:
 *    Same JE as paypal_fee — user can pick a different expense account.
 *
 *  payout (mass payment / Payouts API):
 *    Dr  Expense Account / Uncategorized (|gross|)    {EntityRef: Vendor if set}
 *    Cr  PayPal Bank                     (|gross|)
 *
 *  refund / chargeback (issued TO customer — gross < 0):
 *    Dr  Income Account                 (|gross|)      {EntityRef: Customer if set}
 *    Cr  PayPal Fees                    (|fee|)        [if fee returned]
 *    Cr  PayPal Bank                    (|net|)
 *
 *  refund / chargeback (received / won — gross > 0):
 *    Dr  PayPal Bank                    (|gross|)
 *    Cr  Expense Account                (|gross|)      {EntityRef: Vendor if set}
 *
 *  adjustment (credit, gross > 0):
 *    Dr  PayPal Bank                    (|gross|)
 *    Cr  Income Account / Uncategorized (|gross|)
 *
 *  adjustment (debit, gross < 0):
 *    Dr  Expense Account / Uncategorized (|gross|)
 *    Cr  PayPal Bank                     (|gross|)
 *
 *  currency_conversion (gain, gross > 0):
 *    Dr  PayPal Bank                    (|gross|)
 *    Cr  Income Account / Uncategorized (|gross|)
 *
 *  currency_conversion (loss, gross < 0):
 *    Dr  Expense Account / Uncategorized (|gross|)
 *    Cr  PayPal Bank                     (|gross|)
 *
 * ClassRef is added to every matching line when qbo_metadata.class_id is set.
 */
const db     = require('../../db/knex');
const qbo    = require('./client');
const logger = require('../../utils/logger');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Safe-parse qbo_metadata whether it's a string or already an object. */
function parseMeta(tx) {
  if (!tx.qbo_metadata) return {};
  if (typeof tx.qbo_metadata === 'string') {
    try { return JSON.parse(tx.qbo_metadata); } catch { return {}; }
  }
  return tx.qbo_metadata;
}

/** Resolve a QBO account from our mapping table, respecting per-tx override. */
async function getAccountId(mappingKey, tx) {
  const key = (tx && tx.override_qbo_account_key) || mappingKey;
  const row = await db('account_mappings').where({ mapping_key: key }).first();
  if (!row || !row.qbo_account_id) {
    throw new Error(`QBO account not mapped for key: "${key}". Please finish account setup.`);
  }
  return { id: row.qbo_account_id, name: row.qbo_account_name };
}

/**
 * Resolve the PayPal clearing (bank/asset) account for a transaction.
 * Prefers qbo_metadata.paypal_account_id set by the reviewer in the UI;
 * falls back to the mapped 'paypal_bank' account from account_mappings.
 */
async function getPaypalAccount(meta, tx) {
  if (meta.paypal_account_id) {
    return { id: meta.paypal_account_id, name: meta.paypal_account_name || 'PayPal' };
  }
  return getAccountId('paypal_bank', tx);
}

/**
 * Resolve the destination bank account for a transfer.
 * Prefers qbo_metadata.bank_account_id set by the reviewer;
 * falls back to mapped 'bank_account_1'.
 */
async function getBankAccount(meta, tx) {
  if (meta.bank_account_id) {
    return { id: meta.bank_account_id, name: meta.bank_account_name || 'Bank' };
  }
  const key = tx.override_qbo_account_key || 'bank_account_1';
  return getAccountId(key, tx);
}

/**
 * Build a single JournalEntry line.
 *
 * options:
 *   entity   — { Type: 'Customer'|'Vendor', EntityRef: { value, name } }
 *   classRef — { value, name }
 */
function line(postingType, accountRef, amount, description, options = {}) {
  const detail = {
    PostingType: postingType,
    AccountRef:  { value: accountRef.id, name: accountRef.name },
  };
  if (options.entity)   detail.Entity   = options.entity;
  if (options.classRef) detail.ClassRef = options.classRef;

  return {
    JournalEntryLineDetail: detail,
    Amount:      parseFloat(Math.abs(amount).toFixed(2)),
    DetailType:  'JournalEntryLineDetail',
    Description: description || '',
  };
}

/** Build entity/class options from qbo_metadata. */
function metaOptions(meta, entityType) {
  const opts = {};
  const id   = entityType === 'Customer' ? meta.customer_id  : meta.vendor_id;
  const name = entityType === 'Customer' ? meta.customer_name : meta.vendor_name;
  if (id) {
    opts.entity = { Type: entityType, EntityRef: { value: id, name: name || '' } };
  }
  if (meta.class_id) {
    opts.classRef = { value: meta.class_id, name: meta.class_name || '' };
  }
  return opts;
}

function buildJE(lines, tx, meta, docSuffix = '') {
  return {
    type: 'JournalEntry',
    payload: {
      Line:        lines,
      TxnDate:     tx.transaction_date,
      DocNumber:   `PP${docSuffix}-${tx.paypal_transaction_id}`.slice(0, 21),
      PrivateNote: [
        `PayPal Tx ${tx.paypal_transaction_id}`,
        tx.payer_name ? `Payer: ${tx.payer_name}` : null,
        meta.memo     ? `Note: ${meta.memo}`       : null,
      ].filter(Boolean).join(' | '),
    },
  };
}

// ── Per-category builders ──────────────────────────────────────────────────

async function buildSale(tx) {
  const meta = parseMeta(tx);

  const paypalBank  = await getPaypalAccount(meta, tx);
  const paypalFees  = await getAccountId('paypal_fees', tx);

  // Prefer specific income account chosen by reviewer; fall back to mapped paypal_sales.
  const incomeAccount = meta.income_account_id
    ? { id: meta.income_account_id, name: meta.income_account_name || 'Income' }
    : await getAccountId('paypal_sales', tx);

  const gross = Math.abs(tx.gross_amount);
  const fee   = Math.abs(tx.fee_amount);
  const net   = gross - fee;

  const incomeOpts = metaOptions(meta, 'Customer');
  const memo       = meta.memo || tx.description || tx.payer_name || '';

  const lines = [
    line('Debit',  paypalBank,    net,   `PayPal payment — net ${tx.paypal_transaction_id}`),
    line('Credit', incomeAccount, gross, `PayPal sale — ${memo}`, incomeOpts),
  ];
  if (fee > 0) {
    lines.splice(1, 0, line('Debit', paypalFees, fee, 'PayPal processing fee'));
  }

  return buildJE(lines, tx, meta);
}

async function buildPaypalFee(tx) {
  const meta = parseMeta(tx);

  const paypalBank = await getPaypalAccount(meta, tx);

  // Use reviewer-chosen expense account if provided; otherwise PayPal Fees mapping.
  const feeAccount = meta.expense_account_id
    ? { id: meta.expense_account_id, name: meta.expense_account_name || 'Expense' }
    : await getAccountId('paypal_fees', tx);

  const amount     = Math.abs(tx.gross_amount || tx.fee_amount);
  const expOpts    = metaOptions(meta, 'Vendor');

  return buildJE([
    line('Debit',  feeAccount, amount, `PayPal fee: ${meta.memo || tx.description || ''}`, expOpts),
    line('Credit', paypalBank, amount, 'PayPal Balance'),
  ], tx, meta);
}

async function buildCreditPurchase(tx) {
  const meta = parseMeta(tx);

  const paypalCredit = await getAccountId('paypal_credit', tx);

  // Use reviewer-chosen expense account; fall back to suggested or uncategorized.
  const expenseAccount = meta.expense_account_id
    ? { id: meta.expense_account_id, name: meta.expense_account_name || 'Expense' }
    : await getAccountId(
        tx.suggested_qbo_account_key === 'paypal_credit' ? 'uncategorized' : (tx.suggested_qbo_account_key || 'uncategorized'),
        tx
      );

  const amount  = Math.abs(tx.gross_amount);
  const expOpts = metaOptions(meta, 'Vendor');

  return buildJE([
    line('Debit',  expenseAccount, amount, `PayPal Credit purchase: ${meta.memo || tx.description || ''}`, expOpts),
    line('Credit', paypalCredit,   amount, 'PayPal Credit liability'),
  ], tx, meta);
}

async function buildCreditRepayment(tx) {
  const meta        = parseMeta(tx);
  const paypalCredit = await getAccountId('paypal_credit', tx);
  const paypalBank   = await getPaypalAccount(meta, tx);
  const amount       = Math.abs(tx.gross_amount);

  return buildJE([
    line('Debit',  paypalCredit, amount, 'PayPal Credit repayment — reduce liability'),
    line('Credit', paypalBank,   amount, 'PayPal Balance'),
  ], tx, meta);
}

async function buildBankTransferIn(tx) {
  const meta = parseMeta(tx);

  // If the reviewer approved an existing QBO bank match, link to it rather
  // than creating a new Transfer that would duplicate the entry.
  if (meta.bank_match?.qbo_id) {
    return { type: 'BankMatchLink', bankMatch: meta.bank_match };
  }

  const bankAccount = await getBankAccount(meta, tx);
  const paypalBank  = await getPaypalAccount(meta, tx);
  const amount      = Math.abs(tx.gross_amount);

  return {
    type: 'Transfer',
    payload: {
      Amount:         parseFloat(amount.toFixed(2)),
      FromAccountRef: { value: bankAccount.id, name: bankAccount.name },
      ToAccountRef:   { value: paypalBank.id,  name: paypalBank.name  },
      TxnDate:        tx.transaction_date,
      PrivateNote:    `Bank → PayPal funding ${tx.paypal_transaction_id}${meta.memo ? ` | ${meta.memo}` : ''}`,
    },
  };
}

async function buildBankTransferOut(tx) {
  const meta = parseMeta(tx);

  // If the reviewer approved an existing QBO bank match, link to it rather
  // than creating a new Transfer that would duplicate the entry.
  if (meta.bank_match?.qbo_id) {
    return { type: 'BankMatchLink', bankMatch: meta.bank_match };
  }

  const paypalBank  = await getPaypalAccount(meta, tx);
  const bankAccount = await getBankAccount(meta, tx);
  const amount      = Math.abs(tx.gross_amount);

  return {
    type: 'Transfer',
    payload: {
      Amount:         parseFloat(amount.toFixed(2)),
      FromAccountRef: { value: paypalBank.id,  name: paypalBank.name  },
      ToAccountRef:   { value: bankAccount.id, name: bankAccount.name },
      TxnDate:        tx.transaction_date,
      PrivateNote:    `PayPal → Bank withdrawal ${tx.paypal_transaction_id}${meta.memo ? ` | ${meta.memo}` : ''}`,
    },
  };
}

async function buildPayout(tx) {
  const meta = parseMeta(tx);

  const paypalBank = await getPaypalAccount(meta, tx);

  // Use reviewer-chosen expense account; fall back to uncategorized (payouts aren't fees).
  const expenseAccount = meta.expense_account_id
    ? { id: meta.expense_account_id, name: meta.expense_account_name || 'Expense' }
    : await getAccountId('uncategorized', tx);

  const amount  = Math.abs(tx.gross_amount);
  const expOpts = metaOptions(meta, 'Vendor');

  return buildJE([
    line('Debit',  expenseAccount, amount, `Payout: ${meta.memo || tx.description || ''}`, expOpts),
    line('Credit', paypalBank,     amount, 'PayPal Balance'),
  ], tx, meta, '-PAY');
}

async function buildAdjustment(tx) {
  const meta      = parseMeta(tx);
  const paypalBank = await getPaypalAccount(meta, tx);
  const amount     = Math.abs(tx.gross_amount);
  const isCredit   = parseFloat(tx.gross_amount) > 0;

  if (isCredit) {
    // Credit adjustment — money added to PayPal balance.
    const incomeAccount = meta.income_account_id
      ? { id: meta.income_account_id, name: meta.income_account_name || 'Income' }
      : await getAccountId('uncategorized', tx);
    return buildJE([
      line('Debit',  paypalBank,    amount, 'PayPal Balance — account credit'),
      line('Credit', incomeAccount, amount, `Adjustment: ${meta.memo || tx.description || ''}`),
    ], tx, meta, '-ADJ');
  } else {
    // Debit adjustment — money removed from PayPal balance.
    const expenseAccount = meta.expense_account_id
      ? { id: meta.expense_account_id, name: meta.expense_account_name || 'Expense' }
      : await getAccountId('uncategorized', tx);
    return buildJE([
      line('Debit',  expenseAccount, amount, `Adjustment: ${meta.memo || tx.description || ''}`),
      line('Credit', paypalBank,     amount, 'PayPal Balance — account debit'),
    ], tx, meta, '-ADJ');
  }
}

async function buildCurrencyConversion(tx) {
  const meta      = parseMeta(tx);
  const paypalBank = await getPaypalAccount(meta, tx);
  const amount     = Math.abs(tx.gross_amount);
  const isGain     = parseFloat(tx.gross_amount) > 0;

  if (isGain) {
    // FX gain — net positive from the conversion.
    const gainAccount = meta.income_account_id
      ? { id: meta.income_account_id, name: meta.income_account_name || 'Income' }
      : await getAccountId('uncategorized', tx);
    return buildJE([
      line('Debit',  paypalBank,  amount, 'PayPal Balance — FX gain'),
      line('Credit', gainAccount, amount, `Currency conversion gain: ${meta.memo || tx.description || ''}`),
    ], tx, meta, '-FX');
  } else {
    // FX loss — net negative from the conversion.
    const lossAccount = meta.expense_account_id
      ? { id: meta.expense_account_id, name: meta.expense_account_name || 'Expense' }
      : await getAccountId('uncategorized', tx);
    return buildJE([
      line('Debit',  lossAccount, amount, `Currency conversion loss: ${meta.memo || tx.description || ''}`),
      line('Credit', paypalBank,  amount, 'PayPal Balance — FX loss'),
    ], tx, meta, '-FX');
  }
}

async function buildRefund(tx) {
  const meta     = parseMeta(tx);
  const gross    = Math.abs(tx.gross_amount);
  const fee      = Math.abs(tx.fee_amount);
  const net      = gross - fee;
  const isIssued = parseFloat(tx.gross_amount) < 0; // we issued a refund (money out)

  const paypalBank  = await getPaypalAccount(meta, tx);
  const paypalFees  = await getAccountId('paypal_fees',  tx);

  if (isIssued) {
    // Money OUT — refund issued to a customer.
    // Dr Income Account (reverse the income), Cr PayPal Bank + Cr Fees returned.
    const incomeAccount = meta.income_account_id
      ? { id: meta.income_account_id, name: meta.income_account_name || 'Income' }
      : await getAccountId('paypal_sales', tx);

    const custOpts = metaOptions(meta, 'Customer');

    const lines = [
      line('Debit',  incomeAccount, gross, `Refund issued: ${meta.memo || tx.description || ''}`, custOpts),
      line('Credit', paypalBank,    net,   'PayPal Balance refunded'),
    ];
    if (fee > 0) {
      lines.splice(1, 0, line('Credit', paypalFees, fee, 'Fee returned on refund'));
    }
    return buildJE(lines, tx, meta, '-RF');
  } else {
    // Money IN — credit/refund received from a vendor.
    // Dr PayPal Bank, Cr Expense Account.
    const expenseAccount = meta.expense_account_id
      ? { id: meta.expense_account_id, name: meta.expense_account_name || 'Expense' }
      : await getAccountId('uncategorized', tx);

    const vendOpts = metaOptions(meta, 'Vendor');

    return buildJE([
      line('Debit',  paypalBank,      gross, 'PayPal Balance — vendor refund received'),
      line('Credit', expenseAccount,  gross, `Vendor credit: ${meta.memo || tx.description || ''}`, vendOpts),
    ], tx, meta, '-CR');
  }
}

// ── Router ─────────────────────────────────────────────────────────────────

async function buildQBOPayload(tx) {
  const category = tx.override_category || tx.category;
  switch (category) {
    // ── Core income ──────────────────────────────────────────────────────────
    case 'sale':                    return buildSale(tx);
    case 'subscription':            return buildSale(tx);          // recurring income, same JE
    case 'donation_received':       return buildSale(tx);          // income JE, user picks account

    // ── Fees & expenses ──────────────────────────────────────────────────────
    case 'paypal_fee':              return buildPaypalFee(tx);
    case 'international_fee':       return buildPaypalFee(tx);     // same JE, user picks account
    case 'purchase':                return buildPayout(tx);        // general expense payment; same JE
    case 'payout':                  return buildPayout(tx);        // mass payment / disbursement

    // ── PayPal Credit ────────────────────────────────────────────────────────
    case 'paypal_credit_purchase':  return buildCreditPurchase(tx);
    case 'paypal_credit_repayment': return buildCreditRepayment(tx);

    // ── Bank transfers ───────────────────────────────────────────────────────
    case 'bank_transfer_in':        return buildBankTransferIn(tx);
    case 'bank_transfer_out':       return buildBankTransferOut(tx);

    // ── Reversals ────────────────────────────────────────────────────────────
    case 'refund':                  return buildRefund(tx);
    case 'chargeback':              return buildRefund(tx);        // same reversal logic

    // ── Other ────────────────────────────────────────────────────────────────
    case 'adjustment':              return buildAdjustment(tx);
    case 'currency_conversion':     return buildCurrencyConversion(tx);

    default:
      throw new Error(`Cannot sync category "${category}" — classify or approve the transaction first.`);
  }
}

// ── Bank match linker ──────────────────────────────────────────────────────
//
// When the reviewer has approved an existing QBO bank transaction as the
// match for a PayPal transfer, we don't create a new object — we just stamp
// our PayPal transaction ID onto the existing QBO object's PrivateNote and
// record its ID as the linked QBO object.
//
// Supported qbo_type values: Transfer | Deposit | Purchase

async function linkBankMatch(tx, bankMatch) {
  const { qbo_id, qbo_type } = bankMatch;
  const meta = parseMeta(tx);

  if (!qbo_id || !qbo_type) {
    throw new Error('Bank match is missing qbo_id or qbo_type.');
  }

  // Fetch the existing QBO object to get its current SyncToken (required for update).
  const existing = await qbo.getObject(qbo_type, qbo_id);
  if (!existing) {
    throw new Error(
      `Matched QBO ${qbo_type} #${qbo_id} was not found — it may have been deleted in QBO. ` +
      `Re-open this transaction, clear the bank match, and save again.`
    );
  }

  // Append our PayPal reference to the note (idempotent — won't duplicate if re-synced).
  const ppRef       = `PayPal Tx ${tx.paypal_transaction_id}`;
  const currentNote = existing.PrivateNote || '';
  const newNote     = currentNote.includes(ppRef)
    ? currentNote
    : [currentNote, ppRef, meta.memo || ''].filter(Boolean).join(' | ');

  const updated = await qbo.sparseUpdateNote(qbo_type, qbo_id, existing.SyncToken, newNote);

  return {
    qboId:         updated.Id,
    qboSyncToken:  updated.SyncToken,
    qboObjectType: qbo_type,
    qboObject:     updated,
  };
}

// ── Sync a single transaction ──────────────────────────────────────────────

async function syncTransaction(tx, userId) {
  if (tx.status === 'synced') throw new Error('Transaction already synced to QBO.');
  if (tx.status !== 'approved') throw new Error('Transaction must be approved before syncing.');

  const built           = await buildQBOPayload(tx);
  const isBankMatchLink = built.type === 'BankMatchLink';
  const logAction       = isBankMatchLink ? 'link' : 'create';

  let qboId, qboSyncToken, qboObjectType, qboObject;

  try {
    if (isBankMatchLink) {
      // ── Link path: stamp PayPal ref onto the existing QBO object ──────────
      const result = await linkBankMatch(tx, built.bankMatch);
      qboId         = result.qboId;
      qboSyncToken  = result.qboSyncToken;
      qboObjectType = result.qboObjectType;
      qboObject     = result.qboObject;
    } else {
      // ── Create path: post a new object to QBO ────────────────────────────
      const { type, payload } = built;
      qboObjectType = type;
      switch (type) {
        case 'JournalEntry':  qboObject = await qbo.createJournalEntry(payload);  break;
        case 'Transfer':      qboObject = await qbo.createTransfer(payload);       break;
        case 'Purchase':      qboObject = await qbo.createPurchase(payload);       break;
        case 'RefundReceipt': qboObject = await qbo.createRefundReceipt(payload);  break;
        default: throw new Error(`Unknown QBO object type: ${type}`);
      }
      qboId        = qboObject.Id;
      qboSyncToken = qboObject.SyncToken;
    }
  } catch (err) {
    await db('qbo_sync_logs').insert({
      transaction_id:        tx.id,
      paypal_transaction_id: tx.paypal_transaction_id,
      action:                logAction,
      qbo_object_type:       isBankMatchLink ? built.bankMatch?.qbo_type : built.type,
      qbo_object_id:         isBankMatchLink ? built.bankMatch?.qbo_id   : null,
      status:                'failed',
      request_payload:       JSON.stringify(isBankMatchLink ? built.bankMatch : built.payload),
      error_message:         err.message,
      performed_by:          userId,
      created_at:            new Date(), updated_at: new Date(),
    });
    await db('normalized_transactions').where({ id: tx.id }).update({
      status:     'failed',
      sync_error: err.message,
      updated_at: new Date(),
    });
    throw err;
  }

  await db('normalized_transactions').where({ id: tx.id }).update({
    status:          'synced',
    qbo_object_id:   qboId,
    qbo_object_type: qboObjectType,
    qbo_sync_token:  qboSyncToken,
    sync_error:      null,   // clear any previous failure message
    updated_at:      new Date(),
  });

  await db('qbo_sync_logs').insert({
    transaction_id:        tx.id,
    paypal_transaction_id: tx.paypal_transaction_id,
    action:                logAction,
    qbo_object_type:       qboObjectType,
    qbo_object_id:         qboId,
    status:                'success',
    request_payload:       JSON.stringify(isBankMatchLink ? built.bankMatch : built.payload),
    response_payload:      JSON.stringify(qboObject),
    performed_by:          userId,
    created_at:            new Date(), updated_at: new Date(),
  });

  await db('audit_logs').insert({
    user_id:     userId,
    action:      'sync',
    entity_type: 'transaction',
    entity_id:   String(tx.id),
    details:     isBankMatchLink
      ? `Linked to existing QBO ${qboObjectType} #${qboId} (bank match — no new object created)`
      : `Synced to QBO as ${qboObjectType} #${qboId}`,
    created_at:  new Date(), updated_at: new Date(),
  });

  return { qboId, qboObjectType, qboObject };
}

// ── Rollback a synced transaction ──────────────────────────────────────────

async function rollbackTransaction(tx, userId) {
  if (tx.status !== 'synced' || !tx.qbo_object_id) {
    throw new Error('Transaction is not synced — nothing to roll back.');
  }

  const meta = parseMeta(tx);

  // Detect whether this sync was a BankMatchLink (we updated an existing object's
  // note) vs a created object.  If it was a link, we must NOT delete the QBO object
  // — it belongs to the user's bank account and predates our sync.
  const isBankMatchLink = !!(
    meta.bank_match?.qbo_id &&
    meta.bank_match.qbo_id === tx.qbo_object_id
  );

  const rollbackAction = isBankMatchLink ? 'unlink' : 'delete';

  if (!isBankMatchLink) {
    // We created this object — delete it from QBO.
    try {
      await qbo.deleteObject(tx.qbo_object_type, tx.qbo_object_id, tx.qbo_sync_token);
    } catch (err) {
      await db('rollback_logs').insert({
        transaction_id:        tx.id,
        paypal_transaction_id: tx.paypal_transaction_id,
        qbo_object_type:       tx.qbo_object_type,
        qbo_object_id:         tx.qbo_object_id,
        action:                rollbackAction,
        status:                'failed',
        error_message:         err.message,
        performed_by:          userId,
        created_at:            new Date(), updated_at: new Date(),
      });
      throw err;
    }
  } else {
    // Linked match — log that we're unlinking (leaving the QBO object intact).
    logger.info('Rollback: bank match link — resetting local state only, QBO object preserved', {
      qbo_type: tx.qbo_object_type,
      qbo_id:   tx.qbo_object_id,
    });
  }

  await db('rollback_logs').insert({
    transaction_id:        tx.id,
    paypal_transaction_id: tx.paypal_transaction_id,
    qbo_object_type:       tx.qbo_object_type,
    qbo_object_id:         tx.qbo_object_id,
    action:                rollbackAction,
    status:                'success',
    performed_by:          userId,
    created_at:            new Date(), updated_at: new Date(),
  });

  await db('normalized_transactions').where({ id: tx.id }).update({
    status:          'approved',
    qbo_object_id:   null,
    qbo_object_type: null,
    qbo_sync_token:  null,
    sync_error:      null,   // clear so the row shows clean after rollback
    updated_at:      new Date(),
  });

  await db('audit_logs').insert({
    user_id:     userId,
    action:      'rollback',
    entity_type: 'transaction',
    entity_id:   String(tx.id),
    details:     isBankMatchLink
      ? `Unlinked from QBO ${tx.qbo_object_type} #${tx.qbo_object_id} (QBO object preserved — not deleted)`
      : `Rolled back QBO ${tx.qbo_object_type} #${tx.qbo_object_id}`,
    created_at:  new Date(), updated_at: new Date(),
  });
}

module.exports = { syncTransaction, rollbackTransaction, buildQBOPayload };
