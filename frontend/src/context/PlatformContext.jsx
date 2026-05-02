/**
 * PlatformContext — provides the active panel platform ('telegram' | 'instagram')
 * to the entire React tree.
 *
 * Reads the platform from the URL (`/:platform/...`) and synchronises:
 *   - localStorage so the next visit sticks to the same platform,
 *   - the html[data-platform] attribute so platform-specific CSS tokens
 *     (see platform-tokens.css) cascade into Tailwind utilities,
 *   - axios default headers so backend requests carry X-Platform.
 *
 * Capabilities for the active platform are fetched once per platform
 * switch from /api/<platform>/meta/capabilities and exposed via
 * `useCapabilities()`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api/client';

export const PLATFORMS = ['telegram', 'instagram'];
export const DEFAULT_PLATFORM = 'telegram';

export const PLATFORM_LABELS = {
  telegram: 'Telegram',
  instagram: 'Instagram',
};

export const PLATFORM_FEATURE_FLAG_KEY = 'feature_instagram_panel';

/**
 * The Instagram panel ships enabled by default. The localStorage flag
 * is now an *opt-out* — set it to "0" to hide the Instagram tab. This
 * matches operator expectations: previously the flag was opt-in and
 * Instagram silently never appeared until someone manually flipped it
 * in DevTools.
 */
function isPlatformEnabled(platform) {
  if (platform === 'telegram') return true;
  if (platform === 'instagram') {
    try {
      return localStorage.getItem(PLATFORM_FEATURE_FLAG_KEY) !== '0';
    } catch (_) {
      return true;
    }
  }
  return false;
}

export function platformFromPath(pathname) {
  const m = /^\/(telegram|instagram)(?=\/|$)/.exec(pathname || '');
  return m ? m[1] : null;
}

const PlatformContext = createContext({
  platform: DEFAULT_PLATFORM,
  setPlatform: () => {},
  isEnabled: () => false,
  capabilities: null,
  capabilitiesLoading: false,
});

export function PlatformProvider({ children }) {
  const location = useLocation();
  const navigate = useNavigate();

  const initial = (() => {
    const fromPath = platformFromPath(location.pathname);
    if (fromPath) return fromPath;
    try {
      const stored = localStorage.getItem('panel_platform');
      if (stored && PLATFORMS.includes(stored) && isPlatformEnabled(stored)) {
        return stored;
      }
    } catch (_) { /* SSR / private mode */ }
    return DEFAULT_PLATFORM;
  })();

  const [platform, _setPlatform] = useState(initial);
  const [capabilities, setCapabilities] = useState(null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);

  // Mirror URL → state when the user navigates between panels.
  useEffect(() => {
    const fromPath = platformFromPath(location.pathname);
    if (fromPath && fromPath !== platform) {
      _setPlatform(fromPath);
    }
  }, [location.pathname, platform]);

  // Mirror state → DOM attribute + localStorage + axios header.
  useEffect(() => {
    try { document.documentElement.setAttribute('data-platform', platform); } catch (_) {}
    try { localStorage.setItem('panel_platform', platform); } catch (_) {}
    try { api.defaults.headers.common['X-Platform'] = platform; } catch (_) {}
  }, [platform]);

  // Fetch capabilities for the current platform on switch.
  useEffect(() => {
    let alive = true;
    setCapabilitiesLoading(true);
    api
      .get(`/${platform}/meta/capabilities`)
      .then((r) => {
        if (!alive) return;
        setCapabilities(r.data?.capabilities || null);
      })
      .catch(() => {
        if (!alive) return;
        // Fallback: leave capabilities=null so consumers degrade by
        // hiding optional features.
        setCapabilities(null);
      })
      .finally(() => { if (alive) setCapabilitiesLoading(false); });
    return () => { alive = false; };
  }, [platform]);

  const setPlatform = useCallback((next) => {
    if (!PLATFORMS.includes(next)) return;
    if (!isPlatformEnabled(next)) return;
    _setPlatform(next);
    // Rewrite the URL to keep it in sync so deep-links work.
    const path = location.pathname || '/';
    const replaced =
      /^\/(telegram|instagram)(?=\/|$)/.test(path)
        ? path.replace(/^\/(telegram|instagram)/, `/${next}`)
        : `/${next}${path}`;
    navigate(replaced + (location.search || '') + (location.hash || ''), { replace: true });
  }, [location.pathname, location.search, location.hash, navigate]);

  const value = useMemo(
    () => ({
      platform,
      setPlatform,
      isEnabled: isPlatformEnabled,
      capabilities,
      capabilitiesLoading,
    }),
    [platform, setPlatform, capabilities, capabilitiesLoading]
  );

  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export function usePlatform() {
  return useContext(PlatformContext);
}

export function useCapabilities() {
  const ctx = useContext(PlatformContext);
  return ctx.capabilities;
}

export function useCapability(name) {
  const caps = useCapabilities();
  if (!caps) return undefined;
  return !!caps[name];
}
