/**
 * BulkEditModal — apply shared QBO fields to multiple selected transactions at once.
 *
 * Rules:
 *  - Only works when all selected transactions share the same Transaction Type
 *    (enforced in ReviewQueue before this modal opens).
 *  - Each field starts DISABLED (toggle off). User must explicitly enable a field
 *    before it is included in the update — prevents accidental overwrites.
 *  - Synced transactions in the selection are silently skipped by the backend.
 *  - Direction (income / expense / transfer) is derived from the shared type so
 *    the right entity and account fields are shown.
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { txApi } from '../api/client';

// ── Constants ──────────────────────────────────────────────────────────────

const INCOME_ACC_TYPES   = ['Income', 'Other Income'];
const EXPENSE_ACC_TYPES  = ['Expense', 'Cost of Goods Sold', 'Other Expense'];
const CLEARING_ACC_TYPES = ['Bank', 'Other Current Asset'];
const BANK_ACC_TYPES     = ['Bank'];

const CATEGORY_OPTIONS = {
  income: [
    { value: 'sale',                label: 'Sale / Payment Received' },
    { value: 'subscription',        label: 'Subscription / Recurring Payment' },
    { value: 'donation_received',   label: 'Donation Received' },
    { value: 'refund',              label: 'Refund Received (from vendor)' },
    { value: 'chargeback',          label: 'Chargeback Won (funds returned)' },
    { value: 'adjustment',          label: 'Account Adjustment / Credit' },
    { value: 'currency_conversion', label: 'Currency Conversion Gain' },
    { value: 'unknown',             label: 'Unknown — needs review' },
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

const STATUS_OPTIONS = ['classified', 'needs_review', 'approved', 'ignored'];

// ── Direction from type ────────────────────────────────────────────────────

function directionFromType(type) {
  if (type === 'Transfer' || type === 'Bank Payout') return 'transfer';
  if (type === 'Purchase')                           return 'expense';
  if (type === 'Other')                              return 'expense';   // fees
  if (type === 'Payment' || type === 'Invoice')      return 'income';
  if (type === 'Refund')                             return 'income';    // default; user can switch category
  return 'income';
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sortByName(arr, getName) {
  return [...arr].sort((a, b) => (getName(a) || '').localeCompare(getName(b) || ''));
}

// ── Toggle field row ───────────────────────────────────────────────────────
// Wraps any field with a labeled toggle. Children only rendered when active.

function FieldToggle({ id, label, hint, active, onToggle, children }) {
  return (
    <div className={`rounded-xl border transition-colors ${active ? 'border-blue-600/50 bg-blue-950/20' : 'border-gray-700/40 bg-gray-800/20'}`}>
      {/* Toggle header */}
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={onToggle}
      >
        <div>
          <p className={`text-sm font-medium ${active ? 'text-gray-100' : 'text-gray-400'}`}>{label}</p>
          {hint && !active && <p className="text-xs text-gray-600 mt-0.5">{hint}</p>}
        </div>
        {/* Toggle pill */}
        <div className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${active ? 'bg-blue-600' : 'bg-gray-700'}`}>
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${active ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </div>
      </button>
      {/* Field content — only when active */}
      {active && (
        <div className="px-4 pb-4 pt-1 border-t border-gray-700/30">
          {children}
        </div>
      )}
    </div>
  );
}

// ── SearchSelect ───────────────────────────────────────────────────────────

function SearchSelect({ items, value, onChange, emptyLabel, placeholder, getKey, getLabel, loading }) {
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => {
    if (!filter) return items;
    const f = filter.toLowerCase();
    return items.filter(i => getLabel(i).toLowerCase().includes(f));
  }, [items, filter, getLabel]);

  return (
    <div className="space-y-1 mt-2">
      <input
        className="input text-xs py-1.5"
        placeholder={loading ? 'Loading…' : placeholder || 'Type to filter…'}
        value={filter}
        disabled={loading}
        onChange={e => setFilter(e.target.value)}
      />
      <select className="input" value={value} disabled={loading} onChange={e => onChange(e.target.value)}>
        <option value="">{emptyLabel}</option>
        {filtered.map(item => (
          <option key={getKey(item)} value={getKey(item)}>{getLabel(item)}</option>
        ))}
      </select>
    </div>
  );
}

// ── Main modal ─────────────────────────────────────────────────────────────

export default function BulkEditModal({ selectedRows, qboData, qboLoading, onClose, onSave }) {
  // All selected rows must share the same type (enforced by caller)
  const sharedType = selectedRows[0]?.transaction_type || 'Other';
  const direction  = directionFromType(sharedType);
  const ids        = selectedRows.map(r => r.id);

  // ── Filtered QBO lists ────────────────────────────────────────────────────
  const customers      = useMemo(() => sortByName(qboData?.customers || [], c => c.DisplayName), [qboData]);
  const vendors        = useMemo(() => sortByName(qboData?.vendors   || [], v => v.DisplayName), [qboData]);
  const incomeAccounts = useMemo(() =>
    sortByName((qboData?.accounts || []).filter(a => INCOME_ACC_TYPES.includes(a.AccountType)),
      a => a.FullyQualifiedName || a.Name), [qboData]);
  const expenseAccounts = useMemo(() =>
    sortByName((qboData?.accounts || []).filter(a => EXPENSE_ACC_TYPES.includes(a.AccountType)),
      a => a.FullyQualifiedName || a.Name), [qboData]);
  const clearingAccounts = useMemo(() =>
    sortByName((qboData?.accounts || []).filter(a => CLEARING_ACC_TYPES.includes(a.AccountType)),
      a => a.FullyQualifiedName || a.Name), [qboData]);
  const bankAccounts = useMemo(() =>
    sortByName((qboData?.accounts || []).filter(a => BANK_ACC_TYPES.includes(a.AccountType)),
      a => a.FullyQualifiedName || a.Name), [qboData]);
  const classes = useMemo(() =>
    sortByName(qboData?.classes || [], c => c.FullyQualifiedName || c.Name), [qboData]);

  // ── Per-field enabled state (all OFF by default) ──────────────────────────
  const [on, setOn] = useState({
    category:       false,
    status:         false,
    customer:       false,
    vendor:         false,
    paypalAccount:  false,
    incomeAccount:  false,
    expenseAccount: false,
    bankAccount:    false,
    class:          false,
    memo:           false,
  });

  const toggle = (key) => setOn(prev => ({ ...prev, [key]: !prev[key] }));

  // ── Field values ──────────────────────────────────────────────────────────
  const [category,          setCategory]          = useState('');
  const [status,            setStatus]            = useState('classified');
  const [customerId,        setCustomerId]        = useState('');
  const [customerName,      setCustomerName]      = useState('');
  const [vendorId,          setVendorId]          = useState('');
  const [vendorName,        setVendorName]        = useState('');
  const [paypalAccountId,   setPaypalAccountId]   = useState('');
  const [paypalAccountName, setPaypalAccountName] = useState('');
  const [incomeAccountId,   setIncomeAccountId]   = useState('');
  const [incomeAccountName, setIncomeAccountName] = useState('');
  const [expenseAccountId,  setExpenseAccountId]  = useState('' );
  const [expenseAccountName,setExpenseAccountName]= useState('');
  const [bankAccountId,     setBankAccountId]     = useState('');
  const [bankAccountName,   setBankAccountName]   = useState('');
  const [classId,           setClassId]           = useState('');
  const [className,         setClassName]         = useState('');
  const [memo,              setMemo]              = useState('');
  const [memoMode,          setMemoMode]          = useState('overwrite'); // 'overwrite' | 'append'

  const [saving,   setSaving]   = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Auto-suggest PayPal clearing account from account names
  useEffect(() => {
    if (!qboData || paypalAccountId) return;
    const match = clearingAccounts.find(a =>
      (a.Name || '').toLowerCase().includes('paypal') ||
      (a.FullyQualifiedName || '').toLowerCase().includes('paypal'));
    if (match) { setPaypalAccountId(match.Id); setPaypalAccountName(match.Name || match.FullyQualifiedName); }
  }, [qboData, clearingAccounts, paypalAccountId]);

  // ── Helpers to sync name when ID changes ─────────────────────────────────
  const pickCustomer = useCallback((id) => {
    setCustomerId(id);
    setCustomerName(customers.find(x => x.Id === id)?.DisplayName || '');
  }, [customers]);

  const pickVendor = useCallback((id) => {
    setVendorId(id);
    setVendorName(vendors.find(x => x.Id === id)?.DisplayName || '');
  }, [vendors]);

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

  const pickClass = useCallback((id) => {
    setClassId(id);
    const c = classes.find(x => x.Id === id);
    setClassName(c ? (c.FullyQualifiedName || c.Name) : '');
  }, [classes]);

  // Count how many fields are enabled
  const activeCount = Object.values(on).filter(Boolean).length;

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (activeCount === 0) { setErrorMsg('Enable at least one field to update.'); return; }
    setSaving(true);
    setErrorMsg('');
    try {
      const updates = {};

      if (on.category && category) updates.override_category = category;
      if (on.status)               updates.status = status;

      // Build qbo_metadata from enabled account/entity fields
      const meta = {};
      if (on.customer       && customerId)       { meta.customer_id        = customerId;       meta.customer_name        = customerName; }
      if (on.vendor         && vendorId)         { meta.vendor_id          = vendorId;         meta.vendor_name          = vendorName; }
      if (on.paypalAccount  && paypalAccountId)  { meta.paypal_account_id  = paypalAccountId;  meta.paypal_account_name  = paypalAccountName; }
      if (on.incomeAccount  && incomeAccountId)  { meta.income_account_id  = incomeAccountId;  meta.income_account_name  = incomeAccountName; }
      if (on.expenseAccount && expenseAccountId) { meta.expense_account_id = expenseAccountId; meta.expense_account_name = expenseAccountName; }
      if (on.bankAccount    && bankAccountId)    { meta.bank_account_id    = bankAccountId;    meta.bank_account_name    = bankAccountName; }
      if (on.class          && classId)          { meta.class_id           = classId;          meta.class_name           = className; }
      if (on.memo && memo.trim())                { meta.memo               = memo.trim(); }

      if (Object.keys(meta).length > 0) updates.qbo_metadata = meta;

      if (Object.keys(updates).length === 0) { setErrorMsg('No values selected for the enabled fields.'); setSaving(false); return; }

      const r = await txApi.bulkUpdate(ids, updates);
      onSave(r.data.updated, r.data.skipped);
    } catch (err) {
      setErrorMsg(err.response?.data?.error || 'Bulk update failed');
    } finally {
      setSaving(false);
    }
  };

  const categoryOptions = CATEGORY_OPTIONS[direction] || [];

  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-xl max-h-[90vh] flex flex-col shadow-2xl">

        {/* ── Header ────────────────────────────────────────────────── */}
        <div className="px-6 py-4 border-b border-gray-800 shrink-0">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-semibold text-gray-100 text-lg">Bulk Edit</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                <span className="text-gray-300 font-medium">{ids.length}</span> selected ·
                Type: <span className="text-blue-400 font-medium">{sharedType}</span>
              </p>
            </div>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none mt-1">✕</button>
          </div>

          {/* Direction hint */}
          <div className={`mt-3 flex items-center gap-2 text-xs px-3 py-2 rounded-lg border
            ${direction === 'income'   ? 'bg-emerald-900/20 border-emerald-800/50 text-emerald-400'
            : direction === 'expense'  ? 'bg-rose-900/20 border-rose-800/50 text-rose-400'
            :                            'bg-violet-900/20 border-violet-800/50 text-violet-400'}`}>
            <span>{direction === 'income' ? '💰' : direction === 'expense' ? '💸' : '↔'}</span>
            <span className="font-medium capitalize">{direction}</span>
            <span className="text-gray-500 ml-1">— showing relevant fields for {sharedType} transactions</span>
          </div>
        </div>

        {/* ── Instructions ──────────────────────────────────────────── */}
        <div className="px-6 pt-4 shrink-0">
          <p className="text-xs text-gray-500">
            Toggle the fields you want to apply. Only <strong className="text-gray-400">enabled fields</strong> will
            be written — existing values on un-toggled fields are preserved.
          </p>
        </div>

        {/* ── Scrollable fields ──────────────────────────────────────── */}
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-3">

          {/* Category Override */}
          <FieldToggle id="category" label="Category Override"
            hint="Set the internal category for all selected transactions"
            active={on.category} onToggle={() => toggle('category')}>
            <label className="label mt-1">Category</label>
            <select className="input mt-1" value={category} onChange={e => setCategory(e.target.value)}>
              <option value="">— Select a category —</option>
              {categoryOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FieldToggle>

          {/* Status */}
          <FieldToggle id="status" label="Status"
            hint="Move all selected transactions to a new status"
            active={on.status} onToggle={() => toggle('status')}>
            <label className="label mt-1">New Status</label>
            <select className="input mt-1" value={status} onChange={e => setStatus(e.target.value)}>
              {STATUS_OPTIONS.map(s => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </FieldToggle>

          {/* Customer (income) */}
          {(direction === 'income') && (
            <FieldToggle id="customer" label="Billed To (Customer)"
              hint="Assign a QBO customer to all selected transactions"
              active={on.customer} onToggle={() => toggle('customer')}>
              <SearchSelect
                items={customers} value={customerId} onChange={pickCustomer}
                emptyLabel="— Select customer —" placeholder="Search customers…"
                getKey={c => c.Id} getLabel={c => c.DisplayName} loading={qboLoading}
              />
              {customerName && <p className="text-xs text-emerald-400 mt-1.5">✓ {customerName}</p>}
            </FieldToggle>
          )}

          {/* Vendor (expense) */}
          {(direction === 'expense') && (
            <FieldToggle id="vendor" label="Vendor / Paid To"
              hint="Assign a QBO vendor to all selected transactions"
              active={on.vendor} onToggle={() => toggle('vendor')}>
              <SearchSelect
                items={vendors} value={vendorId} onChange={pickVendor}
                emptyLabel="— Select vendor —" placeholder="Search vendors…"
                getKey={v => v.Id} getLabel={v => v.DisplayName} loading={qboLoading}
              />
              {vendorName && <p className="text-xs text-emerald-400 mt-1.5">✓ {vendorName}</p>}
            </FieldToggle>
          )}

          {/* PayPal Clearing Account */}
          <FieldToggle id="paypalAccount" label="PayPal Clearing Account"
            hint="Override the QBO bank/asset account that represents your PayPal balance"
            active={on.paypalAccount} onToggle={() => toggle('paypalAccount')}>
            <SearchSelect
              items={clearingAccounts} value={paypalAccountId} onChange={pickPaypalAccount}
              emptyLabel="— Select account —" placeholder="Search bank / asset accounts…"
              getKey={a => a.Id} getLabel={a => a.FullyQualifiedName || a.Name} loading={qboLoading}
            />
            {paypalAccountName && <p className="text-xs text-emerald-400 mt-1.5">✓ {paypalAccountName}</p>}
          </FieldToggle>

          {/* Income Account */}
          {direction === 'income' && (
            <FieldToggle id="incomeAccount" label="Income Category"
              hint="Override the income account for all selected transactions"
              active={on.incomeAccount} onToggle={() => toggle('incomeAccount')}>
              <SearchSelect
                items={incomeAccounts} value={incomeAccountId} onChange={pickIncomeAccount}
                emptyLabel="— Select income account —" placeholder="Search income accounts…"
                getKey={a => a.Id} getLabel={a => a.FullyQualifiedName || a.Name} loading={qboLoading}
              />
            </FieldToggle>
          )}

          {/* Expense Account */}
          {direction === 'expense' && (
            <FieldToggle id="expenseAccount" label="Expense Category"
              hint="Override the expense account for all selected transactions"
              active={on.expenseAccount} onToggle={() => toggle('expenseAccount')}>
              <SearchSelect
                items={expenseAccounts} value={expenseAccountId} onChange={pickExpenseAccount}
                emptyLabel="— Select expense account —" placeholder="Search expense accounts…"
                getKey={a => a.Id} getLabel={a => a.FullyQualifiedName || a.Name} loading={qboLoading}
              />
            </FieldToggle>
          )}

          {/* Bank Account (transfers) */}
          {direction === 'transfer' && (
            <FieldToggle id="bankAccount" label="Bank Account"
              hint="The bank account involved in this transfer"
              active={on.bankAccount} onToggle={() => toggle('bankAccount')}>
              <SearchSelect
                items={bankAccounts} value={bankAccountId} onChange={pickBankAccount}
                emptyLabel="— Select bank account —" placeholder="Search bank accounts…"
                getKey={a => a.Id} getLabel={a => a.FullyQualifiedName || a.Name} loading={qboLoading}
              />
              {bankAccountName && <p className="text-xs text-emerald-400 mt-1.5">✓ {bankAccountName}</p>}
            </FieldToggle>
          )}

          {/* Class */}
          {classes.length > 0 && (
            <FieldToggle id="class" label="Class / Department"
              hint="Assign a QBO class to all selected transactions"
              active={on.class} onToggle={() => toggle('class')}>
              <SearchSelect
                items={classes} value={classId} onChange={pickClass}
                emptyLabel="— Select class —" placeholder="Search classes…"
                getKey={c => c.Id} getLabel={c => c.FullyQualifiedName || c.Name} loading={qboLoading}
              />
              {className && <p className="text-xs text-emerald-400 mt-1.5">✓ {className}</p>}
            </FieldToggle>
          )}

          {/* Memo */}
          <FieldToggle id="memo" label="QBO Memo"
            hint="Set or append a memo on all selected transactions"
            active={on.memo} onToggle={() => toggle('memo')}>
            <div className="flex gap-3 mt-2 mb-2">
              {['overwrite', 'append'].map(m => (
                <label key={m} className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                  <input type="radio" className="accent-blue-500" name="memoMode"
                         checked={memoMode === m} onChange={() => setMemoMode(m)} />
                  <span className="capitalize">{m}</span>
                </label>
              ))}
            </div>
            <input
              className="input"
              value={memo}
              onChange={e => setMemo(e.target.value)}
              placeholder={memoMode === 'append' ? 'Text to append to existing memo…' : 'Memo to set on all transactions…'}
            />
          </FieldToggle>

        </div>

        {/* ── Footer ────────────────────────────────────────────────── */}
        <div className="px-6 py-4 border-t border-gray-800 shrink-0 space-y-3">
          {errorMsg && (
            <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/50 rounded-lg px-3 py-2">
              {errorMsg}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              className="btn-primary"
              onClick={handleSave}
              disabled={saving || activeCount === 0}>
              {saving
                ? 'Applying…'
                : activeCount === 0
                ? 'Enable a field above'
                : `Apply ${activeCount} field${activeCount !== 1 ? 's' : ''} to ${ids.length} transaction${ids.length !== 1 ? 's' : ''}`}
            </button>
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <span className="ml-auto text-xs text-gray-600">
              Synced transactions are always skipped
            </span>
          </div>
        </div>

      </div>
    </div>
  );
}
