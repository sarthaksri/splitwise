import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext(null);

export const THEMES = ['light', 'dark', 'system'];
const STORAGE_KEY = 'sw-theme';

/** What `system` currently resolves to. */
const systemPrefersDark = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-color-scheme: dark)').matches;

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);

  // The <meta name="theme-color"> tags in index.html are media-query based, so
  // they follow the OS and would ignore a manual override. Write an explicit
  // one so the browser and PWA chrome match what's actually on screen.
  let meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = dark ? '#0a0a0a' : '#f7f1e4';

  return dark;
}

export function ThemeProvider({ children }) {
  // Read the same key the inline boot script used, so React starts in the
  // theme that's already painted rather than flipping on mount.
  const [theme, setThemeState] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(stored) ? stored : 'system';
  });
  const [isDark, setIsDark] = useState(() => systemPrefersDark());

  useEffect(() => {
    setIsDark(applyTheme(theme));
  }, [theme]);

  // Follow the OS while the preference is "system".
  useEffect(() => {
    if (theme !== 'system') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setIsDark(applyTheme('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((next) => {
    setThemeState(next);
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const value = useMemo(
    () => ({
      theme,
      isDark,
      setTheme,
      /** Flip to the opposite of what's on screen right now. */
      toggle: () => setTheme(isDark ? 'light' : 'dark'),
    }),
    [theme, isDark, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
