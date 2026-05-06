/**
 * InstagramPrivacy — IG-native privacy controls.
 *
 * Instagram's API exposes a tiny privacy surface compared to Telegram:
 *   - is_private              account.setAccountPrivate / setAccountPublic
 *   - has_anonymous_profile_picture  read-only flag mirrored from the
 *                                    "anonymous" profile-pic experiment
 *
 * The TG-style "11 privacy keys → bulk job" model would be misleading
 * for IG, so this page works per-session: pick a logged-in IG account,
 * see its current state, flip Public ↔ Private. We also surface the
 * read-only flags so the operator has the full picture in one view.
 *
 * Wired through:
 *   GET   /api/instagram/privacy/account/:sessionId
 *   PATCH /api/instagram/privacy/account/:sessionId
 *     body: { is_private?: boolean, has_anonymous_profile_picture?: boolean }
 */

import { apiError } from '../../utils/apiError';
import { useEffect, useMemo, useState } from 'react';
import {
  Shield,
  Lock,
  Globe,
  RefreshCw,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Info,
} from 'lucide-react';
import { listSessions } from '../../api/sessions';
import { getInstagramPrivacy, setInstagramPrivacy } from '../../api/privacy';
import { useToast } from '../../components/common/Toast';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';

const IG_GRADIENT_BTN =
  'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

export default function InstagramPrivacy() {
  const { showToast } = useToast();

  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);

  const [privacy, setPrivacy] = useState(null);
  const [privacyLoading, setPrivacyLoading] = useState(false);
  const [saving, setSaving] = useState(false);
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

  async function loadPrivacy(sessionId) {
    if (!sessionId) return;
    setPrivacyLoading(true);
    setError(null);
    try {
      const r = await getInstagramPrivacy(sessionId);
      setPrivacy(r.data?.data || null);
    } catch (err) {
      setPrivacy(null);
      const msg = apiError(err, 'Failed to load privacy state');
      setError(msg);
    } finally {
      setPrivacyLoading(false);
    }
  }

  useEffect(() => {
    reloadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedId) loadPrivacy(selectedId);
  }, [selectedId]);

  async function togglePrivate(nextValue) {
    if (!selectedId) return;
    setSaving(true);
    try {
      const r = await setInstagramPrivacy(selectedId, { is_private: nextValue });
      const result = r.data?.data || {};
      // Optimistic update + refetch to reflect any IG-side echo.
      setPrivacy((prev) => ({ ...(prev || {}), is_private: nextValue }));
      showToast(
        nextValue
          ? 'Account is now Private — only approved followers can see posts.'
          : 'Account is now Public — anyone can see posts.',
        'success'
      );
      // Trust the server echo if present.
      if (result.set_private || result.set_public) {
        await loadPrivacy(selectedId);
      }
    } catch (err) {
      showToast(apiError(err, 'Failed to update privacy'), 'error');
    } finally {
      setSaving(false);
    }
  }

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedId) || null,
    [sessions, selectedId]
  );

  return (
    <InstagramFeatureShell
      icon={Shield}
      title="Privacy"
      subtitle="Control who can find and follow each Instagram account."
      actions={
        <button
          type="button"
          onClick={() => loadPrivacy(selectedId)}
          disabled={!selectedId || privacyLoading}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium ring-1 ring-white/25 hover:bg-white/25 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${privacyLoading ? 'animate-spin' : ''}`} />
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

        {/* Privacy detail */}
        <div className="rounded-xl border border-white/10 bg-black/20 p-5">
          {!selectedId ? (
            <div className="flex h-40 items-center justify-center text-sm text-white/60">
              Pick an Instagram account on the left to manage its privacy.
            </div>
          ) : privacyLoading ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-white/60">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading privacy state…
            </div>
          ) : error ? (
            <div className="flex items-start gap-3 rounded-lg border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-medium">Couldn't read privacy state</div>
                <div className="text-xs opacity-90">{error}</div>
                <button
                  type="button"
                  onClick={() => loadPrivacy(selectedId)}
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
                  <span className="opacity-70">Editing privacy for </span>
                  <span className="font-semibold text-white">
                    @{selectedSession.username || `session_${selectedSession.id}`}
                  </span>
                </div>
              )}

              {/* Public/Private toggle */}
              <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-start gap-3">
                  <div
                    className={[
                      'flex h-10 w-10 items-center justify-center rounded-lg ring-1',
                      privacy?.is_private
                        ? 'bg-pink-500/20 text-pink-200 ring-pink-300/30'
                        : 'bg-white/10 text-white/85 ring-white/20',
                    ].join(' ')}
                  >
                    {privacy?.is_private ? (
                      <Lock className="h-5 w-5" />
                    ) : (
                      <Globe className="h-5 w-5" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-semibold text-white">
                        {privacy?.is_private ? 'Private account' : 'Public account'}
                      </div>
                      <span
                        className={[
                          'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                          privacy?.is_private
                            ? 'bg-pink-500/20 text-pink-200'
                            : 'bg-white/15 text-white/85',
                        ].join(' ')}
                      >
                        {privacy?.is_private ? 'Private' : 'Public'}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-white/70">
                      {privacy?.is_private
                        ? 'Only approved followers see your posts, stories and reels. New followers must request to follow.'
                        : 'Anyone on or off Instagram can see your posts, stories and reels.'}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => togglePrivate(true)}
                      disabled={saving || !!privacy?.is_private}
                      className={[
                        'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition',
                        privacy?.is_private
                          ? 'bg-pink-500/30 text-white ring-pink-300/40'
                          : 'bg-white/10 text-white/90 ring-white/15 hover:bg-white/20',
                      ].join(' ')}
                    >
                      <Lock className="h-3.5 w-3.5" /> Make private
                    </button>
                    <button
                      type="button"
                      onClick={() => togglePrivate(false)}
                      disabled={saving || !privacy?.is_private}
                      className={[
                        'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition',
                        !privacy?.is_private
                          ? 'bg-white/20 text-white ring-white/30'
                          : 'bg-white/10 text-white/90 ring-white/15 hover:bg-white/20',
                      ].join(' ')}
                    >
                      <Globe className="h-3.5 w-3.5" /> Make public
                    </button>
                  </div>
                </div>
                {saving && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-white/70">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Pushing change to Instagram…
                  </div>
                )}
              </div>

              {/* Read-only flags */}
              <div className="grid gap-3 sm:grid-cols-2">
                <FlagCard
                  icon={privacy?.has_anonymous_profile_picture ? EyeOff : Eye}
                  title="Anonymous profile picture"
                  value={!!privacy?.has_anonymous_profile_picture}
                  hint={
                    privacy?.has_anonymous_profile_picture
                      ? 'Instagram has flagged this account into the anonymous-PFP experiment. The default avatar shows in places where the real picture would normally appear.'
                      : 'No anonymous-PFP flag from Instagram. The real profile picture is used everywhere.'
                  }
                />
                <CheckpointStatusCard session={selectedSession} />
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Comment &amp; story controls (close-friends list, restricted
                  accounts, comment filters) are not exposed by Instagram's mobile
                  API on session-bound clients. Manage those from inside the official
                  app for now — the panel will surface them here as soon as the
                  endpoint becomes available.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </InstagramFeatureShell>
  );
}

function FlagCard({ icon: Icon, title, value, hint }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white/10 text-white/85 ring-1 ring-white/15">
          <Icon className="h-4 w-4" />
        </div>
        <div className="text-sm font-semibold text-white">{title}</div>
        <span
          className={[
            'ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            value
              ? 'bg-amber-300/30 text-amber-100'
              : 'bg-emerald-300/20 text-emerald-100',
          ].join(' ')}
        >
          {value ? 'On' : 'Off'}
        </span>
      </div>
      <div className="mt-2 text-xs text-white/70">{hint}</div>
    </div>
  );
}

function CheckpointStatusCard({ session }) {
  const flagged = !!(
    session
    && (session.warmup_state?.state === 'needs_attention'
      || session.warmup_state?.state === 'dead'
      || ['checkpoint', 'expired'].includes(session.status))
  );
  const Icon = flagged ? AlertTriangle : CheckCircle2;
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center gap-2">
        <div
          className={[
            'flex h-8 w-8 items-center justify-center rounded-md ring-1',
            flagged
              ? 'bg-amber-300/20 text-amber-100 ring-amber-200/30'
              : 'bg-emerald-300/20 text-emerald-100 ring-emerald-200/30',
          ].join(' ')}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="text-sm font-semibold text-white">Account health</div>
        <span
          className={[
            'ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            flagged
              ? 'bg-amber-300/30 text-amber-100'
              : 'bg-emerald-300/20 text-emerald-100',
          ].join(' ')}
        >
          {flagged ? 'Flagged' : 'Healthy'}
        </span>
      </div>
      <div className="mt-2 text-xs text-white/70">
        {flagged
          ? 'Instagram has put this session into a checkpoint or marked it expired. Solve it on a trusted device and re-upload before changing privacy.'
          : 'No checkpoint, action-block or feedback-required flags on this session.'}
      </div>
    </div>
  );
}
