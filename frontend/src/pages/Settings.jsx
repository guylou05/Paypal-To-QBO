import React, { useState, useEffect, useCallback, useRef } from 'react';
import { settingsApi } from '../api/client';

// ── Classification rules constants ─────────────────────────────────────────

const MATCH_FIELDS = [
  { value: 'description',    label: 'Description' },
  { value: 'event_code',     label: 'Event Code'  },
  { value: 'payer_name',     label: 'Payer Name'  },
  { value: 'payer_email',    label: 'Payer Email' },
  { value: 'funding_source', label: 'Funding Source' },
];

const MATCH_TYPES = [
  { value: 'contains',    label: 'contains' },
  { value: 'equals',      label: 'equals (exact)' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with',   label: 'ends with' },
  { value: 'regex',       label: 'regex' },
];

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

const CONFIDENCES = ['high', 'medium', 'low'];

const EMPTY_RULE = {
  name: '', match_field: 'description', match_type: 'contains',
  match_value: '', category: 'sale', confidence: 'high', priority: 50, is_active: true,
};

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(parseFloat(n));
}

// ── Cron presets ───────────────────────────────────────────────────────────

const CRON_PRESETS = [
  { label: 'Every hour',    value: '0 * * * *'   },
  { label: 'Every 6 hours', value: '0 */6 * * *'  },
  { label: 'Every 12 hours',value: '0 */12 * * *' },
  { label: 'Daily at 2 am', value: '0 2 * * *'   },
  { label: 'Daily at 6 am', value: '0 6 * * *'   },
  { label: 'Custom',        value: 'custom'        },
];

const LOOKBACK_OPTIONS = [
  { label: '24 hours', value: 24  },
  { label: '48 hours', value: 48  },
  { label: '72 hours', value: 72  },
  { label: '7 days',   value: 168 },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDatetime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function StatusDot({ status }) {
  const cfg = {
    success: 'bg-emerald-400',
    failed:  'bg-rose-400',
    running: 'bg-amber-400 animate-pulse',
  };
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${cfg[status] || 'bg-gray-600'}`} />
  );
}

// ── Cron preview — human-readable next-run description ────────────────────

function cronLabel(expr) {
  const preset = CRON_PRESETS.find(p => p.value === expr && p.value !== 'custom');
  if (preset) return preset.label;
  // Basic fallback for common patterns
  const parts = expr.trim().split(/\s+/);
  if (parts.length === 5) return `Custom schedule (${expr})`;
  return expr;
}

// ── Section card ───────────────────────────────────────────────────────────

function Card({ icon, title, children }) {
  return (
    <div className="card mb-4">
      <div className="flex items-center gap-2 mb-5 pb-3 border-b border-gray-800">
        <span className="text-lg">{icon}</span>
        <h2 className="font-semibold text-gray-200 text-sm">{title}</h2>
      </div>
      {children}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function Settings() {
  // ── Auto-import state ──────────────────────────────────────────────────
  const [enabled,       setEnabled]       = useState(false);
  const [cronPreset,    setCronPreset]     = useState('0 2 * * *');
  const [customCron,    setCustomCron]     = useState('');
  const [lookbackHours, setLookbackHours] = useState(48);
  const [lastRunAt,     setLastRunAt]      = useState(null);
  const [lastBatchId,   setLastBatchId]   = useState(null);
  const [lastStatus,    setLastStatus]    = useState(null);
  const [lastError,     setLastError]     = useState('');

  const [saving,    setSaving]    = useState(false);
  const [running,   setRunning]   = useState(false);
  const [saveMsg,   setSaveMsg]   = useState('');
  const [saveError, setSaveError] = useState('');

  // Derived: what cron expression is currently selected?
  const activeCron = cronPreset === 'custom' ? customCron : cronPreset;

  // ── Load current config ────────────────────────────────────────────────
  const loadConfig = useCallback(async () => {
    try {
      const r = await settingsApi.getAutoImport();
      const d = r.data;
      setEnabled(!!d.enabled);
      setLookbackHours(d.lookback_hours || 48);
      setLastRunAt(d.last_run_at);
      setLastBatchId(d.last_batch_id);
      setLastStatus(d.last_run_status);
      setLastError(d.last_run_error || '');

      // Map cron value to preset or custom
      const matched = CRON_PRESETS.find(p => p.value === d.cron && p.value !== 'custom');
      if (matched) {
        setCronPreset(d.cron);
      } else {
        setCronPreset('custom');
        setCustomCron(d.cron || '0 2 * * *');
      }
    } catch {
      // Silently ignore on load
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // ── Poll last-run status while a run is in progress ────────────────────
  useEffect(() => {
    if (lastStatus !== 'running') return;
    const timer = setInterval(async () => {
      try {
        const r = await settingsApi.getAutoImport();
        const d = r.data;
        setLastStatus(d.last_run_status);
        setLastBatchId(d.last_batch_id);
        setLastError(d.last_run_error || '');
        setLastRunAt(d.last_run_at);
      } catch {}
    }, 3000);
    return () => clearInterval(timer);
  }, [lastStatus]);

  // ── Save ───────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    setSaveError('');
    try {
      await settingsApi.saveAutoImport({
        enabled,
        cron:           activeCron,
        lookback_hours: lookbackHours,
      });
      setSaveMsg('Settings saved. Scheduler updated.');
    } catch (err) {
      setSaveError(err.response?.data?.error || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  // ── Run now ────────────────────────────────────────────────────────────
  const handleRunNow = async () => {
    setRunning(true);
    setSaveMsg('');
    setSaveError('');
    try {
      await settingsApi.runAutoImport();
      setLastStatus('running');
      setSaveMsg('Import started — status will update automatically.');
    } catch (err) {
      setSaveError(err.response?.data?.error || 'Failed to trigger import');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold text-white mb-2">Settings</h1>
      <p className="text-gray-500 text-sm mb-8">Application configuration and automation</p>

      {/* ── Auto-Import Schedule ──────────────────────────────────────── */}
      <Card icon="⏰" title="Auto-Import Schedule">
        <p className="text-sm text-gray-400 mb-5">
          Automatically pull new PayPal transactions on a recurring schedule.
          Overlapping date ranges are safe — duplicate transactions are skipped.
        </p>

        {/* Enable toggle */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <p className="text-sm font-medium text-gray-200">Enable automatic imports</p>
            <p className="text-xs text-gray-500 mt-0.5">
              When enabled, the server will import PayPal transactions on the schedule below.
            </p>
          </div>
          <button
            onClick={() => setEnabled(e => !e)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
              enabled ? 'bg-blue-600' : 'bg-gray-700'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Schedule frequency */}
        <div className={`space-y-4 transition-opacity ${enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
          <div>
            <label className="label">Frequency</label>
            <div className="grid grid-cols-3 gap-2">
              {CRON_PRESETS.map(p => (
                <button
                  key={p.value}
                  onClick={() => setCronPreset(p.value)}
                  className={`text-xs px-3 py-2 rounded-lg border transition-colors ${
                    cronPreset === p.value
                      ? 'bg-blue-900/50 border-blue-600 text-blue-300'
                      : 'bg-gray-800/40 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-300'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Custom cron input */}
          {cronPreset === 'custom' && (
            <div>
              <label className="label">Cron Expression (UTC)</label>
              <input
                className="input font-mono"
                placeholder="0 2 * * *"
                value={customCron}
                onChange={e => setCustomCron(e.target.value)}
              />
              <p className="text-xs text-gray-600 mt-1">
                Standard 5-field cron: minute hour day month weekday.
                <a href="https://crontab.guru" target="_blank" rel="noreferrer"
                   className="text-blue-500 hover:text-blue-400 ml-1">crontab.guru ↗</a>
              </p>
            </div>
          )}

          {/* Lookback window */}
          <div>
            <label className="label">Lookback Window</label>
            <p className="text-xs text-gray-500 mb-2">
              How far back each automatic run will fetch. A longer window catches
              delayed PayPal settlements but is slower. Duplicates are always skipped.
            </p>
            <div className="flex gap-2">
              {LOOKBACK_OPTIONS.map(o => (
                <button
                  key={o.value}
                  onClick={() => setLookbackHours(o.value)}
                  className={`flex-1 text-xs px-3 py-2 rounded-lg border transition-colors ${
                    lookbackHours === o.value
                      ? 'bg-blue-900/50 border-blue-600 text-blue-300'
                      : 'bg-gray-800/40 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-300'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* Summary line */}
          {activeCron && (
            <p className="text-xs text-gray-500 bg-gray-800/40 border border-gray-700/50 rounded-lg px-3 py-2">
              ↻ <span className="text-gray-300">{cronLabel(activeCron)}</span>
              {' '}— will fetch the last{' '}
              <span className="text-gray-300">
                {lookbackHours < 24 ? `${lookbackHours}h` : `${lookbackHours / 24} day${lookbackHours / 24 === 1 ? '' : 's'}`}
              </span>{' '}
              of PayPal transactions (all times UTC).
            </p>
          )}
        </div>

        {/* Save button */}
        <div className="flex items-center gap-3 mt-6 pt-4 border-t border-gray-800">
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Schedule'}
          </button>
          {saveMsg   && <span className="text-xs text-emerald-400">{saveMsg}</span>}
          {saveError && <span className="text-xs text-rose-400">{saveError}</span>}
        </div>
      </Card>

      {/* ── Last Run Status ───────────────────────────────────────────── */}
      <Card icon="📋" title="Last Automatic Run">
        {!lastRunAt ? (
          <p className="text-sm text-gray-500">No automatic runs yet.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-gray-500 mb-1">Run at</p>
                <p className="text-gray-300">{fmtDatetime(lastRunAt)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">Status</p>
                <div className="flex items-center gap-2">
                  <StatusDot status={lastStatus} />
                  <span className={`text-sm capitalize ${
                    lastStatus === 'success' ? 'text-emerald-400' :
                    lastStatus === 'failed'  ? 'text-rose-400'    :
                    lastStatus === 'running' ? 'text-amber-400'   : 'text-gray-400'
                  }`}>
                    {lastStatus || '—'}
                  </span>
                </div>
              </div>
              {lastBatchId && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Batch ID</p>
                  <span className="font-mono text-gray-300 text-xs">#{lastBatchId}</span>
                </div>
              )}
            </div>
            {lastError && (
              <div className="px-3 py-2 bg-rose-900/20 border border-rose-800/50 rounded-lg">
                <p className="text-xs text-rose-300 font-mono break-words">{lastError}</p>
              </div>
            )}
          </div>
        )}

        {/* Run now */}
        <div className="mt-4 pt-4 border-t border-gray-800">
          <p className="text-xs text-gray-500 mb-3">
            Trigger an immediate import using the current lookback window,
            regardless of the schedule. Useful for testing or catching up after downtime.
          </p>
          <button
            className="btn-secondary text-xs"
            onClick={handleRunNow}
            disabled={running || lastStatus === 'running'}
          >
            {running || lastStatus === 'running' ? '⏳ Running…' : '▶ Run Now'}
          </button>
        </div>
      </Card>

      {/* ── Classification Rules ──────────────────────────────────────── */}
      <ClassificationRules />
    </div>
  );
}

// ── Classification Rules component ─────────────────────────────────────────

function RuleForm({ initial, onSave, onCancel, isSaving, testResult, onTest, testing }) {
  const [rule, setRule] = useState(initial || EMPTY_RULE);
  const field = (k, v) => setRule(r => ({ ...r, [k]: v }));

  return (
    <div className="bg-gray-800/50 border border-gray-700/60 rounded-xl p-4 space-y-3">
      {/* Row 1: name + priority */}
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="label">Rule Name</label>
          <input className="input" value={rule.name} placeholder="e.g. Stripe fee"
                 onChange={e => field('name', e.target.value)} />
        </div>
        <div>
          <label className="label">Priority</label>
          <input className="input" type="number" min="1" max="999" value={rule.priority}
                 onChange={e => field('priority', parseInt(e.target.value, 10) || 50)} />
          <p className="text-[10px] text-gray-600 mt-0.5">Lower = runs first</p>
        </div>
      </div>

      {/* Row 2: match condition */}
      <div>
        <label className="label">Match Condition</label>
        <div className="flex items-center gap-2 flex-wrap">
          <select className="input w-40" value={rule.match_field}
                  onChange={e => field('match_field', e.target.value)}>
            {MATCH_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <select className="input w-36" value={rule.match_type}
                  onChange={e => field('match_type', e.target.value)}>
            {MATCH_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <input className="input flex-1 font-mono text-sm" value={rule.match_value}
                 placeholder={rule.match_type === 'regex' ? '^stripe.*fee' : 'subscription'}
                 onChange={e => field('match_value', e.target.value)} />
          <button
            className="btn-secondary text-xs shrink-0"
            disabled={!rule.match_value || testing}
            onClick={() => onTest(rule)}>
            {testing ? '…' : '⚡ Test'}
          </button>
        </div>
      </div>

      {/* Test result */}
      {testResult && (
        <div className={`px-3 py-2 rounded-lg border text-xs ${
          testResult.match_count > 0
            ? 'bg-blue-900/20 border-blue-800/50 text-blue-300'
            : 'bg-gray-800/60 border-gray-700/50 text-gray-500'
        }`}>
          <p className="font-semibold mb-1">
            {testResult.match_count > 0
              ? `⚡ Matches ${testResult.match_count} of ${testResult.total_scanned} transactions`
              : `No matches found in ${testResult.total_scanned} transactions`}
          </p>
          {testResult.sample.length > 0 && (
            <div className="space-y-1 mt-2 max-h-36 overflow-y-auto">
              {testResult.sample.map(s => (
                <div key={s.id} className="flex items-center gap-2 text-[10px] text-gray-400">
                  <span className="text-gray-600">{s.date}</span>
                  <span className="truncate max-w-[200px]">{s.description || s.payer_name || '—'}</span>
                  <span className="font-mono text-gray-500">{fmt(s.gross_amount)}</span>
                  <span className="text-gray-600">{s.current_category}</span>
                  {rule.category && s.current_category !== rule.category && (
                    <span className="text-blue-400">→ {rule.category}</span>
                  )}
                </div>
              ))}
              {testResult.match_count > 10 && (
                <p className="text-gray-600 italic">…and {testResult.match_count - 10} more</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Row 3: result */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Classify As</label>
          <select className="input" value={rule.category}
                  onChange={e => field('category', e.target.value)}>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Confidence</label>
          <select className="input" value={rule.confidence}
                  onChange={e => field('confidence', e.target.value)}>
            {CONFIDENCES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {/* Buttons */}
      <div className="flex items-center gap-2 pt-1">
        <button className="btn-primary text-xs" disabled={!rule.name || !rule.match_value || isSaving}
                onClick={() => onSave(rule)}>
          {isSaving ? 'Saving…' : initial?.id ? 'Update Rule' : 'Create Rule'}
        </button>
        <button className="btn-secondary text-xs" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ClassificationRules() {
  const [rules,      setRules]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [showForm,   setShowForm]   = useState(false);
  const [editingId,  setEditingId]  = useState(null);
  const [saving,     setSaving]     = useState(false);
  const [deleting,   setDeleting]   = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing,    setTesting]    = useState(false);
  const [error,      setError]      = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await settingsApi.getRules();
      setRules(r.data);
    } catch { setError('Failed to load rules'); }
    finally  { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleTest = async (rule) => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await settingsApi.testRule({
        match_field: rule.match_field,
        match_type:  rule.match_type,
        match_value: rule.match_value,
        category:    rule.category,
      });
      setTestResult(r.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Test failed');
    } finally { setTesting(false); }
  };

  const handleCreate = async (rule) => {
    setSaving(true);
    try {
      await settingsApi.createRule(rule);
      setShowForm(false);
      setTestResult(null);
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Failed to create rule'); }
    finally { setSaving(false); }
  };

  const handleUpdate = async (rule) => {
    setSaving(true);
    try {
      await settingsApi.updateRule(rule.id, rule);
      setEditingId(null);
      setTestResult(null);
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Failed to update rule'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    setDeleting(id);
    try {
      await settingsApi.deleteRule(id);
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Failed to delete rule'); }
    finally { setDeleting(null); }
  };

  const handleToggleActive = async (rule) => {
    try {
      await settingsApi.updateRule(rule.id, { is_active: !rule.is_active });
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Failed to update rule'); }
  };

  return (
    <Card icon="📐" title="Classification Rules">
      <p className="text-sm text-gray-400 mb-5">
        Custom rules override the built-in classifier. Rules run in priority order —
        lower number wins. Inactive rules are skipped but preserved.
      </p>

      {error && (
        <div className="mb-4 px-3 py-2 bg-rose-900/20 border border-rose-800/40 rounded-lg text-xs text-rose-300 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-gray-500 hover:text-gray-300">✕</button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 animate-pulse">Loading rules…</p>
      ) : (
        <div className="space-y-2">
          {rules.length === 0 && !showForm && (
            <p className="text-sm text-gray-500 py-3 text-center border border-dashed border-gray-700 rounded-xl">
              No custom rules yet. Create one to override the built-in classifier.
            </p>
          )}

          {/* Existing rules list */}
          {rules.map(rule => (
            <div key={rule.id}>
              {editingId === rule.id ? (
                <RuleForm
                  initial={rule}
                  isSaving={saving}
                  testResult={testResult}
                  testing={testing}
                  onTest={r => { setTestResult(null); handleTest(r); }}
                  onSave={handleUpdate}
                  onCancel={() => { setEditingId(null); setTestResult(null); }}
                />
              ) : (
                <div className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                  rule.is_active
                    ? 'bg-gray-800/30 border-gray-700/50'
                    : 'bg-gray-900/30 border-gray-800/50 opacity-50'
                }`}>
                  {/* Priority badge */}
                  <span className="text-[10px] font-mono bg-gray-700/60 text-gray-400 px-1.5 py-0.5 rounded shrink-0">
                    #{rule.priority}
                  </span>

                  {/* Rule description */}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-300 truncate">{rule.name}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">
                      <span className="text-gray-400">{rule.match_field}</span>
                      {' '}<span className="text-gray-600">{rule.match_type}</span>{' '}
                      <span className="font-mono text-blue-400">"{rule.match_value}"</span>
                      {' → '}
                      <span className="text-emerald-400">{rule.category}</span>
                      <span className="text-gray-600 ml-1">({rule.confidence})</span>
                    </p>
                  </div>

                  {/* Controls */}
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Active toggle */}
                    <button
                      onClick={() => handleToggleActive(rule)}
                      className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                        rule.is_active
                          ? 'bg-emerald-900/40 border-emerald-700/60 text-emerald-400'
                          : 'bg-gray-800/60 border-gray-700 text-gray-500'
                      }`}>
                      {rule.is_active ? 'Active' : 'Off'}
                    </button>
                    <button
                      className="text-[10px] text-gray-500 hover:text-blue-400 transition-colors"
                      onClick={() => { setEditingId(rule.id); setTestResult(null); }}>
                      Edit
                    </button>
                    <button
                      className="text-[10px] text-gray-500 hover:text-rose-400 transition-colors"
                      disabled={deleting === rule.id}
                      onClick={() => handleDelete(rule.id)}>
                      {deleting === rule.id ? '…' : 'Delete'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* New rule form */}
          {showForm && (
            <RuleForm
              isSaving={saving}
              testResult={testResult}
              testing={testing}
              onTest={r => { setTestResult(null); handleTest(r); }}
              onSave={handleCreate}
              onCancel={() => { setShowForm(false); setTestResult(null); }}
            />
          )}

          {!showForm && (
            <button
              className="btn-secondary text-xs mt-2"
              onClick={() => { setShowForm(true); setTestResult(null); }}>
              + New Rule
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
