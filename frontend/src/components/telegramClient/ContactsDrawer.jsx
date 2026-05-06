import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Loader2, Search, UserPlus, Trash2, AlertCircle, Phone, AtSign,
  MessageSquare, RefreshCcw, Check, BadgeCheck, Star,
} from 'lucide-react';
import {
  listContacts,
  searchContactsApi,
  addContact,
  deleteContacts,
} from '../../api/telegramClient';
import Avatar from './Avatar';

/**
 * ContactsDrawer — D9 UI for the in-panel Telegram client.
 *
 * Sections:
 *   - Search box (locally filters loaded contacts; long queries also
 *     hit the global directory via /contacts/search).
 *   - Add contact form (toggle between by-phone and by-userId modes).
 *   - List of contacts, with avatar, name, @username, phone, mutual
 *     and bot/premium/verified badges. Each row exposes "Open chat"
 *     and "Delete contact" buttons.
 *
 * Live updates: subscribes to the window-level 'tg-client:contactsChanged'
 * CustomEvent (forwarded by useTelegramClientSocket) and refreshes the
 * list when one arrives. This keeps multiple windows (and side-channel
 * changes from another device) in sync.
 */
export default function ContactsDrawer({
  sessionId,
  isOpen,
  onClose,
  onOpenChat,
}) {
  const [contacts, setContacts] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [query, setQuery] = useState('');
  const [globalResults, setGlobalResults] = useState([]);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await listContacts(sessionId);
      const payload = data?.data || {};
      setContacts(payload.contacts || []);
      setCount(payload.count ?? (payload.contacts || []).length);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed to load contacts');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!isOpen) return undefined;
    refresh();
    return undefined;
  }, [isOpen, refresh]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onChange = (ev) => {
      const detail = ev?.detail;
      if (!detail || String(detail.sessionId) !== String(sessionId)) return;
      refresh();
    };
    window.addEventListener('tg-client:contactsChanged', onChange);
    return () => window.removeEventListener('tg-client:contactsChanged', onChange);
  }, [isOpen, sessionId, refresh]);

  const trimmedQuery = query.trim();

  const localFiltered = useMemo(() => {
    if (!trimmedQuery) return contacts;
    const q = trimmedQuery.toLowerCase();
    return contacts.filter((c) => {
      const hay = [
        c.firstName, c.lastName, c.username, ...(c.usernames || []), c.phone,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [contacts, trimmedQuery]);

  const globalDebounceRef = useRef(null);
  useEffect(() => {
    if (!isOpen) return undefined;
    if (trimmedQuery.length < 3) {
      setGlobalResults([]);
      setGlobalLoading(false);
      return undefined;
    }
    if (globalDebounceRef.current) clearTimeout(globalDebounceRef.current);
    globalDebounceRef.current = setTimeout(async () => {
      setGlobalLoading(true);
      try {
        const { data } = await searchContactsApi(sessionId, trimmedQuery, 30);
        const results = data?.data?.results || [];
        const localIds = new Set(contacts.map((c) => String(c.id)));
        setGlobalResults(results.filter((r) => !localIds.has(String(r.id))));
      } catch (_err) {
        setGlobalResults([]);
      } finally {
        setGlobalLoading(false);
      }
    }, 300);
    return () => {
      if (globalDebounceRef.current) {
        clearTimeout(globalDebounceRef.current);
        globalDebounceRef.current = null;
      }
    };
  }, [trimmedQuery, isOpen, sessionId, contacts]);

  const handleDelete = async (contact) => {
    if (typeof window !== 'undefined') {
      const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim()
        || contact.username
        || contact.phone
        || `User ${contact.id}`;
      if (!window.confirm(`Remove ${name} from your contacts?`)) return;
    }
    setBusyId(contact.id);
    setError(null);
    try {
      await deleteContacts(sessionId, [contact.id]);
      setContacts((prev) => prev.filter((c) => String(c.id) !== String(contact.id)));
      setCount((n) => Math.max(0, n - 1));
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed to delete contact');
    } finally {
      setBusyId(null);
    }
  };

  const handleOpenChat = (contact) => {
    onOpenChat?.({ peerType: 'user', peerId: Number(contact.id) });
    onClose?.();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-md flex-col border-l border-white/10 bg-dark-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
          <div className="text-sm font-semibold text-gray-100">Contacts</div>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-gray-400">
            {count.toLocaleString()}
          </span>
          <button
            type="button"
            onClick={() => refresh()}
            className="ml-auto rounded-full p-1 text-gray-400 hover:bg-white/5"
            title="Refresh"
            disabled={loading}
          >
            <RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-gray-400 hover:bg-white/5"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-white/5 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search contacts or @usernames…"
              className="w-full rounded-lg bg-dark-800 pl-9 pr-3 py-2 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
            />
          </div>
          <div className="mt-2 flex">
            <button
              type="button"
              onClick={() => setShowAdd((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-gray-200 hover:bg-white/5"
            >
              <UserPlus className="h-3.5 w-3.5" />
              {showAdd ? 'Cancel' : 'Add new contact'}
            </button>
          </div>
          {showAdd && (
            <AddContactForm
              sessionId={sessionId}
              onAdded={() => {
                setShowAdd(false);
                refresh();
              }}
              onError={(msg) => setError(msg)}
            />
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && (
            <div className="m-3 flex items-start gap-2 rounded-md bg-red-900/30 p-3 text-xs text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <div className="flex-1">{error}</div>
              <button
                type="button"
                className="text-red-200 underline"
                onClick={() => setError(null)}
              >
                dismiss
              </button>
            </div>
          )}

          {loading && contacts.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-gray-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <>
              <ul className="divide-y divide-white/5">
                {localFiltered.length === 0 && !trimmedQuery && (
                  <li className="px-4 py-6 text-center text-sm text-gray-500">
                    You haven't added any contacts yet.
                  </li>
                )}
                {localFiltered.map((c) => (
                  <ContactRow
                    key={`local-${c.id}`}
                    sessionId={sessionId}
                    contact={c}
                    busy={busyId === c.id}
                    onOpenChat={() => handleOpenChat(c)}
                    onDelete={() => handleDelete(c)}
                  />
                ))}
              </ul>

              {trimmedQuery.length >= 3 && (
                <div className="border-t border-white/5">
                  <div className="flex items-center gap-2 px-4 py-2 text-[11px] uppercase tracking-wider text-gray-500">
                    Global directory
                    {globalLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                  </div>
                  {globalResults.length === 0 && !globalLoading && (
                    <div className="px-4 pb-3 text-xs text-gray-500">No matches.</div>
                  )}
                  <ul className="divide-y divide-white/5">
                    {globalResults
                      .filter((r) => r.kind === 'user')
                      .map((r) => (
                        <GlobalRow
                          key={`global-${r.id}`}
                          sessionId={sessionId}
                          result={r}
                          onAdded={() => refresh()}
                          onOpenChat={() => handleOpenChat({ id: r.id })}
                          onError={setError}
                        />
                      ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function ContactRow({ sessionId, contact, busy, onOpenChat, onDelete }) {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim()
    || contact.username
    || contact.phone
    || `User ${contact.id}`;
  return (
    <li className="flex items-center gap-3 px-3 py-2 hover:bg-white/5">
      <Avatar
        sessionId={sessionId}
        peerType="user"
        peerId={Number(contact.id)}
        label={name}
        size="md"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-gray-100">{name}</span>
          {contact.verified && <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-blue-400" title="Verified" />}
          {contact.premium && <Star className="h-3.5 w-3.5 shrink-0 text-amber-300" title="Premium" />}
          {contact.bot && (
            <span className="rounded bg-blue-500/10 px-1 text-[10px] font-medium text-blue-300">BOT</span>
          )}
          {contact.mutual && (
            <span className="rounded bg-emerald-500/10 px-1 text-[10px] font-medium text-emerald-300" title="You are in their contacts">MUTUAL</span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-gray-500">
          {contact.username && (
            <span className="inline-flex items-center gap-0.5">
              <AtSign className="h-3 w-3" />
              {contact.username}
            </span>
          )}
          {contact.phone && (
            <span className="inline-flex items-center gap-0.5">
              <Phone className="h-3 w-3" />
              {contact.phone}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onOpenChat}
        className="rounded-md p-1.5 text-gray-400 hover:bg-white/10 hover:text-blue-300"
        title="Open chat"
      >
        <MessageSquare className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        className="rounded-md p-1.5 text-gray-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
        title="Remove contact"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
      </button>
    </li>
  );
}

function GlobalRow({ sessionId, result, onAdded, onOpenChat, onError }) {
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const name = [result.firstName, result.lastName].filter(Boolean).join(' ').trim()
    || result.username
    || `User ${result.id}`;

  const onAdd = async () => {
    setAdding(true);
    try {
      await addContact(sessionId, {
        userId: Number(result.id),
        firstName: result.firstName || '',
        lastName: result.lastName || '',
      });
      setAdded(true);
      onAdded?.();
    } catch (err) {
      onError?.(err?.response?.data?.error?.message || err?.message || 'Failed to add contact');
    } finally {
      setAdding(false);
    }
  };

  return (
    <li className="flex items-center gap-3 px-3 py-2 hover:bg-white/5">
      <Avatar
        sessionId={sessionId}
        peerType="user"
        peerId={Number(result.id)}
        label={name}
        size="md"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-gray-100">{name}</span>
          {result.verified && <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-blue-400" />}
          {result.premium && <Star className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
          {result.bot && (
            <span className="rounded bg-blue-500/10 px-1 text-[10px] font-medium text-blue-300">BOT</span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-2 text-[11px] text-gray-500">
          {result.username && (
            <span className="inline-flex items-center gap-0.5">
              <AtSign className="h-3 w-3" />
              {result.username}
            </span>
          )}
        </div>
      </div>
      {!added ? (
        <button
          type="button"
          onClick={onAdd}
          disabled={adding}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-gray-100 hover:bg-white/5 disabled:opacity-50"
        >
          {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-3 w-3" />}
          Add
        </button>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300">
          <Check className="h-3 w-3" />
          Added
        </span>
      )}
      <button
        type="button"
        onClick={onOpenChat}
        className="rounded-md p-1.5 text-gray-400 hover:bg-white/10 hover:text-blue-300"
        title="Open chat"
      >
        <MessageSquare className="h-4 w-4" />
      </button>
    </li>
  );
}

function AddContactForm({ sessionId, onAdded, onError }) {
  const [mode, setMode] = useState('phone');
  const [phone, setPhone] = useState('');
  const [userId, setUserId] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [sharePhone, setSharePhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setLocalError(null);
    const payload = {
      firstName: firstName.trim().slice(0, 64),
      lastName: lastName.trim().slice(0, 64),
      sharePhone,
    };
    if (mode === 'phone') {
      const cleaned = phone.replace(/[^\d+]/g, '');
      if (!cleaned) {
        setLocalError('Phone is required.');
        return;
      }
      payload.phone = cleaned;
      if (!payload.firstName) {
        setLocalError('First name is required when adding by phone.');
        return;
      }
    } else {
      const id = Number(userId);
      if (!Number.isFinite(id) || id <= 0) {
        setLocalError('Numeric user ID is required.');
        return;
      }
      payload.userId = id;
    }
    setBusy(true);
    try {
      await addContact(sessionId, payload);
      setPhone('');
      setUserId('');
      setFirstName('');
      setLastName('');
      setSharePhone(false);
      onAdded?.();
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err?.response?.data?.error || err?.message || 'Failed to add contact';
      setLocalError(typeof msg === 'string' ? msg : 'Failed to add contact');
      onError?.(typeof msg === 'string' ? msg : 'Failed to add contact');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 rounded-md border border-white/10 bg-dark-800 p-3 text-sm">
      <div className="mb-2 inline-flex rounded-md bg-dark-700 p-0.5 text-xs">
        <button
          type="button"
          onClick={() => setMode('phone')}
          className={`rounded px-2 py-1 ${mode === 'phone' ? 'bg-blue-600 text-white' : 'text-gray-300'}`}
        >
          By phone
        </button>
        <button
          type="button"
          onClick={() => setMode('id')}
          className={`rounded px-2 py-1 ${mode === 'id' ? 'bg-blue-600 text-white' : 'text-gray-300'}`}
        >
          By user ID
        </button>
      </div>
      {mode === 'phone' ? (
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1 555 555 5555"
          className="mb-2 w-full rounded-md bg-dark-900 px-2 py-1.5 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
        />
      ) : (
        <input
          type="text"
          inputMode="numeric"
          value={userId}
          onChange={(e) => setUserId(e.target.value.replace(/[^\d]/g, ''))}
          placeholder="Telegram numeric user ID"
          className="mb-2 w-full rounded-md bg-dark-900 px-2 py-1.5 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <input
          type="text"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="First name"
          maxLength={64}
          className="rounded-md bg-dark-900 px-2 py-1.5 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
        />
        <input
          type="text"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          placeholder="Last name (optional)"
          maxLength={64}
          className="rounded-md bg-dark-900 px-2 py-1.5 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
        />
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-gray-400">
        <input
          type="checkbox"
          checked={sharePhone}
          onChange={(e) => setSharePhone(e.target.checked)}
          className="h-3 w-3 rounded border-white/20"
        />
        Share my phone number with this contact
      </label>
      {localError && (
        <div className="mt-2 text-xs text-red-300">{localError}</div>
      )}
      <button
        type="submit"
        disabled={busy}
        className="mt-2 inline-flex w-full items-center justify-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
        Add contact
      </button>
    </form>
  );
}
