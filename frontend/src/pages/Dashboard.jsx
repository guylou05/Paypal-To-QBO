import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { txApi, paypalApi, qboApi } from '../api/client';
import StatusBadge from '../components/StatusBadge';

function StatCard({ label, value, sub, color = 'blue' }) {
  const colors = {
    blue:   'border-blue-700 bg-blue-900/20',
    green:  'border-green-700 bg-green-900/20',
    yellow: 'border-yellow-700 bg-yellow-900/20',
    red:    'border-red-700 bg-red-900/20',
    purple: 'border-purple-700 bg-purple-900/20',
  };
  return (
    <div className={`card border-l-4 ${colors[color]}`}>
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-2xl sm:text-3xl font-bold text-white">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

export default function Dashboard() {
  const [summary,    setSummary]    = useState(null);
  const [batches,    setBatches]    = useState([]);
  const [ppStatus,   setPpStatus]   = useState(null);
  const [qboStatus,  setQboStatus]  = useState(null);
  const [loading,    setLoading]    = useState(true);

  useEffect(() => {
    Promise.all([
      txApi.summary(),
      paypalApi.batches(),
      paypalApi.status(),
      qboApi.status(),
    ]).then(([s, b, pp, qbo]) => {
      setSummary(s.data);
      setBatches(b.data.slice(0, 5));
      setPpStatus(pp.data);
      setQboStatus(qbo.data);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  const getCount = (status) => {
    if (!summary) return 0;
    const row = summary.byStatus.find(r => r.status === status);
    return row ? parseInt(row.cnt, 10) : 0;
  };

  if (loading) return (
    <div className="p-4 sm:p-8 flex items-center gap-3 text-gray-500">
      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500" />
      Loading dashboard…
    </div>
  );

  return (
    <div className="p-4 sm:p-8 space-y-5 sm:space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-1">PayPal → QuickBooks reconciliation overview</p>
      </div>

      {/* Connection status */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className={`card flex items-center gap-3 ${ppStatus?.connected ? 'border-green-800' : 'border-red-800'}`}>
          <div className={`w-3 h-3 rounded-full ${ppStatus?.connected ? 'bg-green-400' : 'bg-red-400'}`} />
          <div>
            <p className="text-sm font-medium">PayPal API</p>
            <p className="text-xs text-gray-500">{ppStatus?.connected ? 'Connected' : 'Not connected — configure in Setup'}</p>
          </div>
          {!ppStatus?.connected && (
            <Link to="/setup" className="ml-auto btn-primary text-xs px-3 py-1">Setup</Link>
          )}
        </div>
        {(() => {
          const te       = qboStatus?.tokenExpiry;
          const expired  = te && te.days_remaining < 0;
          const critical = te && te.days_remaining <= 3 && !expired;
          const warning  = te && te.days_remaining <= 14 && !expired && !critical;
          const borderCls = !qboStatus?.connected ? 'border-red-800'
                          : expired               ? 'border-red-800'
                          : critical              ? 'border-orange-700'
                          : warning               ? 'border-amber-700'
                          :                         'border-green-800';
          const dotCls    = !qboStatus?.connected ? 'bg-red-400'
                          : expired               ? 'bg-red-400'
                          : critical || warning   ? 'bg-amber-400'
                          :                         'bg-green-400';
          return (
            <div className={`card flex items-center gap-3 ${borderCls}`}>
              <div className={`w-3 h-3 rounded-full shrink-0 ${dotCls}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium">QuickBooks Online</p>
                <p className="text-xs text-gray-500">
                  {qboStatus?.connected
                    ? (qboStatus.company?.CompanyName || 'Connected')
                    : 'Not connected — configure in Setup'}
                </p>
                {qboStatus?.connected && te && (
                  <p className={`text-xs mt-0.5 ${
                    expired  ? 'text-red-400' :
                    critical ? 'text-orange-400' :
                    warning  ? 'text-amber-400' :
                               'text-gray-600'
                  }`}>
                    {expired
                      ? 'OAuth token expired — reconnect required'
                      : `OAuth token expires in ${te.days_remaining} day${te.days_remaining === 1 ? '' : 's'}`}
                  </p>
                )}
              </div>
              {(!qboStatus?.connected || expired || critical) && (
                <Link to="/setup" className="ml-auto btn-primary text-xs px-3 py-1 shrink-0">
                  {expired ? 'Reconnect' : 'Setup'}
                </Link>
              )}
            </div>
          );
        })()}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard label="Needs Review"  value={getCount('needs_review')} color="yellow" />
        <StatCard label="Approved"      value={getCount('approved')}     color="purple" />
        <StatCard label="Synced to QBO" value={getCount('synced')}       color="green"  />
        <StatCard label="Failed"        value={getCount('failed')}        color="red"    />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
        <StatCard label="Imported"   value={getCount('imported')}   color="blue" />
        <StatCard label="Classified" value={getCount('classified')} color="blue" />
        <StatCard label="Ignored"    value={getCount('ignored')}    color="blue" />
      </div>

      {/* Quick actions */}
      <div className="card">
        <h2 className="text-sm font-semibold text-gray-300 mb-4">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <Link to="/import"  className="btn-primary">Import Transactions</Link>
          <Link to="/review"  className="btn-secondary">Review Queue</Link>
          <Link to="/sync"    className="btn-success">Sync to QuickBooks</Link>
          <Link to="/reports" className="btn-secondary">View Reports</Link>
        </div>
      </div>

      {/* Recent batches */}
      {batches.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold text-gray-300 mb-4">Recent Import Batches</h2>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="table-th">Date Range</th>
                  <th className="table-th">Fetched</th>
                  <th className="table-th">New</th>
                  <th className="table-th">Duplicates</th>
                  <th className="table-th">Status</th>
                  <th className="table-th">Imported At</th>
                </tr>
              </thead>
              <tbody>
                {batches.map(b => (
                  <tr key={b.id} className="table-tr">
                    <td className="table-td">{b.start_date} → {b.end_date}</td>
                    <td className="table-td">{b.total_fetched}</td>
                    <td className="table-td">{b.total_new}</td>
                    <td className="table-td">{b.total_duplicate}</td>
                    <td className="table-td">
                      <StatusBadge value={b.status} />
                    </td>
                    <td className="table-td text-gray-500">
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
