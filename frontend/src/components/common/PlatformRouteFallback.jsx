import React from 'react';
import { useLocation } from 'react-router-dom';
import RouteFallback from './RouteFallback';
import InstagramRouteFallback from '../instagram/InstagramRouteFallback';

/**
 * Picks the right loading screen for the active panel so route
 * transitions never flash the wrong color.
 *
 * Instagram routes (any URL starting with /instagram/...) get the
 * pink/orange aurora fallback; everything else (Telegram, login,
 * register, pending) keeps the dark-blue Telegram fallback.
 *
 * Falls back to the URL because PlatformProvider's data-platform
 * attribute is set inside a useEffect — it isn't guaranteed to be on
 * <html> during the very first paint of a Suspense fallback.
 */
export default function PlatformRouteFallback(props) {
  let path = '';
  try {
    // useLocation must be inside <BrowserRouter>, which is always the
    // case for our top-level Suspense.
    path = useLocation().pathname || '';
  } catch (_) {
    if (typeof window !== 'undefined' && window.location) {
      path = window.location.pathname || '';
    }
  }
  if (path.startsWith('/instagram')) {
    return <InstagramRouteFallback {...props} />;
  }
  return <RouteFallback {...props} />;
}
