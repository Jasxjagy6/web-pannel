/**
 * Instagram Anti-Detect / Identity — per-session device fingerprint.
 *
 * Telegram pins a single device-info string; Instagram has a much
 * deeper anti-bot surface (deviceId, uuid, phoneId, adid, build,
 * app_version, locale, plus a separately pinned webFingerprint for
 * web-API calls). The TG /anti-detect page is meaningless here, so
 * the IG panel reads the IG-shape platform_state directly and exposes
 * the rotate gate (min account age, last-rotation cooldown) explicitly.
 */

import { apiError } from '../../utils/apiError';
import { useEffect, useMemo, useState } from 'react';
import {
  Cpu,
  Globe,
  Smartphone,
  Languages,
  Hash,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Info,
  ShieldCheck,
} from 'lucide-react';
import { listSessions } from '../../api/sessions';
import { getIdentity, rotateIdentity } from '../../api/instagramIdentity';
import { useToast } from '../../components/common/Toast';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';

const IG_GRADIENT_BTN =
  'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

function formatDate(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); } catch (_) { return s; }
}

function daysSince(iso) {
  if (!iso) return null;
  try {
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  } catch (_) { return null; }
}

export default function InstagramAntiDetect() {
  const { showToast } = useToast();

  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);

  const [identity, setIdentity] = useState(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [error, setError] = useState(null);
  const [rotating, setRotating] = useState(false);

  async function reloadSessions() {
    setSessionsLoading(true);
    try {
      const r = await listSessions({ page: 1, limit: 200 });
      const data = r.data?.data || r.data || {};
      const list = (data.sessions || []).filter(
        (s) => s.platform === 'instagram'
      );
      setSessions(list);
      if (!selectedId && list.length) setSelectedId(list[0].id);
    } catch (err) {
      showToast(apiError(err, 'Failed to load Instagram sessions'), 'error');
    } finally {
      setSessionsLoading(false);
    }
  }

  async function loadIdentity(id) {
    if (!id) return;
    setIdentityLoading(true);
    setError(null);
    try {
      const r = await getIdentity(id);
      setIdentity(r.data?.data || null);
    } catch (err) {
      setIdentity(null);
      setError(apiError(err, 'Failed to load identity'));
    } finally {
      setIdentityLoading(false);
    }
  }

  useEffect(() => { reloadSessions(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (selectedId) loadIdentity(selectedId); }, [selectedId]);

  async function handleRotate(force = false) {
    if (!selectedId || rotating) return;
    if (force) {
      if (!window.confirm(
        'Force-rotate this session\'s device fingerprint? Rotating outside the cooldown trips Instagram\'s "new device" check more often than not.'
      )) return;
    }
    setRotating(true);
    try {
      await rotateIdentity(selectedId, { force });
      showToast('Device fingerprint rotated.', 'success');
      await loadIdentity(selectedId);
    } catch (err) {
      showToast(apiError(err, 'Failed to rotate identity'), 'error');
    } finally {
      setRotating(false);
    }
  }

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedId) || null,
    [sessions, selectedId]
  );

  const fp = identity?.fingerprint || null;
  const ageDays = identity?.session?.created_at ? daysSince(identity.session.created_at) : null;
  const sinceRotation = fp?.rotated_at ? daysSince(fp.rotated_at) : null;

  return (
    <InstagramFeatureShell
      icon={ShieldCheck}
      title="Identity & anti-detect"
      subtitle="Device fingerprint, app version and locale per Instagram account."
      actions={
        <button
          type="button"
          onClick={() => loadIdentity(selectedId)}
          disabled={!selectedId || identityLoading}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium ring-1 ring-white/25 hover:bg-white/25 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${identityLoading ? 'animate-spin' : ''}`} />
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
              No Instagram sessions yet. Create one from the Sessions page.
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
                        active ? `${IG_GRADIENT_BTN} text-white shadow` : 'text-white/85 hover:bg-white/10',
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

        {/* Identity detail */}
        <div className="rounded-xl border border-white/10 bg-black/20 p-5">
          {!selectedId ? (
            <div className="flex h-40 items-center justify-center text-sm text-white/60">
              Pick an Instagram account on the left to view its identity blob.
            </div>
          ) : identityLoading ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-white/60">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading identity…
            </div>
          ) : error ? (
            <div className="flex items-start gap-3 rounded-lg border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-medium">Couldn't read identity</div>
                <div className="text-xs opacity-90">{error}</div>
                <button
                  type="button"
                  onClick={() => loadIdentity(selectedId)}
                  className="mt-2 inline-flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1 text-xs"
                >
                  <RefreshCw className="h-3 w-3" /> Retry
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Heading */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                <div>
                  <div className="text-sm font-semibold text-white">
                    @{selectedSession?.username || `session_${selectedSession?.id}`}
                  </div>
                  <div className="text-xs text-white/70">
                    Account age: {ageDays != null ? `${ageDays} day${ageDays === 1 ? '' : 's'}` : '—'}
                    <span className="mx-2 opacity-50">·</span>
                    Last rotation: {sinceRotation != null
                      ? `${sinceRotation} day${sinceRotation === 1 ? '' : 's'} ago`
                      : 'never'}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleRotate(false)}
                    disabled={rotating}
                    className={`${IG_GRADIENT_BTN} inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-white shadow disabled:opacity-50`}
                  >
                    {rotating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    Rotate fingerprint
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRotate(true)}
                    disabled={rotating}
                    className="inline-flex items-center gap-2 rounded-lg bg-amber-500/20 px-3 py-2 text-xs font-medium text-amber-100 ring-1 ring-amber-300/30 hover:bg-amber-500/30 disabled:opacity-50"
                  >
                    Force rotate
                  </button>
                </div>
              </div>

              {/* Mobile-API device fingerprint */}
              <Section icon={Smartphone} title="Mobile-API device">
                {fp ? (
                  <KVList
                    items={[
                      ['Seed', fp.seed],
                      ['Device ID', fp.deviceId],
                      ['UUID', fp.uuid],
                      ['Phone ID', fp.phoneId],
                      ['ADID', fp.adid],
                      ['Build', fp.build],
                      ['Created', formatDate(fp.created_at)],
                      ['Last rotated', formatDate(fp.rotated_at)],
                      ['Assigned', formatDate(fp.assigned_at)],
                    ]}
                  />
                ) : (
                  <div className="text-xs text-white/60">
                    No pinned device fingerprint yet. The first scrape or messaging
                    request on this session will mint one and persist it here.
                  </div>
                )}
              </Section>

              {/* App version + locale */}
              <div className="grid gap-4 sm:grid-cols-2">
                <Section icon={Hash} title="App version" compact>
                  {identity?.appVersion ? (
                    <KVList
                      items={[
                        ['app_version', identity.appVersion.app_version],
                        ['version_code', identity.appVersion.version_code],
                        ['platform', identity.appVersion.platform || 'android'],
                      ]}
                    />
                  ) : (
                    <div className="text-xs text-white/60">No pinned app version.</div>
                  )}
                </Section>
                <Section icon={Languages} title="Locale" compact>
                  {identity?.locale ? (
                    <KVList
                      items={[
                        ['Language', identity.locale.language],
                        ['Region', identity.locale.regionHint],
                        ['Timezone offset', `${identity.locale.timezoneOffset ?? 0}m`],
                      ]}
                    />
                  ) : (
                    <div className="text-xs text-white/60">No pinned locale.</div>
                  )}
                </Section>
              </div>

              {/* Web fingerprint */}
              <Section icon={Globe} title="Web-API fingerprint">
                {identity?.webFingerprint ? (
                  <KVList
                    items={[
                      ['User agent', identity.webFingerprint.userAgent],
                      ['Platform', identity.webFingerprint.platform],
                      ['Language', identity.webFingerprint.language],
                      ['Pinned at', formatDate(identity.webFingerprint.pinned_at)],
                    ]}
                  />
                ) : (
                  <div className="text-xs text-white/60">
                    No web fingerprint pinned yet (set on first web-API request).
                  </div>
                )}
              </Section>

              {/* API mode + proxy */}
              <Section icon={Cpu} title="Runtime">
                <KVList
                  items={[
                    ['API mode', identity?.apiMode || '—'],
                    ['Proxy bound', identity?.session?.proxy_url ? identity.session.proxy_url : 'none'],
                    ['Status', identity?.session?.status || '—'],
                    ['Logged in', identity?.session?.is_logged_in ? 'yes' : 'no'],
                  ]}
                />
              </Section>

              <div className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Backend gates: rotations require the session to be at least
                  90 days old and at least 60 days since last rotation.
                  Force-rotate bypasses both checks but is much more likely to
                  trigger Instagram's new-device challenge.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </InstagramFeatureShell>
  );
}

function Section({ icon: Icon, title, children, compact = false }) {
  return (
    <div className={`rounded-xl border border-white/10 bg-white/5 p-${compact ? 3 : 4}`}>
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-4 w-4 text-white/85" />
        <div className="text-sm font-semibold text-white">{title}</div>
      </div>
      {children}
    </div>
  );
}

function KVList({ items }) {
  return (
    <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-xs">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-white/60">{k}</dt>
          <dd className="break-all text-white/90">
            {v == null || v === '' ? <span className="text-white/40">—</span> : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
