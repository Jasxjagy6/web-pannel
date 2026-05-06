import React from 'react';
import { useProfilePhoto } from './useProfilePhoto';

const PALETTE = [
  'bg-rose-500', 'bg-orange-500', 'bg-amber-500', 'bg-lime-500',
  'bg-emerald-500', 'bg-teal-500', 'bg-cyan-500', 'bg-sky-500',
  'bg-blue-500', 'bg-indigo-500', 'bg-violet-500', 'bg-fuchsia-500',
  'bg-pink-500',
];

function _initials(label) {
  if (!label) return '?';
  const parts = String(label).trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] || '').join('').toUpperCase() || '?';
}

function _color(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/**
 * Avatar — displays a user/chat/channel profile photo with initials fallback.
 *
 * Props:
 *   sessionId   panel session id (for photo fetch auth)
 *   peerType    'user' | 'chat' | 'channel'
 *   peerId      numeric id
 *   label       display name (for initials + color seeding)
 *   size        'sm' | 'md' | 'lg'  (default 'md')
 *   large       fetch the high-res photo (default false)
 *   className   extra Tailwind classes
 */
export default function Avatar({
  sessionId,
  peerType,
  peerId,
  label,
  size = 'md',
  large = false,
  className = '',
}) {
  const { url } = useProfilePhoto(sessionId, peerType, peerId, { large });
  const sizeClass =
    size === 'sm' ? 'h-8 w-8 text-xs' :
    size === 'lg' ? 'h-12 w-12 text-base' :
    'h-10 w-10 text-sm';
  const colorClass = _color(`${peerType}:${peerId}:${label || ''}`);

  return (
    <div
      className={`relative shrink-0 rounded-full overflow-hidden flex items-center justify-center text-white font-semibold ${sizeClass} ${url ? 'bg-dark-700' : colorClass} ${className}`}
      title={label || ''}
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <span>{_initials(label)}</span>
      )}
    </div>
  );
}
