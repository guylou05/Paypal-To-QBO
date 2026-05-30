import React, { useEffect, useState, useCallback, useRef } from 'react';
import { txApi, qboApi, logsApi } from '../api/client';
import StatusBadge from '../components/StatusBadge';
import { buildQboUrl } from '../utils/qboUrl';

function fmt(n) {
  const v = parseFloat(n || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
}

function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Server-side sync batch poller ──────────────────────────────────────────
/**
 * Displays a live progress card for a server-side sync_batch.
 * Polls GET /transactions/sync-queue/:batchId every 2 s until done.
 */
function SyncBatchCard({ batchId, qboEnvironment, onDone }) {
  const [batch,    setBatch]    = useState(null);
  const [jobs,     setJobs]     = useState([]);
  const [cancelling, setCancelling] = useState(false);
  const pollRef = useRef(null);

  const poll = useCallback(async () => {
    try {
      const r = await txApi.syncBatchStatus(batchId);
      setBatch(r.data.batch);
      setJobs(r.data.jobs);
      if (['complete','partial','failed','cancelled'].includes(r.data.batch.status)) {
        clearInterval(pollRef.current);
        onDone(r.data);
      }
    } catch { /* keep polling */ }
  }, [batchId, onDone]);

  useEffect(() => {
    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => clearInterval(pollRef.current);
  }, [poll]);

  const handleCancel = async () => {
    setCancelling(true);
    try { await txApi.cancelSyncBatch(batchId); } catch { /* ignore */ }
    finally { setCancelling(false); }
  };

  if (!batch) return (
    <div className="card flex items-center gap-3 text-gray-500 text-sm">
      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500" />
      Connecting to sync queue…
    </div>
  );

  const total     = batch.total_jobs    || 0;
  const completed = batch.completed_jobs || 0;
  const failed    = batch.failed_jobs    || 0;
  const done      = completed + failed;
  const pct       = total > 0 ? Math.round((done / total) * 100) : 0;
  const running   = batch.status === 'running';

  const failedJobs = jobs.filter(j => j.status === 'failed');

  const borderCls = batch.status === 'complete'  ? 'border-green-800'
                  : batch.status === 'failed'     ? 'border-red-800'
                  : batch.status === 'partial'    ? 'border-amber-800'
                  : batch.status === 'cancelled'  ? 'border-gray-700'
                  :                                 'border-blue-800';

  return (
    <div className={`card border ${borderCls} space-y-4`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {running && <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500 shrink-0" />}
          <h2 className="font-semibold text-gray-200">
            {batch.status === 'running'   ? 'Syncing on server…'
           : batch.status === 'complete'  ? 'Sync Complete'
           : batch.status === 'partial'   ? 'Sync Finished with Errors'
           : batch.status === 'failed'    ? 'Sync Failed'
           : batch.status === 'cancelled' ? 'Sync Cancelled'
           : batch.status}
          </h2>
        </div>
        {running && (
          <button
            className="btn-danger text-xs px-3 py-1.5 shrink-0"
            onClick={handleCancel}
            disabled={cancelling}
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs text-gray-500">
          <span>{running ? 'Server is processing transactions…' : `${done} of ${total} processed`}</span>
          <span>{done}/{total} ({pct}%)</span>
        </div>
        <div className="w-full bg-gray-800 rounded-full h-2.5 overflow-hidden">
          <div
            className={`h-2.5 rounded-full transition-all duration-500
              ${batch.status === 'failed'   ? 'bg-red-500'
              : batch.status === 'partial'  ? 'bg-amber-500'
              : batch.status === 'complete' ? 'bg-emerald-500'
              :                              'bg-blue-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3 text-center">
        <div>
          <p className="text-xl font-bold text-emerald-400">{completed}</p>
          <p className="text-xs text-gray-500">Synced</p>
        </div>
        <div>
          <p className="text-xl font-bold text-red-400">{failed}</p>
          <p className="text-xs text-gray-500">Failed</p>
        </div>
        <div>
          <p className="text-xl font-bold text-gray-400">{total - done}</p>
          <p className="text-xs text-gray-500">Pending</p>
        </div>
      </div>

      {/* Failed job details */}
      {failedJobs.length > 0 && (
        <div className="border-t border-gray-800 pt-3 space-y-1.5">
          <p className="text-xs text-red-400 font-semibold uppercase tracking-wider">Failed transactions</p>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {failedJobs.map(j => {
              const payload = j.result_payload && (typeof j.result_payload === 'string' ? JSON.parse(j.result_payload) : j.result_payload);
              const qboUrl  = payload?.qboId && payload?.qboObjectType
                ? buildQboUrl(payload.qboObjectType, payload.qboId, qboEnvironment)
                : null;
              return (
                <div key={j.id} className="flex items-start gap-2 px-3 py-2 bg-red-900/20 border border-red-800 rounded text-xs">
                  <span className="text-red-400 shrink-0">✕</span>
                  <div className="min-w-0">
                    <span className="font-mono text-gray-400">{j.paypal_transaction_id}</span>
                    {j.error_message && (
                      <p className="text-red-300 text-[11px] mt-0.5 truncate">{j.error_message}</p>
                    )}
                    {qboUrl && (
                      <a href={qboUrl} target="_blank" rel="noopener noreferrer"
                         className="text-emerald-400 hover:underline text-[11px]">
                        View in QBO ↗
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function SyncToQBO() {
  // ── Ready-to-sync (approved) state ──────────────────────────────────────
  const [approved,       setApproved]       = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [syncing,        setSyncing]        = useState(new Set());
  const [selected,       setSelected]       = useState(new Set());
  const [qboEnvironment, setQboEnvironment] = useState('production');

  // Immediate sync results (single-tx "Sync" buttons)
  const [results, setResults] = useState([]);

  // Server-side queue state (Sync All / Sync Selected / Retry)
  const [activeBatchId, setActiveBatchId] = useState(null);
  const [batchHistory,  setBatchHistory]  = useState([]);
  const [enqueuing,     setEnqueuing]     = useState(false);

  // ── Failed transactions state ────────────────────────────────────────────
  const [failed,          setFailed]         = useState([]);
  const [loadingFailed,   setLoadingFailed]   = useState(false);
  const [selectedFailed,  setSelectedFailed]  = useState(new Set());
  const [retrying,        setRetrying]        = useState(false);

  // ── Sync history state ───────────────────────────────────────────────────
  const [syncHistory,       setSyncHistory]      = useState([]);
  const [loadingHistory,    setLoadingHistory]    = useState(false);
  const [historyPage,       setHistoryPage]       = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);
  const [historyFilter,     setHistoryFilter]     = useState('');
  const HISTORY_PAGE_SIZE = 25;

  // ── Active tab ───────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('ready');

  // ── Data loaders ─────────────────────────────────────────────────────────
  const loadApproved = useCallback(async () => {
    setLoading(true);
    try {
      const r = await txApi.list({ status: 'approved', pageSize: 500 });
      setApproved(r.data.data);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFailed = useCallback(async () => {
    setLoadingFailed(true);
    try {
      const r = await txApi.list({ status: 'failed', pageSize: 500 });
      setFailed(r.data.data);
    } finally {
      setLoadingFailed(false);
    }
  }, []);

  const loadHistory = useCallback(async (page = 1, filter = '') => {
    setLoadingHistory(true);
    try {
      const params = { page, pageSize: HISTORY_PAGE_SIZE };
      if (filter) params.status = filter;
      const r = await logsApi.sync(params);
      setSyncHistory(r.data.data);
      setHistoryTotalPages(r.data.totalPages || 1);
      setHistoryPage(page);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    loadApproved();
    loadFailed();
    qboApi.status()
      .then(r => setQboEnvironment(r.data.environment || 'production'))
      .catch(() => {});
  }, [loadApproved, loadFailed]);

  // Lazy-load history only when that tab is opened
  useEffect(() => {
    if (activeTab === 'history') {
      loadHistory(1, historyFilter);
    }
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Individual (synchronous) sync ─────────────────────────────────────────
  const syncOne = async (tx) => {
    setSyncing(s => new Set([...s, tx.id]));
    try {
      const r = await txApi.sync(tx.id);
      setResults(prev => [{
        id: tx.id, ppId: tx.paypal_transaction_id,
        status: 'success', qboId: r.data.qboId, type: r.data.qboObjectType,
      }, ...prev]);
      setApproved(prev => prev.filter(t => t.id !== tx.id));
    } catch (err) {
      setResults(prev => [{
        id: tx.id, ppId: tx.paypal_transaction_id,
        status: 'failed', error: err.response?.data?.error || err.message,
      }, ...prev]);
    } finally {
      setSyncing(s => { const n = new Set(s); n.delete(tx.id); return n; });
    }
  };

  // ── Server-side queue: enqueue a batch ───────────────────────────────────
  const enqueueBatch = async (ids) => {
    setEnqueuing(true);
    try {
      const r = await txApi.enqueueSyncBatch(ids);
      setActiveBatchId(r.data.batchId);
      setSelected(new Set());
    } catch (err) {
      alert('Failed to start sync: ' + (err.response?.data?.error || err.message));
    } finally {
      setEnqueuing(false);
    }
  };

  const handleSyncAll      = () => enqueueBatch(approved.map(t => t.id));
  const handleSyncSelected = () => enqueueBatch([...selected]);

  // ── Retry failed transactions ─────────────────────────────────────────────
  const handleRetry = async (ids) => {
    if (ids.length === 0) return;
    setRetrying(true);
    try {
      const r = await txApi.bulkRetry(ids);
      setActiveBatchId(r.data.batchId);
      setSelectedFailed(new Set());
    } catch (err) {
      alert('Failed to retry: ' + (err.response?.data?.error || err.message));
    } finally {
      setRetrying(false);
    }
  };

  const handleRetrySelected = () => handleRetry([...selectedFailed]);
  const handleRetryAll      = () => handleRetry(failed.map(t => t.id));

  // Called by SyncBatchCard when polling detects completion
  const handleBatchDone = useCallback((data) => {
    setBatchHistory(prev => [data, ...prev]);
    setActiveBatchId(null);
    loadApproved();
    loadFailed();
    // Reload history if already loaded (tab may have been visited)
    if (activeTab === 'history') loadHistory(1, historyFilter);
  }, [loadApproved, loadFailed, loadHistory, activeTab, historyFilter]);

  const rollback = async (tx) => {
    if (!confirm(`Roll back QBO entry for ${tx.paypal_transaction_id}?`)) return;
    try {
      await txApi.rollback(tx.id);
      alert('Rolled back successfully.');
      loadApproved();
    } catch (err) {
      alert('Rollback failed: ' + (err.response?.data?.error || err.message));
    }
  };

  const toggleSelect       = (id) =>
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleSelectFailed = (id) =>
    setSelectedFailed(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const totalGross    = approved.reduce((s, tx) => s + parseFloat(tx.gross_amount || 0), 0);
  const batchRunning  = !!activeBatchId;
  const failedResults = results.filter(r => r.status === 'failed');

  // ── Tabs config ───────────────────────────────────────────────────────────
  const tabs = [
    { id: 'ready',   label: `Ready to Sync${approved.length ? ` (${approved.length})` : ''}` },
    { id: 'failed',  label: `Failed${failed.length ? ` (${failed.length})` : ''}` },
    { id: 'history', label: 'Sync History' },
  ];

  return (
    <div className="p-4 sm:p-8 space-y-5 sm:space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Sync to QuickBooks</h1>
        <p className="text-gray-500 text-sm mt-1">
          Post approved transactions to QuickBooks Online.
          Bulk syncs run on the server — safe to close your browser.
        </p>
      </div>

      {/* Summary card */}
      <div className="card">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex gap-6">
            <div>
              <p className="text-3xl font-bold text-white">{approved.length}</p>
              <p className="text-sm text-gray-500 mt-1">ready to sync</p>
              {totalGross !== 0 && (
                <p className="text-xs text-gray-600 mt-0.5">
                  Total: <span className="text-gray-400">{fmt(totalGross)}</span>
                </p>
              )}
            </div>
            {failed.length > 0 && (
              <div className="border-l border-gray-800 pl-6">
                <p className="text-3xl font-bold text-red-400">{failed.length}</p>
                <p className="text-sm text-gray-500 mt-1">failed</p>
              </div>
            )}
          </div>
          <div className="flex gap-3 flex-wrap">
            {failed.length > 0 && (
              <button
                className="btn-danger"
                onClick={handleRetryAll}
                disabled={batchRunning || retrying}
                title="Reset all failed transactions to approved and re-queue them"
              >
                {retrying ? 'Queuing…' : `Retry All Failed (${failed.length})`}
              </button>
            )}
            {selected.size > 0 && activeTab === 'ready' && (
              <button
                className="btn-success"
                onClick={handleSyncSelected}
                disabled={batchRunning || enqueuing}
              >
                {enqueuing ? 'Queuing…' : `Queue Selected (${selected.size})`}
              </button>
            )}
            {selectedFailed.size > 0 && activeTab === 'failed' && (
              <button
                className="btn-warning"
                onClick={handleRetrySelected}
                disabled={batchRunning || retrying}
              >
                {retrying ? 'Queuing…' : `Retry Selected (${selectedFailed.size})`}
              </button>
            )}
            <button
              className="btn-success"
              onClick={handleSyncAll}
              disabled={batchRunning || enqueuing || approved.length === 0}
            >
              {enqueuing    ? 'Queuing…'
             : batchRunning ? 'Batch Running…'
             :                `Sync All (${approved.length})`}
            </button>
          </div>
        </div>

        {!batchRunning && approved.length > 0 && (
          <p className="text-xs text-gray-600 mt-3 border-t border-gray-800 pt-3">
            💡 "Sync All" runs on the server with automatic retries (up to 3 attempts per transaction).
            You can safely close this tab — progress is preserved.
          </p>
        )}
      </div>

      {/* Active server-side batch (always visible regardless of tab) */}
      {activeBatchId && (
        <SyncBatchCard
          batchId={activeBatchId}
          qboEnvironment={qboEnvironment}
          onDone={handleBatchDone}
        />
      )}

      {/* Past batch summaries (this session) */}
      {batchHistory.map((data, i) => {
        const b         = data.batch;
        const failedJobs = (data.jobs || []).filter(j => j.status === 'failed');
        return (
          <div key={i} className={`card border text-sm flex items-center justify-between gap-4 flex-wrap
            ${b.status === 'complete' ? 'border-green-800' : b.status === 'partial' ? 'border-amber-700' : 'border-gray-700'}`}>
            <div className="flex items-center gap-3">
              <span className={b.status === 'complete' ? 'text-emerald-400' : 'text-amber-400'}>
                {b.status === 'complete' ? '✓' : '⚠'}
              </span>
              <span className="text-gray-300">
                {b.status === 'complete'
                  ? `Batch complete — ${b.completed_jobs} synced`
                  : `Batch finished — ${b.completed_jobs} synced, ${b.failed_jobs} failed`}
              </span>
            </div>
            {failedJobs.length > 0 && (
              <button
                className="btn-warning text-xs px-3 py-1"
                onClick={() => handleRetry(failedJobs.map(j => j.transaction_id))}
                disabled={batchRunning || retrying}
              >
                Retry {failedJobs.length} Failed
              </button>
            )}
          </div>
        );
      })}

      {/* Tabs */}
      <div className="border-b border-gray-800">
        <nav className="flex gap-0 -mb-px">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors
                ${activeTab === tab.id
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-600'}
                ${tab.id === 'failed' && failed.length > 0 && activeTab !== 'failed'
                  ? 'text-red-400 hover:text-red-300'
                  : ''}`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* ── Tab: Ready to Sync ─────────────────────────────────────────────── */}
      {activeTab === 'ready' && (
        <>
          {loading ? (
            <div className="text-gray-500 text-sm">Loading approved transactions…</div>
          ) : approved.length === 0 && !batchRunning ? (
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
                             checked={selected.size === approved.length && approved.length > 0}
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
                            disabled={syncing.has(tx.id) || batchRunning}
                            onClick={() => syncOne(tx)}
                            title="Sync immediately (synchronous)"
                          >
                            {syncing.has(tx.id) ? '…' : 'Sync'}
                          </button>
                          <button
                            className="btn-danger text-xs px-2 py-1"
                            onClick={() => rollback(tx)}
                            disabled={tx.status !== 'synced'}
                          >
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

          {/* Immediate sync results log */}
          {results.length > 0 && (
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-gray-200">
                  Sync Results (individual)
                  {failedResults.length > 0 && (
                    <span className="ml-2 text-xs font-normal text-red-400">— {failedResults.length} failed</span>
                  )}
                </h2>
                <button className="text-xs text-gray-500 hover:text-gray-300" onClick={() => setResults([])}>
                  Clear
                </button>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {results.map((r, i) => {
                  const qboUrl = r.status === 'success'
                    ? buildQboUrl(r.type, r.qboId, qboEnvironment)
                    : null;
                  return (
                    <div key={i} className={`flex items-center gap-3 px-3 py-2 rounded text-xs
                      ${r.status === 'success' ? 'bg-green-900/20 border border-green-800' : 'bg-red-900/20 border border-red-800'}`}>
                      <span className={r.status === 'success' ? 'text-green-400' : 'text-red-400'}>
                        {r.status === 'success' ? '✓' : '✕'}
                      </span>
                      <span className="font-mono text-gray-400 shrink-0">{r.ppId}</span>
                      {r.status === 'success' ? (
                        <span className="text-gray-400 flex items-center gap-1.5 flex-wrap">
                          <span>→ QBO {r.type}</span>
                          {qboUrl
                            ? <a href={qboUrl} target="_blank" rel="noopener noreferrer"
                                 className="font-mono text-emerald-400 hover:text-emerald-300 underline underline-offset-2">
                                {r.qboId} ↗
                              </a>
                            : <span className="font-mono text-gray-300">{r.qboId}</span>
                          }
                        </span>
                      ) : (
                        <span className="text-red-400">{r.error}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Tab: Failed ───────────────────────────────────────────────────── */}
      {activeTab === 'failed' && (
        <>
          {loadingFailed ? (
            <div className="text-gray-500 text-sm">Loading failed transactions…</div>
          ) : failed.length === 0 ? (
            <div className="card text-center py-12">
              <p className="text-gray-400 text-lg mb-2">No failed transactions</p>
              <p className="text-gray-600 text-sm">All transactions have been synced successfully.</p>
            </div>
          ) : (
            <>
              {/* Bulk actions bar */}
              {selectedFailed.size > 0 && (
                <div className="flex items-center gap-3 px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-sm">
                  <span className="text-gray-400">{selectedFailed.size} selected</span>
                  <button
                    className="btn-warning text-xs px-3 py-1.5"
                    onClick={handleRetrySelected}
                    disabled={batchRunning || retrying}
                  >
                    {retrying ? 'Queuing…' : `Retry Selected (${selectedFailed.size})`}
                  </button>
                </div>
              )}

              <div className="card p-0 overflow-x-auto">
                <table className="w-full min-w-[900px]">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="table-th w-10">
                        <input type="checkbox"
                               checked={selectedFailed.size === failed.length && failed.length > 0}
                               onChange={() => setSelectedFailed(selectedFailed.size === failed.length
                                 ? new Set()
                                 : new Set(failed.map(t => t.id))
                               )} />
                      </th>
                      <th className="table-th">Date</th>
                      <th className="table-th">PayPal ID</th>
                      <th className="table-th">Payer</th>
                      <th className="table-th">Category</th>
                      <th className="table-th">Gross</th>
                      <th className="table-th">Error</th>
                      <th className="table-th">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failed.map(tx => (
                      <tr key={tx.id} className={`table-tr ${selectedFailed.has(tx.id) ? 'bg-red-900/10' : ''}`}>
                        <td className="table-td">
                          <input type="checkbox" checked={selectedFailed.has(tx.id)}
                                 onChange={() => toggleSelectFailed(tx.id)} />
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
                        <td className="table-td max-w-xs">
                          {tx.sync_error
                            ? <span className="text-red-400 text-[11px] line-clamp-2" title={tx.sync_error}>{tx.sync_error}</span>
                            : <span className="text-gray-600 text-xs">—</span>}
                        </td>
                        <td className="table-td">
                          <button
                            className="btn-warning text-xs px-2 py-1"
                            disabled={batchRunning || retrying}
                            onClick={() => handleRetry([tx.id])}
                            title="Reset to approved and re-queue for sync"
                          >
                            Retry
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {/* ── Tab: Sync History ─────────────────────────────────────────────── */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          {/* Filter bar */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">Filter:</span>
            {['', 'success', 'failed'].map(f => (
              <button
                key={f}
                onClick={() => { setHistoryFilter(f); loadHistory(1, f); }}
                className={`text-xs px-3 py-1.5 rounded border transition-colors
                  ${historyFilter === f
                    ? (f === 'failed' ? 'bg-red-900/30 border-red-700 text-red-300'
                      : f === 'success' ? 'bg-green-900/30 border-green-700 text-green-300'
                      : 'bg-blue-900/30 border-blue-700 text-blue-300')
                    : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'}`}
              >
                {f === '' ? 'All' : f === 'success' ? 'Succeeded' : 'Failed'}
              </button>
            ))}
            <button
              className="text-xs text-gray-500 hover:text-gray-300 ml-auto"
              onClick={() => loadHistory(historyPage, historyFilter)}
              disabled={loadingHistory}
            >
              {loadingHistory ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>

          {loadingHistory ? (
            <div className="text-gray-500 text-sm">Loading sync history…</div>
          ) : syncHistory.length === 0 ? (
            <div className="card text-center py-12">
              <p className="text-gray-400 text-lg mb-2">No sync history yet</p>
              <p className="text-gray-600 text-sm">Sync records will appear here once transactions are posted to QBO.</p>
            </div>
          ) : (
            <div className="card p-0 overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="table-th">Timestamp</th>
                    <th className="table-th">PayPal ID</th>
                    <th className="table-th">Action</th>
                    <th className="table-th">QBO Type</th>
                    <th className="table-th">QBO ID</th>
                    <th className="table-th">Status</th>
                    <th className="table-th">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {syncHistory.map(row => {
                    const qboUrl = row.qbo_object_id && row.qbo_object_type
                      ? buildQboUrl(row.qbo_object_type, row.qbo_object_id, qboEnvironment)
                      : null;
                    return (
                      <tr key={row.id} className="table-tr">
                        <td className="table-td text-xs text-gray-500 whitespace-nowrap">
                          {fmtDateTime(row.created_at)}
                        </td>
                        <td className="table-td font-mono text-xs text-gray-400">
                          {row.paypal_transaction_id || '—'}
                        </td>
                        <td className="table-td">
                          <span className={`text-xs px-2 py-0.5 rounded-full border
                            ${row.action === 'delete' ? 'bg-orange-900/20 border-orange-800 text-orange-300'
                            : row.action === 'retry'  ? 'bg-yellow-900/20 border-yellow-800 text-yellow-300'
                            :                           'bg-blue-900/20 border-blue-800 text-blue-300'}`}>
                            {row.action}
                          </span>
                        </td>
                        <td className="table-td text-xs text-gray-400">
                          {row.qbo_object_type || '—'}
                        </td>
                        <td className="table-td font-mono text-xs">
                          {row.qbo_object_id
                            ? (qboUrl
                                ? <a href={qboUrl} target="_blank" rel="noopener noreferrer"
                                     className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">
                                    {row.qbo_object_id} ↗
                                  </a>
                                : <span className="text-gray-300">{row.qbo_object_id}</span>)
                            : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="table-td">
                          <span className={`text-xs font-medium
                            ${row.status === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
                            {row.status === 'success' ? '✓ success' : '✕ failed'}
                          </span>
                        </td>
                        <td className="table-td max-w-xs">
                          {row.error_message
                            ? <span className="text-red-400 text-[11px] line-clamp-2" title={row.error_message}>
                                {row.error_message}
                              </span>
                            : <span className="text-gray-600 text-xs">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {historyTotalPages > 1 && (
            <div className="flex items-center justify-center gap-3 text-sm">
              <button
                className="btn-secondary text-xs px-3 py-1.5"
                onClick={() => loadHistory(historyPage - 1, historyFilter)}
                disabled={historyPage <= 1 || loadingHistory}
              >
                ← Prev
              </button>
              <span className="text-gray-500">
                Page {historyPage} of {historyTotalPages}
              </span>
              <button
                className="btn-secondary text-xs px-3 py-1.5"
                onClick={() => loadHistory(historyPage + 1, historyFilter)}
                disabled={historyPage >= historyTotalPages || loadingHistory}
              >
                Next →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
