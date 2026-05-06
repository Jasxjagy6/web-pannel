import React, { useEffect, useState } from 'react';
import { X, Download, Loader2 } from 'lucide-react';
import { useMessageMedia } from './useMessageMedia';
import { fetchMessageMediaBlob } from '../../api/telegramClient';

/**
 * MediaViewer — full-screen lightbox for a single message's photo/video.
 *
 * Closes on Escape or backdrop click. Renders <video> for video kinds
 * (browser handles streaming via the Range header the backend sets).
 */
export default function MediaViewer({ sessionId, peerType, peerId, message, onClose }) {
  const { url, loading } = useMessageMedia(
    sessionId,
    peerType,
    peerId,
    message.id,
    { thumb: false }
  );
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isVideo = message.mediaKind === 'video';
  const fileName = message?.mediaPreview?.fileName || `media-${message.id}`;

  const onDownload = async () => {
    setDownloading(true);
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
      setDownloading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
    >
      <div
        className="absolute right-3 top-3 flex items-center gap-2 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onDownload}
          disabled={downloading}
          className="rounded-full bg-white/10 p-2 hover:bg-white/20 disabled:opacity-50"
          title="Download"
        >
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full bg-white/10 p-2 hover:bg-white/20"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div onClick={(e) => e.stopPropagation()} className="flex max-h-full max-w-full">
        {loading || !url ? (
          <div className="flex items-center gap-2 text-white">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : isVideo ? (
          <video
            src={url}
            controls
            autoPlay
            className="max-h-[90vh] max-w-[90vw] rounded-lg shadow-2xl"
          />
        ) : (
          <img
            src={url}
            alt={fileName}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
            draggable={false}
          />
        )}
      </div>
    </div>
  );
}
