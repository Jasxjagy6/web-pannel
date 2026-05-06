/**
 * Instagram 2FA — per-session TOTP / SMS / WhatsApp status panel.
 *
 * Telegram has a single cloud-password layer that the panel can mass-set
 * with bulk jobs. Instagram is fundamentally different:
 *   - 2FA is per-account TOTP/SMS/WhatsApp.
 *   - There is no SRP-style password to bulk-rotate.
 *
 * So this page is per-account: pick a logged-in IG session, see the
 * current 2FA state (totp / sms / whatsapp / trusted devices) and
 * enable/disable/rotate the TOTP layer if the SDK exposes it.
 */

import { apiError } from '../../utils/apiError';
import { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck,
  ShieldOff,
  KeyRound,
  Smartphone,
  MessageCircle,
  RefreshCw,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Info,
} from 'lucide-react';
import { listSessions } from '../../api/sessions';
import {
  getStatus,
  enable,
  disable,
  rotate,
} from '../../api/instagramTwoFactor';
import { useToast } from '../../components/common/Toast';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';

const IG_GRADIENT_BTN =
  'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

export default function InstagramChange2FA() {
  const { showToast } = useToast();

  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);

  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [busy, setBusy] = useState(null); // 'enable' | 'disable' | 'rotate' | null
  const [error, setError] = useState(null);

  async function reloadSessions() {
    setSessionsLoading(true);
    try {
      const r = await listSessions({ page: 1, limit: 200 });
      const data = r.data?.data || r.data || {};
      const list = (data.sessions || []).filter(
        (s) => s.is_logged_in && s.platform === 'instagram'
      );
      setSessions(list);
      if (!selectedId && list.length) setSelectedId(list[0].id);
    } catch (err) {
      showToast(apiError(err, 'Failed to load Instagram sessions'), 'error');
    } finally {
      setSessionsLoading(false);
    }
  }

  async function loadStatus(id) {
    if (!id) return;
    setStatusLoading(true);
    setError(null);
    try {
      const r = await getStatus(id);
      setStatus(r.data?.data || null);
    } catch (err) {
      setStatus(null);
      setError(apiError(err, 'Failed to read 2FA status'));
    } finally {
      setStatusLoading(false);
    }
  }

  useEffect(() => {
    reloadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedId) loadStatus(selectedId);
  }, [selectedId]);

  async function handleAction(kind) {
    if (!selectedId || busy) return;
    setBusy(kind);
    try {
      if (kind === 'enable') await enable(selectedId);
      else if (kind === 'disable') await disable(selectedId);
      else if (kind === 'rotate') await rotate(selectedId);
      const messages = {
        enable: 'TOTP 2FA enabled. Save the backup codes Instagram returned.',
        disable: 'TOTP 2FA disabled.',
        rotate: 'TOTP secret rotated. Re-enrol your authenticator app.',
      };
      showToast(messages[kind], 'success');
      await loadStatus(selectedId);
    } catch (err) {
      showToast(apiError(err, `Failed to ${kind} 2FA`), 'error');
    } finally {
      setBusy(null);
    }
  }

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedId) || null,
    [sessions, selectedId]
  );

  return (
    <InstagramFeatureShell
      icon={ShieldCheck}
      title="Two-factor authentication"
      subtitle="TOTP, SMS and WhatsApp 2FA per Instagram account."
      actions={
        <button
          type="button"
          onClick={() => loadStatus(selectedId)}
          disabled={!selectedId || statusLoading}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium ring-1 ring-white/25 hover:bg-white/25 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${statusLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
        {/* Session picker */}
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="mb-2 px-1 text-xs uppercase tracking-wide text-white/60">
            Instagram accounts
          </div>
          {sessionsLoading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-white/60">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : sessions.length === 0 ? (
            <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
              No logged-in Instagram sessions. Create one from the Sessions page.
            </div>
          ) : (
            <ul className="max-h-[420px] space-y-1 overflow-y-auto">
              {sessions.map((s) => {
                const active = s.id === selectedId;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(s.id)}
                      className={[
                        'flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition',
                        active
                          ? `${IG_GRADIENT_BTN} text-white shadow`
                          : 'text-white/85 hover:bg-white/10',
                      ].join(' ')}
                    >
                      <span className="truncate">@{s.username || `session_${s.id}`}</span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide opacity-80">
                        #{s.id}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Status panel */}
        <div className="rounded-xl border border-white/10 bg-black/20 p-5">
          {!selectedId ? (
            <div className="flex h-40 items-center justify-center text-sm text-white/60">
              Pick an Instagram account on the left to manage its 2FA.
            </div>
          ) : statusLoading ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-white/60">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading 2FA status…
            </div>
          ) : error ? (
            <div className="flex items-start gap-3 rounded-lg border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-medium">Couldn't read 2FA status</div>
                <div className="text-xs opacity-90">{error}</div>
                <button
                  type="button"
                  onClick={() => loadStatus(selectedId)}
                  className="mt-2 inline-flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1 text-xs"
                >
                  <RefreshCw className="h-3 w-3" /> Retry
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {selectedSession && (
                <div className="text-sm text-white/80">
                  <span className="opacity-70">Editing 2FA for </span>
                  <span className="font-semibold text-white">
                    @{selectedSession.username || `session_${selectedSession.id}`}
                  </span>
                </div>
              )}

              {/* Headline status */}
              <div
                className={[
                  'rounded-xl p-5 ring-1',
                  status?.is_enabled
                    ? 'bg-emerald-500/10 ring-emerald-300/30'
                    : 'bg-amber-500/10 ring-amber-300/30',
                ].join(' ')}
              >
                <div className="flex items-center gap-3">
                  {status?.is_enabled ? (
                    <CheckCircle2 className="h-7 w-7 text-emerald-200" />
                  ) : (
                    <AlertTriangle className="h-7 w-7 text-amber-200" />
                  )}
                  <div>
                    <div className="text-base font-semibold text-white">
                      {status?.is_enabled
                        ? '2FA is enabled'
                        : '2FA is not enabled'}
                    </div>
                    <div className="text-xs text-white/70">
                      {status?.is_enabled
                        ? `Active methods: ${
                            (status.methods || []).map((m) => m.toUpperCase()).join(', ')
                            || 'unspecified'
                          }`
                        : 'Adding a TOTP layer makes the account significantly harder to take over.'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Method matrix */}
              <div className="grid gap-3 sm:grid-cols-3">
                <MethodCard
                  icon={KeyRound}
                  label="Authenticator (TOTP)"
                  on={!!status?.totp_enabled}
                />
                <MethodCard
                  icon={Smartphone}
                  label="Text message (SMS)"
                  on={!!status?.sms_enabled}
                />
                <MethodCard
                  icon={MessageCircle}
                  label="WhatsApp"
                  on={!!status?.whatsapp_enabled}
                />
              </div>

              {/* Trusted devices */}
              <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white/10 text-white/85 ring-1 ring-white/15">
                    <Smartphone className="h-4 w-4" />
                  </div>
                  <div className="text-sm font-semibold text-white">
                    Trusted devices
                  </div>
                  <span className="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/85">
                    {status?.trusted_devices ?? 0} device
                    {(status?.trusted_devices ?? 0) === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="mt-2 text-xs text-white/70">
                  Devices Instagram has remembered as not requiring a 2FA prompt.
                  If you don't recognise one, disable 2FA below to revoke them
                  all, then re-enable.
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-3">
                {!status?.totp_enabled && (
                  <button
                    type="button"
                    onClick={() => handleAction('enable')}
                    disabled={busy != null || !status?.supported}
                    className={`${IG_GRADIENT_BTN} inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow disabled:opacity-50`}
                  >
                    {busy === 'enable' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-4 w-4" />
                    )}
                    Enable TOTP
                  </button>
                )}
                {status?.totp_enabled && (
                  <button
                    type="button"
                    onClick={() => handleAction('rotate')}
                    disabled={busy != null}
                    className="inline-flex items-center gap-2 rounded-lg bg-white/15 px-4 py-2 text-sm font-medium text-white ring-1 ring-white/25 hover:bg-white/25 disabled:opacity-50"
                  >
                    {busy === 'rotate' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    Rotate TOTP secret
                  </button>
                )}
                {status?.is_enabled && (
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(
                          'Disable 2FA for this Instagram account? This drops all trusted devices and reduces takeover protection.'
                        )
                      ) handleAction('disable');
                    }}
                    disabled={busy != null}
                    className="inline-flex items-center gap-2 rounded-lg bg-red-500/20 px-4 py-2 text-sm font-medium text-red-100 ring-1 ring-red-300/30 hover:bg-red-500/30 disabled:opacity-50"
                  >
                    {busy === 'disable' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldOff className="h-4 w-4" />
                    )}
                    Disable 2FA
                  </button>
                )}
              </div>

              {!status?.supported && (
                <div className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    The bundled instagram-private-api build doesn't expose the 2FA
                    surface for this account. Enable or disable 2FA from the
                    official app and reload — the panel will read the new state.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </InstagramFeatureShell>
  );
}

function MethodCard({ icon: Icon, label, on }) {
  return (
    <div
      className={[
        'rounded-xl border p-4',
        on
          ? 'border-emerald-300/30 bg-emerald-500/10'
          : 'border-white/10 bg-white/5',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        <div
          className={[
            'flex h-8 w-8 items-center justify-center rounded-md ring-1',
            on
              ? 'bg-emerald-300/20 text-emerald-100 ring-emerald-200/30'
              : 'bg-white/10 text-white/85 ring-white/15',
          ].join(' ')}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="text-sm font-medium text-white">{label}</div>
        <span
          className={[
            'ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            on
              ? 'bg-emerald-300/30 text-emerald-100'
              : 'bg-white/15 text-white/70',
          ].join(' ')}
        >
          {on ? 'On' : 'Off'}
        </span>
      </div>
    </div>
  );
}
