import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { paypalApi, qboApi } from '../api/client';

// Core PayPal ↔ QBO account mappings
const CORE_MAPPINGS = {
  paypal_bank:        { label: 'PayPal Balance Account',        hint: 'Bank / asset account in QBO that represents your PayPal balance (the clearing account)' },
  paypal_credit:      { label: 'PayPal Credit Card Account',    hint: 'Credit card liability account for PayPal Credit / BML purchases — NEVER use PayPal Bank here' },
  paypal_fees:        { label: 'PayPal Fees Expense Account',   hint: 'Expense account for PayPal transaction and processing fees' },
  paypal_sales:       { label: 'PayPal Sales Income Account',   hint: 'Default income account for PayPal sales (used by JournalEntry fallback; SalesReceipts use the Item below)' },
  paypal_adjustments: { label: 'PayPal Adjustments / COGS',    hint: 'Used for adjustments and cost-of-goods entries' },
  uncategorized:      { label: 'Uncategorized / Review Account',hint: 'Holding account for transactions that need manual classification' },
};

// Bank accounts physically connected to PayPal (for bank transfer matching)
const BANK_MAPPING_KEYS   = ['bank_account_1', 'bank_account_2', 'bank_account_3'];
const BANK_MAPPING_LABELS = {
  bank_account_1: 'Connected Bank Account 1',
  bank_account_2: 'Connected Bank Account 2',
  bank_account_3: 'Connected Bank Account 3',
};

function Step({ number, title, active, done }) {
  return (
    <div className={`flex items-center gap-3 ${active ? 'text-blue-400' : done ? 'text-green-400' : 'text-gray-600'}`}>
      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2
        ${active ? 'border-blue-400 bg-blue-900/30' : done ? 'border-green-400 bg-green-900/30' : 'border-gray-700'}`}>
        {done ? '✓' : number}
      </div>
      <span className="text-sm font-medium">{title}</span>
    </div>
  );
}

// ── Minimal search+select for items and customers ──────────────────────────

function EntityPicker({ label, hint, items, value, onChange, getKey, getLabel, emptyLabel, badge }) {
  const [filter, setFilter] = useState('');
  const filtered = filter
    ? items.filter(i => getLabel(i).toLowerCase().includes(filter.toLowerCase()))
    : items;
  return (
    <div className="bg-gray-800/40 border border-gray-700/40 rounded-xl p-4">
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <label className="label mb-0">{label}</label>
            {badge && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-800/50">
                {badge}
              </span>
            )}
          </div>
          {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
        </div>
        {value && <span className="text-xs text-emerald-400 ml-3 shrink-0">✓ Mapped</span>}
      </div>
      <input
        className="input text-xs py-1.5 mb-1"
        placeholder="Type to filter…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      <select className="input" value={value} onChange={e => onChange(e.target.value)}>
        <option value="">{emptyLabel || '— Select —'}</option>
        {filtered.map(item => (
          <option key={getKey(item)} value={getKey(item)}>{getLabel(item)}</option>
        ))}
      </select>
    </div>
  );
}

export default function SetupWizard() {
  const [searchParams] = useSearchParams();
  const [step,         setStep]         = useState(1);
  const [ppClientId,   setPpClientId]   = useState('');
  const [ppSecret,     setPpSecret]     = useState('');
  const [ppLoading,    setPpLoading]    = useState(false);
  const [ppStatus,     setPpStatus]     = useState(null);
  const [qboStatus,    setQboStatus]    = useState(null);
  const [qboLoading,   setQboLoading]   = useState(false);
  const [accounts,     setAccounts]     = useState([]);
  const [customers,    setCustomers]    = useState([]);
  const [items,        setItems]        = useState([]);
  const [mappings,     setMappings]     = useState({});
  const [saveLoading,  setSaveLoading]  = useState(false);
  const [message,      setMessage]      = useState('');
  const [error,        setError]        = useState('');

  // Load QBO data lazily when step 3 is shown
  const [qboDataLoaded, setQboDataLoaded] = useState(false);

  useEffect(() => {
    paypalApi.status().then(r => setPpStatus(r.data)).catch(() => {});
    qboApi.status().then(r => setQboStatus(r.data)).catch(() => {});
    qboApi.getMappings().then(r => {
      const m = {};
      r.data.forEach(row => { m[row.mapping_key] = row.qbo_account_id || ''; });
      setMappings(m);
    }).catch(() => {});

    if (searchParams.get('qbo_connected')) {
      setMessage('QuickBooks connected successfully!');
      qboApi.status().then(r => setQboStatus(r.data)).catch(() => {});
      setStep(3);
    }
    if (searchParams.get('qbo_error')) {
      setError('QuickBooks connection failed: ' + searchParams.get('qbo_error'));
    }
  }, []);

  const handlePayPalSave = async () => {
    setPpLoading(true);
    setError('');
    try {
      await paypalApi.saveCredentials(ppClientId, ppSecret);
      setPpStatus({ connected: true });
      setPpClientId('');
      setPpSecret('');
      setMessage('PayPal credentials saved and verified!');
      setStep(2);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save PayPal credentials');
    } finally {
      setPpLoading(false);
    }
  };

  const handleQBOConnect = async () => {
    setQboLoading(true);
    setError('');
    try {
      const r = await qboApi.connect();
      window.location.href = r.data.authUrl;
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start QuickBooks connection');
      setQboLoading(false);
    }
  };

  const handleLoadQBOData = async () => {
    setError('');
    try {
      const [acctRes, custRes, itemRes] = await Promise.all([
        qboApi.accounts(),
        qboApi.customers(),
        qboApi.items(),
      ]);
      setAccounts(acctRes.data);
      setCustomers(custRes.data);
      setItems(itemRes.data);
      setQboDataLoaded(true);
    } catch (err) {
      setError('Failed to load QBO data: ' + (err.response?.data?.error || err.message));
    }
  };

  const handleSaveMappings = async () => {
    setSaveLoading(true);
    setError('');
    try {
      // Build mappings array for account-type mappings
      const accountMappings = Object.entries(mappings)
        .filter(([key]) => !['paypal_sales_item', 'paypal_default_customer'].includes(key))
        .map(([mapping_key, qbo_account_id]) => {
          const acc = accounts.find(a => a.Id === qbo_account_id);
          return {
            mapping_key,
            qbo_account_id:   qbo_account_id || null,
            qbo_account_name: acc ? acc.Name : null,
            qbo_account_type: acc ? acc.AccountType : null,
          };
        });

      // Sales item mapping
      const itemId   = mappings['paypal_sales_item'] || null;
      const itemObj  = items.find(i => i.Id === itemId);
      accountMappings.push({
        mapping_key:      'paypal_sales_item',
        qbo_account_id:   itemId,
        qbo_account_name: itemObj ? itemObj.Name : null,
        qbo_account_type: 'Item',
      });

      // Default customer mapping
      const custId  = mappings['paypal_default_customer'] || null;
      const custObj = customers.find(c => c.Id === custId);
      accountMappings.push({
        mapping_key:      'paypal_default_customer',
        qbo_account_id:   custId,
        qbo_account_name: custObj ? custObj.DisplayName : null,
        qbo_account_type: 'Customer',
      });

      await qboApi.saveMappings(accountMappings);
      setMessage('Account mappings saved!');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save mappings');
    } finally {
      setSaveLoading(false);
    }
  };

  // Derived lists filtered by account type
  const bankAndAssetAccounts = accounts.filter(a => ['Bank', 'Other Current Asset'].includes(a.AccountType));
  const expenseAccounts      = accounts.filter(a => ['Expense', 'Cost of Goods Sold', 'Other Expense'].includes(a.AccountType));
  const incomeAccounts       = accounts.filter(a => ['Income', 'Other Income'].includes(a.AccountType));
  const liabilityAccounts    = accounts.filter(a => ['Credit Card', 'Other Current Liability', 'Long Term Liability'].includes(a.AccountType));

  const accountsByMappingKey = (key) => {
    if (key === 'paypal_bank')        return bankAndAssetAccounts;
    if (key === 'paypal_credit')      return [...liabilityAccounts, ...bankAndAssetAccounts]; // Credit Card type
    if (key === 'paypal_fees')        return expenseAccounts;
    if (key === 'paypal_sales')       return incomeAccounts;
    if (key === 'paypal_adjustments') return [...incomeAccounts, ...expenseAccounts];
    if (key === 'uncategorized')      return accounts;
    return accounts;
  };

  return (
    <div className="p-4 sm:p-8 max-w-3xl">
      <h1 className="text-2xl font-bold text-white mb-2">Setup Wizard</h1>
      <p className="text-gray-500 text-sm mb-8">Configure your PayPal and QuickBooks connections</p>

      {/* Steps indicator */}
      <div className="flex items-center gap-4 mb-8">
        <Step number={1} title="PayPal API"       active={step === 1} done={step > 1 || ppStatus?.connected} />
        <div className="flex-1 h-px bg-gray-800" />
        <Step number={2} title="QuickBooks OAuth" active={step === 2} done={step > 2 || qboStatus?.connected} />
        <div className="flex-1 h-px bg-gray-800" />
        <Step number={3} title="Account Mapping"  active={step === 3} done={false} />
      </div>

      {message && (
        <div className="mb-4 px-4 py-3 bg-green-900/30 border border-green-800 rounded-lg text-green-300 text-sm">
          {message}
        </div>
      )}
      {error && (
        <div className="mb-4 px-4 py-3 bg-red-900/30 border border-red-800 rounded-lg text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Step 1: PayPal */}
      <div className="card mb-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-200">Step 1 — PayPal API Credentials</h2>
          {ppStatus?.connected && (
            <span className="text-xs text-green-400 bg-green-900/30 px-2 py-1 rounded">✓ Connected</span>
          )}
        </div>
        {!ppStatus?.connected ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-500">
              Enter your PayPal REST API credentials from{' '}
              <a href="https://developer.paypal.com/developer/applications" target="_blank" rel="noreferrer"
                 className="text-blue-400 hover:underline">developer.paypal.com</a>.
            </p>
            <div>
              <label className="label">Client ID</label>
              <input className="input" value={ppClientId} onChange={e => setPpClientId(e.target.value)}
                     placeholder="AaBbCc..." />
            </div>
            <div>
              <label className="label">Client Secret</label>
              <input className="input" type="password" value={ppSecret}
                     onChange={e => setPpSecret(e.target.value)} placeholder="Secret..." />
            </div>
            <button className="btn-primary" onClick={handlePayPalSave}
                    disabled={ppLoading || !ppClientId || !ppSecret}>
              {ppLoading ? 'Verifying…' : 'Save & Verify'}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full bg-green-400" />
            <span className="text-sm text-gray-400">PayPal API is connected and verified</span>
            <button className="btn-secondary text-xs ml-auto" onClick={() => setPpStatus(null)}>
              Change Credentials
            </button>
          </div>
        )}
      </div>

      {/* Step 2: QuickBooks */}
      <div className="card mb-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-200">Step 2 — QuickBooks Online OAuth</h2>
          {qboStatus?.connected && (
            <span className="text-xs text-green-400 bg-green-900/30 px-2 py-1 rounded">✓ Connected</span>
          )}
        </div>
        {!qboStatus?.connected ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-500">
              Connect your QuickBooks Online company. You will be redirected to Intuit to authorize access.
              Make sure <code className="text-blue-300 text-xs">QBO_CLIENT_ID</code> and
              <code className="text-blue-300 text-xs ml-1">QBO_CLIENT_SECRET</code> are set in your environment.
            </p>
            <button className="btn-primary" onClick={handleQBOConnect} disabled={qboLoading}>
              {qboLoading ? 'Redirecting…' : 'Connect QuickBooks Online'}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-green-400" />
              <div>
                <p className="text-sm text-gray-300">{qboStatus.company?.CompanyName || 'Connected'}</p>
                <p className="text-xs text-gray-500">QuickBooks Online</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button className="btn-secondary text-xs"
                      onClick={() => { setStep(3); handleLoadQBOData(); }}>
                Next: Map Accounts
              </button>
              <button className="btn-danger text-xs"
                      onClick={() => qboApi.disconnect().then(() => setQboStatus({ connected: false }))}>
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Step 3: Account Mapping */}
      {(step === 3 || qboStatus?.connected) && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-200">Step 3 — Map QuickBooks Accounts</h2>
            <button className="btn-secondary text-xs" onClick={handleLoadQBOData}>
              ↺ Refresh
            </button>
          </div>

          <p className="text-sm text-gray-500 mb-6">
            Map each PayPal category to the correct QuickBooks account, item, and customer.
            The Sales Item and Default Customer unlock Sales Receipts — without them the
            syncer creates Journal Entries as a fallback.
          </p>

          {!qboDataLoaded ? (
            <button className="btn-secondary" onClick={handleLoadQBOData}>
              Load Chart of Accounts
            </button>
          ) : (
            <div className="space-y-10">

              {/* ── Sales Receipt setup ──────────────────────────────────── */}
              <div className="space-y-4">
                <div className="border-b border-gray-800 pb-2">
                  <h3 className="text-sm font-semibold text-gray-300">Sales Receipt Defaults</h3>
                  <p className="text-xs text-gray-500 mt-1">
                    Required to post customer payments as <strong className="text-gray-300">Sales Receipts</strong> and
                    refunds as <strong className="text-gray-300">Refund Receipts</strong> — the professional bookkeeping
                    approach. Without both fields the syncer falls back to Journal Entries.
                  </p>
                </div>

                {/* Sales Item */}
                <EntityPicker
                  label="PayPal Sales Item"
                  hint="Service/Non-Inventory item in QBO whose income account is your PayPal Sales account. Create one in QBO if needed (e.g. 'PayPal Sales')."
                  badge="Required for SalesReceipts"
                  items={items}
                  value={mappings['paypal_sales_item'] || ''}
                  onChange={v => setMappings(m => ({ ...m, paypal_sales_item: v }))}
                  getKey={i => i.Id}
                  getLabel={i => `${i.Name}${i.IncomeAccountRef?.name ? ` → ${i.IncomeAccountRef.name}` : ''}`}
                  emptyLabel="— No item selected (JournalEntry fallback) —"
                />

                {/* Default Customer */}
                <EntityPicker
                  label="Default PayPal Customer"
                  hint="QBO customer used when no specific customer has been matched to a PayPal transaction (e.g. a generic 'PayPal Customer' customer)."
                  badge="Required for SalesReceipts"
                  items={customers}
                  value={mappings['paypal_default_customer'] || ''}
                  onChange={v => setMappings(m => ({ ...m, paypal_default_customer: v }))}
                  getKey={c => c.Id}
                  getLabel={c => c.DisplayName}
                  emptyLabel="— No default customer (JournalEntry fallback) —"
                />

                {(!mappings['paypal_sales_item'] || !mappings['paypal_default_customer']) && (
                  <div className="flex items-start gap-2 px-3 py-2 bg-amber-900/20 border border-amber-800/40 rounded-lg">
                    <span className="text-amber-400 text-sm mt-0.5">⚠</span>
                    <p className="text-xs text-amber-300">
                      Both fields must be filled to enable Sales Receipts. The syncer will
                      use Journal Entries as a fallback until both are configured.
                    </p>
                  </div>
                )}
              </div>

              {/* ── Core PayPal accounts ──────────────────────────────────── */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-300 border-b border-gray-800 pb-2">
                  Core PayPal Accounts
                </h3>
                {Object.entries(CORE_MAPPINGS).map(([key, { label, hint }]) => {
                  const filteredAccounts = accountsByMappingKey(key);
                  return (
                    <div key={key}>
                      <label className="label">{label}</label>
                      <p className="text-xs text-gray-600 mb-1">{hint}</p>
                      <select
                        className="input"
                        value={mappings[key] || ''}
                        onChange={e => setMappings(m => ({ ...m, [key]: e.target.value }))}
                      >
                        <option value="">— Select account —</option>
                        {filteredAccounts.map(a => (
                          <option key={a.Id} value={a.Id}>{a.Name} ({a.AccountType})</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>

              {/* ── PayPal-connected bank accounts ───────────────────────── */}
              <div className="space-y-4">
                <div className="border-b border-gray-800 pb-2">
                  <h3 className="text-sm font-semibold text-gray-300">PayPal-Connected Bank Accounts</h3>
                  <p className="text-xs text-gray-500 mt-1">
                    The physical bank accounts you transfer money to/from PayPal. Up to 3.
                    Used to suggest matching QBO bank transactions when reviewing PayPal transfers.
                  </p>
                </div>
                {BANK_MAPPING_KEYS.map(key => {
                  const slotNum = key.slice(-1);
                  return (
                    <div key={key} className="bg-gray-800/30 border border-gray-700/40 rounded-xl p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-xs font-bold bg-blue-900/50 text-blue-300 border border-blue-800/50 rounded-full w-5 h-5 flex items-center justify-center">
                          {slotNum}
                        </span>
                        <label className="label mb-0">{BANK_MAPPING_LABELS[key]}</label>
                        {mappings[key] && <span className="ml-auto text-xs text-emerald-400">✓ Mapped</span>}
                      </div>
                      <select
                        className="input"
                        value={mappings[key] || ''}
                        onChange={e => setMappings(m => ({ ...m, [key]: e.target.value }))}
                      >
                        <option value="">— Not used —</option>
                        {bankAndAssetAccounts.map(a => (
                          <option key={a.Id} value={a.Id}>{a.Name}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>

              <button className="btn-primary" onClick={handleSaveMappings} disabled={saveLoading}>
                {saveLoading ? 'Saving…' : 'Save All Mappings'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
