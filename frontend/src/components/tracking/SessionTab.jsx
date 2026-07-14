import { useState, useEffect, useCallback } from 'react';
import { UploadCloud, FileCheck2 } from 'lucide-react';
import { trackingAccountsAPI } from '@/api';
import { useToast } from '../common/Toast';
import { parseApiError, formatDateTime, formatBytes } from '@/utils/formatters';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

const inputClass = 'w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500';
const labelClass = 'block text-xs font-medium text-gray-400 mb-1';

export default function SessionTab({ accountId, onChanged }) {
  const { success, error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ sessionName: '', sessionVersion: '', encryptionStatus: 'none' });
  const [deviceForm, setDeviceForm] = useState({
    appId: '', appHash: '', deviceModel: '', systemVersion: '', clientAppVersion: '',
    langPack: '', systemLangPack: '', appConfigHash: '',
  });
  const [saving, setSaving] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadingBackup, setUploadingBackup] = useState(false);

  const fetchSession = useCallback(async () => {
    setLoading(true);
    try {
      const response = await trackingAccountsAPI.getSession(accountId);
      const data = response.data.data;
      setSession(data);
      setForm({
        sessionName: data?.sessionName || '',
        sessionVersion: data?.sessionVersion || '',
        encryptionStatus: data?.encryptionStatus || 'none',
      });
      setDeviceForm({
        appId: data?.appId ?? '', appHash: data?.appHash || '', deviceModel: data?.deviceModel || '',
        systemVersion: data?.systemVersion || '', clientAppVersion: data?.clientAppVersion || '',
        langPack: data?.langPack || '', systemLangPack: data?.systemLangPack || '', appConfigHash: data?.appConfigHash || '',
      });
    } catch (err) {
      showError(parseApiError(err), 'Failed to load session info');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => { fetchSession(); }, [fetchSession]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await trackingAccountsAPI.updateSession(accountId, {
        ...form,
        ...deviceForm,
        appId: deviceForm.appId === '' ? null : Number(deviceForm.appId),
      });
      success('Session info saved');
      fetchSession();
      onChanged?.();
    } catch (err) {
      showError(parseApiError(err), 'Failed to save session info');
    } finally {
      setSaving(false);
    }
  };

  const handleUpload = async (e, type) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const setBusy = type === 'file' ? setUploadingFile : setUploadingBackup;
    setBusy(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (type === 'file') {
        await trackingAccountsAPI.uploadSessionFile(accountId, formData);
        success('Session file uploaded');
      } else {
        await trackingAccountsAPI.uploadBackupFile(accountId, formData);
        success('Backup file uploaded');
      }
      fetchSession();
      onChanged?.();
    } catch (err) {
      showError(parseApiError(err), 'Upload failed');
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  if (loading) return <p className="text-sm text-gray-400 py-6">Loading…</p>;
  const canEdit = hasPermission('edit');

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="rounded-xl border border-white/5 bg-dark-800/50 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Session File</h3>
        {session?.sessionFileAttachmentId ? (
          <div className="flex items-center gap-2 text-sm text-green-400">
            <FileCheck2 className="h-4 w-4" /> Uploaded {formatDateTime(session.uploadedAt)}
            {session.sessionSizeBytes != null && <span className="text-gray-500">({formatBytes(session.sessionSizeBytes)})</span>}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No session file uploaded yet.</p>
        )}
        {canEdit && (
          <label className="flex items-center gap-2 rounded-lg border border-dashed border-white/15 px-4 py-3 text-sm text-gray-400 hover:border-primary-500/50 hover:text-primary-400 cursor-pointer transition-colors">
            <UploadCloud className="h-4 w-4" />
            {uploadingFile ? 'Uploading…' : 'Upload session file'}
            <input type="file" className="hidden" disabled={uploadingFile} onChange={(e) => handleUpload(e, 'file')} />
          </label>
        )}

        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide pt-2">Backup File</h3>
        {session?.backupAvailable ? (
          <div className="flex items-center gap-2 text-sm text-green-400">
            <FileCheck2 className="h-4 w-4" /> Backed up {formatDateTime(session.backupDate)}
          </div>
        ) : (
          <p className="text-sm text-amber-400">No backup on file.</p>
        )}
        {canEdit && (
          <label className="flex items-center gap-2 rounded-lg border border-dashed border-white/15 px-4 py-3 text-sm text-gray-400 hover:border-primary-500/50 hover:text-primary-400 cursor-pointer transition-colors">
            <UploadCloud className="h-4 w-4" />
            {uploadingBackup ? 'Uploading…' : 'Upload backup file'}
            <input type="file" className="hidden" disabled={uploadingBackup} onChange={(e) => handleUpload(e, 'backup')} />
          </label>
        )}
      </div>

      <div className="rounded-xl border border-white/5 bg-dark-800/50 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Session Metadata</h3>
        <div>
          <label className={labelClass}>Session name</label>
          <input className={inputClass} disabled={!canEdit} value={form.sessionName} onChange={(e) => setForm((f) => ({ ...f, sessionName: e.target.value }))} />
        </div>
        <div>
          <label className={labelClass}>Session version</label>
          <input className={inputClass} disabled={!canEdit} value={form.sessionVersion} onChange={(e) => setForm((f) => ({ ...f, sessionVersion: e.target.value }))} />
        </div>
        <div>
          <label className={labelClass}>Encryption status</label>
          <select className={inputClass} disabled={!canEdit} value={form.encryptionStatus} onChange={(e) => setForm((f) => ({ ...f, encryptionStatus: e.target.value }))}>
            <option value="none">None</option>
            <option value="encrypted">Encrypted</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
        {session?.lastUpdatedAt && (
          <p className="text-xs text-gray-500">Last updated {formatDateTime(session.lastUpdatedAt)}</p>
        )}
        {canEdit && (
          <button onClick={handleSave} disabled={saving} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>

      <div className="md:col-span-2 rounded-xl border border-white/5 bg-dark-800/50 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Device / Client Fingerprint</h3>
        <p className="text-xs text-gray-500 -mt-2">
          Passive record of the client that created this session (usually auto-filled from a session ZIP import). Never used to connect.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className={labelClass}>App ID</label>
            <input className={inputClass} disabled={!canEdit} value={deviceForm.appId} onChange={(e) => setDeviceForm((f) => ({ ...f, appId: e.target.value }))} />
          </div>
          <div className="col-span-2">
            <label className={labelClass}>App Hash</label>
            <input className={inputClass} disabled={!canEdit} value={deviceForm.appHash} onChange={(e) => setDeviceForm((f) => ({ ...f, appHash: e.target.value }))} />
          </div>
          <div>
            <label className={labelClass}>App Version</label>
            <input className={inputClass} disabled={!canEdit} value={deviceForm.clientAppVersion} onChange={(e) => setDeviceForm((f) => ({ ...f, clientAppVersion: e.target.value }))} />
          </div>
          <div>
            <label className={labelClass}>Device</label>
            <input className={inputClass} disabled={!canEdit} value={deviceForm.deviceModel} onChange={(e) => setDeviceForm((f) => ({ ...f, deviceModel: e.target.value }))} />
          </div>
          <div>
            <label className={labelClass}>System / SDK</label>
            <input className={inputClass} disabled={!canEdit} value={deviceForm.systemVersion} onChange={(e) => setDeviceForm((f) => ({ ...f, systemVersion: e.target.value }))} />
          </div>
          <div>
            <label className={labelClass}>Lang Pack</label>
            <input className={inputClass} disabled={!canEdit} value={deviceForm.langPack} onChange={(e) => setDeviceForm((f) => ({ ...f, langPack: e.target.value }))} />
          </div>
          <div>
            <label className={labelClass}>System Lang Pack</label>
            <input className={inputClass} disabled={!canEdit} value={deviceForm.systemLangPack} onChange={(e) => setDeviceForm((f) => ({ ...f, systemLangPack: e.target.value }))} />
          </div>
          <div className="col-span-2">
            <label className={labelClass}>App Config Hash</label>
            <input className={inputClass} disabled={!canEdit} value={deviceForm.appConfigHash} onChange={(e) => setDeviceForm((f) => ({ ...f, appConfigHash: e.target.value }))} />
          </div>
        </div>
        {session?.sessionCreatedAt && (
          <p className="text-xs text-gray-500">Session created {formatDateTime(session.sessionCreatedAt)}</p>
        )}
      </div>
    </div>
  );
}
