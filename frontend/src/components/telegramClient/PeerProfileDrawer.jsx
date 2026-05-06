import React, { useEffect, useState } from 'react';
import {
  X, Loader2, AlertCircle, AtSign, User, Phone, BellOff, Bell, Ban,
  ShieldOff, Users, Hash, Star, Bot, Verified, Crown, Megaphone,
} from 'lucide-react';
import {
  getPeerProfile,
  setPeerBlocked,
  setPeerMuted,
  getCommonChats,
} from '../../api/telegramClient';
import Avatar from './Avatar';

/**
 * PeerProfileDrawer — slide-over for a non-self peer (user / chat / channel).
 *
 * Renders avatar, title, bio, and the action bar (mute/unmute,
 * block/unblock for users), participant count for groups/channels, and
 * common chats for users. Emits onProfileLoaded so callers can mirror
 * mute/block state into their dialog list.
 */
export default function PeerProfileDrawer({
  sessionId,
  peerType,
  peerId,
  isOpen,
  onClose,
  onProfileLoaded,
}) {
  const [profile, setProfile] = useState(null);
  const [commonChats, setCommonChats] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen || !peerType || peerId == null) return undefined;
    let alive = true;
    setLoading(true);
    setError(null);
    setProfile(null);
    setCommonChats([]);
    Promise.all([
      getPeerProfile(sessionId, peerType, peerId),
      peerType === 'user'
        ? getCommonChats(sessionId, peerId, { limit: 12 }).catch(() => ({ data: { data: { chats: [] } } }))
        : Promise.resolve({ data: { data: { chats: [] } } }),
    ])
      .then(([{ data }, { data: cc }]) => {
        if (!alive) return;
        const p = data?.data || null;
        setProfile(p);
        setCommonChats(cc?.data?.chats || []);
        onProfileLoaded?.(p);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err?.response?.data?.error?.message || err?.message || 'Failed to load profile');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [isOpen, sessionId, peerType, peerId, onProfileLoaded]);

  if (!isOpen) return null;

  const mainTitle = profile?.title
    || [profile?.firstName, profile?.lastName].filter(Boolean).join(' ').trim()
    || (profile?.username ? `@${profile.username}` : '');

  const onToggleBlock = async () => {
    if (!profile || profile.peerType !== 'user') return;
    const next = !profile.isBlocked;
    if (next && typeof window !== 'undefined' && !window.confirm(`Block ${mainTitle}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await setPeerBlocked(sessionId, peerType, peerId, next);
      setProfile(data?.data || null);
      onProfileLoaded?.(data?.data || null);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed to update block status');
    } finally { setBusy(false); }
  };

  const onToggleMute = async () => {
    if (!profile) return;
    const next = !profile.isMuted;
    setBusy(true);
    setError(null);
    try {
      const { data } = await setPeerMuted(sessionId, peerType, peerId, next);
      setProfile(data?.data || null);
      onProfileLoaded?.(data?.data || null);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed to update mute status');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-md flex-col border-l border-white/10 bg-dark-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
          <div className="text-sm font-semibold text-gray-100">
            {peerType === 'user' ? 'User info' : peerType === 'channel' ? 'Channel info' : 'Group info'}
          </div>
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
              {/* Header */}
              <div className="flex flex-col items-center gap-3">
                <Avatar
                  sessionId={sessionId}
                  peerType={peerType}
                  peerId={Number(peerId)}
                  label={mainTitle}
                  size="2xl"
                  large
                />
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1 text-base font-semibold text-gray-100">
                    {mainTitle || `${peerType} ${peerId}`}
                    {profile.isVerified && <Verified className="h-4 w-4 text-blue-400" title="Verified" />}
                    {profile.isPremium && <Star className="h-4 w-4 text-amber-300" title="Telegram Premium" />}
                  </div>
                  {profile.username && (
                    <div className="text-xs text-blue-300">@{profile.username}</div>
                  )}
                  <PeerSubLine profile={profile} />
                </div>
              </div>

              {/* Action bar */}
              <div className="mt-4 flex justify-center gap-2">
                <ActionPill
                  onClick={onToggleMute}
                  disabled={busy}
                  Icon={profile.isMuted ? Bell : BellOff}
                  label={profile.isMuted ? 'Unmute' : 'Mute'}
                />
                {peerType === 'user' && (
                  <ActionPill
                    onClick={onToggleBlock}
                    disabled={busy}
                    Icon={profile.isBlocked ? ShieldOff : Ban}
                    label={profile.isBlocked ? 'Unblock' : 'Block'}
                    danger={!profile.isBlocked}
                  />
                )}
              </div>

              {/* Body */}
              <div className="mt-6 space-y-3">
                {profile.bio && (
                  <InfoRow icon={User} label={profile.isBot ? 'About bot' : 'Bio'}>
                    <div className="whitespace-pre-wrap text-sm text-gray-200">{profile.bio}</div>
                  </InfoRow>
                )}
                {profile.peerType === 'user' && profile.phone && (
                  <InfoRow icon={Phone} label="Phone">
                    <div className="text-sm text-gray-200">+{profile.phone}</div>
                  </InfoRow>
                )}
                {profile.username && (
                  <InfoRow icon={AtSign} label="Username">
                    <a
                      href={`https://t.me/${profile.username}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-blue-300 hover:underline"
                    >
                      @{profile.username}
                    </a>
                  </InfoRow>
                )}
                {profile.peerType !== 'user' && profile.participantsCount > 0 && (
                  <InfoRow icon={profile.isBroadcast ? Megaphone : Users} label={profile.isBroadcast ? 'Subscribers' : 'Members'}>
                    <div className="text-sm text-gray-200">{profile.participantsCount.toLocaleString()}</div>
                  </InfoRow>
                )}
                {profile.peerType === 'channel' && profile.linkedChatId && (
                  <InfoRow icon={Hash} label="Linked group">
                    <div className="text-sm text-gray-200">#{profile.linkedChatId}</div>
                  </InfoRow>
                )}
                {profile.botInfo && (
                  <InfoRow icon={Bot} label="Bot commands">
                    <div className="space-y-1 text-sm">
                      {profile.botInfo.commands.length > 0 ? profile.botInfo.commands.map((c) => (
                        <div key={c.command} className="flex gap-2">
                          <span className="font-mono text-blue-300">/{c.command}</span>
                          <span className="text-gray-300">{c.description}</span>
                        </div>
                      )) : (
                        <span className="italic text-gray-500">No commands</span>
                      )}
                    </div>
                  </InfoRow>
                )}
                {profile.isCreator && (
                  <InfoRow icon={Crown} label="Role">
                    <div className="text-sm text-amber-300">Creator</div>
                  </InfoRow>
                )}
              </div>

              {/* Common chats */}
              {peerType === 'user' && commonChats.length > 0 && (
                <div className="mt-6">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                    Groups in common ({commonChats.length})
                  </div>
                  <div className="space-y-1">
                    {commonChats.map((c) => (
                      <div key={`${c.peerType}:${c.peerId}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5">
                        <Avatar
                          sessionId={sessionId}
                          peerType={c.peerType}
                          peerId={Number(c.peerId)}
                          label={c.title}
                          size="sm"
                        />
                        <span className="truncate text-gray-200">{c.title || `${c.peerType} ${c.peerId}`}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function PeerSubLine({ profile }) {
  if (profile.peerType === 'user') {
    if (profile.isBot) return <div className="text-xs text-gray-500">bot</div>;
    if (profile.isBlocked) return <div className="text-xs text-red-300">Blocked</div>;
    if (profile.isContact) return <div className="text-xs text-emerald-400">Contact</div>;
    return null;
  }
  if (profile.peerType === 'channel') {
    return (
      <div className="text-xs text-gray-500">
        {profile.isBroadcast ? 'Channel' : profile.isMegagroup ? 'Supergroup' : 'Group'}
        {profile.isPublic ? ' · public' : ' · private'}
      </div>
    );
  }
  return <div className="text-xs text-gray-500">Group</div>;
}

function ActionPill({ Icon, label, onClick, disabled, danger }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex flex-col items-center gap-1 rounded-lg border px-4 py-2 text-xs disabled:opacity-50 ${
        danger
          ? 'border-red-400/30 bg-red-400/10 text-red-300 hover:bg-red-400/20'
          : 'border-white/10 bg-dark-800 text-gray-200 hover:bg-white/5'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function InfoRow({ icon: Icon, label, children }) {
  return (
    <div className="rounded-lg border border-white/5 bg-dark-800/40 p-3">
      <div className="mb-1 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-gray-500" />
        <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      </div>
      {children}
    </div>
  );
}
