/**
 * Instagram Panel — settings.
 *
 * Telegram needs an api_id/api_hash credential vault before it can do
 * anything (MTProto). Instagram doesn't — instagram-private-api
 * authenticates per-account with the IG username/password during
 * session creation, so there's no panel-wide credential to set here.
 *
 * Instead this page exposes:
 *   - The admin profile (managed via backend .env, surfaced read-only).
 *   - Per-account notification preferences (stored in localStorage).
 *   - Per-platform IG defaults (default API mode, default locale,
 *     scrape limit guardrails). These are stored under
 *     `localStorage["ig:settings:v1"]` and consumed by the IG
 *     pages on this side of the panel.
 *   - Danger zone (sign out / wipe local prefs).
 */

import { useEffect, useState } from 'react';
import {
  Settings as SettingsIcon,
  Bell,
  AlertTriangle,
  Save,
  LogOut,
  Volume2,
  Languages,
  Cpu,
  RotateCcw,
} from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../components/common/Toast';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';

const PREF_KEY = 'ig:settings:v1';

const DEFAULTS = {
  notifSessionLogin: true,
  notifScrapeComplete: true,
  notifMessageSent: true,
  notifErrors: true,
  notifSound: false,

  defaultApiMode: 'mobile',
  defaultLocale: 'en_US',
  defaultScrapeLimit: 1000,
  showProxyByDefault: true,
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
    return true;
  } catch (_) {
    return false;
  }
}

function SectionCard({ icon: Icon, title, description, children }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 shadow-sm">
      <div className="border-b border-white/5 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-pink-500/10 text-pink-300">
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white">{title}</h2>
            {description && <p className="text-xs text-white/65">{description}</p>}
          </div>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label, description }) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex-1">
        <p className="text-sm font-medium text-white/90">{label}</p>
        {description && <p className="mt-0.5 text-xs text-white/60">{description}</p>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]' : 'bg-white/15'
        }`}
        role="switch"
        aria-checked={checked}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

export default function InstagramSettings() {
  const { user, logout } = useAuth();
  const { showToast } = useToast();
  const [prefs, setPrefs] = useState(loadPrefs);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { setDirty(false); }, []);

  function set(key, value) {
    setPrefs((p) => ({ ...p, [key]: value }));
    setDirty(true);
  }

  function handleSave() {
    if (savePrefs(prefs)) {
      setDirty(false);
      showToast('Instagram panel preferences saved.', 'success');
    } else {
      showToast('Could not write to localStorage', 'error');
    }
  }

  function handleReset() {
    setPrefs({ ...DEFAULTS });
    setDirty(true);
  }

  return (
    <InstagramFeatureShell
      icon={SettingsIcon}
      title="Panel settings"
      subtitle="Notification preferences and Instagram-specific defaults for this panel."
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium ring-1 ring-white/25 hover:bg-white/25"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] px-3 py-1.5 text-xs font-semibold text-white shadow disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            Save
          </button>
        </div>
      }
    >
      <div className="grid gap-5 lg:grid-cols-2">
        {/* Profile (read-only) */}
        <SectionCard
          icon={SettingsIcon}
          title="Admin profile"
          description="Single-admin mode — credentials are managed in the backend .env."
        >
          <div className="space-y-3 text-sm">
            <div>
              <div className="mb-1 text-xs font-medium text-white/65">Email</div>
              <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white/90">
                {user?.email || 'admin@example.com'}
              </div>
            </div>
            <div className="text-xs text-white/55">
              Password is managed via <code className="rounded bg-black/40 px-1.5 py-0.5">ADMIN_PASSWORD</code>
              in the backend <code className="rounded bg-black/40 px-1.5 py-0.5">.env</code> file.
            </div>
          </div>
        </SectionCard>

        {/* Instagram defaults */}
        <SectionCard
          icon={Cpu}
          title="Instagram defaults"
          description="Sensible defaults for new IG sessions and scrape jobs."
        >
          <div className="space-y-4 text-sm">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-white/70">Default API mode</label>
              <select
                value={prefs.defaultApiMode}
                onChange={(e) => set('defaultApiMode', e.target.value)}
                className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-white focus:border-pink-300 focus:outline-none focus:ring-1 focus:ring-pink-300"
              >
                <option value="mobile">Mobile (instagram-private-api)</option>
                <option value="web">Web (graphql)</option>
              </select>
              <p className="mt-1 text-[11px] text-white/55">
                Mobile API is required for editing the profile / changing the
                profile picture / 2FA. Web API is read-mostly.
              </p>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-white/70">
                <Languages className="mr-1 inline h-3.5 w-3.5" />Default locale
              </label>
              <select
                value={prefs.defaultLocale}
                onChange={(e) => set('defaultLocale', e.target.value)}
                className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-white focus:border-pink-300 focus:outline-none focus:ring-1 focus:ring-pink-300"
              >
                <option value="en_US">English (US)</option>
                <option value="en_GB">English (UK)</option>
                <option value="es_ES">Español (España)</option>
                <option value="es_MX">Español (México)</option>
                <option value="pt_BR">Português (Brasil)</option>
                <option value="fr_FR">Français</option>
                <option value="de_DE">Deutsch</option>
                <option value="hi_IN">हिन्दी (India)</option>
                <option value="ar_SA">العربية</option>
                <option value="ru_RU">Русский</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-white/70">Default scrape limit</label>
              <input
                type="number"
                min={1}
                max={50000}
                value={prefs.defaultScrapeLimit}
                onChange={(e) => set('defaultScrapeLimit', Math.max(1, Math.min(50000, Number(e.target.value) || 1000)))}
                className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-white focus:border-pink-300 focus:outline-none focus:ring-1 focus:ring-pink-300"
              />
              <p className="mt-1 text-[11px] text-white/55">
                Pre-fills the scrape job form. Per-account daily caps still apply
                regardless of this setting.
              </p>
            </div>
            <Toggle
              checked={prefs.showProxyByDefault}
              onChange={(v) => set('showProxyByDefault', v)}
              label="Use proxy by default on scrape jobs"
              description='Pre-tick the "Use proxy" box on the scrape form. Untick on the form to bypass per-job.'
            />
          </div>
        </SectionCard>

        {/* Notifications */}
        <SectionCard
          icon={Bell}
          title="Notifications"
          description="Toast / sound prompts for IG events. Stored locally."
        >
          <div className="divide-y divide-white/5">
            <Toggle checked={prefs.notifSessionLogin} onChange={(v) => set('notifSessionLogin', v)}
              label="Session login alerts" description="Notify on new IG account login." />
            <Toggle checked={prefs.notifScrapeComplete} onChange={(v) => set('notifScrapeComplete', v)}
              label="Scrape job completion" description="Notify when an IG scrape job finishes." />
            <Toggle checked={prefs.notifMessageSent} onChange={(v) => set('notifMessageSent', v)}
              label="Direct-message campaign completion" description="Notify when a DM batch finishes." />
            <Toggle checked={prefs.notifErrors} onChange={(v) => set('notifErrors', v)}
              label="Error alerts" description="Notify on checkpoint, login_required, or proxy failures." />
            <div className="flex items-center justify-between py-3">
              <div className="flex-1">
                <p className="text-sm font-medium text-white/90 flex items-center gap-1.5">
                  <Volume2 className="h-3.5 w-3.5" /> Sound effects
                </p>
                <p className="mt-0.5 text-xs text-white/60">Play a sound for in-app notifications.</p>
              </div>
              <button
                type="button"
                onClick={() => set('notifSound', !prefs.notifSound)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                  prefs.notifSound ? 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]' : 'bg-white/15'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                    prefs.notifSound ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>
        </SectionCard>

        {/* Danger zone */}
        <div className="rounded-xl border border-red-500/20 bg-black/30 shadow-sm">
          <div className="border-b border-red-500/10 px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-500/10 text-red-300">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-red-200">Danger zone</h2>
                <p className="text-xs text-white/65">Sign out or reset local IG panel preferences.</p>
              </div>
            </div>
          </div>
          <div className="space-y-3 p-5">
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Reset all Instagram panel preferences to defaults? This only affects this browser.')) {
                  localStorage.removeItem(PREF_KEY);
                  setPrefs({ ...DEFAULTS });
                  setDirty(false);
                  showToast('Instagram panel preferences cleared.', 'success');
                }
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-white hover:bg-white/15"
            >
              <RotateCcw className="h-4 w-4" />
              Reset preferences
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Sign out of the panel?')) logout();
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-red-500/15 px-3 py-2 text-sm font-medium text-red-200 ring-1 ring-red-300/30 hover:bg-red-500/25"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      </div>
    </InstagramFeatureShell>
  );
}
