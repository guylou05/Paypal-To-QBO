import React, { useEffect, useState, useCallback, useRef } from 'react';
import { paypalApi } from '../api/client';
import StatusBadge from '../components/StatusBadge';

const CATEGORY_DISPLAY = {
  sale:                    { label: 'Sales',                 color: 'text-emerald-400' },
  paypal_fee:              { label: 'PayPal Fees',           color: 'text-orange-400'  },
  paypal_credit_purchase:  { label: 'PP Credit Purchases',  color: 'text-purple-400'  },
  paypal_credit_repayment: { label: 'PP Credit Repayments', color: 'text-violet-400'  },
  bank_transfer_in:        { label: 'Bank → PayPal',        color: 'text-cyan-400'    },
  bank_transfer_out:       { label: 'PayPal → Bank',        color: 'text-teal-400'    },
  refund:                  { label: 'Refunds',              color: 'text-rose-400'    },
  noise:                   { label: 'Ignored (Noise/Hold)', color: 'text-gray-500'    },
  unknown:                 { label: 'Needs Review',         color: 'text-yellow-400'  },
  funding_detail:          { label: 'Split-Funding Detail', color: 'text-gray-500'    },
};

export default function ImportTransactions() {
  const today = new Date().toISOString().slice(0, 10);
  const first = new Date(new Date().setDate(1)).toISOString().slice(0, 10);

  const [startDate,   setStartDate]   = useState(first);
  const [endDate,     setEndDate]     = useState(today);
  const [loading,     setLoading]     = useState(false);
  const [polling,     setPolling]     = useState(false);
  const [batchId,     setBatchId]     = useState(null);
  const [batchDetail, setBatchDetail] = useState(null);
  const [batches,     setBatches]     = useState([]);
  const [error,       setError]       = useState('');

  // ── Duplicate / overlap detection ─────────────────────────────────────────
  const [overlapInfo,    setOverlapInfo]    = useState(null);  // { existingCount, overlappingBatches }
  const [overlapLoading, setOverlapLoading] = useState(false);
  const debounceRef = useRef(null);

  // Re-check whenever dates change (debounced 600 ms)
  useEffect(() => {
    if (!startDate || !endDate || startDate > endDate) {
      setOverlapInfo(null);
      return;
    }
    clearTimeout(debounceRef.current);
    setOverlapLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await paypalApi.check(startDate, endDate);
        setOverlapInfo(r.data);
      } catch {
        setOverlapInfo(null);
      } finally {
        setOverlapLoading(false);
      }
    }, 600);
    return () => clearTimeout(debounceRef.current);
  }, [startDate, endDate]);

  const hasOverlap = overlapInfo && (
    overlapInfo.existingCount > 0 || overlapInfo.overlappingBatches?.length > 0
  );

  // ── Batch loading & polling ───────────────────────────────────────────────
  const loadBatches = useCallback(() => {
    paypalApi.batches().then(r => setBatches(r.data)).catch(() => {});
  }, []);

  useEffect(() => { loadBatches(); }, []);

  useEffect(() => {
    if (!batchId || !polling) return;
    const iv = setInterval(async () => {
      try {
        const r = await paypalApi.batchDetail(batchId);
        setBatchDetail(r.data);
        if (r.data.status === 'complete' || r.data.status === 'failed') {
          setPolling(false);
          loadBatches();
        }
      } catch { setPolling(false); }
    }, 2000);
    return () => clearInterval(iv);
  }, [batchId, polling]);

  const handleImport = async () => {
    setError('');
    setLoading(true);
    setBatchDetail(null);
    try {
      const r = await paypalApi.import(startDate, endDate);
      setBatchId(r.data.batchId);
      setPolling(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed');
    } finally {
      setLoading(false);
    }
  };

  const parseSummary = (summary) => {
    if (!summary) return [];
    const raw = typeof summary === 'string' ? JSON.parse(summary) : summary;
    const map = {};
    raw.forEach(r => {
      const k = r.category || 'unknown';
      if (!map[k]) map[k] = { category: k, count: 0 };
      map[k].count += parseInt(r.cnt, 10);
    });
    return Object.values(map).sort((a, b) => b.count - a.count);
  };

  return (
    <div className="p-4 sm:p-8 max-w-4xl space-y-6 sm:space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Import Transactions</h1>
        <p className="text-gray-500 text-sm mt-1">Pull PayPal transactions and classify them for review</p>
      </div>

      {/* Import form */}
      <div className="card space-y-4">
        <h2 className="font-semibold text-gray-200">Select Date Range</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Start Date</label>
            <input type="date" className="input" value={startDate}
                   onChange={e => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className="label">End Date</label>
            <input type="date" className="input" value={endDate}
                   onChange={e => setEndDate(e.target.value)} />
          </div>
        </div>

        {/* ── Overlap / duplicate warning ─────────────────────────────── */}
        {overlapLoading && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="animate-spin inline-block w-3 h-3 border border-gray-600 border-t-blue-400 rounded-full" />
            Checking for existing data…
          </div>
        )}

        {!overlapLoading && hasOverlap && (
          <div className="rounded-xl border border-amber-700/60 bg-amber-900/20 px-4 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-amber-400 text-base">⚠</span>
              <p className="text-sm font-semibold text-amber-300">
                This date range overlaps with previously imported data
              </p>
            </div>

            {overlapInfo.existingCount > 0 && (
              <p className="text-xs text-amber-400/80">
                <span className="font-semibold text-amber-300">{overlapInfo.existingCount.toLocaleString()}</span>{' '}
                transaction{overlapInfo.existingCount !== 1 ? 's' : ''} already exist in your database
                for this period. All duplicates will be automatically skipped — no double-counting will occur.
              </p>
            )}

            {overlapInfo.overlappingBatches?.length > 0 && (
              <div className="space-y-1 pt-1 border-t border-amber-700/30">
                <p className="text-[10px] text-amber-500 uppercase tracking-wider font-semibold">
                  Previous import batches covering this period:
                </p>
                {overlapInfo.overlappingBatches.map(b => (
                  <div key={b.id} className="flex items-center justify-between text-xs text-amber-400/70">
                    <span>{b.start_date} → {b.end_date}</span>
                    <span>
                      {b.total_new} new · {b.total_fetched} fetched ·{' '}
                      {new Date(b.created_at).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[10px] text-amber-600">
              You can still proceed — duplicates are safely skipped. This is informational only.
            </p>
          </div>
        )}

        {!overlapLoading && overlapInfo && !hasOverlap && startDate && endDate && (
          <div className="flex items-center gap-2 text-xs text-emerald-500">
            <span>✓</span>
            <span>No existing data found for this date range — all fetched transactions will be new.</span>
          </div>
        )}

        {error && (
          <div className="px-4 py-3 bg-red-900/30 border border-red-800 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

        <button className="btn-primary" onClick={handleImport}
                disabled={loading || polling || !startDate || !endDate}>
          {loading ? 'Starting import…' : polling ? 'Importing…' : 'Import Transactions'}
        </button>

        <p className="text-xs text-gray-600">
          Duplicate transactions are automatically detected and skipped.
          New transactions are classified immediately after import.
        </p>
      </div>

      {/* Current batch progress */}
      {batchDetail && (
        <div className={`card border ${
          batchDetail.status === 'complete' ? 'border-green-800' :
          batchDetail.status === 'failed'   ? 'border-red-800'   : 'border-blue-800'
        }`}>
          <div className="flex items-center gap-3 mb-4">
            {batchDetail.status === 'running' && (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500" />
            )}
            <h2 className="font-semibold text-gray-200">
              Import {batchDetail.status === 'complete' ? 'Complete' :
                      batchDetail.status === 'failed'   ? 'Failed'   : 'In Progress'}
            </h2>
            <StatusBadge value={batchDetail.status} />
          </div>

          {batchDetail.error_message && (
            <p className="text-red-400 text-sm mb-4">{batchDetail.error_message}</p>
          )}

          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-white">{batchDetail.total_fetched ?? '—'}</p>
              <p className="text-xs text-gray-500">Total Fetched</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-green-400">{batchDetail.total_new ?? '—'}</p>
              <p className="text-xs text-gray-500">New</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-amber-400">{batchDetail.total_duplicate ?? '—'}</p>
              <p className="text-xs text-gray-500">Duplicates Skipped</p>
            </div>
          </div>

          {batchDetail.status === 'complete' && batchDetail.summary && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">Classification Summary</p>
              <div className="grid grid-cols-2 gap-2">
                {parseSummary(batchDetail.summary).map(({ category, count }) => {
                  const info = CATEGORY_DISPLAY[category] || { label: category, color: 'text-gray-400' };
                  return (
                    <div key={category} className="flex items-center justify-between bg-gray-800/50 rounded px-3 py-2">
                      <span className={`text-sm ${info.color}`}>{info.label}</span>
                      <span className="text-sm font-bold text-white">{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Past batches */}
      {batches.length > 0 && (
        <div className="card">
          <h2 className="font-semibold text-gray-200 mb-4">Import History</h2>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="table-th">Date Range</th>
                  <th className="table-th">Fetched</th>
                  <th className="table-th">New</th>
                  <th className="table-th">Dups Skipped</th>
                  <th className="table-th">Status</th>
                  <th className="table-th">Ran At</th>
                </tr>
              </thead>
              <tbody>
                {batches.map(b => (
                  <tr key={b.id} className="table-tr cursor-pointer"
                      onClick={() => { setBatchDetail(b); setBatchId(b.id); }}>
                    <td className="table-td">{b.start_date} → {b.end_date}</td>
                    <td className="table-td">{b.total_fetched}</td>
                    <td className="table-td text-emerald-400 font-medium">{b.total_new}</td>
                    <td className="table-td text-amber-400">{b.total_duplicate}</td>
                    <td className="table-td"><StatusBadge value={b.status} /></td>
                    <td className="table-td text-gray-500 text-xs">
                      {new Date(b.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
