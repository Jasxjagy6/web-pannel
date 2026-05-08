/**
 * ThemeContext — light / dark theme switcher for the Telegram panel.
 *
 * The Instagram panel intentionally stays on its obsidian / aurora
 * design and is not affected by this context.
 *
 * Mechanics:
 *   - Persists the chosen theme to localStorage under THEME_STORAGE_KEY.
 *   - Mirrors the chosen theme to html[data-tg-theme="dark"|"light"].
 *   - The override CSS in index.css keys off
 *     `html[data-platform="telegram"][data-tg-theme="light"]` (and
 *     `…="dark"`), so the Telegram panel repaints to the chosen
 *     surface palette without re-rendering React.
 *   - Initial theme is read from localStorage (or defaults to 'dark')
 *     synchronously inside <head> via main.jsx, so the very first
 *     paint already renders in the correct palette — no flash.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export const TG_THEMES = ['dark', 'light'];
export const DEFAULT_TG_THEME = 'dark';
export const THEME_STORAGE_KEY = 'tg_panel_theme';

function readStoredTheme() {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v && TG_THEMES.includes(v)) return v;
  } catch (_) { /* SSR / private mode */ }
  return DEFAULT_TG_THEME;
}

const ThemeContext = createContext({
  theme: DEFAULT_TG_THEME,
  setTheme: () => {},
  toggleTheme: () => {},
});

export function ThemeProvider({ children }) {
  const [theme, _setTheme] = useState(() => readStoredTheme());

  // Mirror state -> DOM attribute + localStorage. The attribute is
  // always set on <html>; the override CSS in index.css scopes to
  // `[data-platform="telegram"]` so Instagram pages aren't affected.
  useEffect(() => {
    try { document.documentElement.setAttribute('data-tg-theme', theme); } catch (_) {}
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch (_) {}
  }, [theme]);

  const setTheme = useCallback((next) => {
    if (!TG_THEMES.includes(next)) return;
    _setTheme(next);
  }, []);

  const toggleTheme = useCallback(() => {
    _setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
