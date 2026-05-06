import React, { useEffect, useState } from 'react';
import {
  X, Loader2, AlertCircle, Bell, Shield, Globe, Sun, Moon, Monitor, Volume2,
  VolumeX, Eye, EyeOff,
} from 'lucide-react';
import {
  getDefaultNotifySettings,
  setDefaultNotifySettings,
  resetNotifySettings,
  getPrivacy,
  setPrivacy,
  getLanguage,
  listLanguages,
} from '../../api/telegramClient';

const PRIVACY_KEYS = [
  { key: 'statusTimestamp', label: 'Last seen & online' },
  { key: 'profilePhoto',    label: 'Profile photo' },
  { key: 'phoneNumber',     label: 'Phone number' },
  { key: 'phoneCall',       label: 'Voice / video calls' },
  { key: 'forwards',        label: 'Forwarded messages' },
  { key: 'chatInvite',      label: 'Group invites' },
  { key: 'voiceMessages',   label: 'Voice messages' },
];

const THEME_KEY = 'tgClient.theme';

function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const want = theme === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  if (want === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

/**
 * SettingsDrawer — slide-over with three tabs:
 *   - Notifications: per-kind defaults (users / chats / broadcasts).
 *   - Privacy: per-key rule (everybody / contacts / nobody).
 *   - Appearance: theme + language.
 */
export default function SettingsDrawer({ sessionId, isOpen, onClose }) {
  const [tab, setTab] = useState('notifications');
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    if (isOpen) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-md flex-col border-l border-white/10 bg-dark-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
          <div className="text-sm font-semibold text-gray-100">Settings</div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-full p-1 text-gray-400 hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-1 border-b border-white/5 px-2 py-2 text-[11px]">
          <TabButton active={tab === 'notifications'} onClick={() => setTab('notifications')} Icon={Bell} label="Notifications" />
          <TabButton active={tab === 'privacy'} onClick={() => setTab('privacy')} Icon={Shield} label="Privacy" />
          <TabButton active={tab === 'appearance'} onClick={() => setTab('appearance')} Icon={Globe} label="Appearance" />
        </div>

        {error && (
          <div className="mx-4 mt-3 flex items-start gap-2 rounded-md bg-red-900/30 p-2 text-xs text-red-300">
            <AlertCircle className="h-4 w-4" />
            <div className="flex-1">{error}</div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'notifications' && <NotificationsTab sessionId={sessionId} setError={setError} />}
          {tab === 'privacy' && <PrivacyTab sessionId={sessionId} setError={setError} />}
          {tab === 'appearance' && <AppearanceTab sessionId={sessionId} setError={setError} />}
        </div>
      </aside>
    </div>
  );
}

function TabButton({ active, onClick, Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-1 rounded-md py-2 ${
        active ? 'bg-white/10 text-blue-300' : 'text-gray-400 hover:bg-white/5'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function NotificationsTab({ sessionId, setError }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getDefaultNotifySettings(sessionId)
      .then(({ data }) => { if (alive) setSettings(data?.data || null); })
      .catch((err) => alive && setError(err?.response?.data?.error?.message || err.message))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sessionId, setError]);

  const update = async (kind, payload) => {
    setBusy(kind);
    try {
      const { data } = await setDefaultNotifySettings(sessionId, kind, payload);
      setSettings(data?.data || settings);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message);
    } finally { setBusy(null); }
  };

  const reset = async () => {
    if (typeof window !== 'undefined' && !window.confirm('Reset all notification overrides?')) return;
    setBusy('reset');
    try {
      const { data } = await resetNotifySettings(sessionId);
      setSettings(data?.data || settings);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message);
    } finally { setBusy(null); }
  };

  if (loading || !settings) {
    return (
      <div className="flex items-center justify-center py-10 text-gray-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {[
        { kind: 'users', label: 'Private chats' },
        { kind: 'chats', label: 'Groups' },
        { kind: 'broadcasts', label: 'Channels' },
      ].map(({ kind, label }) => {
        const s = settings[kind] || {};
        const muted = s.muteUntil > Math.floor(Date.now() / 1000);
        return (
          <div key={kind} className="rounded-lg border border-white/5 bg-dark-800/40 p-3">
            <div className="mb-2 flex items-center gap-2">
              <div className="text-sm font-semibold text-gray-100">{label}</div>
              {busy === kind && <Loader2 className="h-3 w-3 animate-spin text-gray-400" />}
            </div>
            <Toggle
              label={muted ? 'Muted' : 'Notifications enabled'}
              Icon={muted ? VolumeX : Volume2}
              on={!muted}
              onChange={(v) => update(kind, { muteUntilSec: v ? 0 : 0x7fffffff })}
            />
            <Toggle
              label="Show message preview"
              Icon={s.showPreviews ? Eye : EyeOff}
              on={s.showPreviews}
              onChange={(v) => update(kind, { showPreviews: v })}
            />
            <Toggle
              label="Silent (no sound)"
              Icon={s.silent ? VolumeX : Volume2}
              on={s.silent}
              onChange={(v) => update(kind, { silent: v })}
            />
          </div>
        );
      })}
      <button
        type="button"
        onClick={reset}
        disabled={busy === 'reset'}
        className="w-full rounded-md border border-white/10 px-3 py-2 text-xs text-gray-300 hover:bg-white/5 disabled:opacity-50"
      >
        {busy === 'reset' ? 'Resetting…' : 'Reset all notification overrides'}
      </button>
    </div>
  );
}

function PrivacyTab({ sessionId, setError }) {
  const [rules, setRules] = useState({}); // key -> {value, allow, disallow}
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all(PRIVACY_KEYS.map(({ key }) => getPrivacy(sessionId, key)
      .then(({ data }) => [key, _ruleValue(data?.data?.rules || [])])
      .catch(() => [key, 'everybody'])))
      .then((entries) => {
        if (!alive) return;
        const acc = {};
        for (const [k, v] of entries) acc[k] = v;
        setRules(acc);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sessionId]);

  const update = async (key, value) => {
    setBusyKey(key);
    try {
      await setPrivacy(sessionId, key, { value });
      setRules((r) => ({ ...r, [key]: value }));
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message);
    } finally { setBusyKey(null); }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-gray-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {PRIVACY_KEYS.map(({ key, label }) => (
        <div key={key} className="rounded-lg border border-white/5 bg-dark-800/40 p-3">
          <div className="mb-2 flex items-center gap-2">
            <div className="text-sm font-medium text-gray-100">{label}</div>
            {busyKey === key && <Loader2 className="h-3 w-3 animate-spin text-gray-400" />}
          </div>
          <div className="grid grid-cols-3 gap-1 text-xs">
            {['everybody', 'contacts', 'nobody'].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => update(key, v)}
                disabled={busyKey === key}
                className={`rounded-md px-2 py-1.5 capitalize ${
                  rules[key] === v
                    ? 'bg-blue-600 text-white'
                    : 'bg-dark-800 text-gray-200 hover:bg-white/5'
                } disabled:opacity-50`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AppearanceTab({ sessionId, setError }) {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) || 'dark'; }
    catch { return 'dark'; }
  });
  const [lang, setLang] = useState(null);
  const [langs, setLangs] = useState([]);
  const [loadingLangs, setLoadingLangs] = useState(true);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (_) { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    let alive = true;
    setLoadingLangs(true);
    Promise.all([
      getLanguage(sessionId).catch(() => ({ data: { data: { langCode: null } } })),
      listLanguages(sessionId).catch(() => ({ data: { data: { languages: [] } } })),
    ])
      .then(([{ data: l }, { data: list }]) => {
        if (!alive) return;
        setLang(l?.data?.langCode || null);
        setLangs(list?.data?.languages || []);
      })
      .catch((err) => alive && setError(err?.response?.data?.error?.message || err.message))
      .finally(() => { if (alive) setLoadingLangs(false); });
    return () => { alive = false; };
  }, [sessionId, setError]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-white/5 bg-dark-800/40 p-3">
        <div className="mb-2 text-sm font-semibold text-gray-100">Theme</div>
        <div className="grid grid-cols-3 gap-1 text-xs">
          {[
            { key: 'light',  Icon: Sun,     label: 'Light' },
            { key: 'dark',   Icon: Moon,    label: 'Dark' },
            { key: 'system', Icon: Monitor, label: 'System' },
          ].map(({ key, Icon, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTheme(key)}
              className={`flex items-center justify-center gap-1 rounded-md px-2 py-2 ${
                theme === key
                  ? 'bg-blue-600 text-white'
                  : 'bg-dark-800 text-gray-200 hover:bg-white/5'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
        <div className="mt-2 text-[11px] text-gray-500">
          Theme is per-window and stored locally.
        </div>
      </div>

      <div className="rounded-lg border border-white/5 bg-dark-800/40 p-3">
        <div className="mb-2 text-sm font-semibold text-gray-100">Language</div>
        {loadingLangs ? (
          <div className="flex items-center justify-center py-3 text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <>
            <div className="mb-2 text-[11px] text-gray-500">
              Account language (read-only): <span className="text-gray-300">{lang || 'unknown'}</span>
            </div>
            <div className="max-h-56 overflow-y-auto rounded-md border border-white/5">
              {langs.slice(0, 50).map((l) => (
                <div
                  key={l.langCode}
                  className={`flex items-center justify-between px-3 py-1.5 text-xs ${
                    l.langCode === lang ? 'bg-blue-500/10 text-blue-200' : 'text-gray-300 hover:bg-white/5'
                  }`}
                >
                  <span className="truncate">{l.nativeName} <span className="text-gray-500">({l.name})</span></span>
                  <span className="text-[10px] text-gray-500">{l.langCode}</span>
                </div>
              ))}
              {langs.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-gray-500">No languages available</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Toggle({ label, Icon, on, onChange }) {
  return (
    <label className="mt-2 flex cursor-pointer items-center gap-2">
      <Icon className={`h-4 w-4 ${on ? 'text-blue-300' : 'text-gray-500'}`} />
      <span className="flex-1 text-xs text-gray-200">{label}</span>
      <span
        onClick={() => onChange(!on)}
        className={`relative inline-block h-4 w-7 rounded-full transition-colors ${
          on ? 'bg-blue-500' : 'bg-gray-600'
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
            on ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </span>
    </label>
  );
}

function _ruleValue(rules) {
  // Compress an array of normalized rule objects back to a UI value.
  const types = (rules || []).map((r) => r.type);
  if (types.includes('PrivacyValueAllowAll')) return 'everybody';
  if (types.includes('PrivacyValueDisallowAll')) return 'nobody';
  if (types.includes('PrivacyValueAllowContacts')) return 'contacts';
  return 'everybody';
}

// Apply persisted theme as soon as the module loads so settings open
// in the right state.
try {
  if (typeof window !== 'undefined') {
    applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
  }
} catch (_) { /* ignore */ }
