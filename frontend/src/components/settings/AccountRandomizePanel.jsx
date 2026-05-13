import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Sparkles,
  Dices,
  RefreshCw,
  Wand2,
  AtSign,
  User as UserIcon,
  FileText,
  Image as ImageIcon,
  Loader2,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import {
  getRandomizePools,
  applyRandomizedAccountSettings,
  randomAvatarUrl,
} from '../../api/accountSettings';
import { parseApiError } from '../../utils/formatters';

/**
 * Cryptographically-weak but plenty-uniform random picker. Used purely for
 * UX-level randomization (which avatar / name / bio to show in the preview),
 * not for anything security-sensitive.
 */
function pick(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Build a sequential username for the n-th (0-indexed) session, given a base.
 * 0 → `<base>`, 1 → `<base>2`, 2 → `<base>3`, … so the very first selected
 * session keeps the bare `@x` the user owns, while every subsequent one gets
 * an incremented suffix.
 */
function buildUsername(base, index) {
  const cleanBase = String(base || '').replace(/^@/, '').trim();
  if (!cleanBase) return '';
  return index === 0 ? cleanBase : `${cleanBase}${index + 1}`;
}

/**
 * Pick an avatar for a session such that we don't accidentally give every
 * session the same one. For each row we sample one of the avatars that has
 * been used the fewest times so far. Duplicates are still allowed once the
 * pool is exhausted — the user explicitly asked for that.
 */
function pickSpreadAvatar(availableIds, usageCounts) {
  if (!availableIds || availableIds.length === 0) return null;
  let minCount = Infinity;
  for (const id of availableIds) {
    const c = usageCounts.get(id) || 0;
    if (c < minCount) minCount = c;
  }
  const candidates = availableIds.filter(
    (id) => (usageCounts.get(id) || 0) === minCount
  );
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function fmtSelectedCount(n) {
  if (n === 1) return '1 session';
  return `${n} sessions`;
}

function fmtElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export default function AccountRandomizePanel({
  selectedSessions, // [{ id, phone, username? }]
  onApplied,
  showSuccess,
  showError,
}) {
  const [pools, setPools] = useState(null);
  const [poolsError, setPoolsError] = useState(null);
  const [poolsLoading, setPoolsLoading] = useState(true);

  // Which fields to randomize.
  const [flags, setFlags] = useState({
    firstName: true,
    lastName: true,
    bio: true,
    username: false,
    profilePhoto: true,
  });

  const [usernameBase, setUsernameBase] = useState('');
  const [assignments, setAssignments] = useState([]); // generated rows
  const [submitting, setSubmitting] = useState(false);
  // Elapsed seconds since Apply was clicked — drives the long-running
  // progress hint so users don't think the request has hung.
  const [submitElapsed, setSubmitElapsed] = useState(0);

  useEffect(() => {
    if (!submitting) {
      setSubmitElapsed(0);
      return undefined;
    }
    const startedAt = Date.now();
    const id = setInterval(() => {
      setSubmitElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [submitting]);

  // ---- Load pools once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPoolsLoading(true);
      setPoolsError(null);
      try {
        const res = await getRandomizePools();
        if (cancelled) return;
        setPools(res.data.data);
      } catch (err) {
        if (cancelled) return;
        setPoolsError(parseApiError(err));
      } finally {
        if (!cancelled) setPoolsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Whenever the selection / flags change, drop stale assignments. The
  //      user must press "Generate" to materialize a fresh preview.
  useEffect(() => {
    setAssignments([]);
  }, [selectedSessions, flags.firstName, flags.lastName, flags.bio, flags.username, flags.profilePhoto, usernameBase]);

  const toggleFlag = (k) => setFlags((prev) => ({ ...prev, [k]: !prev[k] }));

  // ---- Validation gates ---------------------------------------------------
  const anyFieldEnabled = useMemo(
    () => Object.values(flags).some(Boolean),
    [flags]
  );
  const usernameBaseRequired = flags.username;
  const usernameBaseProvided = usernameBase.trim().length > 0;
  const canGenerate =
    selectedSessions.length > 0 &&
    anyFieldEnabled &&
    (!usernameBaseRequired || usernameBaseProvided) &&
    !!pools;

  // ---- Generate the per-session assignments client-side.
  const generate = useCallback(() => {
    if (!pools) return;
    const usage = new Map();
    const rows = selectedSessions.map((s, idx) => {
      const row = { sessionId: s.id, phone: s.phone };
      if (flags.firstName) row.firstName = pick(pools.firstNames) || '';
      if (flags.lastName) row.lastName = pick(pools.lastNames) || '';
      if (flags.bio) row.bio = pick(pools.bios) || '';
      if (flags.username) row.username = buildUsername(usernameBase, idx);
      if (flags.profilePhoto && pools.avatars.length > 0) {
        const id = pickSpreadAvatar(
          pools.avatars.map((a) => a.id),
          usage
        );
        usage.set(id, (usage.get(id) || 0) + 1);
        row.avatarId = id;
      }
      return row;
    });
    setAssignments(rows);
  }, [selectedSessions, flags, pools, usernameBase]);

  // ---- Re-roll a single row.
  const rerollRow = useCallback(
    (sessionId) => {
      if (!pools) return;
      setAssignments((prev) => {
        // Count current usage across the OTHER rows so the re-roll still
        // tries to spread avatars across the cohort.
        const usage = new Map();
        for (const r of prev) {
          if (r.sessionId === sessionId) continue;
          if (r.avatarId) usage.set(r.avatarId, (usage.get(r.avatarId) || 0) + 1);
        }
        return prev.map((r, idx) => {
          if (r.sessionId !== sessionId) return r;
          const next = { ...r };
          if (flags.firstName) next.firstName = pick(pools.firstNames) || '';
          if (flags.lastName) next.lastName = pick(pools.lastNames) || '';
          if (flags.bio) next.bio = pick(pools.bios) || '';
          if (flags.username) next.username = buildUsername(usernameBase, idx);
          if (flags.profilePhoto && pools.avatars.length > 0) {
            next.avatarId = pickSpreadAvatar(
              pools.avatars.map((a) => a.id),
              usage
            );
          }
          return next;
        });
      });
    },
    [pools, flags, usernameBase]
  );

  // ---- Inline-edit a single field on one row.
  const editField = useCallback((sessionId, field, value) => {
    setAssignments((prev) =>
      prev.map((r) => (r.sessionId === sessionId ? { ...r, [field]: value } : r))
    );
  }, []);

  // ---- Submit.
  const apply = useCallback(async () => {
    if (assignments.length === 0) return;
    setSubmitting(true);
    try {
      // Strip empty strings for fields we DON'T want to update, otherwise the
      // backend would happily blank them out.
      const payload = assignments.map((r) => {
        const out = { sessionId: r.sessionId };
        if (flags.firstName && typeof r.firstName === 'string' && r.firstName.length > 0) out.firstName = r.firstName;
        if (flags.lastName && typeof r.lastName === 'string') out.lastName = r.lastName;
        if (flags.bio && typeof r.bio === 'string') out.bio = r.bio;
        if (flags.username && typeof r.username === 'string' && r.username.length > 0) out.username = r.username;
        if (flags.profilePhoto && typeof r.avatarId === 'string' && r.avatarId.length > 0) out.avatarId = r.avatarId;
        return out;
      });
      const res = await applyRandomizedAccountSettings(payload);
      const { success, failed } = res.data.data;
      if (failed === 0) {
        showSuccess(`Randomized ${success} session(s)`, 'Success');
      } else {
        showSuccess(`Randomized ${success} session(s), ${failed} failed`, 'Partial success');
      }
      setAssignments([]);
      onApplied?.(res.data.data);
    } catch (err) {
      showError(parseApiError(err), 'Randomize failed');
    } finally {
      setSubmitting(false);
    }
  }, [assignments, flags, onApplied, showSuccess, showError]);

  // ---- UI ---------------------------------------------------------------
  const previewBase = usernameBase.trim().replace(/^@/, '');

  if (poolsLoading) {
    return (
      <div className="rounded-xl border border-white/5 bg-dark-800 p-8 flex items-center justify-center text-gray-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading randomize pools…
      </div>
    );
  }
  if (poolsError) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-300 flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 mt-0.5" />
        <div>
          <p className="font-medium text-red-200">Couldn't load randomize pools</p>
          <p className="mt-1 text-xs">{poolsError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-primary-500/20 bg-gradient-to-br from-primary-500/10 via-dark-800 to-dark-800 p-5">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-primary-500/15 p-2.5 text-primary-300">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-white">Randomize Mode</h3>
            <p className="mt-1 text-xs text-gray-400">
              Picks a different value <span className="text-white">per session</span> from a curated pool.
              Generate a preview, re-roll anything you don't like, then apply.
            </p>
          </div>
        </div>
      </div>

      {/* Selection summary */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
        <h3 className="text-sm font-semibold text-white mb-2">Selected sessions</h3>
        <p className="text-xs text-gray-400">
          {selectedSessions.length === 0
            ? 'No sessions selected. Pick at least one in the panel to the right (or below on mobile).'
            : `Randomize will apply to ${fmtSelectedCount(selectedSessions.length)}.`}
        </p>
      </div>

      {/* Field toggles */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-white">What to randomize</h3>

        <FlagRow
          checked={flags.firstName}
          onChange={() => toggleFlag('firstName')}
          icon={<UserIcon className="w-4 h-4" />}
          label="First name"
          hint={`Sampled from ${pools.firstNames.length} options`}
        />
        <FlagRow
          checked={flags.lastName}
          onChange={() => toggleFlag('lastName')}
          icon={<UserIcon className="w-4 h-4" />}
          label="Last name"
          hint={`Sampled from ${pools.lastNames.length} options`}
        />
        <FlagRow
          checked={flags.bio}
          onChange={() => toggleFlag('bio')}
          icon={<FileText className="w-4 h-4" />}
          label="Bio"
          hint={`Sampled from ${pools.bios.length} short bios (≤70 chars)`}
        />
        <FlagRow
          checked={flags.profilePhoto}
          onChange={() => toggleFlag('profilePhoto')}
          icon={<ImageIcon className="w-4 h-4" />}
          label="Profile photo"
          hint={`${pools.avatars.length} bundled avatars — duplicates allowed but spread`}
        />

        {/* Username section */}
        <div className="border-t border-white/10 pt-4">
          <FlagRow
            checked={flags.username}
            onChange={() => toggleFlag('username')}
            icon={<AtSign className="w-4 h-4" />}
            label="Username"
            hint="Built from a base you provide — see below"
          />

          <div className={`mt-3 space-y-2 ${flags.username ? '' : 'opacity-50 pointer-events-none'}`}>
            <label className="text-xs font-medium text-gray-300 flex items-center gap-1.5">
              Base username
              <span className="text-red-400">*</span>
              <span className="text-gray-500 font-normal">
                (you confirmed it's available)
              </span>
            </label>
            <div className="flex items-center gap-2">
              <span className="text-gray-500">@</span>
              <input
                type="text"
                value={usernameBase}
                onChange={(e) => setUsernameBase(e.target.value.replace(/^@/, ''))}
                placeholder="e.g. x"
                disabled={!flags.username}
                className="flex-1 rounded-lg border border-white/10 bg-dark-900 py-2 px-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition disabled:cursor-not-allowed"
              />
            </div>
            {flags.username && previewBase && (
              <p className="text-xs text-gray-500">
                First session gets <span className="text-primary-300">@{previewBase}</span>,
                second <span className="text-primary-300">@{previewBase}2</span>,
                third <span className="text-primary-300">@{previewBase}3</span>, and so on.
              </p>
            )}
            {flags.username && !previewBase && (
              <p className="text-xs text-amber-400">
                Enter a base username — it will be used as-is for the first session.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Generate button */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!canGenerate}
          onClick={generate}
          className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-primary-600 to-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-600/25 transition-all duration-200 hover:from-primary-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Wand2 className="w-4 h-4" />
          {assignments.length === 0 ? 'Generate preview' : 'Re-generate all'}
        </button>
        {assignments.length > 0 && (
          <span className="text-xs text-gray-500">
            {assignments.length} assignment(s) ready — review below before applying.
          </span>
        )}
      </div>

      {/* Preview list */}
      {assignments.length > 0 && (
        <div className="rounded-xl border border-white/5 bg-dark-800 overflow-hidden">
          <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Preview</h3>
            <span className="text-xs text-gray-500">Click 🎲 to re-roll a single row</span>
          </div>
          <ul className="divide-y divide-white/5 max-h-[480px] overflow-y-auto">
            {assignments.map((row, idx) => (
              <PreviewRow
                key={row.sessionId}
                row={row}
                idx={idx}
                flags={flags}
                onReroll={() => rerollRow(row.sessionId)}
                onEdit={editField}
              />
            ))}
          </ul>
          {submitting && (
            <div className="px-5 py-3 border-t border-white/10 bg-emerald-500/[0.04]">
              <div className="flex items-center gap-3 text-sm text-emerald-100">
                <Loader2 className="w-4 h-4 animate-spin text-emerald-300" />
                <div className="flex-1">
                  <div className="font-medium">
                    Applying to {assignments.length} session{assignments.length === 1 ? '' : 's'}…
                  </div>
                  <div className="mt-1 text-xs text-emerald-200/70">
                    Elapsed: {fmtElapsed(submitElapsed)}. Each session takes a few seconds — please
                    keep this tab open until completion.
                  </div>
                  <div className="mt-2 h-1 w-full overflow-hidden rounded bg-emerald-900/30">
                    <div className="h-full animate-pulse rounded bg-emerald-400/70" style={{ width: '100%' }} />
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="px-5 py-4 border-t border-white/10 flex justify-end">
            <button
              type="button"
              disabled={submitting}
              onClick={apply}
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-emerald-600 to-emerald-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-600/25 transition-all duration-200 hover:from-emerald-500 hover:to-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Applying… ({fmtElapsed(submitElapsed)})
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  Apply to {fmtSelectedCount(assignments.length)}
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FlagRow({ checked, onChange, icon, label, hint }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="mt-1 rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500"
      />
      <div className="flex-1">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-200">
          {icon}
          {label}
        </div>
        {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
      </div>
    </label>
  );
}

function PreviewRow({ row, idx, flags, onReroll, onEdit }) {
  const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ');
  return (
    <li className="px-5 py-3 flex items-start gap-4">
      <div className="flex-shrink-0">
        {flags.profilePhoto && row.avatarId ? (
          <img
            src={randomAvatarUrl(row.avatarId)}
            alt=""
            className="w-12 h-12 rounded-full object-cover border-2 border-white/10"
          />
        ) : (
          <div className="w-12 h-12 rounded-full bg-dark-900 border-2 border-white/10 flex items-center justify-center text-gray-600 text-xs">
            —
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2">
        <div>
          <p className="text-xs text-gray-500">Session</p>
          <p className="text-sm text-white truncate">{row.phone || `#${row.sessionId}`}</p>
        </div>
        {(flags.firstName || flags.lastName) && (
          <div>
            <p className="text-xs text-gray-500">Name</p>
            <div className="flex items-center gap-2">
              {flags.firstName && (
                <input
                  type="text"
                  value={row.firstName || ''}
                  onChange={(e) => onEdit(row.sessionId, 'firstName', e.target.value)}
                  className="flex-1 rounded border border-white/10 bg-dark-900 py-1 px-2 text-xs text-white"
                />
              )}
              {flags.lastName && (
                <input
                  type="text"
                  value={row.lastName || ''}
                  onChange={(e) => onEdit(row.sessionId, 'lastName', e.target.value)}
                  className="flex-1 rounded border border-white/10 bg-dark-900 py-1 px-2 text-xs text-white"
                />
              )}
            </div>
            {!flags.firstName && !flags.lastName && (
              <p className="text-sm text-gray-400 truncate">{fullName || '—'}</p>
            )}
          </div>
        )}
        {flags.username && (
          <div>
            <p className="text-xs text-gray-500">Username (#{idx + 1})</p>
            <div className="flex items-center gap-1">
              <span className="text-gray-500">@</span>
              <input
                type="text"
                value={row.username || ''}
                onChange={(e) => onEdit(row.sessionId, 'username', e.target.value.replace(/^@/, ''))}
                className="flex-1 rounded border border-white/10 bg-dark-900 py-1 px-2 text-xs text-white"
              />
            </div>
          </div>
        )}
        {flags.bio && (
          <div className="md:col-span-2">
            <p className="text-xs text-gray-500">Bio</p>
            <input
              type="text"
              value={row.bio || ''}
              maxLength={70}
              onChange={(e) => onEdit(row.sessionId, 'bio', e.target.value.slice(0, 70))}
              className="w-full rounded border border-white/10 bg-dark-900 py-1 px-2 text-xs text-white"
            />
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onReroll}
        title="Re-roll this row"
        className="flex-shrink-0 rounded-md border border-white/10 p-2 text-gray-400 hover:text-primary-300 hover:border-primary-500/40 transition"
      >
        <Dices className="w-4 h-4" />
      </button>
    </li>
  );
}
