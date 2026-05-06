import React, { useEffect, useRef, useState } from 'react';
import {
  Loader2, Users, UserPlus, Shield, ShieldOff, Ban, MoreHorizontal, Pencil,
  Camera, LogOut, X, Search, Crown,
} from 'lucide-react';
import {
  getChatMembers,
  addChatMember,
  kickChatMember,
  setChatAdmin,
  editChatTitle,
  editChatAbout,
  editChatPhoto,
  leaveChat,
} from '../../api/telegramClient';
import Avatar from './Avatar';
import { invalidateProfilePhoto } from './useProfilePhoto';

/**
 * ChatAdminPanel — embedded admin section for the PeerProfileDrawer
 * when the active peer is a group or channel. Shows:
 *   - Edit title / description / photo (only if user has the right).
 *   - Members list with filter (recent / admins / banned / bots).
 *   - Member actions: promote, demote, kick, ban.
 *   - Leave chat / channel.
 */
export default function ChatAdminPanel({ sessionId, profile, onProfileUpdated }) {
  const peerType = profile.peerType;
  const peerId = profile.id;
  const isAdmin = profile.isCreator || profile.isAdmin;
  const canEdit = isAdmin && !profile.isLeft;

  const [filter, setFilter] = useState('recent');
  const [search, setSearch] = useState('');
  const [members, setMembers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busyUserId, setBusyUserId] = useState(null);

  // Refresh on filter/search change
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        const { data } = await getChatMembers(sessionId, peerType, peerId, {
          filter,
          search: search.trim(),
          limit: 100,
        });
        if (!alive) return;
        setMembers(data?.data?.members || []);
        setTotal(data?.data?.total || 0);
      } catch (err) {
        if (!alive) return;
        setError(err?.response?.data?.error?.message || err?.message || 'Failed to load members');
      } finally {
        if (alive) setLoading(false);
      }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [sessionId, peerType, peerId, filter, search]);

  const refresh = async () => {
    try {
      const { data } = await getChatMembers(sessionId, peerType, peerId, {
        filter, search: search.trim(), limit: 100,
      });
      setMembers(data?.data?.members || []);
      setTotal(data?.data?.total || 0);
    } catch (_) { /* ignore */ }
  };

  // React to live participant updates (add / remove / promote) from
  // useTelegramClientSocket — refresh the list whenever the active
  // peer is mentioned.
  useEffect(() => {
    const onUpdate = (e) => {
      const d = e.detail;
      if (!d) return;
      if (d.peerType !== peerType || Number(d.peerId) !== Number(peerId)) return;
      refresh();
    };
    window.addEventListener('tg-client:participantUpdate', onUpdate);
    return () => window.removeEventListener('tg-client:participantUpdate', onUpdate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerType, peerId, filter, search]);

  const onKick = async (m, ban) => {
    const verb = ban ? 'Ban' : 'Remove';
    if (typeof window !== 'undefined' && !window.confirm(`${verb} ${_displayName(m)}?`)) return;
    setBusyUserId(m.userId);
    try {
      await kickChatMember(sessionId, peerType, peerId, m.userId, { ban });
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed');
    } finally { setBusyUserId(null); }
  };

  const onToggleAdmin = async (m) => {
    setBusyUserId(m.userId);
    try {
      const promote = !m.isAdmin && !m.isCreator;
      const rights = promote ? {
        // Default supergroup admin set; channels keep postMessages.
        changeInfo: peerType === 'channel' && profile.isBroadcast,
        postMessages: peerType === 'channel' && profile.isBroadcast,
        editMessages: peerType === 'channel' && profile.isBroadcast,
        deleteMessages: true,
        banUsers: peerType === 'channel' && !profile.isBroadcast,
        inviteUsers: true,
        pinMessages: peerType === 'channel' && !profile.isBroadcast,
        addAdmins: false,
      } : {};
      await setChatAdmin(sessionId, peerType, peerId, m.userId, {
        isAdmin: promote,
        rights,
        rank: '',
      });
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed');
    } finally { setBusyUserId(null); }
  };

  return (
    <div className="mt-6 space-y-4">
      {error && (
        <div className="rounded-md bg-red-900/30 px-3 py-2 text-xs text-red-300">{error}</div>
      )}

      {canEdit && (
        <EditChatSection
          sessionId={sessionId}
          profile={profile}
          onProfileUpdated={onProfileUpdated}
          setError={setError}
        />
      )}

      <div>
        <div className="mb-2 flex items-center gap-2">
          <Users className="h-4 w-4 text-gray-400" />
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Members {total > 0 ? `(${total.toLocaleString()})` : ''}
          </div>
          {canEdit && (
            <AddMemberButton
              sessionId={sessionId}
              peerType={peerType}
              peerId={peerId}
              setError={setError}
              onAdded={refresh}
            />
          )}
        </div>
        <div className="mb-2 flex items-center gap-2">
          <Search className="h-3.5 w-3.5 text-gray-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search members"
            className="flex-1 rounded-md bg-dark-800 px-2 py-1 text-xs text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="rounded-md bg-dark-800 px-2 py-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="recent">All</option>
            <option value="admins">Admins</option>
            {peerType === 'channel' && <option value="kicked">Restricted</option>}
            {peerType === 'channel' && <option value="banned">Banned</option>}
            <option value="bots">Bots</option>
          </select>
        </div>
        <div className="rounded-lg border border-white/5 bg-dark-800/40">
          {loading && members.length === 0 ? (
            <div className="flex items-center justify-center py-6 text-xs text-gray-500">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading…
            </div>
          ) : members.length === 0 ? (
            <div className="py-6 text-center text-xs text-gray-500">No members</div>
          ) : (
            <div className="divide-y divide-white/5">
              {members.map((m) => (
                <MemberRow
                  key={m.userId}
                  sessionId={sessionId}
                  member={m}
                  canManage={canEdit && !m.isSelf}
                  busy={busyUserId === m.userId}
                  onKick={() => onKick(m, false)}
                  onBan={() => onKick(m, true)}
                  onToggleAdmin={() => onToggleAdmin(m)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {!profile.isCreator && !profile.isLeft && (
        <button
          type="button"
          onClick={async () => {
            if (typeof window !== 'undefined' && !window.confirm(`Leave ${profile.title}?`)) return;
            try {
              await leaveChat(sessionId, peerType, peerId);
              onProfileUpdated?.({ ...profile, isLeft: true });
            } catch (err) {
              setError(err?.response?.data?.error?.message || err?.message || 'Failed to leave');
            }
          }}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10"
        >
          <LogOut className="h-3.5 w-3.5" />
          Leave {profile.isBroadcast ? 'channel' : 'group'}
        </button>
      )}
    </div>
  );
}

function MemberRow({ sessionId, member, canManage, busy, onKick, onBan, onToggleAdmin }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const name = _displayName(member);
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <Avatar
        sessionId={sessionId}
        peerType="user"
        peerId={Number(member.userId)}
        label={name}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 truncate text-sm text-gray-100">
          <span className="truncate">{name}</span>
          {member.isCreator && <Crown className="h-3 w-3 text-amber-300" title="Creator" />}
          {member.isAdmin && !member.isCreator && <Shield className="h-3 w-3 text-blue-300" title="Admin" />}
          {member.isBanned && <Ban className="h-3 w-3 text-red-400" title="Banned" />}
        </div>
        <div className="truncate text-[11px] text-gray-500">
          {member.username ? `@${member.username}` : member.isBot ? 'bot' : ''}
          {member.rank ? ` · ${member.rank}` : ''}
        </div>
      </div>
      {canManage && (
        <div ref={ref} className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            disabled={busy}
            className="rounded-md p-1 text-gray-400 hover:bg-white/5 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
          </button>
          {open && (
            <div className="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-md border border-white/10 bg-dark-800 shadow-xl">
              {!member.isCreator && (
                <ActionRow
                  Icon={member.isAdmin ? ShieldOff : Shield}
                  label={member.isAdmin ? 'Demote' : 'Promote to admin'}
                  onClick={() => { setOpen(false); onToggleAdmin(); }}
                />
              )}
              {!member.isCreator && (
                <ActionRow
                  Icon={X}
                  label="Remove"
                  onClick={() => { setOpen(false); onKick(); }}
                />
              )}
              {!member.isCreator && (
                <ActionRow
                  Icon={Ban}
                  label="Ban"
                  danger
                  onClick={() => { setOpen(false); onBan(); }}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActionRow({ Icon, label, danger, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-white/5 ${
        danger ? 'text-red-300' : 'text-gray-100'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function EditChatSection({ sessionId, profile, onProfileUpdated, setError }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(profile.title || '');
  const [about, setAbout] = useState(profile.bio || '');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    setTitle(profile.title || '');
    setAbout(profile.bio || '');
  }, [profile.title, profile.bio]);

  const save = async () => {
    setBusy(true);
    try {
      let next = profile;
      if (title.trim() && title.trim() !== profile.title) {
        const { data } = await editChatTitle(sessionId, profile.peerType, profile.id, title.trim());
        next = data?.data || next;
      }
      if (about.trim() !== (profile.bio || '').trim()) {
        const { data } = await editChatAbout(sessionId, profile.peerType, profile.id, about.trim());
        next = data?.data || next;
      }
      onProfileUpdated?.(next);
      setEditing(false);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed to save');
    } finally { setBusy(false); }
  };

  const onPickPhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const { data } = await editChatPhoto(sessionId, profile.peerType, profile.id, file);
      onProfileUpdated?.(data?.data || profile);
      invalidateProfilePhoto(sessionId, profile.peerType, profile.id);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed to upload');
    } finally { setBusy(false); }
  };

  if (!editing) {
    return (
      <div className="rounded-lg border border-white/5 bg-dark-800/40 p-3">
        <div className="mb-1 flex items-center gap-2">
          <Pencil className="h-3.5 w-3.5 text-gray-500" />
          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Edit</div>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-blue-300 hover:underline"
          >
            <Pencil className="h-3 w-3" /> Title / about
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-1 text-[11px] text-blue-300 hover:underline disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />}
            Photo
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/jpg"
            className="hidden"
            onChange={onPickPhoto}
          />
        </div>
        <div className="text-xs text-gray-400">
          You can manage this {profile.isBroadcast ? 'channel' : 'group'}.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-dark-800 p-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Title</div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={128}
        className="mb-3 w-full rounded-md bg-dark-900 px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Description</div>
      <textarea
        value={about}
        onChange={(e) => setAbout(e.target.value)}
        maxLength={255}
        rows={3}
        className="w-full resize-none rounded-md bg-dark-900 px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <div className="mt-1 text-right text-[10px] text-gray-500">{about.length}/255</div>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={busy}
          className="rounded-md border border-white/10 px-3 py-1 text-xs text-gray-300 hover:bg-white/5"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Save
        </button>
      </div>
    </div>
  );
}

function AddMemberButton({ sessionId, peerType, peerId, setError, onAdded }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);

  const onAdd = async () => {
    const v = val.trim();
    if (!v) return;
    let userId = Number(v);
    if (!Number.isFinite(userId)) {
      setError('Enter a numeric Telegram user id');
      return;
    }
    setBusy(true);
    try {
      await addChatMember(sessionId, peerType, peerId, { userId });
      setVal('');
      setOpen(false);
      onAdded?.();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed to add member');
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/5"
      >
        <UserPlus className="h-3 w-3" /> Add
      </button>
    );
  }
  return (
    <div className="ml-auto inline-flex items-center gap-1">
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="user id"
        className="w-24 rounded-md bg-dark-800 px-2 py-0.5 text-[11px] text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <button
        type="button"
        onClick={onAdd}
        disabled={busy}
        className="rounded-md bg-blue-600 px-2 py-0.5 text-[11px] text-white hover:bg-blue-500 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
      </button>
      <button
        type="button"
        onClick={() => { setOpen(false); setVal(''); }}
        className="rounded-md p-0.5 text-gray-400 hover:bg-white/5"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function _displayName(m) {
  return [m.firstName, m.lastName].filter(Boolean).join(' ').trim()
    || (m.username ? `@${m.username}` : '')
    || `User ${m.userId}`;
}
