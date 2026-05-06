import React, { useEffect, useRef, useState } from 'react';
import { Send, Loader2 } from 'lucide-react';

/**
 * Composer — text input + send button at the bottom of ChatPane.
 *
 * Production-ready behaviours:
 *   - Enter sends, Shift+Enter newlines.
 *   - Auto-resizes up to 6 rows.
 *   - Disables / shows spinner while a send is in flight.
 *   - Clears on success only (failed sends keep the text so the user
 *     can retry without retyping).
 */
export default function Composer({ disabled, onSend }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, 24 * 6); // 6 rows max
    el.style.height = `${next}px`;
  }, [text]);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;
    setSending(true);
    try {
      const ok = await onSend(trimmed);
      if (ok) setText('');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-white/5 bg-dark-900 px-3 py-2">
      <div className="flex items-end gap-2 rounded-2xl bg-dark-800 px-3 py-2">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled || sending}
          placeholder={disabled ? 'Connecting…' : 'Write a message…'}
          className="flex-1 resize-none bg-transparent text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none"
        />
        <button
          type="button"
          disabled={!text.trim() || sending || disabled}
          onClick={submit}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-blue-600/40"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}
