/**
 * QuickBooks Online transaction syncer.
 *
 * Accounting object priority (mimics professional bookkeeper workflow):
 *
 *  1. SalesReceipt   — customer revenue (sale, subscription, donation).
 *  2. Purchase       — expense payments, fees, PayPal Credit buys.
 *  3. Transfer       — bank ↔ PayPal movements and Credit repayments.
 *  4. RefundReceipt  — refunds / chargebacks issued to customers.
 *  5. JournalEntry   — FALLBACK ONLY: adjustments, FX conversions, or
 *                       when SalesReceipt can't be built (Sales Item /
 *                       Customer not yet configured in Setup).
 *
 * ── Object mapping by category ────────────────────────────────────────────
 *
 *  sale / subscription / donation_received:
 *    SalesReceipt — Customer, gross amount, DepositToAccountRef = PayPal Bank
 *    + Purchase   — PayPal processing fee, paid from PayPal Bank
 *    → Returned as { type: 'SaleWithFee' } when fee > 0.
 *    [Falls back to JournalEntry when paypal_sales_item or default customer
 *     is not configured in Setup → Account Mapping]
 *
 *  paypal_fee / international_fee:
 *    Purchase — paid from PayPal Bank → PayPal Fees expense account.
 *
 *  purchase / payout:
 *    Purchase — paid from PayPal Bank → chosen expense / uncategorized account.
 *
 *  paypal_credit_purchase:
 *    Purchase — MUST be paid from PayPal Credit (liability), NEVER PayPal Bank.
 *    Increases the credit card liability correctly.
 *
 *  paypal_credit_repayment:
 *    Transfer — PayPal Bank → PayPal Credit. Reduces liability, no P&L impact.
 *
 *  bank_transfer_in / bank_transfer_out:
 *    Transfer — between bank account and PayPal Bank.
 *    BankMatchLink — if reviewer approved an existing QBO bank transaction.
 *
 *  refund / chargeback (issued, gross < 0):
 *    RefundReceipt — Customer, amount, DepositToAccountRef = PayPal Bank.
 *    [Falls back to JournalEntry when Sales Item / Customer not configured]
 *
 *  refund / chargeback (received / won, gross > 0):
 *    JournalEntry — Dr PayPal Bank / Cr Expense (vendor credit / chargeback win).
 *
 *  adjustment / currency_conversion:
 *    JournalEntry — no cleaner native QBO object exists.
 *
 * ── Compound objects ────────────────────────────────────────────────────────
 *
 *  SaleWithFee  { type, primary: SalesReceipt, fee: Purchase }
 *    Syncer creates both. fee_qbo_id + fee_qbo_type stored in qbo_metadata
 *    so rollback can delete both objects.
 *
 *  SplitSale (legacy) { type, primary: JournalEntry, fee: JournalEntry }
 *    Preserved for backward-compat rollback of already-synced records.
 *    New syncs never produce SplitSale — they use SaleWithFee or the
 *    standard JE fallback.
 *
 * ── ClassRef ────────────────────────────────────────────────────────────────
 *   Added to SalesReceipt and Purchase lines when qbo_metadata.class_id set.
 */
const db     = require('../../db/knex');
const qbo    = require('./client');
const logger = require('../../utils/logger');

// ── Meta helpers ───────────────────────────────────────────────────────────

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

/** PayPal clearing/bank account — reviewer override or mapped paypal_bank. */
async function getPaypalAccount(meta, tx) {
  if (meta.paypal_account_id) {
    return { id: meta.paypal_account_id, name: meta.paypal_account_name || 'PayPal' };
  }
  return getAccountId('paypal_bank', tx);
}

/** Destination bank account for transfers — reviewer override or bank_account_1. */
async function getBankAccount(meta, tx) {
  if (meta.bank_account_id) {
    return { id: meta.bank_account_id, name: meta.bank_account_name || 'Bank' };
  }
  return getAccountId(tx.override_qbo_account_key || 'bank_account_1', tx);
}

/**
 * Resolve the QBO Service/Non-Inventory Item used as the line item on
 * SalesReceipts and RefundReceipts.  Configured in Setup → Account Mapping
 * under the key 'paypal_sales_item'.
 * Returns null when not yet configured (triggers JE fallback).
 */
async function getSalesItem() {
  const row = await db('account_mappings').where({ mapping_key: 'paypal_sales_item' }).first();
  return row?.qbo_account_id
    ? { id: row.qbo_account_id, name: row.qbo_account_name || 'PayPal Sales' }
    : null;
}

/**
 * Resolve the default QBO Customer used when the reviewer has not picked
 * a specific customer.  Configured in Setup → Account Mapping under the
 * key 'paypal_default_customer'.
 * Returns null when not configured (triggers JE fallback).
 */
async function getDefaultCustomer() {
  const row = await db('account_mappings').where({ mapping_key: 'paypal_default_customer' }).first();
  return row?.qbo_account_id
    ? { id: row.qbo_account_id, name: row.qbo_account_name || 'PayPal Customer' }
    : null;
}

/** Standard PrivateNote for any QBO object. */
function buildNote(tx, meta) {
  return [
    `PayPal Tx ${tx.paypal_transaction_id}`,
    tx.payer_name ? `Payer: ${tx.payer_name}` : null,
    meta.memo     ? `Note: ${meta.memo}`       : null,
  ].filter(Boolean).join(' | ');
}

/**
 * Build entity/class options from qbo_metadata.
 * Used by JournalEntry line helpers only.
 * (Purchase and SalesReceipt handle entity/class slightly differently.)
 */
function metaOptions(meta, entityType) {
  const opts = {};
  const id   = entityType === 'Customer' ? meta.customer_id  : meta.vendor_id;
  const name = entityType === 'Customer' ? meta.customer_name : meta.vendor_name;
  if (id) opts.entity = { Type: entityType, EntityRef: { value: id, name: name || '' } };
  if (meta.class_id) opts.classRef = { value: meta.class_id, name: meta.class_name || '' };
  return opts;
}

// ── JournalEntry helpers (retained for fallback, adjustment, conversion) ───

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

function buildJE(lines, tx, meta, docSuffix = '') {
  return {
    type: 'JournalEntry',
    payload: {
      Line:        lines,
      TxnDate:     tx.transaction_date,
      DocNumber:   `PP${docSuffix}-${tx.paypal_transaction_id}`.slice(0, 21),
      PrivateNote: buildNote(tx, meta),
    },
  };
}

// ── Purchase (Expense) payload builder ─────────────────────────────────────
/**
 * Build a QBO Purchase object payload.
 *   QBO API endpoint: POST /purchase   (UI label: "Expense")
 *
 * paymentAccount — where the money was paid FROM (PayPal Bank or PayPal Credit).
 * expenseAccount — the expense category account (line level).
 * meta           — full qbo_metadata; entity = Vendor unless entityType overridden.
 * docSuffix      — appended between "PP" and "-{txId}" in DocNumber.
 */
function buildPurchasePayload(tx, meta, { paymentAccount, expenseAccount, amount, docSuffix, description, entityType }) {
  const opts     = metaOptions(meta, entityType || 'Vendor');
  const classRef = opts.classRef;

  const lineItem = {
    Amount:     parseFloat(Math.abs(amount).toFixed(2)),
    DetailType: 'AccountBasedExpenseLineDetail',
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: expenseAccount.id, name: expenseAccount.name },
      ...(classRef ? { ClassRef: classRef } : {}),
    },
    Description: (description || '').slice(0, 255),
  };

  const payload = {
    PaymentType: 'Cash',
    AccountRef:  { value: paymentAccount.id, name: paymentAccount.name },
    TxnDate:     tx.transaction_date,
    DocNumber:   `PP${docSuffix || ''}-${tx.paypal_transaction_id}`.slice(0, 21),
    PrivateNote: buildNote(tx, meta),
    TotalAmt:    parseFloat(Math.abs(amount).toFixed(2)),
    Line:        [lineItem],
  };

  // Vendor/Customer entity at the document level (not inside lines for Purchase)
  if (opts.entity) {
    payload.EntityRef = {
      value: opts.entity.EntityRef.value,
      name:  opts.entity.EntityRef.name,
      Type:  opts.entity.Type,
    };
  }

  return { type: 'Purchase', payload };
}

// ── Per-category builders ──────────────────────────────────────────────────

/**
 * Income: SalesReceipt (gross amount) + companion Purchase for the fee.
 *
 * The fee Purchase is ALWAYS created when fee > 0 because without it
 * the PayPal Bank account would show +gross but only +net was deposited —
 * causing a reconciliation discrepancy.
 *
 * Falls back to JournalEntry if paypal_sales_item or default customer
 * is not yet configured in Setup → Account Mapping.
 */
async function buildSale(tx) {
  const meta        = parseMeta(tx);
  const salesItem   = await getSalesItem();
  const defCustomer = await getDefaultCustomer();

  const customerId   = meta.customer_id   || defCustomer?.id   || null;
  const customerName = meta.customer_name || defCustomer?.name || 'PayPal Customer';

  if (!salesItem || !customerId) {
    logger.warn(
      !salesItem
        ? `paypal_sales_item not configured in Setup — using JournalEntry fallback for ${tx.paypal_transaction_id}`
        : `No customer available for SalesReceipt — using JournalEntry fallback for ${tx.paypal_transaction_id}`
    );
    return buildSaleAsJE(tx);
  }

  const paypalBank = await getPaypalAccount(meta, tx);
  const gross      = Math.abs(parseFloat(tx.gross_amount));
  const fee        = Math.abs(parseFloat(tx.fee_amount || 0));
  const memo       = meta.memo || tx.description || tx.payer_name || '';
  const classRef   = meta.class_id ? { value: meta.class_id, name: meta.class_name || '' } : null;

  const srPayload = {
    CustomerRef:         { value: customerId, name: customerName },
    TxnDate:             tx.transaction_date,
    DocNumber:           `PP-${tx.paypal_transaction_id}`.slice(0, 21),
    PrivateNote:         buildNote(tx, meta),
    DepositToAccountRef: { value: paypalBank.id, name: paypalBank.name },
    Line: [
      {
        Amount:     parseFloat(gross.toFixed(2)),
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: salesItem.id, name: salesItem.name },
          ...(classRef ? { ClassRef: classRef } : {}),
        },
        Description: `PayPal sale — ${memo}`.slice(0, 255),
      },
    ],
  };

  const sr = { type: 'SalesReceipt', payload: srPayload };

  if (fee > 0) {
    // Companion Purchase records the fee so PayPal Bank net is correct.
    const paypalFees = await getAccountId('paypal_fees', tx);
    const feeObj = buildPurchasePayload(tx, meta, {
      paymentAccount: paypalBank,
      expenseAccount: paypalFees,
      amount:         fee,
      docSuffix:      'FEE',
      description:    `PayPal processing fee — ${tx.paypal_transaction_id}`,
      entityType:     'Vendor',   // fee has no entity but class may apply
    });
    return { type: 'SaleWithFee', primary: sr, fee: feeObj };
  }

  return sr;
}

/**
 * JournalEntry fallback for sales when paypal_sales_item or customer
 * is not configured.  Also handles the legacy split_fee JE mode.
 */
async function buildSaleAsJE(tx) {
  const meta          = parseMeta(tx);
  const paypalBank    = await getPaypalAccount(meta, tx);
  const paypalFees    = await getAccountId('paypal_fees', tx);
  const incomeAccount = meta.income_account_id
    ? { id: meta.income_account_id, name: meta.income_account_name || 'Income' }
    : await getAccountId('paypal_sales', tx);

  const gross      = Math.abs(parseFloat(tx.gross_amount));
  const fee        = Math.abs(parseFloat(tx.fee_amount || 0));
  const net        = gross - fee;
  const incomeOpts = metaOptions(meta, 'Customer');
  const memo       = meta.memo || tx.description || tx.payer_name || '';

  // Legacy split_fee mode: two separate JEs
  if (meta.split_fee && fee > 0) {
    const saleJE = buildJE([
      line('Debit',  paypalBank,    gross, `PayPal sale — gross ${tx.paypal_transaction_id}`),
      line('Credit', incomeAccount, gross, `PayPal sale — ${memo}`, incomeOpts),
    ], tx, meta);
    const feeJE = buildJE([
      line('Debit',  paypalFees, fee, `PayPal fee — ${tx.paypal_transaction_id}`),
      line('Credit', paypalBank, fee, 'PayPal Balance — fee deducted'),
    ], tx, meta, '-FEE');
    return { type: 'SplitSale', primary: saleJE, fee: feeJE };
  }

  // Standard 3-line JE
  const jeLines = [
    line('Debit',  paypalBank,    net,   `PayPal payment — net ${tx.paypal_transaction_id}`),
    line('Credit', incomeAccount, gross, `PayPal sale — ${memo}`, incomeOpts),
  ];
  if (fee > 0) jeLines.splice(1, 0, line('Debit', paypalFees, fee, 'PayPal processing fee'));
  return buildJE(jeLines, tx, meta);
}

/**
 * Standalone PayPal fee / international fee:
 * Purchase paid from PayPal Bank → PayPal Fees expense account.
 */
async function buildPaypalFee(tx) {
  const meta         = parseMeta(tx);
  const paypalBank   = await getPaypalAccount(meta, tx);
  const feeAccount   = meta.expense_account_id
    ? { id: meta.expense_account_id, name: meta.expense_account_name || 'Expense' }
    : await getAccountId('paypal_fees', tx);
  const amount = Math.abs(parseFloat(tx.gross_amount || tx.fee_amount || 0));
  const memo   = meta.memo || tx.description || '';

  return buildPurchasePayload(tx, meta, {
    paymentAccount: paypalBank,
    expenseAccount: feeAccount,
    amount,
    description:    `PayPal fee: ${memo}`,
  });
}

/**
 * PayPal Credit purchase:
 * Purchase paid from PayPal Credit (liability) — NEVER from PayPal Bank.
 * The credit card liability increases; no PayPal Bank movement.
 */
async function buildCreditPurchase(tx) {
  const meta          = parseMeta(tx);
  // CRITICAL: payment account must be PayPal Credit, not PayPal Bank.
  const paypalCredit  = await getAccountId('paypal_credit', tx);
  const expenseAccount = meta.expense_account_id
    ? { id: meta.expense_account_id, name: meta.expense_account_name || 'Expense' }
    : await getAccountId('uncategorized', tx);
  const amount = Math.abs(parseFloat(tx.gross_amount));
  const memo   = meta.memo || tx.description || '';

  return buildPurchasePayload(tx, meta, {
    paymentAccount: paypalCredit,     // ← PayPal Credit liability, not PayPal Bank
    expenseAccount,
    amount,
    docSuffix:      'CC',
    description:    `PayPal Credit purchase: ${memo}`,
  });
}

/**
 * PayPal Credit repayment:
 * Transfer from PayPal Bank → PayPal Credit liability.
 * Reduces the credit card balance — no P&L impact.
 */
async function buildCreditRepayment(tx) {
  const meta         = parseMeta(tx);
  const paypalCredit = await getAccountId('paypal_credit', tx);
  const paypalBank   = await getPaypalAccount(meta, tx);
  const amount       = Math.abs(parseFloat(tx.gross_amount));

  return {
    type: 'Transfer',
    payload: {
      Amount:         parseFloat(amount.toFixed(2)),
      FromAccountRef: { value: paypalBank.id,  name: paypalBank.name  },
      ToAccountRef:   { value: paypalCredit.id, name: paypalCredit.name },
      TxnDate:        tx.transaction_date,
      PrivateNote:    buildNote(tx, meta),
    },
  };
}

/** Bank → PayPal funding transfer. */
async function buildBankTransferIn(tx) {
  const meta = parseMeta(tx);
  if (meta.bank_match?.qbo_id) return { type: 'BankMatchLink', bankMatch: meta.bank_match };

  const bankAccount = await getBankAccount(meta, tx);
  const paypalBank  = await getPaypalAccount(meta, tx);
  const amount      = Math.abs(parseFloat(tx.gross_amount));

  return {
    type: 'Transfer',
    payload: {
      Amount:         parseFloat(amount.toFixed(2)),
      FromAccountRef: { value: bankAccount.id, name: bankAccount.name },
      ToAccountRef:   { value: paypalBank.id,  name: paypalBank.name  },
      TxnDate:        tx.transaction_date,
      PrivateNote:    buildNote(tx, meta),
    },
  };
}

/** PayPal → bank withdrawal. */
async function buildBankTransferOut(tx) {
  const meta = parseMeta(tx);
  if (meta.bank_match?.qbo_id) return { type: 'BankMatchLink', bankMatch: meta.bank_match };

  const paypalBank  = await getPaypalAccount(meta, tx);
  const bankAccount = await getBankAccount(meta, tx);
  const amount      = Math.abs(parseFloat(tx.gross_amount));

  return {
    type: 'Transfer',
    payload: {
      Amount:         parseFloat(amount.toFixed(2)),
      FromAccountRef: { value: paypalBank.id,  name: paypalBank.name  },
      ToAccountRef:   { value: bankAccount.id, name: bankAccount.name },
      TxnDate:        tx.transaction_date,
      PrivateNote:    buildNote(tx, meta),
    },
  };
}

/**
 * Payout / mass payment / general purchase:
 * Purchase paid from PayPal Bank → uncategorized (or reviewer-chosen) expense account.
 */
async function buildPayout(tx) {
  const meta    = parseMeta(tx);
  const paypalBank = await getPaypalAccount(meta, tx);
  const expenseAccount = meta.expense_account_id
    ? { id: meta.expense_account_id, name: meta.expense_account_name || 'Expense' }
    : await getAccountId('uncategorized', tx);
  const amount = Math.abs(parseFloat(tx.gross_amount));
  const memo   = meta.memo || tx.description || '';

  return buildPurchasePayload(tx, meta, {
    paymentAccount: paypalBank,
    expenseAccount,
    amount,
    docSuffix:      'PAY',
    description:    `Payout: ${memo}`,
  });
}

/**
 * Account adjustment:
 * JournalEntry — credit (Dr PayPal Bank / Cr income) or debit (Dr expense / Cr PayPal Bank).
 * No cleaner native QBO object exists for adjustments.
 */
async function buildAdjustment(tx) {
  const meta       = parseMeta(tx);
  const paypalBank = await getPaypalAccount(meta, tx);
  const amount     = Math.abs(parseFloat(tx.gross_amount));
  const isCredit   = parseFloat(tx.gross_amount) > 0;

  if (isCredit) {
    const incomeAccount = meta.income_account_id
      ? { id: meta.income_account_id, name: meta.income_account_name || 'Income' }
      : await getAccountId('uncategorized', tx);
    return buildJE([
      line('Debit',  paypalBank,    amount, 'PayPal Balance — account credit'),
      line('Credit', incomeAccount, amount, `Adjustment: ${meta.memo || tx.description || ''}`),
    ], tx, meta, '-ADJ');
  } else {
    const expenseAccount = meta.expense_account_id
      ? { id: meta.expense_account_id, name: meta.expense_account_name || 'Expense' }
      : await getAccountId('uncategorized', tx);
    return buildJE([
      line('Debit',  expenseAccount, amount, `Adjustment: ${meta.memo || tx.description || ''}`),
      line('Credit', paypalBank,     amount, 'PayPal Balance — account debit'),
    ], tx, meta, '-ADJ');
  }
}

/**
 * Currency conversion gain/loss:
 * JournalEntry — FX gain (Dr PayPal Bank / Cr income) or loss (Dr expense / Cr PayPal Bank).
 */
async function buildCurrencyConversion(tx) {
  const meta       = parseMeta(tx);
  const paypalBank = await getPaypalAccount(meta, tx);
  const amount     = Math.abs(parseFloat(tx.gross_amount));
  const isGain     = parseFloat(tx.gross_amount) > 0;

  if (isGain) {
    const gainAccount = meta.income_account_id
      ? { id: meta.income_account_id, name: meta.income_account_name || 'Income' }
      : await getAccountId('uncategorized', tx);
    return buildJE([
      line('Debit',  paypalBank,  amount, 'PayPal Balance — FX gain'),
      line('Credit', gainAccount, amount, `Currency conversion gain: ${meta.memo || tx.description || ''}`),
    ], tx, meta, '-FX');
  } else {
    const lossAccount = meta.expense_account_id
      ? { id: meta.expense_account_id, name: meta.expense_account_name || 'Expense' }
      : await getAccountId('uncategorized', tx);
    return buildJE([
      line('Debit',  lossAccount, amount, `Currency conversion loss: ${meta.memo || tx.description || ''}`),
      line('Credit', paypalBank,  amount, 'PayPal Balance — FX loss'),
    ], tx, meta, '-FX');
  }
}

/**
 * Refund / chargeback:
 *
 *  Issued (gross < 0):
 *    RefundReceipt — Customer, amount, DepositToAccountRef = PayPal Bank.
 *    Falls back to JournalEntry if Sales Item / Customer not configured.
 *
 *  Received / won (gross > 0):
 *    JournalEntry — Dr PayPal Bank / Cr Expense (vendor credit or chargeback win).
 */
async function buildRefund(tx) {
  const meta     = parseMeta(tx);
  const gross    = parseFloat(tx.gross_amount);
  const isIssued = gross < 0;

  const paypalBank = await getPaypalAccount(meta, tx);

  if (isIssued) {
    // ── RefundReceipt to customer ──────────────────────────────────────────
    const salesItem   = await getSalesItem();
    const defCustomer = await getDefaultCustomer();
    const customerId  = meta.customer_id   || defCustomer?.id   || null;
    const customerName = meta.customer_name || defCustomer?.name || 'PayPal Customer';

    if (!salesItem || !customerId) {
      logger.warn(
        `RefundReceipt fallback to JE for ${tx.paypal_transaction_id} — item/customer not configured in Setup`
      );
      return buildRefundAsJE(tx);
    }

    const absGross = Math.abs(gross);
    const classRef = meta.class_id ? { value: meta.class_id, name: meta.class_name || '' } : null;

    return {
      type: 'RefundReceipt',
      payload: {
        CustomerRef:         { value: customerId, name: customerName },
        TxnDate:             tx.transaction_date,
        PaymentRefNum:       tx.paypal_transaction_id,
        PrivateNote:         buildNote(tx, meta),
        DepositToAccountRef: { value: paypalBank.id, name: paypalBank.name },
        Line: [
          {
            Amount:     parseFloat(absGross.toFixed(2)),
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: {
              ItemRef: { value: salesItem.id, name: salesItem.name },
              ...(classRef ? { ClassRef: classRef } : {}),
            },
            Description: `Refund: ${meta.memo || tx.description || ''}`.slice(0, 255),
          },
        ],
      },
    };
  } else {
    // ── Vendor credit / chargeback won → JournalEntry ────────────────────
    const absGross = Math.abs(gross);
    const absFee   = Math.abs(parseFloat(tx.fee_amount || 0));
    const absNet   = absGross - absFee;
    const paypalFees = await getAccountId('paypal_fees', tx);
    const expenseAccount = meta.expense_account_id
      ? { id: meta.expense_account_id, name: meta.expense_account_name || 'Expense' }
      : await getAccountId('uncategorized', tx);
    const vendOpts = metaOptions(meta, 'Vendor');

    const jeLines = [
      line('Debit',  paypalBank,     absFee > 0 ? absNet : absGross, 'PayPal Balance — credit/win received'),
      line('Credit', expenseAccount, absGross, `Vendor credit: ${meta.memo || tx.description || ''}`, vendOpts),
    ];
    if (absFee > 0) jeLines.splice(1, 0, line('Debit', paypalFees, absFee, 'Fee returned'));
    return buildJE(jeLines, tx, meta, '-CR');
  }
}

/** JournalEntry fallback for refunds when Sales Item / Customer not configured. */
async function buildRefundAsJE(tx) {
  const meta          = parseMeta(tx);
  const gross         = Math.abs(parseFloat(tx.gross_amount));
  const fee           = Math.abs(parseFloat(tx.fee_amount || 0));
  const net           = gross - fee;
  const paypalBank    = await getPaypalAccount(meta, tx);
  const paypalFees    = await getAccountId('paypal_fees', tx);
  const incomeAccount = meta.income_account_id
    ? { id: meta.income_account_id, name: meta.income_account_name || 'Income' }
    : await getAccountId('paypal_sales', tx);
  const custOpts = metaOptions(meta, 'Customer');

  const jeLines = [
    line('Debit',  incomeAccount, gross, `Refund issued: ${meta.memo || tx.description || ''}`, custOpts),
    line('Credit', paypalBank,    net,   'PayPal Balance refunded'),
  ];
  if (fee > 0) jeLines.splice(1, 0, line('Credit', paypalFees, fee, 'Fee returned on refund'));
  return buildJE(jeLines, tx, meta, '-RF');
}

// ── Router ─────────────────────────────────────────────────────────────────

async function buildQBOPayload(tx) {
  const category = tx.override_category || tx.category;
  switch (category) {
    // ── SalesReceipt (income) ─────────────────────────────────────────────
    case 'sale':              return buildSale(tx);
    case 'subscription':      return buildSale(tx);
    case 'donation_received': return buildSale(tx);

    // ── Purchase / Expense ────────────────────────────────────────────────
    case 'paypal_fee':             return buildPaypalFee(tx);
    case 'international_fee':      return buildPaypalFee(tx);
    case 'purchase':               return buildPayout(tx);
    case 'payout':                 return buildPayout(tx);
    case 'paypal_credit_purchase': return buildCreditPurchase(tx);

    // ── Transfer ──────────────────────────────────────────────────────────
    case 'paypal_credit_repayment': return buildCreditRepayment(tx);
    case 'bank_transfer_in':        return buildBankTransferIn(tx);
    case 'bank_transfer_out':       return buildBankTransferOut(tx);

    // ── RefundReceipt ─────────────────────────────────────────────────────
    case 'refund':     return buildRefund(tx);
    case 'chargeback': return buildRefund(tx);

    // ── JournalEntry (no cleaner native object) ───────────────────────────
    case 'adjustment':          return buildAdjustment(tx);
    case 'currency_conversion': return buildCurrencyConversion(tx);

    default:
      throw new Error(`Cannot sync category "${category}" — classify or approve the transaction first.`);
  }
}

// ── Bank match linker ──────────────────────────────────────────────────────

async function linkBankMatch(tx, bankMatch) {
  const { qbo_id, qbo_type } = bankMatch;
  const meta = parseMeta(tx);

  if (!qbo_id || !qbo_type) throw new Error('Bank match is missing qbo_id or qbo_type.');

  const existing = await qbo.getObject(qbo_type, qbo_id);
  if (!existing) {
    throw new Error(
      `Matched QBO ${qbo_type} #${qbo_id} was not found — it may have been deleted in QBO. ` +
      `Re-open this transaction, clear the bank match, and save again.`
    );
  }

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
  if (tx.status === 'synced')   throw new Error('Transaction already synced to QBO.');
  if (tx.status !== 'approved') throw new Error('Transaction must be approved before syncing.');

  const built = await buildQBOPayload(tx);

  const isBankMatchLink = built.type === 'BankMatchLink';
  const isSaleWithFee   = built.type === 'SaleWithFee';   // SalesReceipt + Purchase
  const isSplitSale     = built.type === 'SplitSale';     // legacy: JE + JE
  const logAction       = isBankMatchLink ? 'link' : 'create';

  let qboId, qboSyncToken, qboObjectType, qboObject;
  let feeQboId, feeQboSyncToken, feeQboObjectType;

  try {
    if (isBankMatchLink) {
      // ── Link existing QBO object ─────────────────────────────────────────
      const result = await linkBankMatch(tx, built.bankMatch);
      qboId         = result.qboId;
      qboSyncToken  = result.qboSyncToken;
      qboObjectType = result.qboObjectType;
      qboObject     = result.qboObject;

    } else if (isSaleWithFee) {
      // ── SalesReceipt (primary) + Purchase fee ────────────────────────────
      qboObjectType = 'SalesReceipt';
      qboObject     = await qbo.createSalesReceipt(built.primary.payload);
      qboId         = qboObject.Id;
      qboSyncToken  = qboObject.SyncToken;

      const feeObj  = await qbo.createPurchase(built.fee.payload);
      feeQboId         = feeObj.Id;
      feeQboSyncToken  = feeObj.SyncToken;
      feeQboObjectType = 'Purchase';

    } else if (isSplitSale) {
      // ── Legacy: two JournalEntries ───────────────────────────────────────
      qboObjectType = 'JournalEntry';
      qboObject     = await qbo.createJournalEntry(built.primary.payload);
      qboId         = qboObject.Id;
      qboSyncToken  = qboObject.SyncToken;

      const feeObj  = await qbo.createJournalEntry(built.fee.payload);
      feeQboId         = feeObj.Id;
      feeQboSyncToken  = feeObj.SyncToken;
      feeQboObjectType = 'JournalEntry';

    } else {
      // ── Standard single-object path ──────────────────────────────────────
      const { type, payload } = built;
      qboObjectType = type;
      switch (type) {
        case 'JournalEntry':  qboObject = await qbo.createJournalEntry(payload);  break;
        case 'Transfer':      qboObject = await qbo.createTransfer(payload);       break;
        case 'Purchase':      qboObject = await qbo.createPurchase(payload);       break;
        case 'SalesReceipt':  qboObject = await qbo.createSalesReceipt(payload);  break;
        case 'RefundReceipt': qboObject = await qbo.createRefundReceipt(payload);  break;
        default: throw new Error(`Unknown QBO object type: ${type}`);
      }
      qboId        = qboObject.Id;
      qboSyncToken = qboObject.SyncToken;
    }
  } catch (err) {
    // Determine the primary type name for the log
    const failType = isBankMatchLink  ? built.bankMatch?.qbo_type
                   : isSaleWithFee    ? 'SalesReceipt'
                   : isSplitSale      ? 'JournalEntry'
                   : built.type;

    await db('qbo_sync_logs').insert({
      transaction_id:        tx.id,
      paypal_transaction_id: tx.paypal_transaction_id,
      action:                logAction,
      qbo_object_type:       failType,
      qbo_object_id:         isBankMatchLink ? built.bankMatch?.qbo_id : null,
      status:                'failed',
      request_payload:       JSON.stringify(
        isBankMatchLink             ? built.bankMatch :
        isSaleWithFee || isSplitSale ? { primary: built.primary.payload, fee: built.fee.payload } :
        built.payload
      ),
      error_message: err.message,
      performed_by:  userId,
      created_at:    new Date(), updated_at: new Date(),
    });
    await db('normalized_transactions').where({ id: tx.id }).update({
      status:     'failed',
      sync_error: err.message,
      updated_at: new Date(),
    });
    throw err;
  }

  // Persist fee object IDs + type so rollback can delete both entries.
  const currentMeta = parseMeta(tx);
  const updatedMeta = feeQboId
    ? { ...currentMeta, fee_qbo_id: feeQboId, fee_qbo_sync_token: feeQboSyncToken, fee_qbo_type: feeQboObjectType }
    : currentMeta;

  await db('normalized_transactions').where({ id: tx.id }).update({
    status:          'synced',
    qbo_object_id:   qboId,
    qbo_object_type: qboObjectType,
    qbo_sync_token:  qboSyncToken,
    qbo_metadata:    JSON.stringify(updatedMeta),
    sync_error:      null,
    updated_at:      new Date(),
  });

  // Build log payload
  const logPayload = isBankMatchLink              ? built.bankMatch
                   : (isSaleWithFee || isSplitSale) ? { primary: built.primary.payload, fee: built.fee.payload }
                   : built.payload;

  const logResponse = (isSaleWithFee || isSplitSale)
    ? { primary: qboObject, fee: { Id: feeQboId, SyncToken: feeQboSyncToken } }
    : qboObject;

  await db('qbo_sync_logs').insert({
    transaction_id:        tx.id,
    paypal_transaction_id: tx.paypal_transaction_id,
    action:                logAction,
    qbo_object_type:       qboObjectType,
    qbo_object_id:         qboId,
    status:                'success',
    request_payload:       JSON.stringify(logPayload),
    response_payload:      JSON.stringify(logResponse),
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
      : isSaleWithFee
        ? `Synced to QBO as SalesReceipt #${qboId} + Purchase #${feeQboId} (fee)`
        : isSplitSale
          ? `Synced to QBO as JournalEntry #${qboId} + JournalEntry #${feeQboId} (fee)`
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

  // Bank match link — don't delete the QBO object; it predates our sync.
  const isBankMatchLink = !!(
    meta.bank_match?.qbo_id &&
    meta.bank_match.qbo_id === tx.qbo_object_id
  );

  // Compound sync: fee object stored in metadata.
  // fee_qbo_type tells us whether it's a Purchase (SaleWithFee) or JE (SplitSale).
  const hasFeeObject   = !isBankMatchLink && !!meta.fee_qbo_id;
  const feeObjectType  = meta.fee_qbo_type || 'JournalEntry'; // default to JE for legacy SplitSale

  const rollbackAction = isBankMatchLink ? 'unlink' : 'delete';

  if (!isBankMatchLink) {
    try {
      // Delete companion fee object first (created second, safer to remove first).
      if (hasFeeObject) {
        // Re-fetch live SyncToken — may have changed if QBO modified the entry.
        let feeSyncToken = meta.fee_qbo_sync_token;
        try {
          const feeObj = await qbo.getObject(feeObjectType, meta.fee_qbo_id);
          if (feeObj?.SyncToken) feeSyncToken = feeObj.SyncToken;
        } catch {
          logger.warn(`Rollback: could not fetch ${feeObjectType} #${meta.fee_qbo_id} — using stored SyncToken`);
        }
        await qbo.deleteObject(feeObjectType, meta.fee_qbo_id, feeSyncToken);
      }

      // Delete the primary QBO object.
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

  // Clear fee IDs and sync state from metadata.
  const cleanedMeta = { ...meta };
  delete cleanedMeta.fee_qbo_id;
  delete cleanedMeta.fee_qbo_sync_token;
  delete cleanedMeta.fee_qbo_type;

  await db('normalized_transactions').where({ id: tx.id }).update({
    status:          'approved',
    qbo_object_id:   null,
    qbo_object_type: null,
    qbo_sync_token:  null,
    qbo_metadata:    JSON.stringify(cleanedMeta),
    sync_error:      null,
    updated_at:      new Date(),
  });

  await db('audit_logs').insert({
    user_id:     userId,
    action:      'rollback',
    entity_type: 'transaction',
    entity_id:   String(tx.id),
    details:     isBankMatchLink
      ? `Unlinked from QBO ${tx.qbo_object_type} #${tx.qbo_object_id} (QBO object preserved)`
      : hasFeeObject
        ? `Rolled back QBO ${tx.qbo_object_type} #${tx.qbo_object_id} + ${feeObjectType} #${meta.fee_qbo_id} (fee)`
        : `Rolled back QBO ${tx.qbo_object_type} #${tx.qbo_object_id}`,
    created_at:  new Date(), updated_at: new Date(),
  });
}

module.exports = { syncTransaction, rollbackTransaction, buildQBOPayload };
