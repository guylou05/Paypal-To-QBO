import React, { useEffect, useState, useCallback } from 'react';
import { txApi, paypalApi, qboApi } from '../api/client';
import StatusBadge from '../components/StatusBadge';
import EditModal from '../components/EditModal';
import BulkEditModal from '../components/BulkEditModal';

const CATEGORIES = [
  // Income
  'sale', 'subscription', 'donation_received',
  // Fees & outflows
  'purchase', 'paypal_fee', 'international_fee', 'payout',
  // PayPal Credit
  'paypal_credit_purchase', 'paypal_credit_repayment',
  // Transfers
  'bank_transfer_in', 'bank_transfer_out',
  // Reversals & adjustments
  'refund', 'chargeback', 'adjustment', 'currency_conversion',
  // Other
  'noise', 'unknown',
];

const TRANSACTION_TYPES = [
  'Payment', 'Invoice', 'Transfer', 'Refund', 'Purchase', 'Bank Payout', 'Other',
];

// ── Sort header ───────────────────────────────────────────────────────────
function SortHeader({ col, label, sortBy, sortDir, onSort, className = '' }) {
  const active = sortBy === col;
  return (
    <th
      className={`table-th cursor-pointer select-none group ${className}`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        <span className={active ? 'text-white' : ''}>{label}</span>
        <span className={`text-[10px] transition-colors ${active ? 'text-blue-400' : 'text-gray-700 group-hover:text-gray-500'}`}>
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </span>
    </th>
  );
}

// ── Type badge ─────────────────────────────────────────────────────────────
const TYPE_STYLES = {
  'Payment':    'bg-emerald-900/40 text-emerald-400 border border-emerald-800',
  'Invoice':    'bg-blue-900/40 text-blue-400 border border-blue-800',
  'Transfer':   'bg-violet-900/40 text-violet-400 border border-violet-800',
  'Refund':     'bg-orange-900/40 text-orange-400 border border-orange-800',
  'Purchase':   'bg-rose-900/40 text-rose-400 border border-rose-800',
  'Bank Payout':'bg-cyan-900/40 text-cyan-400 border border-cyan-800',
  'Other':      'bg-gray-800/60 text-gray-400 border border-gray-700',
};

function TypeBadge({ value }) {
  const cls = TYPE_STYLES[value] || TYPE_STYLES['Other'];
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${cls}`}>
      {value || 'Other'}
    </span>
  );
}

function fmt(n) {
  if (n === null || n === undefined) return '—';
  const v = parseFloat(n);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function ReviewQueue() {
  const [rows,           setRows]           = useState([]);
  const [total,          setTotal]          = useState(0);
  const [page,           setPage]           = useState(1);
  const [totalPages,     setTotalPages]     = useState(1);
  const [loading,        setLoading]        = useState(true);
  const [selected,       setSelected]       = useState(new Set());
  const [editTx,         setEditTx]         = useState(null);
  const [isSandbox,      setIsSandbox]      = useState(true);

  // QBO data cache — loaded once on first modal open
  const [qboData,        setQboData]        = useState(null);
  const [qboLoading,     setQboLoading]     = useState(false);

  // Sorting
  const [sortBy,         setSortBy]         = useState('transaction_date');
  const [sortDir,        setSortDir]        = useState('desc');

  // Filters
  const [statusFilter,   setStatusFilter]   = useState('needs_review');
  const [typeFilter,     setTypeFilter]     = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search,         setSearch]         = useState('');
  const [startDate,      setStartDate]      = useState('');
  const [endDate,        setEndDate]        = useState('');

  const [actionLoading,  setActionLoading]  = useState(false);
  const [message,        setMessage]        = useState('');
  const [statusCounts,   setStatusCounts]   = useState({});
  const [confirmRollback,setConfirmRollback]= useState(null); // tx to rollback
  const [bulkEditOpen,   setBulkEditOpen]   = useState(false);

  // Fetch PayPal sandbox flag + status counts once (and after mutations)
  const loadSummary = useCallback(async () => {
    try {
      const r = await txApi.summary();
      const counts = {};
      r.data.byStatus.forEach(row => { counts[row.status] = parseInt(row.cnt, 10); });
      setStatusCounts(counts);
    } catch {}
  }, []);

  useEffect(() => {
    paypalApi.status()
      .then(r => setIsSandbox(r.data.sandbox !== false))
      .catch(() => setIsSandbox(true));
    loadSummary();
  }, [loadSummary]);

  // Lazy-load QBO reference data the first time a modal opens
  const ensureQboData = useCallback(async () => {
    if (qboData || qboLoading) return;
    setQboLoading(true);
    try {
      const [accR, custR, vendR, clsR] = await Promise.allSettled([
        qboApi.accounts(),
        qboApi.customers(),
        qboApi.vendors(),
        qboApi.classes(),
      ]);
      setQboData({
        accounts:  accR.status  === 'fulfilled' ? accR.value.data  : [],
        customers: custR.status === 'fulfilled' ? custR.value.data : [],
        vendors:   vendR.status === 'fulfilled' ? vendR.value.data : [],
        classes:   clsR.status  === 'fulfilled' ? clsR.value.data  : [],
      });
    } catch {
      setQboData({ accounts: [], customers: [], vendors: [], classes: [] });
    } finally {
      setQboLoading(false);
    }
  }, [qboData, qboLoading]);

  const openEdit = useCallback((tx) => {
    setEditTx(tx);
    ensureQboData();
  }, [ensureQboData]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await txApi.list({
        status:           statusFilter   || undefined,
        transaction_type: typeFilter     || undefined,
        category:         categoryFilter || undefined,
        search:           search         || undefined,
        startDate:        startDate      || undefined,
        endDate:          endDate        || undefined,
        sortBy,
        sortDir,
        page,
        pageSize: 50,
      });
      setRows(r.data.data);
      setTotal(r.data.total);
      setTotalPages(r.data.totalPages);
      setSelected(new Set());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter, categoryFilter, search, startDate, endDate, sortBy, sortDir, page]);

  useEffect(() => { load(); }, [load]);

  const resetPage = () => setPage(1);

  const toggleSelect = (id) => {
    setSelected(s => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const toggleAll = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map(r => r.id)));
  };

  const bulkApprove = async () => {
    if (!selected.size) return;
    setActionLoading(true);
    try {
      const r = await txApi.bulkApprove([...selected]);
      setMessage(`${r.data.updated} transaction(s) approved`);
      load();
      loadSummary();
    } catch (err) {
      setMessage('Error: ' + (err.response?.data?.error || err.message));
    } finally {
      setActionLoading(false);
    }
  };

  const bulkIgnore = async () => {
    if (!selected.size) return;
    setActionLoading(true);
    try {
      const r = await txApi.bulkIgnore([...selected]);
      setMessage(`${r.data.updated} transaction(s) ignored`);
      load();
      loadSummary();
    } catch (err) {
      setMessage('Error: ' + (err.response?.data?.error || err.message));
    } finally {
      setActionLoading(false);
    }
  };

  const doRollback = async (tx) => {
    setConfirmRollback(null);
    setActionLoading(true);
    try {
      await txApi.rollback(tx.id);
      setMessage(`Rolled back ${tx.paypal_transaction_id} — transaction reset to "approved"`);
      load();
      loadSummary();
    } catch (err) {
      setMessage('Rollback failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setActionLoading(false);
    }
  };

  const recomputeTypes = async () => {
    setActionLoading(true);
    try {
      const r = await txApi.recomputeTypes();
      setMessage(`Transaction types recomputed for ${r.data.count} record(s)`);
      load();
    } catch (err) {
      setMessage('Error: ' + (err.response?.data?.error || err.message));
    } finally {
      setActionLoading(false);
    }
  };

  const clearFilters = () => {
    setStatusFilter('');
    setTypeFilter('');
    setCategoryFilter('');
    setSearch('');
    setStartDate('');
    setEndDate('');
    setPage(1);
  };

  const hasActiveFilters = statusFilter || typeFilter || categoryFilter || search || startDate || endDate;

  const handleSort = (col) => {
    if (col === sortBy) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
    setPage(1);
  };

  // ── Bulk-edit validation ───────────────────────────────────────────────────
  // Bulk edit is only enabled when ≥2 selected rows all share the same type
  // and none of them are synced.
  const selectedRows      = rows.filter(r => selected.has(r.id));
  const selectedTypes     = [...new Set(selectedRows.map(r => r.transaction_type).filter(Boolean))];
  const selectedHasSynced = selectedRows.some(r => r.status === 'synced');
  const canBulkEdit       = selected.size >= 2
    && selectedTypes.length === 1
    && !selectedHasSynced;

  const bulkEditTooltip = selected.size < 2
    ? 'Select 2+ transactions to bulk edit'
    : selectedHasSynced
    ? 'Deselect synced transactions first'
    : selectedTypes.length > 1
    ? `Mixed types selected: ${selectedTypes.join(', ')}`
    : '';

  // Status pill definitions with colors
  const STATUS_PILLS = [
    { value: '',             label: 'All',          color: 'gray'   },
    { value: 'needs_review', label: 'Needs Review', color: 'amber'  },
    { value: 'approved',     label: 'Approved',     color: 'blue'   },
    { value: 'synced',       label: 'Synced',       color: 'emerald'},
    { value: 'classified',   label: 'Classified',   color: 'purple' },
    { value: 'imported',     label: 'Imported',     color: 'gray'   },
    { value: 'ignored',      label: 'Ignored',      color: 'gray'   },
    { value: 'failed',       label: 'Failed',       color: 'red'    },
  ];

  const PILL_ACTIVE = {
    gray:    'bg-gray-700 text-gray-100 border-gray-600',
    amber:   'bg-amber-900/60 text-amber-200 border-amber-700',
    blue:    'bg-blue-900/60 text-blue-200 border-blue-700',
    emerald: 'bg-emerald-900/60 text-emerald-200 border-emerald-700',
    purple:  'bg-purple-900/60 text-purple-200 border-purple-700',
    red:     'bg-red-900/60 text-red-200 border-red-700',
  };

  const PILL_DOT = {
    gray:    'bg-gray-400',
    amber:   'bg-amber-400',
    blue:    'bg-blue-400',
    emerald: 'bg-emerald-400',
    purple:  'bg-purple-400',
    red:     'bg-red-400',
  };

  return (
    <div className="p-8 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Review Queue</h1>
          <p className="text-gray-500 text-sm mt-1">{total} transaction(s) matching filter</p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <button className="btn-secondary text-xs" onClick={recomputeTypes}
                  disabled={actionLoading}
                  title="Re-run transaction type logic on all existing records">
            ⟳ Recompute Types
          </button>
          {/* Bulk Edit — only enabled when selection is valid */}
          <div className="relative group">
            <button
              className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors
                ${canBulkEdit
                  ? 'bg-blue-900/50 text-blue-200 border-blue-700 hover:bg-blue-900/70'
                  : 'bg-gray-800/40 text-gray-600 border-gray-700 cursor-not-allowed'}`}
              onClick={() => { if (canBulkEdit) { ensureQboData(); setBulkEditOpen(true); } }}
              disabled={!canBulkEdit || actionLoading}>
              ✎ Bulk Edit{selected.size >= 2 ? ` (${selected.size})` : ''}
            </button>
            {/* Tooltip when disabled */}
            {!canBulkEdit && bulkEditTooltip && (
              <div className="absolute right-0 top-full mt-1.5 z-10 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-400 whitespace-nowrap shadow-lg hidden group-hover:block">
                {bulkEditTooltip}
              </div>
            )}
          </div>
          <button className="btn-success text-xs" onClick={bulkApprove}
                  disabled={!selected.size || actionLoading}>
            Approve Selected ({selected.size})
          </button>
          <button className="btn-secondary text-xs" onClick={bulkIgnore}
                  disabled={!selected.size || actionLoading}>
            Ignore Selected ({selected.size})
          </button>
        </div>
      </div>

      {/* Status pills — one-click status filter with live counts */}
      <div className="flex flex-wrap gap-2">
        {STATUS_PILLS.map(pill => {
          const active = statusFilter === pill.value;
          const count  = pill.value === ''
            ? Object.values(statusCounts).reduce((a, b) => a + b, 0)
            : (statusCounts[pill.value] || 0);
          return (
            <button
              key={pill.value}
              onClick={() => { setStatusFilter(pill.value); resetPage(); }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors
                ${active
                  ? PILL_ACTIVE[pill.color]
                  : 'bg-transparent text-gray-500 border-gray-700 hover:text-gray-300 hover:border-gray-600'}`}
            >
              {active && <span className={`w-1.5 h-1.5 rounded-full ${PILL_DOT[pill.color]}`} />}
              {pill.label}
              {count > 0 && (
                <span className={`${active ? 'opacity-80' : 'text-gray-600'}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {message && (
        <div className="px-4 py-3 bg-blue-900/30 border border-blue-800 rounded-lg text-blue-300 text-sm flex items-center justify-between">
          <span>{message}</span>
          <button className="text-gray-500 hover:text-gray-300" onClick={() => setMessage('')}>✕</button>
        </div>
      )}

      {/* Filters */}
      <div className="card p-4 space-y-3">
        <div className="flex gap-3 flex-wrap items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Transaction Type</label>
            <select className="input w-44" value={typeFilter}
                    onChange={e => { setTypeFilter(e.target.value); resetPage(); }}>
              <option value="">All types</option>
              {TRANSACTION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Category</label>
            <select className="input w-52" value={categoryFilter}
                    onChange={e => { setCategoryFilter(e.target.value); resetPage(); }}>
              <option value="">All categories</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">From date</label>
            <input type="date" className="input w-40" value={startDate}
                   onChange={e => { setStartDate(e.target.value); resetPage(); }} />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">To date</label>
            <input type="date" className="input w-40" value={endDate}
                   onChange={e => { setEndDate(e.target.value); resetPage(); }} />
          </div>

          <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <label className="text-xs text-gray-500">Search</label>
            <input className="input" placeholder="Name, email, ID, description…"
                   value={search}
                   onChange={e => { setSearch(e.target.value); resetPage(); }} />
          </div>

          {hasActiveFilters && (
            <button className="btn-secondary text-xs self-end" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card p-0 overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No transactions match the current filter.</div>
        ) : (
          <table className="w-full min-w-[1050px]">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="table-th w-10">
                  <input type="checkbox" className="rounded"
                         checked={selected.size === rows.length && rows.length > 0}
                         onChange={toggleAll} />
                </th>
                <SortHeader col="transaction_date" label="Date"        sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader col="transaction_type" label="Type"        sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader col="payer_name"        label="Payer"       sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader col="description"       label="Description" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader col="gross_amount"      label="Gross"       sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader col="fee_amount"        label="Fee"         sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader col="net_amount"        label="Net"         sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader col="category"          label="Category"    sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader col="confidence"        label="Confidence"  sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader col="status"            label="Status"      sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                {statusFilter === 'synced'  && <th className="table-th">QBO ID</th>}
                {statusFilter === 'failed'  && <th className="table-th">Sync Error</th>}
                <th className="table-th">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(tx => (
                <tr
                  key={tx.id}
                  className={`table-tr cursor-pointer hover:bg-blue-900/20 transition-colors ${selected.has(tx.id) ? 'bg-blue-900/10' : ''}`}
                  onClick={() => openEdit(tx)}
                >
                  {/* Checkbox — stop propagation so click doesn't open modal */}
                  <td className="table-td" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" className="rounded"
                           checked={selected.has(tx.id)}
                           onChange={() => toggleSelect(tx.id)} />
                  </td>

                  <td className="table-td text-gray-400 text-xs whitespace-nowrap">
                    {tx.transaction_date}
                  </td>

                  <td className="table-td">
                    <TypeBadge value={tx.transaction_type} />
                  </td>

                  <td className="table-td">
                    <div className="text-xs">
                      <p className="text-gray-300">{tx.payer_name || '—'}</p>
                      <p className="text-gray-600">{tx.payer_email || ''}</p>
                    </div>
                  </td>

                  <td className="table-td max-w-[180px]">
                    <p className="text-xs text-gray-400 truncate" title={tx.description}>
                      {tx.description || '—'}
                    </p>
                    <p className="text-xs text-gray-600">{tx.event_code}</p>
                  </td>

                  <td className={`table-td font-mono text-xs font-medium ${parseFloat(tx.gross_amount) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {fmt(tx.gross_amount)}
                  </td>
                  <td className="table-td font-mono text-xs text-gray-500">{fmt(tx.fee_amount)}</td>
                  <td className="table-td font-mono text-xs text-gray-300">{fmt(tx.net_amount)}</td>

                  <td className="table-td">
                    <StatusBadge value={tx.override_category || tx.category} type="category" />
                  </td>

                  <td className="table-td">
                    <span className={`text-xs ${tx.confidence === 'high' ? 'text-green-400' : tx.confidence === 'medium' ? 'text-yellow-400' : 'text-red-400'}`}>
                      {tx.confidence || '—'}
                    </span>
                  </td>

                  <td className="table-td">
                    <StatusBadge value={tx.status} />
                    {tx.status === 'failed' && tx.sync_error && (
                      <p className="text-[10px] text-rose-400 mt-1 max-w-[160px] truncate" title={tx.sync_error}>
                        {tx.sync_error}
                      </p>
                    )}
                  </td>

                  {/* QBO ID column — only when Synced filter is active */}
                  {statusFilter === 'synced' && (
                    <td className="table-td" onClick={e => e.stopPropagation()}>
                      {tx.qbo_object_id ? (
                        <div>
                          <p className="font-mono text-xs text-emerald-400">{tx.qbo_object_id}</p>
                          <p className="text-xs text-gray-600">{tx.qbo_object_type}</p>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-600">—</span>
                      )}
                    </td>
                  )}

                  {/* Sync Error column — only when Failed filter is active */}
                  {statusFilter === 'failed' && (
                    <td className="table-td max-w-[240px]" onClick={e => e.stopPropagation()}>
                      {tx.sync_error ? (
                        <p className="text-xs text-rose-400 break-words leading-tight" title={tx.sync_error}>
                          {tx.sync_error}
                        </p>
                      ) : (
                        <span className="text-xs text-gray-600">—</span>
                      )}
                    </td>
                  )}

                  {/* Actions — stop propagation */}
                  <td className="table-td" onClick={e => e.stopPropagation()}>
                    <div className="flex gap-1 items-center flex-wrap">
                      <button className="text-xs text-blue-400 hover:text-blue-300"
                              onClick={() => openEdit(tx)}>
                        {tx.status === 'synced' ? 'View' : 'Edit'}
                      </button>
                      {tx.status === 'synced' && (
                        <button
                          className="text-xs text-amber-400 hover:text-amber-300 font-medium"
                          onClick={() => setConfirmRollback(tx)}
                          disabled={actionLoading}>
                          ↩ Rollback
                        </button>
                      )}
                      {tx.status === 'failed' && (
                        <button
                          className="text-xs text-rose-400 hover:text-rose-300 font-medium"
                          disabled={actionLoading}
                          onClick={async () => {
                            setActionLoading(true);
                            try {
                              // Re-approve then re-sync
                              await txApi.update(tx.id, { status: 'approved' });
                              await txApi.sync(tx.id);
                              setMessage(`Re-synced ${tx.paypal_transaction_id}`);
                            } catch (err) {
                              setMessage('Retry failed: ' + (err.response?.data?.error || err.message));
                            } finally {
                              setActionLoading(false);
                              load();
                              loadSummary();
                            }
                          }}>
                          ↺ Retry
                        </button>
                      )}
                      {tx.status !== 'approved' && tx.status !== 'synced' && tx.status !== 'failed' && (
                        <button className="text-xs text-green-400 hover:text-green-300"
                                onClick={async () => {
                                  await txApi.update(tx.id, { status: 'approved' });
                                  load();
                                  loadSummary();
                                }}>
                          Approve
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button className="btn-secondary text-xs" disabled={page === 1}
                  onClick={() => setPage(p => p - 1)}>← Prev</button>
          <span className="text-sm text-gray-500">Page {page} of {totalPages}</span>
          <button className="btn-secondary text-xs" disabled={page === totalPages}
                  onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      )}

      {editTx && (
        <EditModal
          tx={editTx}
          isSandbox={isSandbox}
          qboData={qboData}
          qboLoading={qboLoading}
          onClose={() => setEditTx(null)}
          onSave={() => { setEditTx(null); load(); loadSummary(); }}
          onRollback={(tx) => { setEditTx(null); setConfirmRollback(tx); }}
        />
      )}

      {bulkEditOpen && (
        <BulkEditModal
          selectedRows={selectedRows}
          qboData={qboData}
          qboLoading={qboLoading}
          onClose={() => setBulkEditOpen(false)}
          onSave={(updated, skipped) => {
            setBulkEditOpen(false);
            setSelected(new Set());
            const msg = skipped > 0
              ? `Updated ${updated} transaction(s). ${skipped} skipped (synced).`
              : `Updated ${updated} transaction(s).`;
            setMessage(msg);
            load();
            loadSummary();
          }}
        />
      )}

      {/* Rollback confirmation dialog */}
      {confirmRollback && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-amber-700/60 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="px-6 py-5 border-b border-gray-800">
              <h3 className="font-semibold text-amber-300 text-lg">↩ Confirm Rollback</h3>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-gray-300 text-sm">
                This will <strong className="text-white">delete the entry from QuickBooks</strong> and
                reset this transaction back to <em>approved</em> so it can be corrected and re-synced.
              </p>
              <div className="bg-gray-800/60 rounded-lg px-4 py-3 text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-500">PayPal ID</span>
                  <span className="font-mono text-gray-300">{confirmRollback.paypal_transaction_id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Amount</span>
                  <span className={`font-mono font-medium ${parseFloat(confirmRollback.gross_amount) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {fmt(confirmRollback.gross_amount)}
                  </span>
                </div>
                {confirmRollback.qbo_object_id && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">QBO {confirmRollback.qbo_object_type}</span>
                    <span className="font-mono text-amber-400">{confirmRollback.qbo_object_id}</span>
                  </div>
                )}
              </div>
              <p className="text-xs text-gray-500">
                This action is logged and can be audited. The QBO entry will be permanently deleted.
              </p>
            </div>
            <div className="flex gap-3 px-6 py-4 border-t border-gray-800">
              <button
                className="btn-primary bg-amber-700 hover:bg-amber-600 border-amber-600"
                onClick={() => doRollback(confirmRollback)}
                disabled={actionLoading}>
                {actionLoading ? 'Rolling back…' : '↩ Rollback Now'}
              </button>
              <button className="btn-secondary" onClick={() => setConfirmRollback(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
