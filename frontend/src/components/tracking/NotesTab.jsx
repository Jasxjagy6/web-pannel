import { useState, useEffect, useCallback } from 'react';
import { Send } from 'lucide-react';
import { trackingAccountsAPI } from '@/api';
import { useToast } from '../common/Toast';
import { parseApiError, formatDateTime } from '@/utils/formatters';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

export default function NotesTab({ accountId }) {
  const { success, error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();
  const canEdit = hasPermission('edit');

  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchNotes = useCallback(async () => {
    setLoading(true);
    try {
      const response = await trackingAccountsAPI.getNotes(accountId);
      setNotes(response.data.data || []);
    } catch (err) {
      showError(parseApiError(err), 'Failed to load notes');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => { fetchNotes(); }, [fetchNotes]);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSubmitting(true);
    try {
      await trackingAccountsAPI.addNote(accountId, { note: text.trim() });
      setText('');
      success('Note added');
      fetchNotes();
    } catch (err) {
      showError(parseApiError(err), 'Failed to add note');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <p className="text-sm text-gray-400 py-6">Loading…</p>;

  return (
    <div className="space-y-4 max-w-2xl">
      {canEdit && (
        <form onSubmit={handleAdd} className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add a note — e.g. 'Reserved until Friday'"
            className="flex-1 rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <button type="submit" disabled={submitting || !text.trim()} className="flex items-center gap-1.5 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">
            <Send className="h-4 w-4" />
          </button>
        </form>
      )}

      {notes.length === 0 ? (
        <p className="text-sm text-gray-500">No notes yet.</p>
      ) : (
        <div className="space-y-2">
          {notes.map((n) => (
            <div key={n.id} className="rounded-lg border border-white/5 bg-dark-800/30 px-4 py-3">
              <p className="text-sm text-gray-200 whitespace-pre-wrap">{n.note}</p>
              <p className="text-xs text-gray-500 mt-1">{n.authorEmail || 'Unknown'} — {formatDateTime(n.createdAt)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
