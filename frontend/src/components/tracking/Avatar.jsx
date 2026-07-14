/**
 * Avatar — small round profile picture with an initials fallback.
 * `src` is a data URI (from a synced Telegram session) or null.
 */
export default function Avatar({ src, name, size = 32 }) {
  const initials = (name || '?').trim().slice(0, 2).toUpperCase();
  const dim = { width: size, height: size };
  if (src) {
    return (
      <img
        src={src}
        alt={name || 'avatar'}
        style={dim}
        className="rounded-full object-cover ring-1 ring-white/10 shrink-0"
      />
    );
  }
  return (
    <span
      style={dim}
      className="inline-flex items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold text-gray-300 ring-1 ring-white/10 shrink-0"
    >
      {initials}
    </span>
  );
}
