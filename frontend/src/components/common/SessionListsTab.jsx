import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Plus,
  Layers,
  Trash2,
  Pencil,
  Search,
  Loader2,
  Check,
  X,
  Users,
  AlertTriangle,
  Download,
  FileJson,
  FileArchive,
} from 'lucide-react';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { sessionListsAPI } from '../../api/sessionLists';
import { listSessions } from '../../api/sessions';
import { parseApiError, formatRelativeTime } from '../../utils/formatters';

/**
 * SessionListsTab — full CRUD UI for the new "session lists" feature.
 *
 * The page layout is:
 *  - Header with "Organise" button (+ Create new list)
 *  - Search/filter
 *  - Table of existing session lists with member counts
 *  - "Create" / "Edit members" modal that shows the user's active
 *    sessions and lets them tick/untick members + name the list.
 *
 * Mounted from <Lists> on the User-Lists / Session-Lists tab switch.
 */

function SessionPickerGrid({ sessions, selected, onToggle, search, onSearch }) {
  const filtered = useMemo(() => {
    const q = (search || '').trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const phone = String(s.phone || '').toLowerCase();
      const username = String(s.username || s.account_info?.username || '').toLowerCase();
      const id = String(s.id || '');
      return phone.includes(q) || username.includes(q) || id.includes(q);
    });
  }, [sessions, search]);
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          value={search || ''}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search sessions by phone, username, or id..."
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-dark-900 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
        />
      </div>
      <div className="max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-dark-900 p-2 space-y-1">
        {filtered.length === 0 && (
          <div className="p-4 text-center text-xs text-gray-500">
            {sessions.length === 0 ? 'No active sessions.' : 'No sessions match this filter.'}
          </div>
        )}
        {filtered.map((s) => {
          const isSelected = selected.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onToggle(s.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition ${
                isSelected
                  ? 'bg-primary-500/20 text-primary-300 border border-primary-500/30'
                  : 'hover:bg-white/5 text-gray-300 border border-transparent'
              }`}
            >
              <span
                className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                  isSelected ? 'border-primary-500 bg-primary-500/30' : 'border-gray-600'
                }`}
              >
                {isSelected && <Check className="w-3 h-3 text-primary-400" />}
              </span>
              <span className="truncate">{s.phone || `Session ${s.id}`}</span>
              {s.username && <span className="text-gray-500 text-xs">@{s.username}</span>}
              <span className="ml-auto text-[10px] text-gray-500">id:{s.id}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-gray-500">{selected.length} session(s) selected.</p>
    </div>
  );
}

function CreateOrEditModal({
  isOpen,
  onClose,
  initialList,
  sessions,
  onSaved,
}) {
  const { showSuccess, showError } = useToast();
  const isEdit = Boolean(initialList?.id);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName(initialList?.name || '');
    setDescription(initialList?.description || '');
    setSelected(Array.isArray(initialList?.member_ids) ? initialList.member_ids : []);
    setSearch('');
  }, [isOpen, initialList]);

  const toggle = (id) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    if (!name.trim()) return showError('Name is required', 'Validation');
    if (selected.length === 0) return showError('Pick at least one session', 'Validation');
    setSubmitting(true);
    try {
      let listId;
      if (isEdit) {
        await sessionListsAPI.update(initialList.id, {
          name: name.trim(),
          description: description.trim() || null,
        });
        await sessionListsAPI.setSessions(initialList.id, selected);
        listId = initialList.id;
      } else {
        const r = await sessionListsAPI.create({
          name: name.trim(),
          description: description.trim() || null,
          sessionIds: selected,
        });
        listId = r.data?.data?.list?.id;
      }
      showSuccess(
        isEdit ? `List "${name}" updated` : `List "${name}" created with ${selected.length} session(s)`,
        'Session list saved'
      );
      onSaved?.(listId);
      onClose?.();
    } catch (err) {
      showError(parseApiError(err), 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? `Edit session list — ${initialList?.name || ''}` : 'Organise sessions into a new list'}
      size="lg"
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-300 mb-1">List name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My personal sessions"
            className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 px-3 text-sm text-white"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-300 mb-1">Description (optional)</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Notes for yourself"
            className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 px-3 text-sm text-white"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-300 mb-2">Sessions to include</label>
          <SessionPickerGrid
            sessions={sessions}
            selected={selected}
            onToggle={toggle}
            search={search}
            onSearch={setSearch}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-60"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : isEdit ? (
              <Check className="w-4 h-4" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            {isEdit ? 'Save changes' : `Create list (${selected.length})`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function SessionListsTab() {
  const { showSuccess, showError } = useToast();
  const [lists, setLists] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [downloadTarget, setDownloadTarget] = useState(null);
  const [downloadFormat, setDownloadFormat] = useState('json');
  const [downloading, setDownloading] = useState(false);

  const fetchLists = useCallback(async () => {
    setLoading(true);
    try {
      const r = await sessionListsAPI.list();
      setLists(r.data?.data?.lists || []);
    } catch (err) {
      showError(parseApiError(err), 'Failed to load session lists');
      setLists([]);
    } finally {
      setLoading(false);
    }
  }, [showError]);

  const fetchSessions = useCallback(async () => {
    try {
      const r = await listSessions({ limit: 200 });
      setSessions(r.data?.data?.sessions || []);
    } catch (err) {
      console.warn('listSessions failed', parseApiError(err));
    }
  }, []);

  useEffect(() => {
    fetchLists();
    fetchSessions();
  }, [fetchLists, fetchSessions]);

  const filteredLists = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return lists;
    return lists.filter(
      (l) =>
        String(l.name || '').toLowerCase().includes(q) ||
        String(l.description || '').toLowerCase().includes(q)
    );
  }, [lists, search]);

  const onOrganise = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const onEdit = async (list) => {
    try {
      const r = await sessionListsAPI.getSessions(list.id);
      const memberIds = (r.data?.data?.sessions || []).map((s) => s.id);
      setEditing({ ...list, member_ids: memberIds });
      setModalOpen(true);
    } catch (err) {
      showError(parseApiError(err), 'Could not open list');
    }
  };

  const onDelete = async () => {
    if (!deleteTarget) return;
    try {
      await sessionListsAPI.delete(deleteTarget.id);
      showSuccess(`Deleted "${deleteTarget.name}"`, 'Session list removed');
      setDeleteTarget(null);
      fetchLists();
    } catch (err) {
      showError(parseApiError(err), 'Delete failed');
    }
  };

  const onConfirmDownload = async () => {
    if (!downloadTarget) return;
    setDownloading(true);
    try {
      const res = await sessionListsAPI.download(downloadTarget.id, {
        format: downloadFormat,
      });
      // Bridge an axios blob into a browser download. We extract the
      // filename from Content-Disposition when present, falling back
      // to a sensible local default.
      const cd =
        res?.headers?.['content-disposition'] ||
        res?.headers?.get?.('content-disposition');
      let filename = `${downloadTarget.name || 'session-list'}_${downloadFormat}.zip`;
      if (cd) {
        const m = cd.match(/filename="?([^"]+)"?/i);
        if (m && m[1]) filename = m[1];
      }
      const blob = new Blob([res.data], { type: 'application/zip' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      showSuccess(`Downloaded "${downloadTarget.name}"`, 'Session list export ready');
      setDownloadTarget(null);
    } catch (err) {
      // For blob responses axios can give us an opaque error body —
      // try to read it as JSON before falling back to the default.
      let msg = parseApiError(err);
      try {
        if (err?.response?.data instanceof Blob) {
          const text = await err.response.data.text();
          const parsed = JSON.parse(text);
          msg = parsed?.error?.message || msg;
        }
      } catch (_) {
        /* ignore */
      }
      showError(msg, 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary-500" />
            Session lists
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Group your sessions into named buckets and pick a whole bucket
            instead of ticking sessions one by one across messaging,
            scraping, privacy, groups, 2FA and OTP.
          </p>
        </div>
        <button
          onClick={onOrganise}
          className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
        >
          <Plus className="w-4 h-4" />
          Organise sessions
        </button>
      </div>

      <div className="rounded-xl border border-white/5 bg-dark-800">
        <div className="border-b border-white/5 p-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search session lists..."
              className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 pl-10 pr-4 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Description</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Sessions</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Created</th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto text-gray-500" />
                  </td>
                </tr>
              ) : filteredLists.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-gray-500">
                    {lists.length === 0 ? (
                      <>
                        <Layers className="w-8 h-8 mx-auto text-gray-600 mb-2" />
                        <p className="font-medium text-gray-400">No session lists yet.</p>
                        <p className="text-xs text-gray-500 mt-1">
                          Click <span className="text-primary-400">Organise sessions</span> above to create one.
                        </p>
                      </>
                    ) : (
                      'No matches.'
                    )}
                  </td>
                </tr>
              ) : (
                filteredLists.map((l) => (
                  <tr key={l.id} className="border-t border-white/5 hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <div className="text-white font-medium flex items-center gap-2">
                        <Layers className="w-3.5 h-3.5 text-primary-400/70" />
                        {l.name}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs max-w-xs truncate" title={l.description || ''}>
                      {l.description || <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary-500/10 text-primary-300 px-2.5 py-0.5 text-xs">
                        <Users className="w-3 h-3" />
                        {l.session_count}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {l.created_at ? formatRelativeTime(l.created_at) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => {
                            setDownloadFormat('json');
                            setDownloadTarget(l);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-primary-500/30 bg-primary-500/10 px-2.5 py-1.5 text-xs text-primary-300 hover:bg-primary-500/20"
                          title="Download as ZIP"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download
                        </button>
                        <button
                          onClick={() => onEdit(l)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/5"
                          title="Edit"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          Edit
                        </button>
                        <button
                          onClick={() => setDeleteTarget(l)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-300 hover:bg-rose-500/20"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <CreateOrEditModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        initialList={editing}
        sessions={sessions.filter(
          (s) => s.is_logged_in || (s.status || '').toLowerCase() === 'active'
        )}
        onSaved={() => fetchLists()}
      />

      {deleteTarget && (
        <Modal
          isOpen={Boolean(deleteTarget)}
          onClose={() => setDeleteTarget(null)}
          title="Delete session list"
          size="sm"
        >
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              <p className="text-sm text-gray-200">
                Delete <span className="font-semibold text-white">"{deleteTarget.name}"</span>?
              </p>
            </div>
            <p className="text-xs text-gray-500">
              The sessions inside the list are NOT deleted; only this grouping
              is removed.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                onClick={onDelete}
                className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700"
              >
                <Trash2 className="w-4 h-4" />
                Delete
              </button>
            </div>
          </div>
        </Modal>
      )}

      {downloadTarget && (
        <Modal
          isOpen={Boolean(downloadTarget)}
          onClose={() => (downloading ? null : setDownloadTarget(null))}
          title={`Download "${downloadTarget.name}"`}
          size="sm"
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-300">
              Choose the file format for the sessions inside this list.
              The download is a ZIP archive containing one file per
              session.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setDownloadFormat('json')}
                className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-3 text-left text-sm transition ${
                  downloadFormat === 'json'
                    ? 'border-primary-500/50 bg-primary-500/10 text-primary-300'
                    : 'border-white/10 bg-dark-900 text-gray-300 hover:border-white/20'
                }`}
              >
                <span className="flex items-center gap-2 font-semibold">
                  <FileJson className="h-4 w-4" />
                  .json
                </span>
                <span className="text-[11px] text-gray-500">
                  GramJS-compatible session string in a plain JSON
                  envelope. Recommended.
                </span>
              </button>
              <button
                type="button"
                onClick={() => setDownloadFormat('session')}
                className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-3 text-left text-sm transition ${
                  downloadFormat === 'session'
                    ? 'border-primary-500/50 bg-primary-500/10 text-primary-300'
                    : 'border-white/10 bg-dark-900 text-gray-300 hover:border-white/20'
                }`}
              >
                <span className="flex items-center gap-2 font-semibold">
                  <FileArchive className="h-4 w-4" />
                  .session
                </span>
                <span className="text-[11px] text-gray-500">
                  Telethon-style SQLite. Use with Telethon-based
                  tooling.
                </span>
              </button>
            </div>
            <p className="text-[11px] text-gray-500">
              Sessions in the ZIP are decrypted (plain). Anyone with
              access to the file can sign in as those accounts.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDownloadTarget(null)}
                disabled={downloading}
                className="rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={onConfirmDownload}
                disabled={downloading}
                className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
              >
                {downloading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                Download ZIP
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
