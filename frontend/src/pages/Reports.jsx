import React, { useEffect, useState, useCallback } from 'react';
import { reportsApi } from '../api/client';

function fmt(n, opts = {}) {
  const v = parseFloat(n || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', ...opts }).format(v);
}
function fmtShort(n) {
  return fmt(n, { notation: 'compact', maximumFractionDigits: 1 });
}

const CATEGORY_LABELS = {
  sale:                    'Sales / Payments',
  paypal_fee:              'PayPal Fees',
  paypal_credit_purchase:  'PP Credit Purchases',
  paypal_credit_repayment: 'PP Credit Repayments',
  bank_transfer_in:        'Bank → PayPal',
  bank_transfer_out:       'PayPal → Bank',
  refund:                  'Refunds',
  noise:                   'Noise / Holds',
  unknown:                 'Needs Review',
};

// ── Status card ──────────────────────────────────────────────────────────────
function StatusCard({ label, count, gross, icon, color }) {
  const colors = {
    green:  { card: 'border-green-700/60  bg-green-900/10',   val: 'text-green-400',  cnt: 'text-green-300'  },
    purple: { card: 'border-purple-700/60 bg-purple-900/10',  val: 'text-purple-400', cnt: 'text-purple-300' },
    amber:  { card: 'border-amber-700/60  bg-amber-900/10',   val: 'text-amber-400',  cnt: 'text-amber-300'  },
    red:    { card: 'border-red-700/60    bg-red-900/10',     val: 'text-red-400',    cnt: 'text-red-300'    },
    gray:   { card: 'border-gray-700/60   bg-gray-800/20',    val: 'text-gray-400',   cnt: 'text-gray-300'   },
  };
  const c = colors[color] || colors.gray;
  return (
    <div className={`rounded-xl border ${c.card} px-5 py-4`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base">{icon}</span>
        <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">{label}</span>
      </div>
      <p className={`text-3xl font-bold ${c.cnt}`}>{count.toLocaleString()}</p>
      {gross !== undefined && (
        <p className={`text-sm font-mono mt-1 ${c.val}`}>{fmt(gross)}</p>
      )}
    </div>
  );
}

// ── Reconciliation / Detail tab ──────────────────────────────────────────────
function ReconciliationDetail({ detail, loading }) {
  if (loading) return <div className="text-gray-500 text-sm py-8 text-center">Loading…</div>;
  if (!detail) return null;

  const { statusSummary: ss, categoryMatrix, syncCoverage, dailyTotals } = detail;

  const totalPending = (ss.approved?.count || 0) + (ss.classified?.count || 0) + (ss.needs_review?.count || 0);
  const totalPendingGross = (ss.approved?.gross || 0) + (ss.classified?.gross || 0) + (ss.needs_review?.gross || 0);

  return (
    <div className="space-y-6">
      {/* Status summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatusCard label="Synced to QBO" count={ss.synced?.count || 0}  gross={ss.synced?.net}  icon="✓" color="green"  />
        <StatusCard label="Ready to Sync" count={ss.approved?.count || 0} gross={ss.approved?.gross} icon="↑" color="purple" />
        <StatusCard label="Needs Review"  count={ss.needs_review?.count || 0} icon="⚠" color="amber"  />
        <StatusCard label="Failed"        count={ss.failed?.count || 0}   icon="✕" color="red"    />
      </div>

      {/* Sync coverage bar */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-gray-300">QBO Sync Coverage</span>
          <span className="font-bold text-white">
            {syncCoverage.synced.toLocaleString()} / {syncCoverage.total_eligible.toLocaleString()}
            <span className="text-gray-500 font-normal ml-1">({syncCoverage.pct}%)</span>
          </span>
        </div>
        <div className="w-full bg-gray-800 rounded-full h-3 overflow-hidden">
          <div
            className="h-3 rounded-full transition-all duration-700 bg-gradient-to-r from-emerald-600 to-emerald-400"
            style={{ width: `${syncCoverage.pct}%` }}
          />
        </div>
        <div className="grid grid-cols-3 gap-4 text-xs text-gray-500 pt-1">
          <div>
            <span className="text-emerald-400 font-semibold">{ss.synced?.count || 0}</span> synced
          </div>
          <div>
            <span className="text-purple-400 font-semibold">{totalPending}</span> pending
            {totalPendingGross !== 0 && <span className="ml-1">({fmtShort(totalPendingGross)})</span>}
          </div>
          <div>
            <span className="text-red-400 font-semibold">{ss.failed?.count || 0}</span> failed
          </div>
        </div>
      </div>

      {/* Category × Status matrix */}
      <div className="card p-0 overflow-x-auto">
        <div className="px-5 py-3 border-b border-gray-800">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Category Breakdown</p>
        </div>
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-900/40">
              <th className="table-th text-left">Category</th>
              <th className="table-th text-right">Total</th>
              <th className="table-th text-right">Synced ✓</th>
              <th className="table-th text-right">Approved</th>
              <th className="table-th text-right">Review Needed</th>
              <th className="table-th text-right">Failed</th>
              <th className="table-th text-right w-28">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {categoryMatrix.map(row => {
              const synced  = row.synced_count  || 0;
              const total   = row.total_count   || 0;
              const pct     = total > 0 ? Math.round((synced / total) * 100) : 0;
              return (
                <tr key={row.category} className="table-tr">
                  <td className="table-td font-medium text-gray-300">
                    {CATEGORY_LABELS[row.category] || row.category}
                  </td>
                  <td className="table-td text-right">
                    <span className="text-white font-semibold">{total}</span>
                    <span className="text-gray-600 font-mono text-xs ml-1">
                      {fmtShort(row.total_gross)}
                    </span>
                  </td>
                  <td className="table-td text-right text-emerald-400">
                    {synced || '—'}
                  </td>
                  <td className="table-td text-right text-purple-400">
                    {row.approved_count || '—'}
                  </td>
                  <td className="table-td text-right text-amber-400">
                    {(row.needs_review_count || 0) + (row.classified_count || 0) || '—'}
                  </td>
                  <td className="table-td text-right text-red-400">
                    {row.failed_count || '—'}
                  </td>
                  <td className="table-td text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 bg-gray-800 rounded-full h-1.5">
                        <div
                          className="h-1.5 rounded-full bg-emerald-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-500 w-8 text-right">{pct}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Daily totals */}
      {dailyTotals.length > 0 && (
        <div className="card p-0 overflow-x-auto">
          <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Daily Activity</p>
            <p className="text-xs text-gray-600">{dailyTotals.length} days</p>
          </div>
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900/40">
                <th className="table-th text-left">Date</th>
                <th className="table-th text-right">Count</th>
                <th className="table-th text-right">Gross In</th>
                <th className="table-th text-right">Gross Out</th>
                <th className="table-th text-right">Net</th>
                <th className="table-th text-right">Synced</th>
              </tr>
            </thead>
            <tbody>
              {dailyTotals.map(d => (
                <tr key={d.transaction_date} className="table-tr">
                  <td className="table-td text-gray-400 font-mono text-xs">{d.transaction_date}</td>
                  <td className="table-td text-right text-gray-300">{parseInt(d.cnt, 10)}</td>
                  <td className="table-td text-right font-mono text-xs text-green-400">{fmt(d.gross_in)}</td>
                  <td className="table-td text-right font-mono text-xs text-red-400">{d.gross_out > 0 ? `(${fmt(d.gross_out)})` : '—'}</td>
                  <td className={`table-td text-right font-mono text-xs font-medium ${parseFloat(d.net || 0) >= 0 ? 'text-gray-200' : 'text-red-300'}`}>
                    {fmt(d.net)}
                  </td>
                  <td className="table-td text-right">
                    <span className="text-emerald-400 text-xs">{parseInt(d.synced_count, 10)}</span>
                    <span className="text-gray-600 text-xs">/{parseInt(d.cnt, 10)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Legacy summary row (for original reconciliation tab) ─────────────────────
function SummaryRow({ label, data, highlight = false }) {
  return (
    <tr className={`border-b border-gray-800 ${highlight ? 'bg-gray-800/30' : ''}`}>
      <td className="px-4 py-3 text-sm text-gray-300">{label}</td>
      <td className="px-4 py-3 text-sm text-right font-mono text-gray-400">{data?.count ?? '—'}</td>
      <td className={`px-4 py-3 text-sm text-right font-mono font-medium ${parseFloat(data?.gross || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
        {fmt(data?.gross)}
      </td>
      <td className="px-4 py-3 text-sm text-right font-mono text-orange-400">{fmt(data?.fees)}</td>
      <td className="px-4 py-3 text-sm text-right font-mono text-gray-300">{fmt(data?.net)}</td>
    </tr>
  );
}

// ── CSV export helper ────────────────────────────────────────────────────────
function exportCSV(rows, filename) {
  if (!rows || rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const header = keys.join(',');
  const body   = rows.map(r =>
    keys.map(k => {
      const v = r[k] ?? '';
      return typeof v === 'string' && v.includes(',') ? `"${v}"` : v;
    }).join(',')
  ).join('\n');
  const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main component ───────────────────────────────────────────────────────────
export default function Reports() {
  const today  = new Date().toISOString().slice(0, 10);
  const first  = new Date(new Date().setDate(1)).toISOString().slice(0, 10);

  const [startDate,  setStartDate]  = useState(first);
  const [endDate,    setEndDate]    = useState(today);
  const [recon,      setRecon]      = useState(null);
  const [detail,     setDetail]     = useState(null);
  const [fees,       setFees]       = useState(null);
  const [exceptions, setExceptions] = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [tab,        setTab]        = useState('detail');

  const loadReports = useCallback(async () => {
    setLoading(true);
    try {
      const params = { startDate, endDate };
      const [r, d, f, e] = await Promise.all([
        reportsApi.reconciliation(params),
        reportsApi.detail(params),
        reportsApi.fees(params),
        reportsApi.exceptions(),
      ]);
      setRecon(r.data);
      setDetail(d.data);
      setFees(f.data);
      setExceptions(e.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => { loadReports(); }, []);

  const tabs = [
    { id: 'detail',         label: 'Reconciliation' },
    { id: 'reconciliation', label: 'Category Summary' },
    { id: 'fees',           label: 'Fees' },
    { id: 'exceptions',     label: `Exceptions (${exceptions.length})` },
  ];

  return (
    <div className="p-4 sm:p-8 space-y-5 sm:space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Reports</h1>
          <p className="text-gray-500 text-sm mt-1">PayPal reconciliation summaries</p>
        </div>
      </div>

      {/* Date filter */}
      <div className="card flex items-end gap-3 sm:gap-4 flex-wrap">
        <div className="w-full sm:w-auto">
          <label className="label">Start Date</label>
          <input type="date" className="input sm:w-44" value={startDate}
                 onChange={e => setStartDate(e.target.value)} />
        </div>
        <div className="w-full sm:w-auto">
          <label className="label">End Date</label>
          <input type="date" className="input sm:w-44" value={endDate}
                 onChange={e => setEndDate(e.target.value)} />
        </div>
        <button className="btn-primary" onClick={loadReports} disabled={loading}>
          {loading ? 'Loading…' : 'Run Reports'}
        </button>

        {/* Export buttons */}
        {tab === 'detail' && detail && (
          <div className="flex gap-2 ml-auto">
            <button
              className="btn-secondary text-xs px-3"
              onClick={() => exportCSV(
                detail.categoryMatrix.map(r => ({
                  Category: CATEGORY_LABELS[r.category] || r.category,
                  'Total Count': r.total_count,
                  'Total Gross': r.total_gross?.toFixed(2),
                  'Synced Count': r.synced_count || 0,
                  'Approved Count': r.approved_count || 0,
                  'Needs Review': (r.needs_review_count || 0) + (r.classified_count || 0),
                  'Failed': r.failed_count || 0,
                })),
                `reconciliation-${startDate}-${endDate}.csv`
              )}
            >
              Export Summary CSV
            </button>
            <button
              className="btn-secondary text-xs px-3"
              onClick={() => exportCSV(
                detail.dailyTotals.map(d => ({
                  Date: d.transaction_date,
                  Count: parseInt(d.cnt, 10),
                  'Gross In': parseFloat(d.gross_in || 0).toFixed(2),
                  'Gross Out': parseFloat(d.gross_out || 0).toFixed(2),
                  'Net': parseFloat(d.net || 0).toFixed(2),
                  'Synced': parseInt(d.synced_count, 10),
                })),
                `daily-${startDate}-${endDate}.csv`
              )}
            >
              Export Daily CSV
            </button>
          </div>
        )}
        {tab === 'fees' && fees?.rows && (
          <button
            className="btn-secondary text-xs px-3 ml-auto"
            onClick={() => exportCSV(
              fees.rows.map(r => ({
                Date: r.transaction_date,
                Description: r.description,
                Category: r.category,
                'Fee Amount': parseFloat(r.fee_amount || 0).toFixed(2),
                Status: r.status,
              })),
              `fees-${startDate}-${endDate}.csv`
            )}
          >
            Export CSV
          </button>
        )}
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 border-b border-gray-800">
        {tabs.map(t => (
          <button key={t.id}
                  className={`px-4 py-2 text-sm font-medium transition-colors
                    ${tab === t.id ? 'text-blue-400 border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-300'}`}
                  onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Reconciliation detail tab */}
      {tab === 'detail' && (
        <ReconciliationDetail detail={detail} loading={loading} />
      )}

      {/* Category summary (legacy) tab */}
      {tab === 'reconciliation' && recon && (
        <div className="card p-0 overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase">Category</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase">Count</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase">Gross</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase">Fees</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase">Net</th>
              </tr>
            </thead>
            <tbody>
              <SummaryRow label="Sales / Customer Payments"      data={recon.sales}             highlight />
              <SummaryRow label="PayPal Fees (standalone)"       data={recon.standalone_fees}   />
              <SummaryRow label="PayPal Credit Purchases"        data={recon.credit_purchases}  />
              <SummaryRow label="PayPal Credit Repayments"       data={recon.credit_repayments} />
              <SummaryRow label="Bank → PayPal Funding"          data={recon.bank_transfers_in} />
              <SummaryRow label="PayPal → Bank Withdrawals"      data={recon.bank_transfers_out}/>
              <SummaryRow label="Refunds"                        data={recon.refunds}           />
              <tr className="border-b border-gray-700 bg-gray-800/50">
                <td className="px-4 py-3 text-sm font-semibold text-yellow-400">Needs Review</td>
                <td className="px-4 py-3 text-sm text-right font-mono text-yellow-400">{recon.needs_review?.count}</td>
                <td colSpan={3} className="px-4 py-3 text-xs text-gray-500 text-right">
                  Not included in totals — classify before syncing
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Fees tab */}
      {tab === 'fees' && fees && (
        <div className="space-y-4">
          <div className="card">
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Total Fees</p>
            <p className="text-3xl font-bold text-orange-400">{fmt(fees.totals?.total_fees)}</p>
            <p className="text-sm text-gray-500 mt-1">{fees.totals?.tx_count} fee records</p>
          </div>
          <div className="card p-0 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="table-th">Date</th>
                  <th className="table-th">Description</th>
                  <th className="table-th">Category</th>
                  <th className="table-th">Fee Amount</th>
                  <th className="table-th">Status</th>
                </tr>
              </thead>
              <tbody>
                {(fees.rows || []).slice(0, 200).map(tx => (
                  <tr key={tx.id} className="table-tr">
                    <td className="table-td text-xs text-gray-500">{tx.transaction_date}</td>
                    <td className="table-td text-xs text-gray-400 max-w-[200px] truncate">{tx.description}</td>
                    <td className="table-td text-xs text-gray-500">{tx.category}</td>
                    <td className="table-td font-mono text-xs text-orange-400">{fmt(tx.fee_amount)}</td>
                    <td className="table-td text-xs text-gray-500">{tx.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Exceptions tab */}
      {tab === 'exceptions' && (
        <div className="card p-0 overflow-x-auto">
          {exceptions.length === 0 ? (
            <div className="p-8 text-center text-gray-500">No exceptions — everything is classified</div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="table-th">Date</th>
                  <th className="table-th">PayPal ID</th>
                  <th className="table-th">Payer</th>
                  <th className="table-th">Description</th>
                  <th className="table-th">Gross</th>
                  <th className="table-th">Status</th>
                </tr>
              </thead>
              <tbody>
                {exceptions.map(tx => (
                  <tr key={tx.id} className="table-tr">
                    <td className="table-td text-xs text-gray-500">{tx.transaction_date}</td>
                    <td className="table-td font-mono text-xs text-gray-600">{tx.paypal_transaction_id}</td>
                    <td className="table-td text-xs text-gray-300">{tx.payer_name || '—'}</td>
                    <td className="table-td text-xs text-gray-500 max-w-[200px] truncate">{tx.description}</td>
                    <td className={`table-td font-mono text-xs ${parseFloat(tx.gross_amount) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {fmt(tx.gross_amount)}
                    </td>
                    <td className="table-td text-xs text-yellow-400">{tx.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
