import { useState, useEffect, useCallback } from 'react';
import { UploadCloud, Download, Trash2, FileText, Image as ImageIcon, Archive } from 'lucide-react';
import { trackingAccountsAPI } from '@/api';
import { useToast } from '../common/Toast';
import { parseApiError, formatDateTime, formatBytes } from '@/utils/formatters';
import ConfirmDialog from '../common/ConfirmDialog';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

const CATEGORY_ICON = {
  session_file: Archive,
  backup_file: Archive,
  screenshot: ImageIcon,
  document: FileText,
  other: FileText,
};

const CATEGORY_LABEL = {
  session_file: 'Session File', backup_file: 'Backup File', screenshot: 'Screenshot',
  document: 'Document', other: 'Other',
};

export default function AttachmentsTab({ accountId }) {
  const { success, error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();
  const canEdit = hasPermission('edit');

  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('screenshot');
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const fetchAttachments = useCallback(async () => {
    setLoading(true);
    try {
      const response = await trackingAccountsAPI.getAttachments(accountId);
      setAttachments(response.data.data || []);
    } catch (err) {
      showError(parseApiError(err), 'Failed to load attachments');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => { fetchAttachments(); }, [fetchAttachments]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('category', category);
      await trackingAccountsAPI.uploadAttachment(accountId, formData);
      success('File uploaded');
      fetchAttachments();
    } catch (err) {
      showError(parseApiError(err), 'Upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleDownload = async (attachment) => {
    try {
      const response = await trackingAccountsAPI.downloadAttachment(accountId, attachment.id);
      const url = URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showError(parseApiError(err), 'Download failed');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await trackingAccountsAPI.deleteAttachment(accountId, deleteTarget.id);
      success('Attachment deleted');
      fetchAttachments();
    } catch (err) {
      showError(parseApiError(err), 'Failed to delete attachment');
    }
  };

  if (loading) return <p className="text-sm text-gray-400 py-6">Loading…</p>;

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-200"
          >
            {Object.entries(CATEGORY_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <label className="flex items-center gap-2 rounded-lg border border-dashed border-white/15 px-4 py-2 text-sm text-gray-400 hover:border-primary-500/50 hover:text-primary-400 cursor-pointer transition-colors">
            <UploadCloud className="h-4 w-4" />
            {uploading ? 'Uploading…' : 'Upload file'}
            <input type="file" className="hidden" disabled={uploading} onChange={handleUpload} />
          </label>
        </div>
      )}

      {attachments.length === 0 ? (
        <p className="text-sm text-gray-500">No attachments yet.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {attachments.map((a) => {
            const Icon = CATEGORY_ICON[a.category] || FileText;
            return (
              <div key={a.id} className="flex items-center justify-between rounded-lg border border-white/5 bg-dark-800/30 px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Icon className="h-5 w-5 text-gray-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-gray-200 truncate">{a.fileName}</p>
                    <p className="text-xs text-gray-500">
                      {CATEGORY_LABEL[a.category]} · {formatBytes(a.fileSizeBytes || 0)} · {formatDateTime(a.createdAt)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => handleDownload(a)} className="rounded-lg p-1.5 text-gray-400 hover:text-white hover:bg-white/10" title="Download">
                    <Download className="h-4 w-4" />
                  </button>
                  {canEdit && (
                    <button onClick={() => setDeleteTarget(a)} className="rounded-lg p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-400/10" title="Delete">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete attachment?"
        message={`This will permanently delete "${deleteTarget?.fileName}".`}
        confirmLabel="Delete"
      />
    </div>
  );
}
