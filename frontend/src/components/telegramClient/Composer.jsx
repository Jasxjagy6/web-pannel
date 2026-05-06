import React, { useEffect, useRef, useState } from 'react';
import {
  Send, Loader2, Paperclip, Image as ImageIcon, Film, FileText, Mic, Square,
} from 'lucide-react';

const KIND_ICONS = {
  photo: ImageIcon,
  video: Film,
  document: FileText,
  audio: FileText,
};

function _kindForFile(file) {
  if (!file) return 'document';
  const t = (file.type || '').toLowerCase();
  if (t.startsWith('image/')) {
    if (t === 'image/webp' || t === 'image/x-webp') return 'sticker';
    return 'photo';
  }
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return 'document';
}

function _humanBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Composer — text + media + voice composer.
 *
 * Capabilities:
 *  - Plain text (Enter sends, Shift+Enter newlines).
 *  - Photo / video / file via the paperclip menu.
 *    Caption is taken from the textarea so users can attach a file
 *    AND write a caption in one go.
 *  - Voice messages via the microphone button (MediaRecorder API).
 *    Records OGG/Opus where supported, falls back to webm/audio.
 *  - Auto-resizes up to 6 rows; disabled while connecting.
 *
 * Props:
 *   disabled            block input while parent is loading
 *   onSend(text)              -> Promise<boolean>  // text-only send
 *   onSendMedia(payload)      -> Promise<boolean>  // { file, kind, caption, clientMsgId }
 *   onSendVoice(payload)      -> Promise<boolean>  // { file, duration, clientMsgId }
 *   uploadProgressByClientId  Map<string, number>  // 0..1, drives the progress bar
 *
 * onSendMedia / onSendVoice are optional; when omitted the
 * attachment / mic buttons are hidden so older callers still work.
 */
export default function Composer({
  disabled,
  onSend,
  onSendMedia,
  onSendVoice,
  uploadProgressByClientId,
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [staged, setStaged] = useState(null);
  const [activeUploadId, setActiveUploadId] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState(null);
  const [showMenu, setShowMenu] = useState(false);

  const ref = useRef(null);
  const fileInputRef = useRef(null);
  const recorderRef = useRef(null);
  const recorderChunksRef = useRef([]);
  const recordStartRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, 24 * 6);
    el.style.height = `${next}px`;
  }, [text]);

  const progress = activeUploadId
    ? uploadProgressByClientId?.get(activeUploadId) ?? null
    : null;

  const canSendText = !sending && !disabled && !recording && !staged && text.trim().length > 0;
  const canSendMedia = !sending && !disabled && !recording && !!staged && !!onSendMedia;

  const submitText = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled || recording) return;
    setSending(true);
    try {
      const ok = await onSend(trimmed);
      if (ok) setText('');
    } finally {
      setSending(false);
    }
  };

  const submitMedia = async () => {
    if (!staged || !onSendMedia) return;
    setSending(true);
    const clientMsgId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setActiveUploadId(clientMsgId);
    const file = staged.file;
    const kind = staged.kind;
    const caption = text.trim() || '';
    try {
      const ok = await onSendMedia({ file, kind, caption, clientMsgId });
      if (ok) {
        setStaged(null);
        setText('');
      }
    } finally {
      setSending(false);
      setActiveUploadId(null);
    }
  };

  const submit = async () => {
    if (staged) return submitMedia();
    return submitText();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      submit();
    }
  };

  const pickFile = (kind) => {
    setShowMenu(false);
    const accept =
      kind === 'photo' ? 'image/*' :
      kind === 'video' ? 'video/*' :
      kind === 'audio' ? 'audio/*' :
      '*/*';
    const el = fileInputRef.current;
    if (!el) return;
    el.dataset.kind = kind;
    el.accept = accept;
    el.value = '';
    el.click();
  };

  const onFileSelected = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const requested = e.target.dataset.kind || 'auto';
    const kind = requested === 'auto' || requested === 'document' ? _kindForFile(file) : requested;
    setStaged({ file, kind });
  };

  const startRecord = async () => {
    if (recording || sending || disabled || !onSendVoice) return;
    setRecordError(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setRecordError('Voice recording is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let mimeType = 'audio/webm;codecs=opus';
      if (window.MediaRecorder && !MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/ogg;codecs=opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
      }
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorderChunksRef.current = [];
      recordStartRef.current = Date.now();
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recorderChunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch (_) { /* ignore */ }
        const blob = new Blob(recorderChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        const duration = Math.max(1, Math.round((Date.now() - recordStartRef.current) / 1000));
        recorderRef.current = null;
        recorderChunksRef.current = [];
        setRecording(false);
        if (blob.size === 0) return;
        const file = new File([blob], `voice-${Date.now()}.ogg`, {
          type: recorder.mimeType || 'audio/ogg',
        });
        const clientMsgId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setActiveUploadId(clientMsgId);
        setSending(true);
        try {
          await onSendVoice({ file, duration, clientMsgId });
        } finally {
          setSending(false);
          setActiveUploadId(null);
        }
      };
      recorder.start();
      setRecording(true);
    } catch (err) {
      setRecordError(err?.message || 'Microphone permission denied.');
    }
  };

  const stopRecord = () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    try {
      recorder.stop();
    } catch (err) {
      setRecordError(err?.message || 'Failed to stop recorder.');
    }
  };

  const removeStaged = () => {
    if (sending) return;
    setStaged(null);
  };

  const StagedIcon = staged ? (KIND_ICONS[staged.kind] || FileText) : null;

  return (
    <div className="border-t border-white/5 bg-dark-900 px-3 py-2">
      {recordError && (
        <div className="mb-1 rounded-md bg-red-900/30 px-3 py-1 text-xs text-red-300">
          {recordError}
        </div>
      )}
      {staged && (
        <div className="mb-1 flex items-center gap-2 rounded-md bg-dark-800 px-3 py-2 text-xs text-gray-300">
          {StagedIcon && <StagedIcon className="h-4 w-4 text-blue-300" />}
          <span className="truncate">{staged.file.name}</span>
          <span className="ml-auto shrink-0 text-gray-500">{_humanBytes(staged.file.size)}</span>
          <button
            type="button"
            onClick={removeStaged}
            disabled={sending}
            className="shrink-0 rounded px-2 py-0.5 text-[11px] text-gray-400 hover:bg-white/5 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      )}
      {progress != null && progress < 1 && (
        <div className="mb-1 h-1 w-full overflow-hidden rounded-full bg-dark-800">
          <div
            className="h-full bg-blue-500 transition-[width] duration-150"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}
      <div className="flex items-end gap-2 rounded-2xl bg-dark-800 px-3 py-2">
        {(onSendMedia || onSendVoice) && (
          <div className="relative">
            <button
              type="button"
              disabled={disabled || sending || recording}
              onClick={() => setShowMenu((v) => !v)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-white/5 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
              title="Attach"
            >
              <Paperclip className="h-5 w-5" />
            </button>
            {showMenu && (
              <div
                className="absolute bottom-12 left-0 z-30 w-44 rounded-lg border border-white/10 bg-dark-900 py-1 shadow-xl"
                onMouseLeave={() => setShowMenu(false)}
              >
                <MenuItem icon={ImageIcon} label="Photo" onClick={() => pickFile('photo')} />
                <MenuItem icon={Film} label="Video" onClick={() => pickFile('video')} />
                <MenuItem icon={FileText} label="File" onClick={() => pickFile('document')} />
              </div>
            )}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={onFileSelected}
        />

        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled || sending || recording}
          placeholder={
            disabled
              ? 'Connecting…'
              : recording
              ? 'Recording…'
              : staged
              ? 'Add a caption…'
              : 'Write a message…'
          }
          className="flex-1 resize-none bg-transparent text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none"
        />

        {onSendVoice && !staged && !text.trim() && !sending && (
          <button
            type="button"
            disabled={disabled}
            onClick={recording ? stopRecord : startRecord}
            className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition-colors ${
              recording
                ? 'bg-red-500 hover:bg-red-400'
                : 'bg-blue-600 hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-blue-600/40'
            }`}
            title={recording ? 'Stop recording' : 'Record voice message'}
          >
            {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
        )}

        {(canSendText || canSendMedia || sending) && (
          <button
            type="button"
            disabled={!canSendText && !canSendMedia}
            onClick={submit}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-blue-600/40"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-white/5"
    >
      <Icon className="h-4 w-4 text-gray-400" />
      {label}
    </button>
  );
}
