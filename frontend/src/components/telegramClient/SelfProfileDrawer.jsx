import React, { useEffect, useRef, useState } from 'react';
import {
  X, Loader2, Camera, Trash2, AtSign, User, Phone, Pencil, Check, AlertCircle,
} from 'lucide-react';
import {
  getSelfProfile,
  updateSelfProfile,
  updateSelfUsername,
  checkSelfUsername,
  updateSelfPhoto,
  deleteSelfPhoto,
} from '../../api/telegramClient';
import Avatar from './Avatar';

/**
 * SelfProfileDrawer — right-side slide-over for the panel-owner's
 * Telegram account.
 *
 * Sections:
 *   - Avatar  (camera button to upload, trash to delete)
 *   - Name + Bio (inline editor with save / cancel)
 *   - Username (inline editor + availability check)
 *   - Phone (read-only)
 *
 * The drawer uses optimistic updates wherever possible; on error it
 * surfaces the message and reverts.
 */
export default function SelfProfileDrawer({ sessionId, isOpen, onClose, onProfileLoaded }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Refresh from the server every time the drawer opens. This is cheap
  // and ensures changes made on another device propagate.
  useEffect(() => {
    if (!isOpen) return undefined;
    let alive = true;
    setLoading(true);
    setError(null);
    getSelfProfile(sessionId)
      .then(({ data }) => {
        if (!alive) return;
        setProfile(data?.data || null);
        onProfileLoaded?.(data?.data || null);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err?.response?.data?.error?.message || err?.message || 'Failed to load profile');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [isOpen, sessionId, onProfileLoaded]);

  const refresh = async () => {
    setLoading(true);
    try {
      const { data } = await getSelfProfile(sessionId);
      setProfile(data?.data || null);
      onProfileLoaded?.(data?.data || null);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-md flex-col border-l border-white/10 bg-dark-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
          <div className="text-sm font-semibold text-gray-100">My profile</div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-full p-1 text-gray-400 hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && !profile && (
            <div className="flex items-center justify-center py-10 text-gray-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}

          {error && (
            <div className="mb-3 flex items-start gap-2 rounded-md bg-red-900/30 p-3 text-xs text-red-300">
              <AlertCircle className="h-4 w-4" />
              <div className="flex-1">{error}</div>
            </div>
          )}

          {profile && (
            <>
              <PhotoSection
                sessionId={sessionId}
                profile={profile}
                onChanged={(p) => { setProfile(p); onProfileLoaded?.(p); }}
                setError={setError}
                refresh={refresh}
              />
              <div className="mt-6 space-y-4">
                <NameBioSection
                  sessionId={sessionId}
                  profile={profile}
                  onChanged={(p) => { setProfile(p); onProfileLoaded?.(p); }}
                  setError={setError}
                />
                <UsernameSection
                  sessionId={sessionId}
                  profile={profile}
                  onChanged={(p) => { setProfile(p); onProfileLoaded?.(p); }}
                  setError={setError}
                />
                <PhoneSection profile={profile} />
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function PhotoSection({ sessionId, profile, onChanged, setError, refresh }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim()
    || profile.username
    || `User ${profile.id}`;

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await updateSelfPhoto(sessionId, file);
      onChanged(data?.data || null);
      // Photo URLs cache by photoId; force a re-fetch of the avatar.
      await refresh?.();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed to update photo');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!profile.hasPhoto) return;
    if (typeof window !== 'undefined' && !window.confirm('Delete your profile photo?')) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await deleteSelfPhoto(sessionId);
      onChanged(data?.data || null);
      await refresh?.();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed to delete photo');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative">
        <Avatar
          sessionId={sessionId}
          peerType="user"
          peerId={Number(profile.id)}
          label={fullName}
          size="2xl"
          large
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full border-2 border-dark-900 bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
          title="Upload new photo"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/jpg"
          className="hidden"
          onChange={onPick}
        />
      </div>
      <div className="text-center">
        <div className="text-base font-semibold text-gray-100">{fullName}</div>
        {profile.username && (
          <div className="text-xs text-blue-300">@{profile.username}</div>
        )}
      </div>
      {profile.hasPhoto && (
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border border-red-500/30 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
        >
          <Trash2 className="h-3 w-3" />
          Delete photo
        </button>
      )}
    </div>
  );
}

function NameBioSection({ sessionId, profile, onChanged, setError }) {
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState(profile.firstName || '');
  const [lastName, setLastName] = useState(profile.lastName || '');
  const [bio, setBio] = useState(profile.bio || '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setFirstName(profile.firstName || '');
    setLastName(profile.lastName || '');
    setBio(profile.bio || '');
  }, [profile.firstName, profile.lastName, profile.bio]);

  if (!editing) {
    return (
      <Field
        icon={User}
        label="Name & bio"
        onEdit={() => setEditing(true)}
      >
        <div className="text-sm text-gray-100">
          {[profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() || (
            <span className="italic text-gray-500">No name set</span>
          )}
        </div>
        <div className="mt-1 whitespace-pre-wrap text-xs text-gray-400">
          {profile.bio || <span className="italic text-gray-500">No bio</span>}
        </div>
      </Field>
    );
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await updateSelfProfile(sessionId, {
        firstName: firstName.slice(0, 64),
        lastName: lastName.slice(0, 64),
        bio: bio.slice(0, 70),
      });
      onChanged(data?.data || null);
      setEditing(false);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-dark-800 p-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">First name</div>
      <input
        value={firstName}
        onChange={(e) => setFirstName(e.target.value)}
        maxLength={64}
        className="mb-3 w-full rounded-md bg-dark-900 px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Last name</div>
      <input
        value={lastName}
        onChange={(e) => setLastName(e.target.value)}
        maxLength={64}
        className="mb-3 w-full rounded-md bg-dark-900 px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Bio</div>
      <textarea
        value={bio}
        onChange={(e) => setBio(e.target.value)}
        maxLength={70}
        rows={3}
        className="w-full resize-none rounded-md bg-dark-900 px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <div className="mt-1 text-right text-[10px] text-gray-500">{bio.length}/70</div>
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
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Save
        </button>
      </div>
    </div>
  );
}

function UsernameSection({ sessionId, profile, onChanged, setError }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(profile.username || '');
  const [check, setCheck] = useState(null); // { available, reason }
  const [busy, setBusy] = useState(false);

  useEffect(() => { setValue(profile.username || ''); }, [profile.username]);

  // Debounce availability checks while editing.
  useEffect(() => {
    if (!editing) { setCheck(null); return undefined; }
    const v = value.trim();
    if (!v || v === (profile.username || '')) { setCheck(null); return undefined; }
    if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v)) {
      setCheck({ available: false, reason: 'BAD_FORMAT' });
      return undefined;
    }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const { data } = await checkSelfUsername(sessionId, v);
        if (alive) setCheck(data?.data || null);
      } catch (_) {
        if (alive) setCheck(null);
      }
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [value, editing, profile.username, sessionId]);

  if (!editing) {
    return (
      <Field
        icon={AtSign}
        label="Username"
        onEdit={() => setEditing(true)}
      >
        <div className="text-sm text-gray-100">
          {profile.username
            ? <span className="text-blue-300">@{profile.username}</span>
            : <span className="italic text-gray-500">No username set</span>}
        </div>
      </Field>
    );
  }

  const save = async () => {
    const v = value.trim();
    setBusy(true);
    setError(null);
    try {
      const { data } = await updateSelfUsername(sessionId, v);
      onChanged(data?.data || null);
      setEditing(false);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed to save username');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-dark-800 p-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Username</div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-400">@</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/^@/, ''))}
          maxLength={32}
          placeholder="example_user"
          className="flex-1 rounded-md bg-dark-900 px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      {check && (
        <div className={`mt-1 text-[11px] ${check.available ? 'text-emerald-400' : 'text-amber-400'}`}>
          {check.available ? 'Available!' : (
            check.reason === 'OCCUPIED' ? 'Username is taken' :
            check.reason === 'INVALID' ? 'Username is invalid' :
            check.reason === 'BAD_FORMAT' ? '5–32 chars, a–z, 0–9, _, must start with a letter' :
            check.reason === 'PURCHASE_ONLY' ? 'Username is purchase-only on Telegram Fragment' :
            'Not available'
          )}
        </div>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => { setEditing(false); setValue(profile.username || ''); }}
          disabled={busy}
          className="rounded-md border border-white/10 px-3 py-1 text-xs text-gray-300 hover:bg-white/5"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy || (check && check.available === false && value.trim() !== '')}
          className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Save
        </button>
      </div>
    </div>
  );
}

function PhoneSection({ profile }) {
  return (
    <Field icon={Phone} label="Phone" readOnly>
      <div className="text-sm text-gray-100">
        {profile.phone ? `+${profile.phone}` : <span className="italic text-gray-500">Hidden</span>}
      </div>
    </Field>
  );
}

function Field({ icon: Icon, label, children, onEdit, readOnly }) {
  return (
    <div className="rounded-lg border border-white/5 bg-dark-800/40 p-3">
      <div className="mb-1 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-gray-500" />
        <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
        {!readOnly && onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-blue-300 hover:underline"
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
        )}
      </div>
      {children}
    </div>
  );
}
