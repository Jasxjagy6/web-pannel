import React from 'react';
import { Check, CheckCheck, AlertCircle } from 'lucide-react';
import Avatar from './Avatar';
import MediaInline from './MediaInline';

function _time(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const RENDERABLE_INLINE_KINDS = new Set([
  'photo', 'video', 'sticker', 'voice', 'audio', 'document',
]);

function _mediaLabel(kind) {
  if (!kind) return null;
  switch (kind) {
    case 'photo': return '🖼  Photo';
    case 'video': return '🎬  Video';
    case 'audio': return '🎵  Audio';
    case 'sticker': return '🎟  Sticker';
    case 'document': return '📎  Document';
    case 'webpage': return '🔗  Link preview';
    case 'geo': return '📍  Location';
    case 'contact': return '👤  Contact';
    case 'poll': return '📊  Poll';
    default: return '📎  Media';
  }
}

/**
 * MessageBubble — single message row in the chat pane.
 *
 * Props:
 *   sessionId
 *   message   normalized message
 *   sender    optional normalized sender (only used for non-out messages)
 *   showSenderHeader  show name above the bubble (group chat first message in a run)
 *   showAvatar        render the avatar slot (otherwise reserve space for alignment)
 *   peerType / peerId — the active dialog (used to clamp avatar lookups)
 */
export default function MessageBubble({
  sessionId,
  message,
  sender,
  showSenderHeader,
  showAvatar,
  peerType,
  peerId,
  uploadProgress,
}) {
  const out = !!message.out;
  const isService = !!message.isService;

  if (isService) {
    return (
      <div className="my-2 flex justify-center">
        <span className="rounded-full bg-white/5 px-3 py-1 text-[11px] uppercase tracking-wide text-gray-400">
          {message.actionType?.replace(/^MessageAction/, '') || 'Service'}
        </span>
      </div>
    );
  }

  const bubbleColor = out
    ? 'bg-blue-600/95 text-white'
    : 'bg-dark-700 text-gray-100';
  const align = out ? 'justify-end' : 'justify-start';

  return (
    <div className={`my-0.5 flex w-full items-end gap-2 ${align}`}>
      {!out && showAvatar && sender && (
        <Avatar
          sessionId={sessionId}
          peerType={sender.peerType}
          peerId={sender.peerId}
          label={sender.title}
          size="sm"
        />
      )}
      {!out && !showAvatar && <div className="h-8 w-8 shrink-0" />}

      <div className={`flex max-w-[72%] flex-col ${out ? 'items-end' : 'items-start'}`}>
        {!out && showSenderHeader && sender?.title && (
          <span className="mb-0.5 px-1 text-[11px] font-semibold text-blue-300">
            {sender.title}
          </span>
        )}

        <div
          className={`group relative rounded-2xl px-3 py-1.5 shadow-sm ${bubbleColor} ${
            message.failed ? 'opacity-70 ring-1 ring-red-500/60' : ''
          } ${message.pending ? 'opacity-80' : ''}`}
        >
          {message.mediaKind && (
            <MediaInline
              sessionId={sessionId}
              peerType={peerType}
              peerId={peerId}
              message={message}
              out={out}
            />
          )}
          {message.mediaKind && !RENDERABLE_INLINE_KINDS.has(message.mediaKind) && (
            <div className={`mb-1 text-xs ${out ? 'text-blue-100/80' : 'text-gray-400'}`}>
              {_mediaLabel(message.mediaKind)}
            </div>
          )}
          {typeof uploadProgress === 'number' && uploadProgress < 1 && (
            <div className="mb-1 h-1 w-full overflow-hidden rounded-full bg-black/20">
              <div
                className="h-full bg-white/80 transition-[width] duration-150"
                style={{ width: `${Math.round(uploadProgress * 100)}%` }}
              />
            </div>
          )}
          {message.text && (
            <div className="whitespace-pre-wrap break-words text-sm leading-snug">
              {message.text}
            </div>
          )}
          <div
            className={`mt-0.5 flex items-center gap-1 text-[10px] ${
              out ? 'text-blue-100/70' : 'text-gray-500'
            }`}
          >
            <span>{_time(message.date)}</span>
            {message.editDate && message.editDate !== message.date && (
              <span className="italic">edited</span>
            )}
            {out && message.failed && (
              <AlertCircle className="h-3 w-3 text-red-300" />
            )}
            {out && message.pending && !message.failed && (
              <span className="opacity-60">…</span>
            )}
            {out && !message.pending && !message.failed && (
              <Check className="h-3 w-3" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
