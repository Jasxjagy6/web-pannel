import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { trackingTeamAPI } from '../api/trackingTeam';

const TrackingAccessContext = createContext(null);

/**
 * Fetches the caller's tracking role/permissions once and shares it across
 * every Tracking page, so each page doesn't independently re-request
 * /tracking/team/me. `hasPermission` mirrors the backend's
 * requireTrackingPermission() gate — pages use it to hide/disable actions
 * the user can't perform (the backend enforces the real gate regardless).
 */
export function TrackingAccessProvider({ children }) {
  const [member, setMember] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await trackingTeamAPI.getMe();
      setMember(response.data.data);
    } catch (err) {
      if (err?.response?.status === 403) {
        setMember(null);
      } else {
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const value = useMemo(() => ({
    member,
    loading,
    error,
    refresh,
    hasAccess: !!member,
    role: member?.role || null,
    hasPermission: (name) => member?.permissions?.[name] === true,
  }), [member, loading, error, refresh]);

  return (
    <TrackingAccessContext.Provider value={value}>
      {children}
    </TrackingAccessContext.Provider>
  );
}

export function useTrackingAccess() {
  const ctx = useContext(TrackingAccessContext);
  if (!ctx) {
    throw new Error('useTrackingAccess must be used within a TrackingAccessProvider');
  }
  return ctx;
}
