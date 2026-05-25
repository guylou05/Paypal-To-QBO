import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

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
  const [collapsed, setCollapsed] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className={`flex flex-col bg-gray-900 border-r border-gray-800 transition-all ${collapsed ? 'w-14' : 'w-56'}`}>
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 h-14 border-b border-gray-800">
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

        {/* Navigation */}
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

        {/* User */}
        <div className="border-t border-gray-800 p-3">
          {!collapsed && (
            <p className="text-xs text-gray-500 truncate mb-2">{user?.email}</p>
          )}
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 text-xs text-gray-500 hover:text-red-400 transition-colors"
          >
            <span>⎋</span>
            {!collapsed && <span>Logout</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-gray-950">
        {children}
      </main>
    </div>
  );
}
