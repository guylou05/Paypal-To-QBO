import React, { useEffect, useState } from 'react';
import { reportsApi } from '../api/client';

function fmt(n) {
  const v = parseFloat(n || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
}

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

export default function Reports() {
  const today  = new Date().toISOString().slice(0, 10);
  const first  = new Date(new Date().setDate(1)).toISOString().slice(0, 10);

  const [startDate,  setStartDate]  = useState(first);
  const [endDate,    setEndDate]    = useState(today);
  const [recon,      setRecon]      = useState(null);
  const [fees,       setFees]       = useState(null);
  const [exceptions, setExceptions] = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [tab,        setTab]        = useState('reconciliation');

  const loadReports = async () => {
    setLoading(true);
    try {
      const params = { startDate, endDate };
      const [r, f, e] = await Promise.all([
        reportsApi.reconciliation(params),
        reportsApi.fees(params),
        reportsApi.exceptions(),
      ]);
      setRecon(r.data);
      setFees(f.data);
      setExceptions(e.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadReports(); }, []);

  const tabs = [
    { id: 'reconciliation', label: 'Reconciliation' },
    { id: 'fees',           label: 'Fees' },
    { id: 'exceptions',     label: `Exceptions (${exceptions.length})` },
  ];

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Reports</h1>
        <p className="text-gray-500 text-sm mt-1">PayPal reconciliation summaries</p>
      </div>

      {/* Date filter */}
      <div className="card flex items-end gap-4 flex-wrap">
        <div>
          <label className="label">Start Date</label>
          <input type="date" className="input w-44" value={startDate}
                 onChange={e => setStartDate(e.target.value)} />
        </div>
        <div>
          <label className="label">End Date</label>
          <input type="date" className="input w-44" value={endDate}
                 onChange={e => setEndDate(e.target.value)} />
        </div>
        <button className="btn-primary" onClick={loadReports} disabled={loading}>
          {loading ? 'Loading…' : 'Run Reports'}
        </button>
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

      {/* Reconciliation tab */}
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
