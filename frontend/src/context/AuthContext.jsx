import React, { createContext, useState, useEffect, useCallback, useContext } from 'react';
import {
  login as apiLogin,
  register as apiRegister,
  getProfile as apiGetProfile,
  updateProfile as apiUpdateProfile,
} from '@/api/auth';

export const AuthContext = createContext(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(localStorage.getItem('token'));

  const persist = useCallback((nextToken, nextUser) => {
    if (nextToken) {
      localStorage.setItem('token', nextToken);
    } else {
      localStorage.removeItem('token');
    }
    if (nextUser) {
      localStorage.setItem('user', JSON.stringify(nextUser));
    } else {
      localStorage.removeItem('user');
    }
    setToken(nextToken || null);
    setUser(nextUser || null);
  }, []);

  const login = useCallback(async (email, password) => {
    const response = await apiLogin({ email, password });
    const { token: newToken, user: userData } = response.data;
    persist(newToken, userData);
    return userData;
  }, [persist]);

  const register = useCallback(async (email, password) => {
    const response = await apiRegister({ email, password });
    const { token: newToken, user: userData } = response.data;
    persist(newToken, userData);
    return userData;
  }, [persist]);

  const logout = useCallback(() => {
    persist(null, null);
  }, [persist]);

  const refreshProfile = useCallback(async () => {
    const r = await apiGetProfile();
    const u = r.data?.user;
    if (u) {
      localStorage.setItem('user', JSON.stringify(u));
      setUser(u);
    }
    return u;
  }, []);

  const updateProfile = useCallback(async (data) => {
    const response = await apiUpdateProfile(data);
    const updatedUser = response.data.user;
    setUser(updatedUser);
    localStorage.setItem('user', JSON.stringify(updatedUser));
    return updatedUser;
  }, []);

  // Hydrate from localStorage on mount; refresh from server when there's a
  // token so banned/approval-state changes reflect on next page load.
  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    const storedToken = localStorage.getItem('token');
    if (storedUser && storedToken) {
      try {
        setUser(JSON.parse(storedUser));
        setToken(storedToken);
        apiGetProfile()
          .then((r) => {
            if (r?.data?.user) {
              localStorage.setItem('user', JSON.stringify(r.data.user));
              setUser(r.data.user);
            }
          })
          .catch(() => { /* interceptor handles invalid token */ })
          .finally(() => setLoading(false));
        return;
      } catch (e) {
        localStorage.removeItem('user');
        localStorage.removeItem('token');
      }
    }
    setLoading(false);
  }, []);

  const role = user?.role || null;
  const status = user?.status || null;
  const isApproved = !!(user?.isApproved || role === 'admin');
  const isBanned = status === 'banned';
  const isAdmin = role === 'admin';

  const value = {
    user,
    token,
    loading,
    login,
    register,
    logout,
    updateProfile,
    refreshProfile,
    isAuthenticated: !!token,
    role,
    status,
    isApproved,
    isBanned,
    isAdmin,
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
}
