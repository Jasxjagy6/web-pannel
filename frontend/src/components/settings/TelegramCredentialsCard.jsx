import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  Key, Shield, Plus, Trash2, Edit3, Save, X as XIcon,
  ExternalLink, Info, Hash, Layers, Check, Power, PowerOff,
  Loader2,
} from 'lucide-react';
import { useToast } from '../common/Toast';
import { useAuth } from '../../hooks/useAuth';
import {
  listCredentials,
  createCredential,
  updateCredential,
  deleteCredential,
} from '../../api/userCredentials';
import { parseApiError } from '@/utils/formatters';

/**
 * TelegramCredentialsCard — multi-credential CRUD for the per-user
 * Telegram API ID/Hash vault. Powers the "Telegram API" card on the
 * Settings page and is the only place a non-admin user can ever
 * enter / see / rotate their API ID and Hash.
 *
 * Behaviour:
 *  - List shows label, masked hash (last 4 chars), max sessions, live
 *    session count, active toggle, edit / delete.
 *  - Add row is a small inline form (label, api_id, api_hash, max
 *    sessions, optional notes). All four "real" fields are required
 *    on create. On update, api_hash is optional (blank = don't
 *    rotate).
 *  - Submitting fires a `user-credentials-updated` window event so
 *    AuthContext can refetch the profile and clear the
 *    apiCredentialsCount=0 popup.
 */
export default function TelegramCredentialsCard() {
  const { refreshProfile } = useAuth();
  const { error: showError, success: showSuccess } = useToast();
  const [creds, setCreds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  const cardRef = useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listCredentials();
      setCreds(r.data?.data?.items || []);
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Deep-link from MissingApiCredsModal: /settings#api-credentials
  // should scroll the card into view AND auto-open the add form when
  // the user has nothing yet.
  useEffect(() => {
    if (window.location.hash !== '#api-credentials') return;
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!loading && creds.length === 0) setShowAdd(true);
  }, [loading, creds.length]);

  async function notifyChanged() {
    try {
      window.dispatchEvent(new Event('user-credentials-updated'));
    } catch (_) { /* ignore */ }
    if (typeof refreshProfile === 'function') {
      try { await refreshProfile(); } catch (_) { /* ignore */ }
    }
  }

  async function handleCreate(payload) {
    try {
      await createCredential(payload);
      showSuccess('Telegram API credential added.', 'Saved');
      setShowAdd(false);
      await refresh();
      await notifyChanged();
    } catch (err) {
      showError(parseApiError(err), 'Could not add credential');
      throw err;
    }
  }

  async function handleUpdate(id, payload) {
    try {
      await updateCredential(id, payload);
      showSuccess('Credential updated.', 'Saved');
      setEditing(null);
      await refresh();
      await notifyChanged();
    } catch (err) {
      showError(parseApiError(err), 'Could not update credential');
      throw err;
    }
  }

  async function handleDelete(id, label) {
    if (!window.confirm(`Delete credential "${label}"? Sessions already created under it stay active.`)) return;
    try {
      await deleteCredential(id);
      showSuccess('Credential deleted.', 'Done');
      await refresh();
      await notifyChanged();
    } catch (err) {
      showError(parseApiError(err), 'Delete failed');
    }
  }

  return (
    <div ref={cardRef} id="api-credentials" className="rounded-xl border border-white/5 bg-dark-800 shadow-sm scroll-mt-24">
      <div className="border-b border-white/5 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-500/10 text-primary-400">
              <Key className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Telegram API Credentials</h2>
              <p className="text-sm text-gray-400">
                Used for every Telegram operation we run on your behalf. Add several to rotate sessions and avoid suspicious-activity flags.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => { setEditing(null); setShowAdd((s) => !s); }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-500"
          >
            <Plus className="h-4 w-4" />
            Add
          </button>
        </div>
      </div>

      <div className="space-y-5 p-6">
        <div className="flex gap-3 rounded-lg border border-blue-500/20 bg-blue-500/5 p-4">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
          <div className="text-sm text-blue-200">
            <p className="mb-1 font-medium">How rotation works</p>
            <ul className="list-disc space-y-1 pl-4 text-blue-300/80">
              <li>You set <strong>max sessions</strong> per credential. We never run more than that many live sessions on it.</li>
              <li>When you create or upload a session, we pick the credential with free capacity that has the fewest live sessions right now.</li>
              <li>If every credential is at its cap, we tell you to add another or raise the cap.</li>
              <li>Disable a credential to stop new sessions binding to it without deleting it.</li>
            </ul>
            <p className="mt-2 text-xs text-blue-300/70">
              Don't have an API ID/Hash yet? Create one at&nbsp;
              <a href="https://my.telegram.org/apps" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline hover:text-blue-200">
                my.telegram.org/apps <ExternalLink className="h-3 w-3" />
              </a>.
            </p>
          </div>
        </div>

        {showAdd && (
          <CredentialForm
            mode="create"
            onCancel={() => setShowAdd(false)}
            onSubmit={handleCreate}
          />
        )}

        {error && (
          <div className="rounded-lg border border-error-500/30 bg-error-500/10 p-3 text-sm text-error-300">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading credentials…
          </div>
        ) : creds.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/10 bg-dark-900/40 p-6 text-center text-sm text-gray-400">
            No credentials yet. Click <span className="font-medium text-white">Add</span> to register your first Telegram API ID and Hash.
          </div>
        ) : (
          <div className="space-y-3">
            {creds.map((c) => (
              <CredentialRow
                key={c.id}
                cred={c}
                editing={editing === c.id}
                onEdit={() => { setShowAdd(false); setEditing(c.id); }}
                onCancelEdit={() => setEditing(null)}
                onSave={(payload) => handleUpdate(c.id, payload)}
                onDelete={() => handleDelete(c.id, c.label || c.apiId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CredentialRow({ cred, editing, onEdit, onCancelEdit, onSave, onDelete }) {
  const used = Number(cred.sessionCount || 0);
  const max = Number(cred.maxSessions || 0);
  const utilization = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;

  if (editing) {
    return (
      <CredentialForm
        mode="edit"
        cred={cred}
        onCancel={onCancelEdit}
        onSubmit={onSave}
      />
    );
  }

  return (
    <div className="rounded-lg border border-white/5 bg-dark-900/40 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-white">{cred.label || `API #${cred.apiId}`}</p>
            {cred.isActive ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-success-500/30 bg-success-500/10 px-2 py-0.5 text-xs text-success-300">
                <Power className="h-3 w-3" /> Active
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-gray-500/30 bg-gray-500/10 px-2 py-0.5 text-xs text-gray-300">
                <PowerOff className="h-3 w-3" /> Disabled
              </span>
            )}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-400 sm:grid-cols-4">
            <div className="flex min-w-0 items-center gap-1">
              <Hash className="h-3 w-3 shrink-0" />
              <span className="shrink-0">API ID:</span>
              <span className="truncate font-mono text-gray-200">{cred.apiId}</span>
            </div>
            <div className="flex min-w-0 items-center gap-1">
              <Shield className="h-3 w-3 shrink-0" />
              <span className="shrink-0">Hash:</span>
              <span className="truncate font-mono text-gray-200" title={cred.apiHashMasked}>
                {cred.apiHashMasked || '••••'}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-1">
              <Layers className="h-3 w-3 shrink-0" />
              <span className="shrink-0">Sessions:</span>
              <span className="truncate text-gray-200">{used}/{max}</span>
            </div>
            <div className="flex min-w-0 items-center gap-1">
              <Check className="h-3 w-3 shrink-0" />
              <span className="shrink-0">Capacity:</span>
              <span className="truncate text-gray-200">{utilization}%</span>
            </div>
          </div>
          {cred.notes && <p className="mt-2 text-xs text-gray-500">{cred.notes}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-gray-200 hover:bg-white/5"
          >
            <Edit3 className="h-3.5 w-3.5" /> Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center gap-1 rounded-lg border border-error-500/30 bg-error-500/10 px-2.5 py-1.5 text-xs text-error-300 hover:bg-error-500/20"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className={`h-full ${utilization >= 100 ? 'bg-warning-500' : 'bg-primary-500'}`}
          style={{ width: `${utilization}%` }}
        />
      </div>
    </div>
  );
}

function CredentialForm({ mode, cred, onCancel, onSubmit }) {
  const isEdit = mode === 'edit';
  const [label, setLabel] = useState(cred?.label || '');
  const [apiId, setApiId] = useState(cred?.apiId ? String(cred.apiId) : '');
  const [apiHash, setApiHash] = useState('');
  const [maxSessions, setMaxSessions] = useState(cred?.maxSessions ? String(cred.maxSessions) : '3');
  const [isActive, setIsActive] = useState(cred ? !!cred.isActive : true);
  const [notes, setNotes] = useState(cred?.notes || '');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const valid = useMemo(() => {
    if (!label.trim()) return 'Label is required.';
    const idNum = Number(apiId);
    if (!Number.isInteger(idNum) || idNum <= 0) return 'API ID must be a positive integer.';
    if (!isEdit) {
      if (!apiHash.trim() || apiHash.trim().length < 16) return 'API Hash must be at least 16 characters.';
    } else if (apiHash && apiHash.trim().length < 16) {
      return 'API Hash must be at least 16 characters or left blank to keep the current one.';
    }
    const maxNum = Number(maxSessions);
    if (!Number.isInteger(maxNum) || maxNum < 1 || maxNum > 50) return 'Max sessions must be between 1 and 50.';
    return null;
  }, [label, apiId, apiHash, maxSessions, isEdit]);

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    if (valid) { setFormError(valid); return; }
    setSubmitting(true);
    try {
      const payload = {
        label: label.trim(),
        apiId: Number(apiId),
        maxSessions: Number(maxSessions),
        isActive,
        notes: notes.trim() || null,
      };
      if (apiHash.trim()) payload.apiHash = apiHash.trim();
      await onSubmit(payload);
    } catch (_) {
      // toast already shown by parent
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-primary-500/30 bg-primary-500/5 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-300">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Personal #1"
            className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-300">API ID</label>
          <input
            type="text"
            inputMode="numeric"
            value={apiId}
            onChange={(e) => setApiId(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="123456"
            className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm font-mono text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-gray-300">
            API Hash {isEdit && <span className="text-gray-500">(leave blank to keep current)</span>}
          </label>
          <input
            type="password"
            autoComplete="off"
            value={apiHash}
            onChange={(e) => setApiHash(e.target.value)}
            placeholder={isEdit ? 'Leave blank to keep the existing hash' : 'Paste the API Hash from my.telegram.org'}
            className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm font-mono text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-300">Max sessions</label>
          <input
            type="number"
            min={1}
            max={50}
            value={maxSessions}
            onChange={(e) => setMaxSessions(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
          <p className="mt-1 text-xs text-gray-500">
            Hard cap of live sessions per this API ID/Hash. Telegram flags credentials with hundreds of sessions, so 3-5 is typical.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => setIsActive((v) => !v)}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
              isActive
                ? 'border-success-500/40 bg-success-500/10 text-success-300'
                : 'border-gray-500/40 bg-gray-500/10 text-gray-300'
            }`}
          >
            {isActive ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />}
            {isActive ? 'Active' : 'Disabled'}
          </button>
          <p className="text-xs text-gray-500">Disabled credentials are not picked for new sessions.</p>
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-gray-300">Notes (optional)</label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal note, e.g. customer X"
            className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
        </div>
      </div>
      {formError && (
        <div className="mt-3 rounded-lg border border-error-500/30 bg-error-500/10 p-2 text-xs text-error-300">
          {formError}
        </div>
      )}
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5"
        >
          <XIcon className="h-4 w-4" /> Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-1 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-500 disabled:opacity-60"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {isEdit ? 'Save changes' : 'Add credential'}
        </button>
      </div>
    </form>
  );
}
