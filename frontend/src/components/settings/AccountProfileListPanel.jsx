import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ListChecks,
  RefreshCw,
  Loader2,
  AtSign,
  User as UserIcon,
  FileText,
  Image as ImageIcon,
  AlertTriangle,
  CheckCircle2,
  CornerDownRight,
} from 'lucide-react';
import { listsAPI } from '../../api';
import {
  previewProfileList,
  applyProfileList,
  randomAvatarUrl,
} from '../../api/accountSettings';
import { parseApiError } from '../../utils/formatters';

/**
 * Account Settings → "Profile List" mode.
 *
 * Lets the operator pick one of their `type='profile'` lists and apply
 * its rows across a set of sessions. The backend cycles rows when the
 * list is shorter than the session count, suffixes duplicate usernames
 * with a random tail so no two sessions claim the same handle, and
 * draws a fresh real-image avatar per session from the bundled catalog.
 *
 * The flow is preview → re-roll (optional) → apply. The preview is
 * cheap (no Telegram calls) so the operator can re-roll the avatars
 * before committing.
 */
export default function AccountProfileListPanel({
  selectedSessions, // [{ id, phone, username? }]
  onApplied,
  showSuccess,
  showError,
}) {
  const [lists, setLists] = useState([]);
  const [listsLoading, setListsLoading] = useState(true);
  const [listsError, setListsError] = useState(null);

  const [selectedListId, setSelectedListId] = useState('');
  const [flags, setFlags] = useState({
    firstName: true,
    lastName: true,
    username: true,
    bio: true,
    profilePhoto: true,
  });

  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState(null);
  const [lastApplyResult, setLastApplyResult] = useState(null);

  const sessionIds = useMemo(
    () =>
      Array.isArray(selectedSessions)
        ? selectedSessions.map((s) => Number(s.id)).filter((n) => Number.isFinite(n) && n > 0)
        : [],
    [selectedSessions]
  );

  const fetchLists = useCallback(async () => {
    setListsLoading(true);
    setListsError(null);
    try {
      const res = await listsAPI.list();
      const all = res.data?.data?.lists || [];
      setLists(all.filter((l) => l.type === 'profile'));
    } catch (err) {
      setListsError(parseApiError(err));
    } finally {
      setListsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLists();
  }, [fetchLists]);

  // Auto-select the most recently-created profile list once they load.
  useEffect(() => {
    if (!selectedListId && lists.length > 0) {
      setSelectedListId(String(lists[0].id));
    }
  }, [lists, selectedListId]);

  const buildPreview = useCallback(async () => {
    setPreviewError(null);
    setLastApplyResult(null);
    if (!selectedListId) {
      setPreviewError('Pick a profile list to continue.');
      return;
    }
    if (sessionIds.length === 0) {
      setPreviewError('Select at least one session from the right-hand picker.');
      return;
    }
    setPreviewing(true);
    try {
      const res = await previewProfileList({
        listId: Number(selectedListId),
        sessionIds,
        updateUsernames: flags.username,
        updatePhotos: flags.profilePhoto,
        updateBios: flags.bio,
      });
      setPreview(res.data?.data || null);
    } catch (err) {
      setPreviewError(parseApiError(err));
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  }, [selectedListId, sessionIds, flags.username, flags.profilePhoto, flags.bio]);

  // Rebuild the preview whenever the inputs change (debounced via state batching).
  useEffect(() => {
    // Wait until the user has picked at least one session.
    if (selectedListId && sessionIds.length > 0) {
      buildPreview();
    } else {
      setPreview(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedListId, sessionIds.length, flags.username, flags.profilePhoto, flags.bio]);

  const toggleFlag = (k) => setFlags((s) => ({ ...s, [k]: !s[k] }));

  const handleApply = async () => {
    setApplyError(null);
    setLastApplyResult(null);
    if (!preview || !Array.isArray(preview.assignments) || preview.assignments.length === 0) {
      setApplyError('Build a preview first.');
      return;
    }
    setApplying(true);
    try {
      const res = await applyProfileList({
        listId: Number(selectedListId),
        // Send the previewed assignments verbatim so the operator gets
        // exactly the avatar / username rolls they saw on screen.
        assignments: preview.assignments.map((a) => ({
          sessionId: a.sessionId,
          firstName: flags.firstName ? a.firstName : undefined,
          lastName: flags.lastName ? a.lastName : undefined,
          username: flags.username ? a.username : undefined,
          bio: flags.bio ? a.bio : undefined,
          avatarId: flags.profilePhoto ? a.avatarId : undefined,
        })),
      });
      const data = res.data?.data;
      setLastApplyResult(data || null);
      showSuccess?.(
        `Profile list applied: ${data?.success ?? 0}/${data?.total ?? 0} sessions updated.`,
        'Apply Complete'
      );
      onApplied?.();
    } catch (err) {
      const msg = parseApiError(err);
      setApplyError(msg);
      showError?.(msg, 'Apply Failed');
    } finally {
      setApplying(false);
    }
  };

  const hasAnyFlag =
    flags.firstName || flags.lastName || flags.username || flags.bio || flags.profilePhoto;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
        <div className="flex items-start gap-3">
          <ListChecks className="h-5 w-5 text-emerald-300 mt-0.5" />
          <div className="text-xs leading-relaxed text-emerald-100/80">
            Apply a <span className="font-semibold text-emerald-200">profile list</span> across the
            selected sessions. Each session gets one row from the list — names and bios cycle
            when the list is shorter than the session count, duplicate usernames get a random
            suffix appended, and every session is assigned a random real profile picture from
            a 150+ image catalog (the list's "PFP" text is ignored).
          </div>
        </div>
      </div>

      {/* List picker */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Source List</h3>
          <button
            type="button"
            onClick={fetchLists}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1 text-xs text-gray-300 hover:bg-white/5"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        </div>

        {listsLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading profile lists...
          </div>
        ) : listsError ? (
          <div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {listsError}
          </div>
        ) : lists.length === 0 ? (
          <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            No profile lists yet. Upload one in <span className="font-medium">Lists → New List → Profile List</span>.
          </div>
        ) : (
          <select
            value={selectedListId}
            onChange={(e) => setSelectedListId(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white focus:border-primary-500 focus:outline-none"
          >
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} — {l.items_count || l.itemCount || 0} entries
              </option>
            ))}
          </select>
        )}

        {/* Field toggles */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-400">
            Fields to apply
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {[
              { k: 'firstName', icon: UserIcon, label: 'First name' },
              { k: 'lastName', icon: UserIcon, label: 'Last name' },
              { k: 'username', icon: AtSign, label: 'Username' },
              { k: 'bio', icon: FileText, label: 'Bio' },
              { k: 'profilePhoto', icon: ImageIcon, label: 'Profile photo' },
            ].map(({ k, icon: Icon, label }) => (
              <label
                key={k}
                className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors ${
                  flags[k]
                    ? 'border-primary-500/40 bg-primary-500/10 text-primary-100'
                    : 'border-white/10 bg-dark-900 text-gray-400 hover:border-white/20'
                }`}
              >
                <input
                  type="checkbox"
                  checked={flags[k]}
                  onChange={() => toggleFlag(k)}
                  className="hidden"
                />
                <Icon className="h-3.5 w-3.5" />
                {label}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Preview */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Preview</h3>
          <button
            type="button"
            onClick={buildPreview}
            disabled={previewing || !selectedListId || sessionIds.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1 text-xs text-gray-200 hover:bg-white/5 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${previewing ? 'animate-spin' : ''}`} />
            Re-roll
          </button>
        </div>

        {previewError && (
          <div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {previewError}
          </div>
        )}

        {preview ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-white/5 px-2.5 py-1 text-gray-300">
                {preview.listSize} list rows
              </span>
              <span className="rounded-full bg-white/5 px-2.5 py-1 text-gray-300">
                {preview.sessionCount} sessions
              </span>
              {preview.repeatsRequired && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-amber-300">
                  <CornerDownRight className="h-3 w-3" />
                  Names + bios will repeat; usernames will get random suffixes
                </span>
              )}
            </div>
            <div className="max-h-96 overflow-auto rounded-lg border border-white/5">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-dark-900/95 backdrop-blur">
                  <tr className="border-b border-white/5">
                    <th className="px-3 py-2 text-left font-semibold text-gray-400">Session</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-400">Avatar</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-400">Name</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-400">Username</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-400 hidden md:table-cell">Bio</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {preview.assignments.map((a) => {
                    const session = (selectedSessions || []).find(
                      (s) => Number(s.id) === Number(a.sessionId)
                    );
                    return (
                      <tr key={a.sessionId} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-2 text-gray-300 font-mono">
                          {session?.phone || `#${a.sessionId}`}
                          {a.repeated && (
                            <span className="ml-1 inline-flex items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                              repeat #{a.sourceIndex + 1}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {a.avatarId ? (
                            <img
                              src={randomAvatarUrl(a.avatarId)}
                              alt={a.avatarId}
                              className="h-8 w-8 rounded-full object-cover ring-1 ring-white/10"
                              loading="lazy"
                            />
                          ) : (
                            <span className="text-gray-600">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-100">
                          {[a.firstName, a.lastName].filter(Boolean).join(' ') || '—'}
                        </td>
                        <td className="px-3 py-2 text-blue-400">{a.username ? `@${a.username}` : '—'}</td>
                        <td className="px-3 py-2 text-gray-400 hidden md:table-cell max-w-xs truncate" title={a.bio || ''}>
                          {a.bio || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : !previewing ? (
          <div className="rounded-md border border-white/5 bg-dark-900/60 px-4 py-6 text-center text-xs text-gray-500">
            Pick a profile list and at least one session to see the preview here.
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Building preview...
          </div>
        )}
      </div>

      {applyError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          <AlertTriangle className="h-4 w-4 mt-0.5" />
          <div>{applyError}</div>
        </div>
      )}

      {lastApplyResult && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
          <CheckCircle2 className="h-4 w-4 mt-0.5" />
          <div>
            Applied to <span className="font-semibold">{lastApplyResult.success}</span> /
            <span className="font-semibold"> {lastApplyResult.total}</span> sessions.
            {lastApplyResult.failed > 0 && (
              <span className="ml-1 text-amber-300">
                {lastApplyResult.failed} session(s) failed — see Sessions page for revoked flags.
              </span>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={handleApply}
          disabled={
            applying ||
            previewing ||
            !preview ||
            !hasAnyFlag ||
            !preview.assignments ||
            preview.assignments.length === 0
          }
          className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-primary-900/30 transition hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}
          {applying ? 'Applying...' : `Apply to ${sessionIds.length || 0} session(s)`}
        </button>
      </div>
    </div>
  );
}
