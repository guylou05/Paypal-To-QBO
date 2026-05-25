import React, { useEffect, useState, useCallback } from 'react';
import { txApi } from '../api/client';
import StatusBadge from '../components/StatusBadge';

function fmt(n) {
  const v = parseFloat(n || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
}

export default function SyncToQBO() {
  const [approved,  setApproved]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [syncing,   setSyncing]   = useState(new Set());
  const [syncAll,   setSyncAll]   = useState(false);
  const [results,   setResults]   = useState([]);
  const [selected,  setSelected]  = useState(new Set());

  const loadApproved = useCallback(async () => {
    setLoading(true);
    try {
      const r = await txApi.list({ status: 'approved', pageSize: 500 });
      setApproved(r.data.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadApproved(); }, []);

  const syncOne = async (tx) => {
    setSyncing(s => new Set([...s, tx.id]));
    try {
      const r = await txApi.sync(tx.id);
      setResults(prev => [{ id: tx.id, ppId: tx.paypal_transaction_id, status: 'success',
        qboId: r.data.qboId, type: r.data.qboObjectType }, ...prev]);
      setApproved(prev => prev.filter(t => t.id !== tx.id));
    } catch (err) {
      setResults(prev => [{ id: tx.id, ppId: tx.paypal_transaction_id, status: 'failed',
        error: err.response?.data?.error || err.message }, ...prev]);
    } finally {
      setSyncing(s => { const n = new Set(s); n.delete(tx.id); return n; });
    }
  };

  const syncSelected = async () => {
    const toSync = approved.filter(tx => selected.has(tx.id));
    for (const tx of toSync) {
      await syncOne(tx);
      await new Promise(r => setTimeout(r, 300)); // rate-limit QBO API
    }
    loadApproved();
  };

  const syncAllApproved = async () => {
    setSyncAll(true);
    for (const tx of approved) {
      await syncOne(tx);
      await new Promise(r => setTimeout(r, 400));
    }
    setSyncAll(false);
    loadApproved();
  };

  const rollback = async (tx) => {
    if (!confirm(`Roll back QBO entry for transaction ${tx.paypal_transaction_id}?`)) return;
    try {
      await txApi.rollback(tx.id);
      alert('Rolled back successfully. Transaction returned to Approved.');
      loadApproved();
    } catch (err) {
      alert('Rollback failed: ' + (err.response?.data?.error || err.message));
    }
  };

  const toggleSelect = (id) => {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const totalGross = approved.reduce((s, tx) => s + parseFloat(tx.gross_amount || 0), 0);

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Sync to QuickBooks</h1>
        <p className="text-gray-500 text-sm mt-1">
          Post approved transactions to QuickBooks Online. Every transaction requires review before posting.
        </p>
      </div>

      {/* Summary card */}
      <div className="card">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-3xl font-bold text-white">{approved.length}</p>
            <p className="text-sm text-gray-500 mt-1">transactions approved and ready to sync</p>
            <p className="text-xs text-gray-600 mt-0.5">
              Total gross: <span className="text-gray-400">{fmt(totalGross)}</span>
            </p>
          </div>
          <div className="flex gap-3">
            {selected.size > 0 && (
              <button className="btn-success" onClick={syncSelected} disabled={syncAll}>
                Sync Selected ({selected.size})
              </button>
            )}
            <button className="btn-success" onClick={syncAllApproved}
                    disabled={syncAll || approved.length === 0 || syncing.size > 0}>
              {syncAll ? `Syncing… (${syncing.size} in flight)` : `Sync All ${approved.length}`}
            </button>
          </div>
        </div>
      </div>

      {/* Approved transactions */}
      {loading ? (
        <div className="text-gray-500 text-sm">Loading approved transactions…</div>
      ) : approved.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-400 text-lg mb-2">No transactions awaiting sync</p>
          <p className="text-gray-600 text-sm">Approve transactions in the Review Queue first.</p>
        </div>
      ) : (
        <div className="card p-0 overflow-x-auto">
          <table className="w-full min-w-[800px]">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="table-th w-10">
                  <input type="checkbox"
                         checked={selected.size === approved.length}
                         onChange={() => setSelected(selected.size === approved.length
                           ? new Set()
                           : new Set(approved.map(t => t.id))
                         )} />
                </th>
                <th className="table-th">Date</th>
                <th className="table-th">PayPal ID</th>
                <th className="table-th">Payer</th>
                <th className="table-th">Category</th>
                <th className="table-th">Gross</th>
                <th className="table-th">Fee</th>
                <th className="table-th">Net</th>
                <th className="table-th">Action</th>
              </tr>
            </thead>
            <tbody>
              {approved.map(tx => (
                <tr key={tx.id} className={`table-tr ${selected.has(tx.id) ? 'bg-blue-900/10' : ''}`}>
                  <td className="table-td">
                    <input type="checkbox" checked={selected.has(tx.id)}
                           onChange={() => toggleSelect(tx.id)} />
                  </td>
                  <td className="table-td text-xs text-gray-400">{tx.transaction_date}</td>
                  <td className="table-td font-mono text-xs text-gray-500">{tx.paypal_transaction_id}</td>
                  <td className="table-td text-xs">
                    <p className="text-gray-300">{tx.payer_name || '—'}</p>
                  </td>
                  <td className="table-td">
                    <StatusBadge value={tx.override_category || tx.category} type="category" />
                  </td>
                  <td className={`table-td font-mono text-xs font-medium ${parseFloat(tx.gross_amount) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {fmt(tx.gross_amount)}
                  </td>
                  <td className="table-td font-mono text-xs text-gray-500">{fmt(tx.fee_amount)}</td>
                  <td className="table-td font-mono text-xs text-gray-300">{fmt(tx.net_amount)}</td>
                  <td className="table-td">
                    <div className="flex gap-2">
                      <button
                        className="btn-success text-xs px-2 py-1"
                        disabled={syncing.has(tx.id) || syncAll}
                        onClick={() => syncOne(tx)}
                      >
                        {syncing.has(tx.id) ? '…' : 'Sync'}
                      </button>
                      <button className="btn-danger text-xs px-2 py-1" onClick={() => rollback(tx)}
                              disabled={tx.status !== 'synced'}>
                        Rollback
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Sync results log */}
      {results.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-200">Sync Results (this session)</h2>
            <button className="text-xs text-gray-500 hover:text-gray-300"
                    onClick={() => setResults([])}>Clear</button>
          </div>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {results.map((r, i) => (
              <div key={i} className={`flex items-center gap-3 px-3 py-2 rounded text-xs
                ${r.status === 'success' ? 'bg-green-900/20 border border-green-800' : 'bg-red-900/20 border border-red-800'}`}>
                <span className={r.status === 'success' ? 'text-green-400' : 'text-red-400'}>
                  {r.status === 'success' ? '✓' : '✕'}
                </span>
                <span className="font-mono text-gray-400">{r.ppId}</span>
                {r.status === 'success'
                  ? <span className="text-gray-400">→ QBO {r.type} <span className="font-mono">{r.qboId}</span></span>
                  : <span className="text-red-400">{r.error}</span>
                }
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
