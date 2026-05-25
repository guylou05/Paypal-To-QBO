import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';

import Login               from './pages/Login';
import Dashboard           from './pages/Dashboard';
import SetupWizard         from './pages/SetupWizard';
import ImportTransactions  from './pages/ImportTransactions';
import ReviewQueue         from './pages/ReviewQueue';
import SyncToQBO           from './pages/SyncToQBO';
import Reports             from './pages/Reports';
import Logs                from './pages/Logs';
import Settings            from './pages/Settings';

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/*" element={
        <ProtectedRoute>
          <Layout>
            <Routes>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/setup"     element={<SetupWizard />} />
              <Route path="/import"    element={<ImportTransactions />} />
              <Route path="/review"    element={<ReviewQueue />} />
              <Route path="/sync"      element={<SyncToQBO />} />
              <Route path="/reports"   element={<Reports />} />
              <Route path="/logs"      element={<Logs />} />
              <Route path="/settings"  element={<Settings />} />
            </Routes>
          </Layout>
        </ProtectedRoute>
      } />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
