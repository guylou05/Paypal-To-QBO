import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../api/client';

// ── Password strength ─────────────────────────────────────────────────────
function passwordStrength(pwd) {
  if (!pwd) return null;
  let score = 0;
  if (pwd.length >= 8)  score++;
  if (pwd.length >= 12) score++;
  if (/[A-Z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;
  if (score <= 1) return { level: 'weak',   label: 'Weak',   bar: 'w-1/4 bg-red-500' };
  if (score <= 2) return { level: 'fair',   label: 'Fair',   bar: 'w-2/4 bg-amber-500' };
  if (score <= 3) return { level: 'good',   label: 'Good',   bar: 'w-3/4 bg-yellow-400' };
  return             { level: 'strong', label: 'Strong', bar: 'w-full  bg-emerald-500' };
}

// ── Inline alert ──────────────────────────────────────────────────────────
function Alert({ type, children, onDismiss }) {
  const styles = {
    success: 'bg-emerald-900/30 border-emerald-700 text-emerald-300',
    error:   'bg-red-900/30     border-red-700     text-red-300',
    info:    'bg-blue-900/30    border-blue-700    text-blue-300',
  };
  return (
    <div className={`flex items-start justify-between gap-3 px-4 py-3 rounded-lg border text-sm ${styles[type]}`}>
      <span>{children}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100 text-xs">✕</button>
      )}
    </div>
  );
}

// ── Section card wrapper ──────────────────────────────────────────────────
function Section({ title, icon, children }) {
  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-2 pb-1 border-b border-gray-800">
        <span className="text-base">{icon}</span>
        <h2 className="text-sm font-semibold text-gray-300">{title}</h2>
      </div>
      {children}
    </div>
  );
}

export default function Account() {
  const { user, logout, refreshUser } = useAuth();
  const navigate = useNavigate();

  // ── Profile / email state ─────────────────────────────────────────────
  const [newEmail,       setNewEmail]       = useState(user?.email || '');
  const [emailSaving,    setEmailSaving]    = useState(false);
  const [emailMsg,       setEmailMsg]       = useState(null); // { type, text }

  // ── Password state ────────────────────────────────────────────────────
  const [currentPwd,     setCurrentPwd]     = useState('');
  const [newPwd,         setNewPwd]         = useState('');
  const [confirmPwd,     setConfirmPwd]     = useState('');
  const [showCurrent,    setShowCurrent]    = useState(false);
  const [showNew,        setShowNew]        = useState(false);
  const [pwdSaving,      setPwdSaving]      = useState(false);
  const [pwdMsg,         setPwdMsg]         = useState(null); // { type, text }

  const strength = passwordStrength(newPwd);
  const pwdMatch = confirmPwd.length > 0 && newPwd === confirmPwd;
  const pwdMismatch = confirmPwd.length > 0 && newPwd !== confirmPwd;

  // ── Handlers ──────────────────────────────────────────────────────────
  const handleEmailSave = async (e) => {
    e.preventDefault();
    setEmailMsg(null);
    if (newEmail === user?.email) {
      setEmailMsg({ type: 'info', text: 'That is already your current email.' });
      return;
    }
    setEmailSaving(true);
    try {
      await authApi.updateProfile(newEmail);
      await refreshUser();
      setEmailMsg({ type: 'success', text: 'Email updated successfully.' });
    } catch (err) {
      setEmailMsg({ type: 'error', text: err.response?.data?.error || 'Failed to update email.' });
    } finally {
      setEmailSaving(false);
    }
  };

  const handlePasswordSave = async (e) => {
    e.preventDefault();
    setPwdMsg(null);

    if (newPwd !== confirmPwd) {
      setPwdMsg({ type: 'error', text: 'New passwords do not match.' });
      return;
    }
    if (newPwd.length < 8) {
      setPwdMsg({ type: 'error', text: 'New password must be at least 8 characters.' });
      return;
    }

    setPwdSaving(true);
    try {
      await authApi.changePassword(currentPwd, newPwd);
      // Backend clears the auth cookie — log out and redirect to login
      setPwdMsg({ type: 'success', text: 'Password changed! Redirecting to login…' });
      setTimeout(async () => {
        await logout();
        navigate('/login');
      }, 1500);
    } catch (err) {
      setPwdMsg({ type: 'error', text: err.response?.data?.error || 'Failed to change password.' });
      setPwdSaving(false);
    }
  };

  const roleLabel = user?.role === 'admin' ? 'Administrator' : (user?.role || 'User');

  return (
    <div className="p-4 sm:p-8 max-w-xl space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-white">My Account</h1>
        <p className="text-gray-500 text-sm mt-1">Manage your profile and security settings</p>
      </div>

      {/* ── Profile ────────────────────────────────────────────────────── */}
      <Section title="Profile" icon="👤">
        {/* Role badge — read-only */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500">Role</span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-900/40 border border-blue-800 text-blue-300 text-xs font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            {roleLabel}
          </span>
        </div>

        {/* Email update form */}
        <form onSubmit={handleEmailSave} className="space-y-3">
          <div>
            <label className="label">Email address</label>
            <input
              type="email"
              className="input"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
          </div>

          {emailMsg && (
            <Alert type={emailMsg.type} onDismiss={() => setEmailMsg(null)}>
              {emailMsg.text}
            </Alert>
          )}

          <button
            type="submit"
            className="btn-primary text-sm"
            disabled={emailSaving || !newEmail.trim()}
          >
            {emailSaving
              ? <><span className="animate-spin inline-block w-3.5 h-3.5 border border-white/30 border-t-white rounded-full" /> Saving…</>
              : 'Update Email'}
          </button>
        </form>
      </Section>

      {/* ── Change Password ────────────────────────────────────────────── */}
      <Section title="Change Password" icon="🔒">
        <form onSubmit={handlePasswordSave} className="space-y-4">

          {/* Current password */}
          <div>
            <label className="label">Current password</label>
            <div className="relative">
              <input
                type={showCurrent ? 'text' : 'password'}
                className="input pr-10"
                value={currentPwd}
                onChange={e => setCurrentPwd(e.target.value)}
                placeholder="Enter current password"
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="absolute inset-y-0 right-3 flex items-center text-gray-500 hover:text-gray-300 text-xs"
                onClick={() => setShowCurrent(v => !v)}
                tabIndex={-1}
              >
                {showCurrent ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          {/* New password */}
          <div>
            <label className="label">New password</label>
            <div className="relative">
              <input
                type={showNew ? 'text' : 'password'}
                className="input pr-10"
                value={newPwd}
                onChange={e => setNewPwd(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                required
              />
              <button
                type="button"
                className="absolute inset-y-0 right-3 flex items-center text-gray-500 hover:text-gray-300 text-xs"
                onClick={() => setShowNew(v => !v)}
                tabIndex={-1}
              >
                {showNew ? 'Hide' : 'Show'}
              </button>
            </div>

            {/* Strength bar */}
            {strength && (
              <div className="mt-2 space-y-1">
                <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-300 ${strength.bar}`} />
                </div>
                <p className={`text-xs ${
                  strength.level === 'weak'   ? 'text-red-400'     :
                  strength.level === 'fair'   ? 'text-amber-400'   :
                  strength.level === 'good'   ? 'text-yellow-400'  :
                                                'text-emerald-400'
                }`}>
                  Password strength: {strength.label}
                </p>
              </div>
            )}
          </div>

          {/* Confirm new password */}
          <div>
            <label className="label">Confirm new password</label>
            <input
              type="password"
              className={`input ${
                pwdMismatch ? 'border-red-600 focus:ring-red-500' :
                pwdMatch    ? 'border-emerald-600 focus:ring-emerald-500' : ''
              }`}
              value={confirmPwd}
              onChange={e => setConfirmPwd(e.target.value)}
              placeholder="Re-enter new password"
              autoComplete="new-password"
              required
            />
            {pwdMismatch && (
              <p className="text-xs text-red-400 mt-1">Passwords do not match.</p>
            )}
            {pwdMatch && (
              <p className="text-xs text-emerald-400 mt-1">✓ Passwords match.</p>
            )}
          </div>

          {pwdMsg && (
            <Alert type={pwdMsg.type} onDismiss={() => setPwdMsg(null)}>
              {pwdMsg.text}
            </Alert>
          )}

          <div className="pt-1">
            <button
              type="submit"
              className="btn-primary text-sm"
              disabled={pwdSaving || !currentPwd || !newPwd || !confirmPwd}
            >
              {pwdSaving
                ? <><span className="animate-spin inline-block w-3.5 h-3.5 border border-white/30 border-t-white rounded-full" /> Changing…</>
                : '🔒 Change Password'}
            </button>
            <p className="text-xs text-gray-600 mt-2">
              You will be logged out and redirected to the login page after changing your password.
            </p>
          </div>
        </form>
      </Section>

      {/* ── Session info ───────────────────────────────────────────────── */}
      <Section title="Session" icon="🔑">
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Signed in as</span>
            <span className="text-gray-300 font-medium">{user?.email}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Session duration</span>
            <span className="text-gray-400">8 hours</span>
          </div>
        </div>
        <button
          onClick={async () => { await logout(); navigate('/login'); }}
          className="btn-danger text-sm w-full sm:w-auto"
        >
          ⎋ Sign Out
        </button>
      </Section>
    </div>
  );
}
