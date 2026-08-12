import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // The cookie is httpOnly, so the only way to know if we're signed in is to ask.
  useEffect(() => {
    let cancelled = false;
    api
      .get('/auth/me')
      .then((data) => !cancelled && setUser(data.user))
      .catch(() => !cancelled && setUser(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      login: async (email, password) => {
        const data = await api.post('/auth/login', { email, password });
        setUser(data.user);
        return data.user;
      },
      register: async (fields) => {
        const data = await api.post('/auth/register', fields);
        setUser(data.user);
        return data.user;
      },
      logout: async () => {
        await api.post('/auth/logout');
        setUser(null);
      },
    }),
    [user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
