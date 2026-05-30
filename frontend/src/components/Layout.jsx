import React, { useState, useEffect } from 'react';
import { NavLink, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { qboApi } from '../api/client';

const NAV = [
  { to: '/dashboard',  label: 'Dashboard',         icon: '⬡' },
  { to: '/setup',      label: 'Setup',              icon: '🔌' },
  { to: '/import',     label: 'Import',             icon: '↓' },
  { to: '/review',     label: 'Review Queue',       icon: '☑' },
  { to: '/sync',       label: 'Sync to QBO',        icon: '↑' },
  { to: '/reports',    label: 'Reports',            icon: '▤' },
  { to: '/logs',       label: 'Logs / Audit',       icon: '≡' },
  { to: '/settings',   label: 'Settings',           icon: '⚙' },
];

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [collapsed,       setCollapsed]       = useState(false);
  const [drawerOpen,      setDrawerOpen]      = useState(false);
  const [tokenExpiry,     setTokenExpiry]     = useState(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    qboApi.status()
      .then(r => { if (r.data.tokenExpiry) setTokenExpiry(r.data.tokenExpiry); })
      .catch(() => {});
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const showBanner = tokenExpiry && !bannerDismissed && tokenExpiry.days_remaining <= 14;
  const isExpired  = tokenExpiry && tokenExpiry.days_remaining < 0;
  const isCritical = tokenExpiry && tokenExpiry.days_remaining <= 3 && !isExpired;

  const bannerBg   = isExpired || isCritical
    ? 'bg-red-950 border-b border-red-800'
    : 'bg-amber-950 border-b border-amber-800';
  const bannerText = isExpired || isCritical ? 'text-red-300' : 'text-amber-300';
  const bannerIcon = isExpired ? '🔴' : isCritical ? '🟠' : '⚠️';

  const expiryLabel = isExpired
    ? 'Your QuickBooks connection has expired.'
    : `Your QuickBooks connection expires in ${tokenExpiry?.days_remaining} day${tokenExpiry?.days_remaining === 1 ? '' : 's'}.`;

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* ── Token expiry banner ─────────────────────────────────────────────── */}
      {showBanner && (
        <div className={`${bannerBg} flex items-center justify-between px-4 py-2 shrink-0 z-50`}>
          <div className={`flex items-center gap-2 text-xs ${bannerText}`}>
            <span>{bannerIcon}</span>
            <span>
              <span className="font-semibold">{expiryLabel}</span>
              {' '}
              <Link to="/setup" className="underline underline-offset-2 hover:opacity-80 font-medium">
                Reconnect QuickBooks →
              </Link>
            </span>
          </div>
          {!isExpired && (
            <button
              onClick={() => setBannerDismissed(true)}
              className={`${bannerText} hover:opacity-60 text-sm ml-4 shrink-0`}
              aria-label="Dismiss"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* ── Mobile top bar (hidden on md+) ──────────────────────────────────── */}
      <div className="md:hidden flex items-center justify-between px-4 h-14 bg-gray-900 border-b border-gray-800 shrink-0 z-40">
        <button
          onClick={() => setDrawerOpen(true)}
          className="text-gray-400 hover:text-gray-200 p-1 -ml-1"
          aria-label="Open navigation"
        >
          {/* Hamburger icon */}
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="text-blue-400 font-bold tracking-tight">PayPal → QBO</span>
        {/* Right spacer keeps title centred */}
        <div className="w-8" />
      </div>

      {/* ── App body ────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Desktop sidebar (hidden on mobile) */}
        <aside
          className={`hidden md:flex flex-col bg-gray-900 border-r border-gray-800 transition-all duration-200
            ${collapsed ? 'w-14' : 'w-56'}`}
        >
          {/* Logo row */}
          <div className="flex items-center gap-3 px-4 h-14 border-b border-gray-800 shrink-0">
            <span className="text-blue-400 text-xl font-bold">PP</span>
            {!collapsed && (
              <span className="text-sm font-semibold text-gray-200 leading-tight">
                PayPal → QBO
              </span>
            )}
            <button
              onClick={() => setCollapsed(c => !c)}
              className="ml-auto text-gray-500 hover:text-gray-300 text-xs"
              title="Toggle sidebar"
            >
              {collapsed ? '›' : '‹'}
            </button>
          </div>

          {/* Nav links */}
          <nav className="flex-1 py-4 overflow-y-auto">
            {NAV.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-4 py-2.5 text-sm transition-colors
                   ${isActive
                     ? 'bg-blue-900/40 text-blue-400 border-r-2 border-blue-500'
                     : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60'}`
                }
              >
                <span className="text-base w-5 text-center">{item.icon}</span>
                {!collapsed && <span>{item.label}</span>}
              </NavLink>
            ))}
          </nav>

          {/* User footer */}
          <div className="border-t border-gray-800 p-3 shrink-0">
            {!collapsed && (
              <p className="text-xs text-gray-500 truncate mb-2">{user?.email}</p>
            )}
            <div className={`flex ${collapsed ? 'flex-col gap-2 items-center' : 'items-center justify-between'}`}>
              <NavLink
                to="/account"
                title="My Account"
                className={({ isActive }) =>
                  `flex items-center gap-1.5 text-xs transition-colors
                   ${isActive ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'}`
                }
              >
                <span>👤</span>
                {!collapsed && <span>Account</span>}
              </NavLink>
              <button
                onClick={handleLogout}
                title="Logout"
                className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-red-400 transition-colors"
              >
                <span>⎋</span>
                {!collapsed && <span>Logout</span>}
              </button>
            </div>
          </div>
        </aside>

        {/* ── Mobile slide-out drawer ──────────────────────────────────────── */}
        {drawerOpen && (
          <div className="md:hidden">
            {/* Backdrop */}
            <div
              className="fixed inset-0 bg-black/60 z-40"
              onClick={() => setDrawerOpen(false)}
            />
            {/* Drawer panel */}
            <div className="fixed inset-y-0 left-0 w-64 bg-gray-900 border-r border-gray-800 z-50 flex flex-col">
              {/* Drawer header */}
              <div className="flex items-center justify-between px-4 h-14 border-b border-gray-800 shrink-0">
                <span className="text-blue-400 font-bold tracking-tight">PayPal → QBO</span>
                <button
                  onClick={() => setDrawerOpen(false)}
                  className="text-gray-500 hover:text-gray-300 p-1"
                  aria-label="Close navigation"
                >
                  ✕
                </button>
              </div>

              {/* Nav links */}
              <nav className="flex-1 py-4 overflow-y-auto">
                {NAV.map(item => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={() => setDrawerOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-4 py-3 text-sm transition-colors
                       ${isActive
                         ? 'bg-blue-900/40 text-blue-400 border-r-2 border-blue-500'
                         : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60'}`
                    }
                  >
                    <span className="text-base w-5 text-center">{item.icon}</span>
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </nav>

              {/* User footer */}
              <div className="border-t border-gray-800 p-4 shrink-0 space-y-3">
                <p className="text-xs text-gray-500 truncate">{user?.email}</p>
                <NavLink
                  to="/account"
                  onClick={() => setDrawerOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-2 text-sm transition-colors
                     ${isActive ? 'text-blue-400' : 'text-gray-400 hover:text-gray-200'}`
                  }
                >
                  <span>👤</span>
                  <span>My Account</span>
                </NavLink>
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-2 text-sm text-gray-500 hover:text-red-400 transition-colors"
                >
                  <span>⎋</span>
                  <span>Logout</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Main content */}
        <main className="flex-1 overflow-y-auto bg-gray-950">
          {children}
        </main>
      </div>
    </div>
  );
}
