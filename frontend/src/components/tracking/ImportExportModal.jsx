import { useState } from 'react';
import { Upload, Download, FileDown, Archive } from 'lucide-react';
import { Modal } from '../common/Modal';
import { trackingImportExportAPI } from '@/api';
import { useToast } from '../common/Toast';
import { parseApiError } from '@/utils/formatters';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

function triggerBlobDownload(blobData, filename) {
  const url = URL.createObjectURL(new Blob([blobData]));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const FORMATS = [
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
  { value: 'xlsx', label: 'Excel (.xlsx)' },
];

export default function ImportExportModal({ isOpen, onClose, currentFilters, onImported }) {
  const { success, error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();
  const [tab, setTab] = useState('import');

  const [importFormat, setImportFormat] = useState('csv');
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const [exportFormat, setExportFormat] = useState('csv');
  const [exportFiltered, setExportFiltered] = useState(true);
  const [exporting, setExporting] = useState(false);

  const [zipFile, setZipFile] = useState(null);
  const [zipImporting, setZipImporting] = useState(false);
  const [zipResult, setZipResult] = useState(null);

  const handleImport = async () => {
    if (!importFile) return;
    setImporting(true);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append('file', importFile);
      const response = await trackingImportExportAPI.importAccounts(formData, importFormat);
      setImportResult(response.data.data);
      success(`Imported ${response.data.data.imported} of ${response.data.data.total} rows`);
      onImported?.();
    } catch (err) {
      showError(parseApiError(err), 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handleZipImport = async () => {
    if (!zipFile) return;
    setZipImporting(true);
    setZipResult(null);
    try {
      const formData = new FormData();
      formData.append('file', zipFile);
      const response = await trackingImportExportAPI.importSessionZip(formData);
      setZipResult(response.data.data);
      success(`${response.data.data.created} created, ${response.data.data.updated} updated`);
      onImported?.();
    } catch (err) {
      showError(parseApiError(err), 'Session ZIP import failed');
    } finally {
      setZipImporting(false);
    }
  };

  const handleTemplate = async () => {
    try {
      const response = await trackingImportExportAPI.downloadTemplate();
      triggerBlobDownload(response.data, 'tracking-import-template.csv');
    } catch (err) {
      showError(parseApiError(err), 'Failed to download template');
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = { format: exportFormat, ...(exportFiltered ? currentFilters : {}) };
      const response = await trackingImportExportAPI.exportAccounts(params);
      const ext = exportFormat === 'xlsx' ? 'xlsx' : exportFormat;
      triggerBlobDownload(response.data, `tracking-accounts.${ext}`);
      success('Export downloaded');
    } catch (err) {
      showError(parseApiError(err), 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const activeFilterCount = Object.keys(currentFilters || {}).length;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Import / Export" size="lg">
      <div className="flex gap-1 border-b border-white/5 mb-4">
        {[
          { key: 'import', label: 'Import' },
          { key: 'session-zip', label: 'Session ZIP' },
          { key: 'export', label: 'Export' },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key ? 'border-primary-500 text-primary-400' : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'import' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-400">Upload a CSV, JSON, or Excel file of accounts.</p>
            <button onClick={handleTemplate} className="flex items-center gap-1.5 text-xs text-primary-400 hover:text-primary-300">
              <FileDown className="h-3.5 w-3.5" /> Download template
            </button>
          </div>

          <select value={importFormat} onChange={(e) => setImportFormat(e.target.value)} className="rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-200">
            {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>

          <label className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-white/15 px-4 py-8 text-sm text-gray-400 hover:border-primary-500/50 hover:text-primary-400 cursor-pointer transition-colors">
            <Upload className="h-6 w-6" />
            {importFile ? importFile.name : 'Click to choose a file'}
            <input
              type="file"
              className="hidden"
              accept=".csv,.json,.xlsx,.txt"
              onChange={(e) => setImportFile(e.target.files?.[0] || null)}
            />
          </label>

          {hasPermission('edit') && (
            <button
              onClick={handleImport}
              disabled={!importFile || importing}
              className="w-full rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {importing ? 'Importing…' : 'Import'}
            </button>
          )}

          {importResult && (
            <div className="rounded-lg border border-white/10 bg-dark-900 p-4 text-sm">
              <p className="text-green-400">{importResult.imported} of {importResult.total} rows imported.</p>
              {importResult.errors.length > 0 && (
                <div className="mt-2 max-h-40 overflow-y-auto space-y-1">
                  {importResult.errors.map((e, i) => (
                    <p key={i} className="text-xs text-red-400">Row {e.row}: {e.error}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'session-zip' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            Upload a ZIP containing paired <code className="text-gray-300">&lt;name&gt;.session</code> +{' '}
            <code className="text-gray-300">&lt;name&gt;.json</code> files (one pair per account — bulk-friendly,
            any number of pairs). The session file is only ever stored, never opened or connected to. Metadata
            (phone, Telegram ID, username, premium, device/client fingerprint, 2FA, spam/premium status) is
            extracted automatically. An existing account with a matching phone number is updated instead of
            duplicated.
          </p>

          <label className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-white/15 px-4 py-8 text-sm text-gray-400 hover:border-primary-500/50 hover:text-primary-400 cursor-pointer transition-colors">
            <Archive className="h-6 w-6" />
            {zipFile ? zipFile.name : 'Click to choose a .zip file'}
            <input type="file" className="hidden" accept=".zip" onChange={(e) => setZipFile(e.target.files?.[0] || null)} />
          </label>

          {hasPermission('edit') && (
            <button
              onClick={handleZipImport}
              disabled={!zipFile || zipImporting}
              className="w-full rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {zipImporting ? 'Importing…' : 'Import Session ZIP'}
            </button>
          )}

          {zipResult && (
            <div className="rounded-lg border border-white/10 bg-dark-900 p-4 text-sm">
              <p className="text-green-400">
                {zipResult.created} created, {zipResult.updated} updated, of {zipResult.total} pair{zipResult.total === 1 ? '' : 's'}.
              </p>
              {zipResult.errors.length > 0 && (
                <div className="mt-2 max-h-40 overflow-y-auto space-y-1">
                  {zipResult.errors.map((e, i) => (
                    <p key={i} className="text-xs text-red-400">{e.file}: {e.error}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'export' && (
        <div className="space-y-4">
          <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value)} className="rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-200">
            {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>

          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={exportFiltered}
              onChange={(e) => setExportFiltered(e.target.checked)}
              disabled={activeFilterCount === 0}
              className="h-4 w-4 rounded border-white/20 bg-dark-900 text-primary-600"
            />
            Export filtered results only {activeFilterCount > 0 ? `(${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} active)` : '(no filters active)'}
          </label>

          {hasPermission('export') ? (
            <button
              onClick={handleExport}
              disabled={exporting}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
            >
              <Download className="h-4 w-4" /> {exporting ? 'Exporting…' : 'Export'}
            </button>
          ) : (
            <p className="text-sm text-amber-400">You don't have export permission.</p>
          )}
        </div>
      )}
    </Modal>
  );
}
