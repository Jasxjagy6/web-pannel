import React, { useState } from 'react';
import { Image as ImageIcon, Film, Music, FileText, Mic, Loader2, Download } from 'lucide-react';
import { useMessageMedia, prefetchMessageMedia } from './useMessageMedia';
import { fetchMessageMediaBlob } from '../../api/telegramClient';
import MediaViewer from './MediaViewer';

const KIND_ICON = {
  photo: ImageIcon,
  sticker: ImageIcon,
  video: Film,
  voice: Mic,
  audio: Music,
  document: FileText,
};

function _humanBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function _formatDuration(s) {
  if (!Number.isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * MediaInline — renders the actual media payload inside a chat bubble,
 * with thumbnails + click-to-open for photo/video, an inline player
 * for audio/voice, and a download button for generic documents.
 *
 * Pending optimistic messages (negative ids) skip the thumbnail fetch
 * — the upload progress bar in MessageBubble already covers them.
 */
const RENDERABLE_KINDS = new Set(['photo', 'video', 'sticker', 'voice', 'audio', 'document']);

export default function MediaInline({
  sessionId,
  peerType,
  peerId,
  message,
  out,
}) {
  const kind = message?.mediaKind;
  if (!kind || !RENDERABLE_KINDS.has(kind)) return null;

  // Optimistic local message (id < 0) — render the staged metadata only.
  const isLocalPending = !message.id || message.id < 0;
  const isClickToView = kind === 'photo' || kind === 'video' || kind === 'sticker';

  // Photos / videos / stickers: thumb in the bubble, full-res on click.
  if (isClickToView) {
    return (
      <PhotoVideoInline
        sessionId={sessionId}
        peerType={peerType}
        peerId={peerId}
        message={message}
        kind={kind}
        out={out}
        isLocalPending={isLocalPending}
      />
    );
  }

  if (kind === 'voice' || kind === 'audio') {
    return (
      <AudioInline
        sessionId={sessionId}
        peerType={peerType}
        peerId={peerId}
        message={message}
        kind={kind}
        out={out}
        isLocalPending={isLocalPending}
      />
    );
  }

  return (
    <DocumentInline
      sessionId={sessionId}
      peerType={peerType}
      peerId={peerId}
      message={message}
      out={out}
      isLocalPending={isLocalPending}
    />
  );
}

function PhotoVideoInline({ sessionId, peerType, peerId, message, kind, out, isLocalPending }) {
  const [open, setOpen] = useState(false);

  const { url: thumbUrl, loading } = useMessageMedia(
    sessionId,
    peerType,
    peerId,
    message.id,
    { thumb: true, enabled: !isLocalPending }
  );

  const w = message.mediaPreview?.width || 240;
  const h = message.mediaPreview?.height || 240;
  const aspect =
    (w && h)
      ? `${w} / ${h}`
      : kind === 'sticker' ? '1 / 1' : '4 / 3';

  const onOpen = (e) => {
    e?.stopPropagation();
    if (kind === 'sticker') return;
    if (isLocalPending) return;
    prefetchMessageMedia(sessionId, peerType, peerId, message.id, { thumb: false }).catch(() => {});
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        className="relative my-1 block max-w-[320px] overflow-hidden rounded-lg bg-black/30 transition-opacity hover:opacity-95"
        style={{ aspectRatio: aspect, width: kind === 'sticker' ? 128 : 280 }}
      >
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            draggable={false}
          />
        ) : loading ? (
          <div className={`flex h-full w-full items-center justify-center ${out ? 'text-blue-100/60' : 'text-gray-500'}`}>
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className={`flex h-full w-full items-center justify-center ${out ? 'text-blue-100/60' : 'text-gray-500'}`}>
            <ImageIcon className="h-6 w-6" />
          </div>
        )}
        {kind === 'video' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-full bg-black/50 p-2">
              <Film className="h-6 w-6 text-white" />
            </div>
          </div>
        )}
      </button>
      {open && (
        <MediaViewer
          sessionId={sessionId}
          peerType={peerType}
          peerId={peerId}
          message={message}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AudioInline({ sessionId, peerType, peerId, message, kind, out, isLocalPending }) {
  const { url, loading } = useMessageMedia(
    sessionId,
    peerType,
    peerId,
    message.id,
    { thumb: false, enabled: !isLocalPending }
  );

  const Icon = kind === 'voice' ? Mic : Music;

  if (isLocalPending) {
    return (
      <div className={`my-1 flex items-center gap-2 text-xs ${out ? 'text-blue-100/80' : 'text-gray-400'}`}>
        <Icon className="h-4 w-4" />
        <span>{kind === 'voice' ? 'Voice message' : 'Audio'}</span>
      </div>
    );
  }

  return (
    <div className={`my-1 flex w-full max-w-[300px] items-center gap-2 rounded-lg bg-black/20 px-2 py-1.5 ${out ? 'text-blue-50' : 'text-gray-100'}`}>
      <Icon className="h-4 w-4 shrink-0 opacity-70" />
      {url ? (
        <audio src={url} controls preload="none" className="h-8 flex-1 min-w-0" />
      ) : loading ? (
        <Loader2 className="h-4 w-4 animate-spin opacity-70" />
      ) : (
        <span className="text-xs opacity-70">Tap to load…</span>
      )}
    </div>
  );
}

function DocumentInline({ sessionId, peerType, peerId, message, out, isLocalPending }) {
  const fileName = message?.mediaPreview?.fileName || `file-${message.id}`;
  const [busy, setBusy] = useState(false);

  const onDownload = async (e) => {
    e?.stopPropagation();
    if (isLocalPending) return;
    setBusy(true);
    try {
      const res = await fetchMessageMediaBlob(sessionId, peerType, peerId, message.id, {
        download: true,
      });
      if (!res || !res.blob) return;
      const objUrl = URL.createObjectURL(res.blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objUrl), 1500);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`my-1 flex w-full max-w-[280px] items-center gap-2 rounded-lg bg-black/20 px-2 py-1.5 ${out ? 'text-blue-50' : 'text-gray-100'}`}>
      <FileText className="h-5 w-5 shrink-0 opacity-80" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{fileName}</div>
        {message?.mediaPreview?.size != null && (
          <div className="truncate text-[10px] opacity-60">
            {_humanBytes(message.mediaPreview.size)}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDownload}
        disabled={busy || isLocalPending}
        className="shrink-0 rounded-full p-1 text-white/70 hover:bg-white/10 disabled:opacity-50"
        title="Download"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      </button>
    </div>
  );
}

export { _humanBytes, _formatDuration, KIND_ICON };
