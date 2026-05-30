import React, { useEffect, useState } from 'react';
import { logsApi } from '../api/client';

export default function Logs() {
  const [tab,        setTab]        = useState('audit');
  const [auditRows,  setAuditRows]  = useState([]);
  const [syncRows,   setSyncRows]   = useState([]);
  const [rollbacks,  setRollbacks]  = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [page,       setPage]       = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [detail,     setDetail]     = useState(null);

  const loadAudit = async (p = 1) => {
    setLoading(true);
    try {
      const r = await logsApi.audit({ page: p, pageSize: 50 });
      setAuditRows(r.data.data);
      setTotalPages(r.data.totalPages);
    } finally { setLoading(false); }
  };

  const loadSync = async (p = 1) => {
    setLoading(true);
    try {
      const r = await logsApi.sync({ page: p, pageSize: 50 });
      setSyncRows(r.data.data);
      setTotalPages(r.data.totalPages);
    } finally { setLoading(false); }
  };

  const loadRollbacks = async () => {
    setLoading(true);
    try {
      const r = await logsApi.rollbacks();
      setRollbacks(r.data);
    } finally { setLoading(false); }
  };

  useEffect(() => {
    setPage(1);
    if (tab === 'audit')     loadAudit(1);
    if (tab === 'sync')      loadSync(1);
    if (tab === 'rollbacks') loadRollbacks();
  }, [tab]);

  useEffect(() => {
    if (tab === 'audit') loadAudit(page);
    if (tab === 'sync')  loadSync(page);
  }, [page]);

  const tabs = [
    { id: 'audit',     label: 'Audit Log' },
    { id: 'sync',      label: 'Sync Log' },
    { id: 'rollbacks', label: 'Rollbacks' },
  ];

  return (
    <div className="p-4 sm:p-8 space-y-5 sm:space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Logs & Audit Trail</h1>
        <p className="text-gray-500 text-sm mt-1">Every action, sync attempt, and rollback is recorded here</p>
      </div>

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

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : tab === 'audit' ? (
        <div className="card p-0 overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="table-th">Timestamp</th>
                <th className="table-th">User</th>
                <th className="table-th">Action</th>
                <th className="table-th">Entity</th>
                <th className="table-th">Details</th>
                <th className="table-th">IP</th>
              </tr>
            </thead>
            <tbody>
              {auditRows.map(r => (
                <tr key={r.id} className="table-tr">
                  <td className="table-td text-xs text-gray-500 whitespace-nowrap">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="table-td text-xs text-gray-400">{r.user_email || '—'}</td>
                  <td className="table-td">
                    <span className="text-xs font-mono text-blue-400">{r.action}</span>
                  </td>
                  <td className="table-td text-xs text-gray-500">
                    {r.entity_type} {r.entity_id && `#${r.entity_id}`}
                  </td>
                  <td className="table-td text-xs text-gray-500 max-w-[250px] truncate">
                    {r.details || '—'}
                  </td>
                  <td className="table-td text-xs text-gray-600">{r.ip_address || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : tab === 'sync' ? (
        <div className="card p-0 overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="table-th">Timestamp</th>
                <th className="table-th">PayPal ID</th>
                <th className="table-th">Action</th>
                <th className="table-th">QBO Type</th>
                <th className="table-th">QBO ID</th>
                <th className="table-th">Status</th>
                <th className="table-th">Details</th>
              </tr>
            </thead>
            <tbody>
              {syncRows.map(r => (
                <tr key={r.id} className="table-tr cursor-pointer" onClick={() => setDetail(r)}>
                  <td className="table-td text-xs text-gray-500 whitespace-nowrap">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="table-td font-mono text-xs text-gray-500">{r.paypal_transaction_id}</td>
                  <td className="table-td text-xs text-gray-400">{r.action}</td>
                  <td className="table-td text-xs text-gray-400">{r.qbo_object_type || '—'}</td>
                  <td className="table-td font-mono text-xs text-gray-400">{r.qbo_object_id || '—'}</td>
                  <td className="table-td">
                    <span className={`text-xs font-medium ${r.status === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="table-td text-xs text-gray-600 max-w-[200px] truncate">
                    {r.error_message || 'click to view payload'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card p-0 overflow-x-auto">
          {rollbacks.length === 0 ? (
            <div className="p-8 text-center text-gray-500">No rollbacks recorded</div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="table-th">Timestamp</th>
                  <th className="table-th">PayPal ID</th>
                  <th className="table-th">QBO Type</th>
                  <th className="table-th">QBO ID</th>
                  <th className="table-th">Status</th>
                  <th className="table-th">Error</th>
                </tr>
              </thead>
              <tbody>
                {rollbacks.map(r => (
                  <tr key={r.id} className="table-tr">
                    <td className="table-td text-xs text-gray-500">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="table-td font-mono text-xs text-gray-500">{r.paypal_transaction_id}</td>
                    <td className="table-td text-xs text-gray-400">{r.qbo_object_type}</td>
                    <td className="table-td font-mono text-xs text-gray-400">{r.qbo_object_id}</td>
                    <td className="table-td">
                      <span className={`text-xs font-medium ${r.status === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="table-td text-xs text-red-400">{r.error_message || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Pagination */}
      {(tab === 'audit' || tab === 'sync') && totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button className="btn-secondary text-xs" disabled={page === 1}
                  onClick={() => setPage(p => p - 1)}>← Prev</button>
          <span className="text-sm text-gray-500">Page {page} of {totalPages}</span>
          <button className="btn-secondary text-xs" disabled={page === totalPages}
                  onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      )}

      {/* Payload detail modal */}
      {detail && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
              <h3 className="font-semibold text-gray-200">Sync Log Detail</h3>
              <button onClick={() => setDetail(null)} className="text-gray-500 hover:text-gray-300">✕</button>
            </div>
            <div className="overflow-y-auto p-6 space-y-4">
              <div>
                <p className="text-xs text-gray-500 mb-1">Request Payload</p>
                <pre className="text-xs text-gray-300 bg-gray-800 rounded p-3 overflow-x-auto">
                  {detail.request_payload
                    ? JSON.stringify(JSON.parse(detail.request_payload), null, 2)
                    : '—'}
                </pre>
              </div>
              {detail.response_payload && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Response Payload</p>
                  <pre className="text-xs text-gray-300 bg-gray-800 rounded p-3 overflow-x-auto">
                    {JSON.stringify(JSON.parse(detail.response_payload), null, 2)}
                  </pre>
                </div>
              )}
              {detail.error_message && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Error</p>
                  <p className="text-xs text-red-400 bg-red-900/20 rounded p-3">{detail.error_message}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
