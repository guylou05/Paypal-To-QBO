/**
 * Context-sensitive transaction edit modal.
 *
 * Layout (mirrors competitor card-per-section pattern):
 *   1. Transaction summary card  — PayPal-branded header
 *   2. Classification card       — Type + Category override (FIRST so direction updates live)
 *   3. Entity card               — Billed To / Vendor (direction-aware)
 *   4. Clearing Account card     — PayPal bank/asset account in QBO (auto-suggested)
 *   5. Income / Expense Account  — category account (direction-aware, filtered by type)
 *   6. Bank Account              — destination for transfers/payouts
 *   7. Class + Memo              — optional QBO class tracking and memo
 *   8. Accounting Preview        — live QBO object preview (SalesReceipt / Expense / Transfer / RefundReceipt / JE)
 *   9. Status + Notes            — reviewer controls
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { txApi, qboApi } from '../api/client';
import { buildQboUrl } from '../utils/qboUrl';

// ── Constants ──────────────────────────────────────────────────────────────

const TRANSACTION_TYPES = [
  'Payment', 'Invoice', 'Transfer', 'Refund', 'Purchase', 'Bank Payout', 'Other',
];

const INCOME_ACC_TYPES   = ['Income', 'Other Income'];
const EXPENSE_ACC_TYPES  = ['Expense', 'Cost of Goods Sold', 'Other Expense'];
const CLEARING_ACC_TYPES = ['Bank', 'Other Current Asset'];
const BANK_ACC_TYPES     = ['Bank'];

// Categories grouped by direction — only relevant options shown per context.
const CATEGORY_OPTIONS = {
  income: [
    { value: 'sale',              label: 'Sale / Payment Received' },
    { value: 'subscription',      label: 'Subscription / Recurring Payment' },
    { value: 'donation_received', label: 'Donation Received' },
    { value: 'refund',            label: 'Refund Received (from vendor)' },
    { value: 'chargeback',        label: 'Chargeback Won (funds returned)' },
    { value: 'adjustment',        label: 'Account Adjustment / Credit' },
    { value: 'currency_conversion', label: 'Currency Conversion Gain' },
    { value: 'unknown',           label: 'Unknown — needs review' },
  ],
  expense: [
    { value: 'purchase',                label: 'Purchase / Expense Payment' },
    { value: 'paypal_fee',              label: 'PayPal Processing Fee' },
    { value: 'international_fee',       label: 'International / Cross-border Fee' },
    { value: 'payout',                  label: 'Payout / Mass Payment Sent' },
    { value: 'paypal_credit_purchase',  label: 'PayPal Credit Purchase' },
    { value: 'refund',                  label: 'Refund Issued to Customer' },
    { value: 'chargeback',              label: 'Chargeback Lost (funds deducted)' },
    { value: 'adjustment',              label: 'Account Adjustment / Debit' },
    { value: 'currency_conversion',     label: 'Currency Conversion Loss' },
    { value: 'noise',                   label: 'Non-business / Ignore' },
    { value: 'unknown',                 label: 'Unknown — needs review' },
  ],
  transfer: [
    { value: 'bank_transfer_in',        label: 'Bank → PayPal (Funding)' },
    { value: 'bank_transfer_out',       label: 'PayPal → Bank (Withdrawal)' },
    { value: 'paypal_credit_repayment', label: 'PayPal Credit Repayment' },
  ],
};

// Human-readable status labels for the status dropdown.
const EDITABLE_STATUSES = ['classified', 'needs_review', 'approved', 'ignored'];

// ── Direction logic ────────────────────────────────────────────────────────
//
// Accepts the *current modal state* (not the raw tx) so that changing
// Transaction Type in the modal immediately re-draws the QBO section.

function getDirection(txType, overrideCategory, txCategory, gross) {
  const cat   = overrideCategory || txCategory || '';
  const type  = txType || '';
  const g     = parseFloat(gross || 0);

  // Transfers always win
  if (['bank_transfer_in', 'bank_transfer_out', 'paypal_credit_repayment'].includes(cat)) return 'transfer';
  if (type === 'Transfer' || type === 'Bank Payout') return 'transfer';

  // Transaction type wins for well-known income types with positive gross.
  // Prevents a mis-classified category (e.g. 'purchase') from flipping a real
  // customer Payment or Invoice into the expense direction.
  if ((type === 'Payment' || type === 'Invoice') && g >= 0) return 'income';

  // Category-based direction (for all other type/category combos)
  if (['paypal_fee', 'international_fee', 'payout', 'purchase', 'paypal_credit_purchase'].includes(cat)) return 'expense';
  if (type === 'Purchase') return 'expense';

  if (['sale', 'subscription', 'donation_received'].includes(cat)) return 'income';
  if (type === 'Payment' || type === 'Invoice') return 'income';  // covers negative gross edge-case

  // Direction depends on gross sign for these bi-directional categories
  if (['refund', 'chargeback', 'adjustment', 'currency_conversion'].includes(cat)) {
    return g >= 0 ? 'income' : 'expense';
  }
  if (type === 'Refund') return g >= 0 ? 'income' : 'expense';

  // Default: sign-based
  return g >= 0 ? 'income' : 'expense';
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(parseFloat(n));
}

function fuzzyMatch(a, b) {
  if (!a || !b) return false;
  const h = a.toLowerCase(), n = b.toLowerCase();
  return h.includes(n) || n.includes(h);
}

function sortByName(arr, getName) {
  return [...arr].sort((a, b) => (getName(a) || '').localeCompare(getName(b) || ''));
}

// ── SearchSelect ───────────────────────────────────────────────────────────

/**
 * SearchSelect — filterable select with optional inline "Create in QBO" button.
 *
 * Extra props vs. plain select:
 *   onCreateNew(name) — called when user clicks "Create in QBO"; receives the
 *                       current filter text as the proposed display name.
 *   creating          — shows a spinner on the create button while the API call
 *                       is in flight (set by the parent).
 *   createLabel       — button text prefix, defaults to "Create".
 */
function SearchSelect({
  items, value, onChange, emptyLabel, placeholder,
  getKey, getLabel, loading, disabled,
  onCreateNew, creating, createLabel,
}) {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    if (!filter) return items;
    const f = filter.toLowerCase();
    return items.filter(i => getLabel(i).toLowerCase().includes(f));
  }, [items, filter, getLabel]);

  const showCreate = onCreateNew && filter.trim().length > 1 && filtered.length === 0 && !loading;

  return (
    <div className="space-y-1">
      <input
        className="input text-xs py-1.5"
        placeholder={loading ? 'Loading…' : (placeholder || 'Type to filter…')}
        value={filter}
        disabled={loading || disabled}
        onChange={e => setFilter(e.target.value)}
      />
      <select
        className="input"
        value={value}
        disabled={loading || disabled}
        onChange={e => onChange(e.target.value)}
      >
        <option value="">{emptyLabel || '— None —'}</option>
        {filtered.map(item => (
          <option key={getKey(item)} value={getKey(item)}>
            {getLabel(item)}
          </option>
        ))}
      </select>
      {showCreate && (
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors mt-0.5"
          disabled={creating || disabled}
          onClick={() => onCreateNew(filter.trim())}
        >
          {creating
            ? <span className="animate-spin inline-block w-3 h-3 border border-blue-500 border-t-transparent rounded-full" />
            : <span>＋</span>
          }
          {creating ? 'Creating…' : `${createLabel || 'Create'} "${filter.trim()}" in QBO`}
        </button>
      )}
    </div>
  );
}

// ── Section card ───────────────────────────────────────────────────────────

function SectionCard({ icon, title, children, accent }) {
  const border = accent ? `border-l-2 ${accent}` : '';
  return (
    <div className={`bg-gray-800/40 border border-gray-700/60 rounded-xl overflow-hidden ${border}`}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700/60">
        <span className="text-base">{icon}</span>
        <h4 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">{title}</h4>
      </div>
      <div className="px-4 py-4">
        {children}
      </div>
    </div>
  );
}

// ── Direction badge ────────────────────────────────────────────────────────

function DirectionBadge({ direction }) {
  const cfg = {
    income:   { label: '💰 Income',   cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700' },
    expense:  { label: '💸 Expense',  cls: 'bg-rose-900/50 text-rose-300 border-rose-700'          },
    transfer: { label: '↔ Transfer', cls: 'bg-violet-900/50 text-violet-300 border-violet-700'    },
  };
  const { label, cls } = cfg[direction] || cfg.income;
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border ${cls}`}>
      {label}
    </span>
  );
}

// ── Accounting Preview ─────────────────────────────────────────────────────

// Pill badge for QBO object type label in the preview
function QboTypePill({ label, color }) {
  const colors = {
    green:  'text-emerald-300 bg-emerald-900/30 border-emerald-700/40',
    red:    'text-rose-300    bg-rose-900/30    border-rose-700/40',
    amber:  'text-amber-300   bg-amber-900/30   border-amber-700/40',
    violet: 'text-violet-300  bg-violet-900/30  border-violet-700/40',
    gray:   'text-gray-400    bg-gray-800/60    border-gray-600/40',
  };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${colors[color] || colors.gray}`}>
      {label}
    </span>
  );
}

// Compact key-value table used inside each object block
function PreviewRow({ label, value, valueClass, mono }) {
  return (
    <div className="flex justify-between items-baseline gap-2">
      <span className="text-gray-500 shrink-0">{label}</span>
      <span className={`text-right truncate max-w-[60%] ${mono ? 'font-mono' : ''} ${valueClass || 'text-gray-300'}`}>
        {value}
      </span>
    </div>
  );
}

// Small "Open in QBO" link shown on each object block when the tx is synced
function QboLink({ objectType, objectId, environment }) {
  if (!objectType || !objectId) return null;
  const url = buildQboUrl(objectType, objectId, environment);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 text-[10px] text-emerald-400 hover:text-emerald-300 underline underline-offset-2 transition-colors shrink-0"
      onClick={e => e.stopPropagation()}
    >
      ↗ Open in QBO
    </a>
  );
}

// Block header row: pill + subtitle on the left, optional QBO link on the right
function BlockHeader({ pill, pillColor, subtitle, qboType, qboId, environment, isSynced }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-2">
      <div className="flex items-center gap-2 min-w-0">
        <QboTypePill label={pill} color={pillColor} />
        {subtitle && <span className="text-[10px] text-gray-500 truncate">{subtitle}</span>}
      </div>
      {isSynced && <QboLink objectType={qboType} objectId={qboId} environment={environment} />}
    </div>
  );
}

function AccountingPreview({ direction, tx, meta,
  isSynced, qboEnvironment,
  primaryQboId, primaryQboType,
  feeQboId, feeQboType }) {

  const gross = Math.abs(parseFloat(tx.gross_amount || 0));
  const fee   = Math.abs(parseFloat(tx.fee_amount   || 0));

  const paypalAccLabel    = meta.paypal_account_name  || 'PayPal Bank (mapped)';
  const paypalCreditLabel = 'PayPal Credit (mapped)';
  const bankAccLabel      = meta.bank_account_name    || 'Bank Account (mapped)';
  const feeAccLabel       = 'PayPal Fees (mapped)';
  const expenseLabel      = meta.expense_account_name || 'Expense Account (mapped)';
  const salesItemLabel    = 'PayPal Sales Item (mapped)';
  const customerLabel     = meta.customer_name || 'PayPal Customer (default)';

  const cat = (tx.override_category || tx.category || '').toLowerCase();

  // ── Transfer ─────────────────────────────────────────────────────────────
  if (direction === 'transfer') {
    if (cat === 'paypal_credit_repayment') {
      return (
        <div className="space-y-2">
          <BlockHeader
            pill="Transfer" pillColor="violet"
            subtitle="Liability reduction — no P&L impact"
            qboType={primaryQboType} qboId={primaryQboId}
            environment={qboEnvironment} isSynced={isSynced}
          />
          <div className="bg-gray-800/50 rounded-lg p-3 space-y-1.5 text-xs">
            <PreviewRow label="Amount"   value={fmt(gross)}         valueClass="text-gray-200" mono />
            <PreviewRow label="From"     value={paypalAccLabel} />
            <PreviewRow label="To"       value={paypalCreditLabel}  valueClass="text-amber-300" />
          </div>
          <p className="text-[10px] text-gray-600 pt-1 border-t border-gray-800">
            Reduces PayPal Credit balance — never affects P&amp;L.
          </p>
        </div>
      );
    }

    const isIn = cat === 'bank_transfer_in';
    return (
      <div className="space-y-2">
        <BlockHeader
          pill="Transfer" pillColor="violet"
          subtitle="No P&L impact"
          qboType={primaryQboType} qboId={primaryQboId}
          environment={qboEnvironment} isSynced={isSynced}
        />
        <div className="bg-gray-800/50 rounded-lg p-3 space-y-1.5 text-xs">
          <PreviewRow label="Amount" value={fmt(gross)} valueClass="text-gray-200" mono />
          <PreviewRow label="From"   value={isIn ? bankAccLabel : paypalAccLabel} />
          <PreviewRow label="To"     value={isIn ? paypalAccLabel : bankAccLabel} />
        </div>
        <p className="text-[10px] text-gray-600 pt-1 border-t border-gray-800">
          Posted as a QBO Transfer between the two accounts.
        </p>
      </div>
    );
  }

  // ── Income ────────────────────────────────────────────────────────────────
  if (direction === 'income') {
    // Refund received / chargeback won → vendor credit → JournalEntry
    if (cat === 'refund' || cat === 'chargeback') {
      const net = gross - fee;
      return (
        <div className="space-y-2">
          <BlockHeader
            pill="Journal Entry" pillColor="gray"
            subtitle="Vendor credit / chargeback recovery"
            qboType={primaryQboType} qboId={primaryQboId}
            environment={qboEnvironment} isSynced={isSynced}
          />
          <table className="w-full text-xs">
            <thead><tr className="border-b border-gray-700/50">
              <th className="pb-1 text-left text-gray-600 w-10">DR/CR</th>
              <th className="pb-1 text-left text-gray-600">Account</th>
              <th className="pb-1 text-right text-gray-600 w-24">Amount</th>
            </tr></thead>
            <tbody>
              <tr className="border-b border-gray-800/40">
                <td className="py-1 font-mono font-bold text-sm text-blue-400">DR</td>
                <td className="py-1 pl-2 text-gray-300">{paypalAccLabel}</td>
                <td className="py-1 text-right font-mono text-gray-300">{fmt(fee > 0 ? net : gross)}</td>
              </tr>
              {fee > 0 && (
                <tr className="border-b border-gray-800/40">
                  <td className="py-1 font-mono font-bold text-sm text-blue-400">DR</td>
                  <td className="py-1 pl-2 text-gray-300">{feeAccLabel}</td>
                  <td className="py-1 text-right font-mono text-gray-300">{fmt(fee)}</td>
                </tr>
              )}
              <tr>
                <td className="py-1 font-mono font-bold text-sm text-emerald-400">CR</td>
                <td className="py-1 pl-2 text-gray-300">{expenseLabel}</td>
                <td className="py-1 text-right font-mono text-gray-300">{fmt(gross)}</td>
              </tr>
            </tbody>
          </table>
          <p className="text-[10px] text-gray-600 pt-1 border-t border-gray-800">
            Credit applied to expense account — JournalEntry (no SalesReceipt for vendor credits).
          </p>
        </div>
      );
    }

    // Standard sale / subscription / donation → SalesReceipt + companion Expense for fee
    return (
      <div className="space-y-3">
        {/* ① SalesReceipt */}
        <div>
          <BlockHeader
            pill="Sales Receipt" pillColor="green"
            subtitle={`Customer: ${customerLabel}`}
            qboType={primaryQboType} qboId={primaryQboId}
            environment={qboEnvironment} isSynced={isSynced}
          />
          <div className="bg-gray-800/50 rounded-lg p-3 space-y-1.5 text-xs">
            <PreviewRow label="Item (income)"   value={salesItemLabel} />
            <PreviewRow label="Gross amount"    value={fmt(gross)}     valueClass="text-emerald-300" mono />
            <PreviewRow label="Deposit to"      value={paypalAccLabel} />
          </div>
        </div>

        {/* ② Companion Expense for fee (auto-created by syncer) */}
        {fee > 0 && (
          <div>
            <BlockHeader
              pill="Expense" pillColor="red"
              subtitle="PayPal processing fee (auto-created)"
              qboType={feeQboType} qboId={feeQboId}
              environment={qboEnvironment} isSynced={isSynced}
            />
            <div className="bg-gray-800/50 rounded-lg p-3 space-y-1.5 text-xs">
              <PreviewRow label="Payment from" value={paypalAccLabel} />
              <PreviewRow label="Category"     value={feeAccLabel} />
              <PreviewRow label="Amount"       value={fmt(fee)}    valueClass="text-rose-300" mono />
            </div>
          </div>
        )}

        <p className="text-[10px] text-gray-600 pt-1 border-t border-gray-800">
          {fee > 0
            ? `Two QBO objects on sync: SalesReceipt (${fmt(gross)} gross revenue) + Expense (${fmt(fee)} fee).`
            : 'Posted as a QBO SalesReceipt.'}
        </p>
      </div>
    );
  }

  // ── Expense ───────────────────────────────────────────────────────────────
  if (direction === 'expense') {
    // Refund issued / chargeback lost → RefundReceipt
    if (cat === 'refund' || cat === 'chargeback') {
      return (
        <div className="space-y-2">
          <BlockHeader
            pill="Refund Receipt" pillColor="amber"
            subtitle={`Customer: ${customerLabel}`}
            qboType={primaryQboType} qboId={primaryQboId}
            environment={qboEnvironment} isSynced={isSynced}
          />
          <div className="bg-gray-800/50 rounded-lg p-3 space-y-1.5 text-xs">
            <PreviewRow label="Item"        value={salesItemLabel} />
            <PreviewRow label="Amount"      value={fmt(gross)}     valueClass="text-amber-300" mono />
            <PreviewRow label="Refund from" value={paypalAccLabel} />
          </div>
          <p className="text-[10px] text-gray-600 pt-1 border-t border-gray-800">
            Posted as a QBO Refund Receipt — reverses revenue.
          </p>
        </div>
      );
    }

    // PayPal Credit purchase → Expense paid from PayPal Credit (NOT PayPal Bank)
    const isCreditPurchase = cat === 'paypal_credit_purchase';
    const paymentSource    = isCreditPurchase ? paypalCreditLabel : paypalAccLabel;

    return (
      <div className="space-y-2">
        <BlockHeader
          pill="Expense" pillColor="red"
          subtitle={isCreditPurchase ? '⚠ Paid via PayPal Credit' : undefined}
          qboType={primaryQboType} qboId={primaryQboId}
          environment={qboEnvironment} isSynced={isSynced}
        />
        <div className="bg-gray-800/50 rounded-lg p-3 space-y-1.5 text-xs">
          <PreviewRow
            label="Payment from"
            value={paymentSource}
            valueClass={isCreditPurchase ? 'text-amber-300' : 'text-gray-300'}
          />
          <PreviewRow label="Category" value={expenseLabel} />
          <PreviewRow label="Amount"   value={fmt(gross)}   valueClass="text-rose-300" mono />
          {meta.vendor_name && <PreviewRow label="Vendor" value={meta.vendor_name} />}
        </div>
        <p className="text-[10px] text-gray-600 pt-1 border-t border-gray-800">
          {isCreditPurchase
            ? 'Expense against PayPal Credit liability — PayPal Bank is NOT affected.'
            : 'Posted as a QBO Expense paid from PayPal Bank.'}
        </p>
      </div>
    );
  }

  return null;
}

// ── Matched entity chip ────────────────────────────────────────────────────

/**
 * Shows how the customer was matched:
 *   source='memory'     → emerald (high confidence — previous reviewer confirmed it)
 *   source='name_fuzzy' → amber (lower confidence — inferred from payer name)
 *   source=null         → just name in gray (manual selection, no auto-match label)
 */
function MatchChip({ name, source, matchCount }) {
  if (!name) return null;

  if (source === 'memory') {
    return (
      <p className="text-xs mt-1.5 flex items-center gap-1.5 text-emerald-400">
        <span>✦</span>
        <span>Auto-matched from memory</span>
        {matchCount > 1 && <span className="text-emerald-600">({matchCount} prior uses)</span>}
      </p>
    );
  }
  if (source === 'name_fuzzy') {
    return (
      <p className="text-xs mt-1.5 flex items-center gap-1.5 text-amber-400">
        <span>⟳</span>
        <span>Suggested from payer name</span>
      </p>
    );
  }
  return (
    <p className="text-xs text-emerald-400 mt-1.5 flex items-center gap-1">
      <span className="text-emerald-500">✓</span> {name}
    </p>
  );
}

// ── Main modal ─────────────────────────────────────────────────────────────

export default function EditModal({ tx, isSandbox, qboData, qboLoading, qboEnvironment, onClose, onSave, onRollback }) {
  const existingMeta = tx.qbo_metadata || {};
  const isSynced     = tx.status === 'synced';

  // ── Classification state (drives direction) ──────────────────────────────
  const [txType,   setTxType]   = useState(tx.transaction_type || 'Other');
  const [category, setCategory] = useState(tx.override_category || tx.category || '');

  // Reactive direction — recomputed whenever type or category changes in UI
  const direction = getDirection(txType, category, tx.category, tx.gross_amount);

  // When the user changes the Transaction Type, reset category if it no
  // longer belongs to the new direction's allowed list.
  useEffect(() => {
    const allowed = (CATEGORY_OPTIONS[direction] || []).map(o => o.value);
    if (category && !allowed.includes(category)) setCategory('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txType]);

  // ── Entity state ─────────────────────────────────────────────────────────
  const [customerId,   setCustomerId]   = useState(existingMeta.customer_id   || '');
  const [customerName, setCustomerName] = useState(existingMeta.customer_name || '');
  const [vendorId,     setVendorId]     = useState(existingMeta.vendor_id     || '');
  const [vendorName,   setVendorName]   = useState(existingMeta.vendor_name   || '');

  // ── Customer auto-match memory ────────────────────────────────────────────
  // source: 'memory' (from payer_customer_matches DB) | 'name_fuzzy' | null
  const [autoMatch,    setAutoMatch]    = useState(null); // { source, matchCount }

  // ── Vendor / customer auto-create ─────────────────────────────────────────
  const [vendorCreating,   setVendorCreating]   = useState(false);
  const [customerCreating, setCustomerCreating] = useState(false);
  // Local extension lists — new entities created this session are appended here
  // so they appear immediately without a full QBO data reload.
  const [extraVendors,   setExtraVendors]   = useState([]);
  const [extraCustomers, setExtraCustomers] = useState([]);

  // ── Account state ─────────────────────────────────────────────────────────
  const [paypalAccountId,   setPaypalAccountId]   = useState(existingMeta.paypal_account_id   || '');
  const [paypalAccountName, setPaypalAccountName] = useState(existingMeta.paypal_account_name || '');
  const [incomeAccountId,   setIncomeAccountId]   = useState(existingMeta.income_account_id   || '');
  const [incomeAccountName, setIncomeAccountName] = useState(existingMeta.income_account_name || '');
  const [expenseAccountId,  setExpenseAccountId]  = useState(existingMeta.expense_account_id  || '');
  const [expenseAccountName,setExpenseAccountName]= useState(existingMeta.expense_account_name|| '');
  const [bankAccountId,     setBankAccountId]     = useState(existingMeta.bank_account_id     || '');
  const [bankAccountName,   setBankAccountName]   = useState(existingMeta.bank_account_name   || '');

  // ── Class / memo / status ─────────────────────────────────────────────────
  const [classId,    setClassId]    = useState(existingMeta.class_id   || '');
  const [className,  setClassName]  = useState(existingMeta.class_name || '');
  const [qboMemo,    setQboMemo]    = useState(existingMeta.memo || tx.description || '');
  const [notes,      setNotes]      = useState(tx.reviewer_notes || '');
  const [status,     setStatus]     = useState(tx.status);
  const [saving,     setSaving]     = useState(false);

  // ── Bank transfer matching ─────────────────────────────────────────────────
  const [bankMatches,      setBankMatches]      = useState(null);   // null = not yet fetched
  const [bankMatchLoading, setBankMatchLoading] = useState(false);
  const [bankMatchError,   setBankMatchError]   = useState('');
  const [bankMatchShowAll, setBankMatchShowAll] = useState(false);
  // Approved match — pulled from existing meta on mount, updated when user picks
  const [approvedMatch,    setApprovedMatch]    = useState(existingMeta.bank_match || null);

  const hasFee = parseFloat(tx.fee_amount || 0) > 0;

  // ── Filtered account lists ────────────────────────────────────────────────
  const clearingAccounts = useMemo(() =>
    sortByName((qboData?.accounts || []).filter(a => CLEARING_ACC_TYPES.includes(a.AccountType)),
      a => a.FullyQualifiedName || a.Name),
    [qboData]);

  const bankAccounts = useMemo(() =>
    sortByName((qboData?.accounts || []).filter(a => BANK_ACC_TYPES.includes(a.AccountType)),
      a => a.FullyQualifiedName || a.Name),
    [qboData]);

  const incomeAccounts = useMemo(() =>
    sortByName((qboData?.accounts || []).filter(a => INCOME_ACC_TYPES.includes(a.AccountType)),
      a => a.FullyQualifiedName || a.Name),
    [qboData]);

  const expenseAccounts = useMemo(() =>
    sortByName((qboData?.accounts || []).filter(a => EXPENSE_ACC_TYPES.includes(a.AccountType)),
      a => a.FullyQualifiedName || a.Name),
    [qboData]);

  const customers = useMemo(() =>
    sortByName([...(qboData?.customers || []), ...extraCustomers], c => c.DisplayName),
    [qboData, extraCustomers]);

  const vendors = useMemo(() =>
    sortByName([...(qboData?.vendors || []), ...extraVendors], v => v.DisplayName),
    [qboData, extraVendors]);

  const classes = useMemo(() =>
    sortByName(qboData?.classes || [], c => c.FullyQualifiedName || c.Name), [qboData]);

  // ── Auto-fetch bank matches when direction is 'transfer' ─────────────────
  // transferDir is null when not a transfer — effect re-runs whenever it
  // changes (e.g. bank_transfer_in ↔ bank_transfer_out), triggering a fresh search.
  const transferDir = useMemo(() => {
    if (direction !== 'transfer') return null;
    const cat = category || tx.category || '';
    return cat === 'bank_transfer_in' ? 'in' : 'out';
  }, [direction, category]);

  useEffect(() => {
    if (!transferDir || isSynced) return;
    let cancelled = false;
    setBankMatches(null);
    setBankMatchError('');
    setBankMatchLoading(true);
    qboApi.bankMatches({
      date:      tx.transaction_date,
      amount:    Math.abs(parseFloat(tx.gross_amount || 0)),
      direction: transferDir,
    })
      .then(r   => { if (!cancelled) setBankMatches(r.data.matches || []); })
      .catch(err => { if (!cancelled) setBankMatchError(err.response?.data?.error || 'Failed to load bank matches'); })
      .finally(() => { if (!cancelled) setBankMatchLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferDir]);

  // ── Auto-suggestions on QBO data load ────────────────────────────────────
  useEffect(() => {
    if (!qboData) return;

    // Auto-suggest PayPal clearing account (first account with "paypal" in name)
    if (!paypalAccountId && clearingAccounts.length) {
      const match = clearingAccounts.find(a =>
        (a.Name || '').toLowerCase().includes('paypal') ||
        (a.FullyQualifiedName || '').toLowerCase().includes('paypal'));
      if (match) { setPaypalAccountId(match.Id); setPaypalAccountName(match.Name || match.FullyQualifiedName); }
    }

    // Customer/vendor suggestion (only when not already set from saved metadata)
    if (!existingMeta.customer_id && !existingMeta.vendor_id) {
      const payer = tx.payer_name || tx.payer_email || '';

      if (direction === 'income' && customers.length) {
        // 1. Memory lookup (async, highest priority — fires separately below)
        // 2. Fuzzy name match as fallback (sync, lower confidence)
        if (payer && !customerId) {
          const m = customers.find(c => fuzzyMatch(c.DisplayName, payer));
          if (m) {
            setCustomerId(m.Id);
            setCustomerName(m.DisplayName);
            setAutoMatch(prev => prev?.source === 'memory' ? prev : { source: 'name_fuzzy', matchCount: 0 });
          }
        }
      }

      if (direction === 'expense' && vendors.length && payer) {
        const m = vendors.find(v => fuzzyMatch(v.DisplayName, payer));
        if (m) { setVendorId(m.Id); setVendorName(m.DisplayName); }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qboData]);

  // ── Memory-based customer match (fires once after customers list is ready) ──
  useEffect(() => {
    // Only relevant for income-direction transactions not already customer-tagged
    if (existingMeta.customer_id) return;
    if (!customers.length) return;
    if (direction !== 'income') return;

    const email = tx.payer_email || '';
    const name  = tx.payer_name  || '';
    if (!email && !name) return;

    txApi.customerMatch({ payer_email: email, payer_name: name })
      .then(r => {
        const match = r.data.match;
        if (!match) return;

        // Verify the remembered customer still exists in QBO list
        const found = customers.find(c => c.Id === match.qbo_customer_id);
        if (!found) return;

        // Memory match beats fuzzy-name suggestion — always apply it
        setCustomerId(match.qbo_customer_id);
        setCustomerName(match.qbo_customer_name || found.DisplayName);
        setAutoMatch({ source: 'memory', matchCount: match.match_count });
      })
      .catch(() => {}); // Non-fatal
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers]);

  // ── Change handlers ───────────────────────────────────────────────────────
  const pickCustomer = useCallback((id) => {
    setCustomerId(id);
    setCustomerName(customers.find(x => x.Id === id)?.DisplayName || '');
    // Clear auto-match badge on manual override — user is making an explicit choice
    setAutoMatch(null);
  }, [customers]);

  const pickVendor = useCallback((id) => {
    setVendorId(id);
    setVendorName(vendors.find(x => x.Id === id)?.DisplayName || '');
  }, [vendors]);

  // ── Inline QBO entity creation handlers ──────────────────────────────────

  const createVendorInQbo = useCallback(async (name) => {
    setVendorCreating(true);
    try {
      const r = await qboApi.createVendor(name);
      const newVendor = { Id: r.data.Id, DisplayName: r.data.DisplayName };
      setExtraVendors(prev => [...prev, newVendor]);
      setVendorId(newVendor.Id);
      setVendorName(newVendor.DisplayName);
    } catch (err) {
      alert('Failed to create vendor in QBO: ' + (err.response?.data?.error || err.message));
    } finally {
      setVendorCreating(false);
    }
  }, []);

  const createCustomerInQbo = useCallback(async (name) => {
    setCustomerCreating(true);
    try {
      const r = await qboApi.createCustomer(name);
      const newCustomer = { Id: r.data.Id, DisplayName: r.data.DisplayName };
      setExtraCustomers(prev => [...prev, newCustomer]);
      setCustomerId(newCustomer.Id);
      setCustomerName(newCustomer.DisplayName);
      setAutoMatch(null);
    } catch (err) {
      alert('Failed to create customer in QBO: ' + (err.response?.data?.error || err.message));
    } finally {
      setCustomerCreating(false);
    }
  }, []);

  const pickPaypalAccount = useCallback((id) => {
    setPaypalAccountId(id);
    const a = clearingAccounts.find(x => x.Id === id);
    setPaypalAccountName(a ? (a.Name || a.FullyQualifiedName) : '');
  }, [clearingAccounts]);

  const pickIncomeAccount = useCallback((id) => {
    setIncomeAccountId(id);
    const a = incomeAccounts.find(x => x.Id === id);
    setIncomeAccountName(a ? (a.FullyQualifiedName || a.Name) : '');
  }, [incomeAccounts]);

  const pickExpenseAccount = useCallback((id) => {
    setExpenseAccountId(id);
    const a = expenseAccounts.find(x => x.Id === id);
    setExpenseAccountName(a ? (a.FullyQualifiedName || a.Name) : '');
  }, [expenseAccounts]);

  const pickBankAccount = useCallback((id) => {
    setBankAccountId(id);
    const a = bankAccounts.find(x => x.Id === id);
    setBankAccountName(a ? (a.Name || a.FullyQualifiedName) : '');
  }, [bankAccounts]);

  const handleClassChange = useCallback((id) => {
    setClassId(id);
    const c = classes.find(x => x.Id === id);
    setClassName(c ? (c.FullyQualifiedName || c.Name) : '');
  }, [classes]);

  // ── Live meta for preview ─────────────────────────────────────────────────
  const liveMeta = useMemo(() => ({
    customer_id:          customerId,      customer_name:        customerName,
    vendor_id:            vendorId,        vendor_name:          vendorName,
    paypal_account_id:    paypalAccountId, paypal_account_name:  paypalAccountName,
    income_account_id:    incomeAccountId, income_account_name:  incomeAccountName,
    expense_account_id:   expenseAccountId,expense_account_name: expenseAccountName,
    bank_account_id:      bankAccountId,   bank_account_name:    bankAccountName,
    class_id: classId, class_name: className,
    memo: qboMemo,
  }), [customerId, customerName, vendorId, vendorName,
       paypalAccountId, paypalAccountName,
       incomeAccountId, incomeAccountName, expenseAccountId, expenseAccountName,
       bankAccountId, bankAccountName,
       classId, className, qboMemo]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    try {
      const qboMetadata = {};

      // Entity
      if (customerId)      { qboMetadata.customer_id   = customerId;   qboMetadata.customer_name   = customerName; }
      if (vendorId)        { qboMetadata.vendor_id     = vendorId;     qboMetadata.vendor_name     = vendorName; }

      // Accounts
      if (paypalAccountId)  { qboMetadata.paypal_account_id  = paypalAccountId;  qboMetadata.paypal_account_name  = paypalAccountName; }
      if (incomeAccountId)  { qboMetadata.income_account_id  = incomeAccountId;  qboMetadata.income_account_name  = incomeAccountName; }
      if (expenseAccountId) { qboMetadata.expense_account_id = expenseAccountId; qboMetadata.expense_account_name = expenseAccountName; }
      if (bankAccountId)    { qboMetadata.bank_account_id    = bankAccountId;    qboMetadata.bank_account_name    = bankAccountName; }

      // Class + memo
      if (classId)  { qboMetadata.class_id = classId; qboMetadata.class_name = className; }
      if (qboMemo)  qboMetadata.memo = qboMemo;

      // Bank transfer match — null clears a previously-approved match
      if (direction === 'transfer') {
        qboMetadata.bank_match = approvedMatch || null;
      }

      await txApi.update(tx.id, {
        transaction_type:  txType,
        override_category: category !== tx.category ? (category || null) : undefined,
        reviewer_notes:    notes,
        status,
        qbo_metadata:      qboMetadata,
      });
      onSave();
    } catch (err) {
      alert(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const paypalUrl = isSandbox
    ? `https://www.sandbox.paypal.com/activity/payment/${tx.paypal_transaction_id}`
    : `https://www.paypal.com/activity/payment/${tx.paypal_transaction_id}`;

  const qboConnected = !!(qboData?.accounts?.length || qboData?.customers?.length);
  const categoryOptions = CATEGORY_OPTIONS[direction] || [];

  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-end sm:items-center justify-center z-50 sm:p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-900 border border-gray-700 w-full flex flex-col shadow-2xl
                      rounded-t-2xl max-h-[92vh]
                      sm:rounded-2xl sm:max-w-2xl sm:max-h-[94vh]">

        {/* ── Header bar ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold text-gray-100">{txType}</span>
            <DirectionBadge direction={direction} />
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">✕</button>
        </div>

        {/* ── Scrollable body ───────────────────────────────────────────── */}
        <div className="overflow-y-auto flex-1 p-5 space-y-4">

          {/* Synced banner — shown when tx is locked in QBO */}
          {isSynced && (
            <div className="flex items-start gap-3 px-4 py-3 bg-emerald-900/30 border border-emerald-700/60 rounded-xl">
              <span className="text-emerald-400 text-lg shrink-0">✓</span>
              <div className="flex-1 min-w-0">
                <p className="text-emerald-300 text-sm font-semibold">Synced to QuickBooks</p>
                {tx.qbo_object_id && (() => {
                  const qboUrl = buildQboUrl(tx.qbo_object_type, tx.qbo_object_id, qboEnvironment);
                  return (
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="text-xs text-emerald-600">
                        {tx.qbo_object_type} · <span className="font-mono">{tx.qbo_object_id}</span>
                      </span>
                      {qboUrl && (
                        <a
                          href={qboUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 underline underline-offset-2 transition-colors"
                          onClick={e => e.stopPropagation()}
                        >
                          View in QBO ↗
                        </a>
                      )}
                    </div>
                  );
                })()}
                <p className="text-xs text-gray-500 mt-1">
                  All fields are read-only. Roll back to delete the QBO entry and re-edit.
                </p>
              </div>
              <button
                className="shrink-0 px-3 py-1.5 text-xs font-semibold bg-amber-900/50 text-amber-300 border border-amber-700/60 rounded-lg hover:bg-amber-900/70 transition-colors"
                onClick={() => onRollback && onRollback(tx)}>
                ↩ Rollback
              </button>
            </div>
          )}

          {/* 1 — Transaction summary ─────────────────────────────────── */}
          <SectionCard icon="🧾" title="Transaction Details">
            {/* PayPal-branded top row */}
            <div className="flex items-start justify-between mb-3 pb-3 border-b border-gray-700/50">
              <div>
                <p className="text-xs text-gray-500 mb-0.5">PayPal Transaction</p>
                <a href={paypalUrl} target="_blank" rel="noopener noreferrer"
                   className="text-blue-400 hover:text-blue-300 font-mono text-xs underline underline-offset-2"
                   onClick={e => e.stopPropagation()}>
                  {tx.paypal_transaction_id} ↗
                </a>
                {tx.event_code && (
                  <span className="ml-2 text-gray-600 font-mono text-xs">{tx.event_code}</span>
                )}
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-500">{tx.transaction_date}</p>
                <p className={`text-lg font-bold font-mono ${parseFloat(tx.gross_amount) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {fmt(tx.gross_amount)}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Payer</span>
                <span className="text-gray-300 truncate max-w-[160px]">{tx.payer_name || tx.payer_email || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Funding</span>
                <span className="text-gray-400 text-xs capitalize">{(tx.funding_source || '—').replace(/_/g, ' ')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Fee</span>
                <span className="text-gray-400 font-mono">{fmt(tx.fee_amount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Net</span>
                <span className="text-gray-200 font-mono font-medium">{fmt(tx.net_amount)}</span>
              </div>
              {tx.description && (
                <div className="col-span-2 pt-2 border-t border-gray-700/40">
                  <p className="text-gray-500 text-xs mb-0.5">Description</p>
                  <p className="text-gray-400 text-xs break-words">{tx.description}</p>
                </div>
              )}
            </div>
          </SectionCard>

          {/* 2 — Classification (first, so direction updates live) ──── */}
          <SectionCard icon="🏷️" title="Classification" accent="border-l-blue-600">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Transaction Type</label>
                <select className="input" value={txType} disabled={isSynced}
                        onChange={e => setTxType(e.target.value)}>
                  {TRANSACTION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                {!isSynced && <p className="text-xs text-gray-600 mt-1">Changes the fields shown below.</p>}
              </div>
              <div>
                <label className="label">Category Override</label>
                <select className="input" value={category} disabled={isSynced}
                        onChange={e => setCategory(e.target.value)}>
                  <option value="">— Auto / keep as is —</option>
                  {categoryOptions.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                {tx.category && tx.category !== category && (
                  <p className="text-xs text-gray-600 mt-1">Auto: {tx.category}</p>
                )}
              </div>
            </div>
          </SectionCard>

          {/* 3 — Entity (Billed To / Vendor) ────────────────────────── */}
          {(direction === 'income' || direction === 'expense') && (
            <SectionCard
              icon={direction === 'income' ? '🏢' : '🏪'}
              title={direction === 'income' ? 'Billed To' : 'Vendor / Paid To'}
              accent={direction === 'income' ? 'border-l-emerald-700' : 'border-l-rose-700'}
            >
              {!qboConnected && !qboLoading && (
                <p className="text-sm text-amber-400 bg-amber-900/20 border border-amber-800 rounded-lg px-3 py-2 mb-3">
                  Connect QuickBooks in Setup to enable {direction === 'income' ? 'customer' : 'vendor'} matching.
                </p>
              )}
              {direction === 'income' ? (
                <>
                  <SearchSelect
                    items={customers} value={customerId} onChange={pickCustomer}
                    emptyLabel="— No specific customer —" placeholder="Search customers…"
                    getKey={c => c.Id} getLabel={c => c.DisplayName}
                    loading={qboLoading} disabled={isSynced}
                    onCreateNew={!isSynced ? createCustomerInQbo : undefined}
                    creating={customerCreating}
                    createLabel="Create customer"
                  />
                  <MatchChip
                    name={customerName}
                    source={autoMatch?.source}
                    matchCount={autoMatch?.matchCount}
                  />
                </>
              ) : (
                <>
                  <SearchSelect
                    items={vendors} value={vendorId} onChange={pickVendor}
                    emptyLabel="— No specific vendor —" placeholder="Search vendors…"
                    getKey={v => v.Id} getLabel={v => v.DisplayName}
                    loading={qboLoading} disabled={isSynced}
                    onCreateNew={!isSynced ? createVendorInQbo : undefined}
                    creating={vendorCreating}
                    createLabel="Create vendor"
                  />
                  <MatchChip name={vendorName} />
                </>
              )}
            </SectionCard>
          )}

          {/* 4 — PayPal Clearing Account ─────────────────────────────── */}
          <SectionCard icon="🏦" title="PayPal Clearing Account">
            <p className="text-xs text-gray-500 mb-2">
              The QBO bank / asset account that represents your PayPal balance.
              This account is debited when money arrives and credited when money leaves.
            </p>
            <SearchSelect
              items={clearingAccounts} value={paypalAccountId} onChange={pickPaypalAccount}
              emptyLabel="— Use mapped PayPal account —" placeholder="Search bank / asset accounts…"
              getKey={a => a.Id} getLabel={a => a.FullyQualifiedName || a.Name}
              loading={qboLoading} disabled={isSynced}
            />
            <MatchChip name={paypalAccountName} />
          </SectionCard>

          {/* 5 — Income / Expense Category Account ─────────────────── */}
          {direction === 'income' && (
            <SectionCard icon="📈" title="Income Category" accent="border-l-emerald-700">
              <p className="text-xs text-gray-500 mb-2">
                Which income account should this revenue be posted to?
                Leave blank to use your default PayPal Sales account.
              </p>
              <SearchSelect
                items={incomeAccounts} value={incomeAccountId} onChange={pickIncomeAccount}
                emptyLabel="— Default PayPal Sales account —" placeholder="Search income accounts…"
                getKey={a => a.Id} getLabel={a => a.FullyQualifiedName || a.Name}
                loading={qboLoading} disabled={isSynced}
              />

              {/* Fee note — always automatic in the new SalesReceipt + Expense model */}
              {hasFee && (
                <div className="mt-3 pt-3 border-t border-gray-700/40">
                  <p className="text-[11px] text-gray-500">
                    ℹ️ A companion <span className="text-gray-400 font-medium">Expense</span> for the {fmt(tx.fee_amount)} PayPal fee
                    will be created automatically alongside the Sales Receipt.
                  </p>
                </div>
              )}
            </SectionCard>
          )}

          {direction === 'expense' && (
            <SectionCard icon="📉" title="Expense Category" accent="border-l-rose-700">
              <p className="text-xs text-gray-500 mb-2">
                Which expense account should this cost be posted to?
              </p>
              <SearchSelect
                items={expenseAccounts} value={expenseAccountId} onChange={pickExpenseAccount}
                emptyLabel="— Default / mapped expense account —" placeholder="Search expense accounts…"
                getKey={a => a.Id} getLabel={a => a.FullyQualifiedName || a.Name}
                loading={qboLoading} disabled={isSynced}
              />
            </SectionCard>
          )}

          {/* 6 — Bank Account (transfers & payouts) ─────────────────── */}
          {direction === 'transfer' && (
            <SectionCard icon="🏛️" title="Bank Account" accent="border-l-violet-700">
              <p className="text-xs text-gray-500 mb-2">
                {(category || tx.category) === 'bank_transfer_in'
                  ? 'The bank account funds were transferred from.'
                  : 'The bank account funds were withdrawn to.'}
              </p>
              <SearchSelect
                items={bankAccounts} value={bankAccountId} onChange={pickBankAccount}
                emptyLabel="— Use mapped bank account —" placeholder="Search bank accounts…"
                getKey={a => a.Id} getLabel={a => a.FullyQualifiedName || a.Name}
                loading={qboLoading} disabled={isSynced}
              />
              <MatchChip name={bankAccountName} />
            </SectionCard>
          )}

          {/* 6b — Bank Transfer Match ────────────────────────────────── */}
          {direction === 'transfer' && !isSynced && (
            <SectionCard icon="🔍" title="Bank Transfer Match" accent="border-l-violet-600">
              <p className="text-xs text-gray-500 mb-3">
                Find the matching bank transaction in QuickBooks to avoid double-entry.
                Approve a match to link it when syncing.
              </p>

              {/* Currently approved match */}
              {approvedMatch && (
                <div className="mb-3 px-3 py-2.5 bg-emerald-900/30 border border-emerald-700/50 rounded-lg">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-emerald-400 text-sm">✓</span>
                      <span className="text-xs font-semibold text-emerald-300">Approved Match</span>
                    </div>
                    <button
                      className="text-xs text-gray-500 hover:text-rose-400 transition-colors"
                      onClick={() => setApprovedMatch(null)}>
                      Clear
                    </button>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">{approvedMatch.qbo_type} · {approvedMatch.qbo_date}</span>
                    <span className="font-mono text-gray-300">{fmt(approvedMatch.qbo_amount)}</span>
                  </div>
                  {approvedMatch.account_name && (
                    <p className="text-xs text-gray-500 mt-0.5">{approvedMatch.account_name}</p>
                  )}
                  {approvedMatch.qbo_memo && (
                    <p className="text-xs text-gray-600 mt-0.5 italic truncate">{approvedMatch.qbo_memo}</p>
                  )}
                </div>
              )}

              {bankMatchLoading && (
                <div className="flex items-center gap-2 py-3 text-xs text-gray-500">
                  <span className="animate-spin inline-block w-3 h-3 border border-gray-500 border-t-violet-400 rounded-full" />
                  Searching QBO bank transactions…
                </div>
              )}

              {bankMatchError && (
                <p className="text-xs text-rose-400 py-2">{bankMatchError}</p>
              )}

              {!bankMatchLoading && bankMatches !== null && (
                <>
                  {bankMatches.length === 0 ? (
                    <p className="text-xs text-gray-500 py-2">
                      No matching bank transactions found in QBO within ±5 days of {tx.transaction_date}.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {(bankMatchShowAll ? bankMatches : bankMatches.slice(0, 3)).map(m => {
                        const isApproved = approvedMatch?.qbo_id === m.qbo_id && approvedMatch?.qbo_type === m.qbo_type;
                        return (
                          <div
                            key={`${m.qbo_type}-${m.qbo_id}`}
                            className={`border rounded-lg p-3 transition-colors ${
                              isApproved
                                ? 'border-emerald-600/60 bg-emerald-900/20'
                                : 'border-gray-700/50 bg-gray-800/30 hover:border-gray-600/60'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                {/* Type pill + date + proximity */}
                                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                  <span className="text-xs font-mono text-violet-300 bg-violet-900/40 px-1.5 py-0.5 rounded border border-violet-800/40">
                                    {m.qbo_type}
                                  </span>
                                  <span className="text-xs text-gray-400">{m.qbo_date}</span>
                                  {m.days_diff === 0
                                    ? <span className="text-xs text-emerald-400 font-medium">Same day</span>
                                    : <span className="text-xs text-gray-500">±{m.days_diff}d</span>
                                  }
                                </div>
                                {/* Amount + account */}
                                <div className="flex items-center gap-3">
                                  <span className="font-mono text-sm text-gray-200">{fmt(m.qbo_amount)}</span>
                                  {m.account_name && (
                                    <span className="text-xs text-gray-500 truncate">{m.account_name}</span>
                                  )}
                                </div>
                                {m.qbo_memo && (
                                  <p className="text-xs text-gray-600 mt-1 truncate italic">{m.qbo_memo}</p>
                                )}
                                {/* Confidence bar */}
                                <div className="mt-2 flex items-center gap-2">
                                  <div className="flex-1 h-1 bg-gray-700 rounded-full overflow-hidden">
                                    <div
                                      className={`h-full rounded-full transition-all ${
                                        m.confidence >= 80 ? 'bg-emerald-500' :
                                        m.confidence >= 50 ? 'bg-amber-500' : 'bg-gray-500'
                                      }`}
                                      style={{ width: `${m.confidence}%` }}
                                    />
                                  </div>
                                  <span className="text-[10px] text-gray-500 shrink-0 w-8 text-right">{m.confidence}%</span>
                                </div>
                              </div>
                              {/* Approve / approved toggle */}
                              <button
                                className={`shrink-0 mt-0.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                                  isApproved
                                    ? 'bg-emerald-800/50 text-emerald-300 border-emerald-600/60'
                                    : 'bg-gray-700/50 text-gray-300 border-gray-600/50 hover:bg-violet-900/50 hover:text-violet-300 hover:border-violet-600/60'
                                }`}
                                onClick={() => setApprovedMatch(isApproved ? null : {
                                  qbo_id:       m.qbo_id,
                                  qbo_type:     m.qbo_type,
                                  qbo_date:     m.qbo_date,
                                  qbo_amount:   m.qbo_amount,
                                  qbo_memo:     m.qbo_memo  || '',
                                  account_id:   m.account_id,
                                  account_name: m.account_name,
                                  matched_at:   new Date().toISOString(),
                                })}
                              >
                                {isApproved ? '✓ Approved' : 'Use this'}
                              </button>
                            </div>
                          </div>
                        );
                      })}

                      {bankMatches.length > 3 && (
                        <button
                          className="w-full text-xs text-gray-500 hover:text-gray-300 py-1.5 transition-colors"
                          onClick={() => setBankMatchShowAll(s => !s)}>
                          {bankMatchShowAll
                            ? '▲ Show fewer'
                            : `▼ Show ${bankMatches.length - 3} more match${bankMatches.length - 3 === 1 ? '' : 'es'}`}
                        </button>
                      )}
                    </div>
                  )}

                  <button
                    className="mt-3 text-xs text-gray-600 hover:text-gray-400 transition-colors"
                    onClick={() => { setBankMatches(null); setBankMatchError(''); }}>
                    ↺ Re-search
                  </button>
                </>
              )}
            </SectionCard>
          )}

          {/* 7 — Class & Memo ─────────────────────────────────────────── */}
          <SectionCard icon="🗂️" title="Class & Memo">
            <div className="space-y-3">
              {classes.length > 0 && (
                <div>
                  <label className="label">Class / Department</label>
                  <SearchSelect
                    items={classes} value={classId} onChange={handleClassChange}
                    emptyLabel="— No class —" placeholder="Search classes…"
                    getKey={c => c.Id} getLabel={c => c.FullyQualifiedName || c.Name}
                    loading={qboLoading} disabled={isSynced}
                  />
                </div>
              )}
              <div>
                <label className="label">QBO Memo</label>
                <input className="input" value={qboMemo} disabled={isSynced}
                       onChange={e => setQboMemo(e.target.value)}
                       placeholder="Memo sent to QuickBooks…" />
              </div>
            </div>
          </SectionCard>

          {/* 8 — Accounting Preview ──────────────────────────────────── */}
          <SectionCard icon="📊" title="Accounting Preview">
            <AccountingPreview
              direction={direction}
              tx={{ ...tx, transaction_type: txType, override_category: category || tx.override_category }}
              meta={liveMeta}
              isSynced={isSynced}
              qboEnvironment={qboEnvironment}
              primaryQboId={tx.qbo_object_id}
              primaryQboType={tx.qbo_object_type}
              feeQboId={existingMeta.fee_qbo_id}
              feeQboType={existingMeta.fee_qbo_type || 'Purchase'}
            />
          </SectionCard>

          {/* 9 — Status & Notes ─────────────────────────────────────── */}
          <SectionCard icon="⚙️" title="Status & Notes">
            <div className="space-y-3">
              {!isSynced && (
                <div>
                  <label className="label">Status</label>
                  <select className="input" value={status} onChange={e => setStatus(e.target.value)}>
                    {EDITABLE_STATUSES.map(s => (
                      <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="label">Reviewer Notes</label>
                <textarea className="input w-full" rows={3} value={notes} disabled={isSynced}
                          onChange={e => setNotes(e.target.value)}
                          placeholder="Internal notes (not sent to QuickBooks)…" />
              </div>
            </div>
          </SectionCard>

        </div>

        {/* ── Footer ───────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-6 py-4 border-t border-gray-800 shrink-0">
          {isSynced ? (
            <>
              <button
                className="px-4 py-2 text-sm font-semibold bg-amber-800/60 text-amber-200 border border-amber-700/60 rounded-lg hover:bg-amber-800/80 transition-colors"
                onClick={() => onRollback && onRollback(tx)}>
                ↩ Rollback from QuickBooks
              </button>
              <button className="btn-secondary" onClick={onClose}>Close</button>
            </>
          ) : (
            <>
              <button className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
            </>
          )}
          <span className="ml-auto text-xs text-gray-600">
            {tx.confidence && <>Confidence: <span className="text-gray-500">{tx.confidence}</span></>}
          </span>
        </div>
      </div>
    </div>
  );
}
