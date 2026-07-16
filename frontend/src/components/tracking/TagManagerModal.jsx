import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { Modal } from '../common/Modal';
import { trackingTagsAPI, trackingAccountsAPI } from '@/api';
import { useToast } from '../common/Toast';
import { parseApiError } from '@/utils/formatters';

export default function TagManagerModal({ isOpen, onClose, accountId, currentTags = [], onChanged }) {
  const { success, error: showError } = useToast();
  const [catalog, setCatalog] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newTagName, setNewTagName] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setSelected(new Set(currentTags.map((t) => t.id)));
    setLoading(true);
    trackingTagsAPI.list()
      .then((response) => setCatalog(response.data.data || []))
      .catch((err) => showError(parseApiError(err), 'Failed to load tags'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const toggle = (tagId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId); else next.add(tagId);
      return next;
    });
  };

  const handleCreateTag = async () => {
    if (!newTagName.trim()) return;
    try {
      const response = await trackingTagsAPI.create({ name: newTagName.trim() });
      const tag = response.data.data;
      setCatalog((prev) => [...prev, tag]);
      setSelected((prev) => new Set(prev).add(tag.id));
      setNewTagName('');
    } catch (err) {
      showError(parseApiError(err), 'Failed to create tag');
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const originalIds = new Set(currentTags.map((t) => t.id));
      const toAdd = [...selected].filter((id) => !originalIds.has(id));
      const toRemove = [...originalIds].filter((id) => !selected.has(id));

      if (toAdd.length > 0) {
        await trackingAccountsAPI.setTags(accountId, toAdd);
      }
      for (const tagId of toRemove) {
        await trackingAccountsAPI.removeTag(accountId, tagId);
      }
      success('Tags updated');
      onChanged?.();
      onClose();
    } catch (err) {
      showError(parseApiError(err), 'Failed to update tags');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Manage Tags"
      footer={
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:bg-white/5">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {catalog.map((tag) => (
              <button
                key={tag.id}
                onClick={() => toggle(tag.id)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium border transition-colors ${
                  selected.has(tag.id)
                    ? 'border-primary-500/50 bg-primary-500/15 text-primary-300'
                    : 'border-white/10 text-gray-400 hover:bg-white/5'
                }`}
              >
                {tag.name}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateTag(); } }}
              placeholder="New tag name"
              className="flex-1 rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <button onClick={handleCreateTag} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5">
              <Plus className="h-4 w-4" /> Add
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
