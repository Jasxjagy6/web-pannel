import React, { useState, useRef, useEffect } from 'react';
import { Check, CheckCheck, AlertCircle, Reply, Forward, Pencil, Trash2, Copy, MoreHorizontal, Pin, PinOff } from 'lucide-react';
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
  messagesById,
  canMessageActions,
  onReply,
  onForward,
  onEdit,
  onDelete,
  onJumpToMessage,
  isPinned,
  canPinned,
  onPin,
  onUnpin,
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

  const replyMessage = message.replyToMsgId && messagesById
    ? messagesById.get(Number(message.replyToMsgId))
    : null;

  const isLocalPending = !message.id || message.id < 0;
  const canEdit = !!canMessageActions && out && !isLocalPending && (!message.mediaKind || message.text != null);
  const canDelete = !!canMessageActions && !isLocalPending;
  const canReply = !!canMessageActions && !isLocalPending;
  const canForward = !!canMessageActions && !isLocalPending;

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
          id={`tgmsg-${message.id}`}
          className={`group relative rounded-2xl px-3 py-1.5 shadow-sm ${bubbleColor} ${
            message.failed ? 'opacity-70 ring-1 ring-red-500/60' : ''
          } ${message.pending ? 'opacity-80' : ''}`}
        >
          {(canReply || canForward || canEdit || canDelete || (canPinned && !isLocalPending)) && (
            <BubbleMenu
              out={out}
              canReply={canReply}
              canForward={canForward}
              canEdit={canEdit}
              canDelete={canDelete}
              canPin={!!canPinned && !isLocalPending && !isPinned}
              canUnpin={!!canPinned && !isLocalPending && !!isPinned}
              hasText={!!message.text}
              onReply={() => onReply?.(message)}
              onForward={() => onForward?.(message)}
              onEdit={() => onEdit?.(message)}
              onDelete={() => onDelete?.(message)}
              onPin={() => onPin?.(message)}
              onUnpin={() => onUnpin?.(message)}
            />
          )}
          {message.replyToMsgId && (
            <ReplyQuote
              out={out}
              replyMessage={replyMessage}
              replyToMsgId={message.replyToMsgId}
              onJump={onJumpToMessage}
            />
          )}
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

function BubbleMenu({
  out, canReply, canForward, canEdit, canDelete, canPin, canUnpin, hasText,
  onReply, onForward, onEdit, onDelete, onPin, onUnpin,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onCopy = async () => {
    setOpen(false);
    try {
      const text = ref.current?.closest('[id^="tgmsg-"]')
        ?.querySelector('div.whitespace-pre-wrap')?.textContent;
      if (text && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch (_) { /* ignore */ }
  };

  return (
    <div ref={ref} className="absolute -top-3 right-1 z-10">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={`opacity-0 transition-opacity group-hover:opacity-100 rounded-full p-1 ${out ? 'bg-blue-700 text-white hover:bg-blue-800' : 'bg-dark-600 text-gray-200 hover:bg-dark-500'}`}
        title="Message actions"
        aria-label="Message actions"
      >
        <MoreHorizontal className="h-3 w-3" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-6 z-20 w-40 rounded-lg border border-white/10 bg-dark-900 py-1 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          {canReply && <MenuRow icon={Reply} label="Reply" onClick={() => { setOpen(false); onReply?.(); }} />}
          {canForward && <MenuRow icon={Forward} label="Forward" onClick={() => { setOpen(false); onForward?.(); }} />}
          {canEdit && <MenuRow icon={Pencil} label="Edit" onClick={() => { setOpen(false); onEdit?.(); }} />}
          {canPin && <MenuRow icon={Pin} label="Pin" onClick={() => { setOpen(false); onPin?.(); }} />}
          {canUnpin && <MenuRow icon={PinOff} label="Unpin" onClick={() => { setOpen(false); onUnpin?.(); }} />}
          {hasText && <MenuRow icon={Copy} label="Copy text" onClick={onCopy} />}
          {canDelete && (
            <MenuRow
              icon={Trash2}
              label="Delete"
              variant="danger"
              onClick={() => { setOpen(false); onDelete?.(); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function MenuRow({ icon: Icon, label, onClick, variant }) {
  const cls = variant === 'danger' ? 'text-red-300 hover:bg-red-500/10' : 'text-gray-200 hover:bg-white/5';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${cls}`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function ReplyQuote({ out, replyMessage, replyToMsgId, onJump }) {
  const text = replyMessage?.text || (replyMessage?.mediaKind ? _mediaLabel(replyMessage.mediaKind) : null);
  const accent = out ? 'border-blue-200/70 bg-blue-700/40' : 'border-blue-300/70 bg-dark-600/60';
  return (
    <button
      type="button"
      onClick={() => replyMessage && onJump?.(replyMessage.id)}
      className={`mb-1 block w-full max-w-full overflow-hidden rounded border-l-2 px-2 py-1 text-left text-[11px] leading-tight ${accent}`}
      title={replyMessage ? 'Jump to message' : 'Original message not loaded'}
    >
      <div className={`truncate ${out ? 'text-blue-50/80' : 'text-blue-200'}`}>
        {replyMessage?.senderTitle || 'Reply'}
      </div>
      <div className={`truncate ${out ? 'text-blue-50' : 'text-gray-200'}`}>
        {text || `Message #${replyToMsgId}`}
      </div>
    </button>
  );
}
