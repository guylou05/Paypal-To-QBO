import React, { createContext, useContext, useState, useEffect } from 'react';
import { authApi } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authApi.me()
      .then(r => setUser(r.data))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const r = await authApi.login(email, password);
    setUser(r.data.user);
    return r.data.user;
  };

  const logout = async () => {
    await authApi.logout().catch(() => {});
    setUser(null);
  };

  // Call after a profile update that changes the user object (e.g. email change)
  const refreshUser = async () => {
    try {
      const r = await authApi.me();
      setUser(r.data);
    } catch {}
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
