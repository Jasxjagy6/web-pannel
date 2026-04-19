import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Upload,
  FileText,
  FileJson,
  List,
  Trash2,
  Eye,
  Download,
  GitMerge,
  Search,
  X,
  Loader2,
  Database,
  ExternalLink,
  Check,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Layers,
} from 'lucide-react';
import { Modal } from '../components/common/Modal';
import { useToast } from '../components/common/Toast';
import { listsAPI } from '@/api';
import { parseApiError, formatNumber, formatDate, formatRelativeTime, exportToFile } from '@/utils/formatters';

function TypeBadge({ type }) {
  const config = {
    users: { bg: 'bg-blue-500/15', text: 'text-blue-400', label: 'Users' },
    groups: { bg: 'bg-purple-500/15', text: 'text-purple-400', label: 'Groups' },
    channels: { bg: 'bg-amber-500/15', text: 'text-amber-400', label: 'Channels' },
  };
  const c = config[type] || config.users;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${c.bg} ${c.text}`}>
      {c.label}
    </span>
  );
}

function ConfirmDialog({ isOpen, onClose, onConfirm, title, message, confirmLabel = 'Confirm', variant = 'danger' }) {
  if (!isOpen) return null;
  const btnClass = variant === 'danger'
    ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
    : 'bg-primary-600 hover:bg-primary-700 focus:ring-primary-500';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl border border-white/10 bg-dark-800 p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0" />
          <h3 className="text-lg font-semibold text-white">{title}</h3>
        </div>
        <p className="text-sm text-gray-300 mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { onConfirm(); onClose(); }}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-dark-800 ${btnClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Lists() {
  const { error: showError, success: showSuccess } = useToast();

  const [lists, setLists] = useState([]);
  const [listsLoading, setListsLoading] = useState(true);
  const [listsSearch, setListsSearch] = useState('');

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createMode, setCreateMode] = useState('import');
  const [importFile, setImportFile] = useState(null);
  const [importFileName, setImportFileName] = useState('');
  const [createName, setCreateName] = useState('');
  const [createScrapeJob, setCreateScrapeJob] = useState('');
  const [importing, setImporting] = useState(false);

  const [detailList, setDetailList] = useState(null);
  const [detailItems, setDetailItems] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailSearch, setDetailSearch] = useState('');
  const [detailPage, setDetailPage] = useState(1);
  const detailPageSize = 15;

  const [showMergeModal, setShowMergeModal] = useState(false);
  const [mergeSelected, setMergeSelected] = useState([]);
  const [mergeName, setMergeName] = useState('');
  const [merging, setMerging] = useState(false);

  const [exportingList, setExportingList] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [selectedLists, setSelectedLists] = useState([]);

  const fetchLists = useCallback(async () => {
    setListsLoading(true);
    try {
      const response = await listsAPI.list();
      setLists(response.data.data?.lists || []);
    } catch (err) {
      showError(parseApiError(err), 'Failed to load lists');
      setLists([]);
    } finally {
      setListsLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchLists(); }, []);

  const filteredLists = lists.filter((l) =>
    l.name.toLowerCase().includes(listsSearch.toLowerCase()) ||
    l.type.toLowerCase().includes(listsSearch.toLowerCase())
  );

  const openDetail = async (list) => {
    setDetailList(list);
    setDetailLoading(true);
    setDetailSearch('');
    setDetailPage(1);
    try {
      const response = await listsAPI.getItems(list.id, { page: 1, limit: 200 });
      setDetailItems(response.data.data?.items || []);
    } catch (err) {
      showError(parseApiError(err), 'Failed to load items');
      setDetailItems([]);
    } finally {
      setDetailLoading(false);
    }
  };

  const filteredDetailItems = detailItems.filter((item) => {
    if (!detailSearch.trim()) return true;
    const lower = detailSearch.toLowerCase();
    return (
      (item.username && item.username.toLowerCase().includes(lower)) ||
      (item.first_name && item.first_name.toLowerCase().includes(lower)) ||
      (item.last_name && item.last_name.toLowerCase().includes(lower)) ||
      (item.phone && item.phone.includes(lower))
    );
  });

  const totalDetailPages = Math.ceil(filteredDetailItems.length / detailPageSize);
  const pagedDetailItems = filteredDetailItems.slice(
    (detailPage - 1) * detailPageSize,
    detailPage * detailPageSize
  );

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setImportFile(file);
      setImportFileName(file.name);
    }
  };

  const handleCreate = async () => {
    if (!createName.trim()) {
      showError('Please enter a list name.', 'Validation Error');
      return;
    }

    if (createMode === 'import') {
      if (!importFile) {
        showError('Please select a file to import.', 'Validation Error');
        return;
      }
      setImporting(true);
      try {
        const formData = new FormData();
        formData.append('file', importFile);
        formData.append('name', createName.trim());
        formData.append('type', 'users');
        await listsAPI.importList(formData);
        showSuccess(`List "${createName}" imported successfully.`, 'Import Complete');
        setShowCreateModal(false);
        resetCreateForm();
        fetchLists();
      } catch (err) {
        showError(parseApiError(err), 'Import failed');
      } finally {
        setImporting(false);
      }
    } else {
      if (!createScrapeJob.trim()) {
        showError('Please enter a scrape job ID.', 'Validation Error');
        return;
      }
      setImporting(true);
      try {
        await listsAPI.createFromScrape({ listName: createName.trim(), scrapeJobId: createScrapeJob.trim() });
        showSuccess(`List created from scrape job.`, 'Success');
        setShowCreateModal(false);
        resetCreateForm();
        fetchLists();
      } catch (err) {
        showError(parseApiError(err), 'Failed to create from scrape');
      } finally {
        setImporting(false);
      }
    }
  };

  const resetCreateForm = () => {
    setCreateName('');
    setCreateScrapeJob('');
    setImportFile(null);
    setImportFileName('');
    setCreateMode('import');
  };

  const handleDelete = async (list) => {
    try {
      await listsAPI.delete(list.id);
      showSuccess(`List "${list.name}" deleted.`, 'Deleted');
      fetchLists();
    } catch (err) {
      showError(parseApiError(err), 'Delete failed');
    }
  };

  const handleExport = async (list, format) => {
    try {
      const response = await listsAPI.exportList(list.id, format);
      // Determine correct MIME type based on format
      const mimeType = format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/plain';
      const blob = new Blob([response.data], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${list.name.replace(/\s+/g, '_')}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      showSuccess(`Exported as ${format.toUpperCase()}.`, 'Export Complete');
    } catch (err) {
      showError(parseApiError(err), 'Export failed');
    }
    setExportingList(null);
  };

  const handleMerge = async () => {
    if (mergeSelected.length < 2) {
      showError('Select at least 2 lists to merge.', 'Merge Error');
      return;
    }
    if (!mergeName.trim()) {
      showError('Please enter a name for the merged list.', 'Merge Error');
      return;
    }
    setMerging(true);
    try {
      await listsAPI.merge({ listIds: mergeSelected, newListName: mergeName.trim() });
      showSuccess(`Merged ${mergeSelected.length} lists into "${mergeName}".`, 'Merge Complete');
      fetchLists();
    } catch (err) {
      showError(parseApiError(err), 'Merge failed');
    } finally {
      setMerging(false);
      setShowMergeModal(false);
      setMergeSelected([]);
      setMergeName('');
    }
  };

  const toggleSelectAll = () => {
    if (selectedLists.length === filteredLists.length) {
      setSelectedLists([]);
    } else {
      setSelectedLists(filteredLists.map((l) => l.id));
    }
  };

  const toggleSelect = (id) => {
    setSelectedLists((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleMergeSelection = (id) => {
    setMergeSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Lists</h1>
          <p className="mt-1 text-sm text-gray-400">
            Manage your contact lists — import, merge, export, and inspect items.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {selectedLists.length > 0 && (
            <button
              onClick={() => {
                setMergeSelected(selectedLists);
                setShowMergeModal(true);
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 transition-colors"
            >
              <GitMerge className="h-4 w-4" />
              Merge ({selectedLists.length})
            </button>
          )}
          <button
            onClick={() => { setShowCreateModal(true); resetCreateForm(); }}
            className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 focus:ring-offset-dark-950"
          >
            <Plus className="h-4 w-4" />
            New List
          </button>
        </div>
      </div>

      {/* Lists Table */}
      <div className="rounded-xl border border-white/5 bg-dark-800 shadow-sm">
        <div className="border-b border-white/5 p-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <input
              type="text"
              value={listsSearch}
              onChange={(e) => setListsSearch(e.target.value)}
              placeholder="Search lists..."
              className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 pl-10 pr-4 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={filteredLists.length > 0 && selectedLists.length === filteredLists.length}
                    onChange={toggleSelectAll}
                    className="rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Type</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Items</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 hidden md:table-cell">Source</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 hidden lg:table-cell">Created</th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {listsLoading ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center">
                    <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary-500" />
                    <p className="mt-3 text-sm text-gray-400">Loading lists...</p>
                  </td>
                </tr>
              ) : filteredLists.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center">
                    <List className="mx-auto mb-3 h-10 w-10 text-gray-600" />
                    <p className="text-sm text-gray-400">No lists yet</p>
                    <p className="mt-1 text-xs text-gray-500">Import a file or create from a scrape job to get started</p>
                  </td>
                </tr>
              ) : (
                filteredLists.map((list) => (
                  <tr key={list.id} className="transition-colors hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedLists.includes(list.id)}
                        onChange={() => toggleSelect(list.id)}
                        className="rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Database className="h-4 w-4 text-gray-500 shrink-0" />
                        <span className="text-sm font-medium text-white">{list.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <TypeBadge type={list.type} />
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-300">{formatNumber(list.items_count || list.itemCount)}</td>
                    <td className="px-4 py-3 text-sm text-gray-400 hidden md:table-cell">{list.source}</td>
                    <td className="px-4 py-3 text-sm text-gray-400 hidden lg:table-cell">{formatRelativeTime(list.created_at || list.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => openDetail(list)}
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-blue-400 transition-colors"
                          title="View items"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        <div className="relative">
                          <button
                            onClick={() => setExportingList(exportingList?.id === list.id ? null : list)}
                            className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-green-400 transition-colors"
                            title="Export"
                          >
                            <Download className="h-4 w-4" />
                          </button>
                          {exportingList?.id === list.id && (
                            <div className="absolute right-0 top-full mt-1 z-20 w-36 rounded-lg border border-white/10 bg-dark-800 p-1 shadow-xl">
                              {['csv', 'json', 'txt'].map((fmt) => (
                                <button
                                  key={fmt}
                                  onClick={() => handleExport(list, fmt)}
                                  className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-white/5 transition-colors"
                                >
                                  {fmt === 'csv' && <FileText className="h-3.5 w-3.5" />}
                                  {fmt === 'json' && <FileJson className="h-3.5 w-3.5" />}
                                  {fmt === 'txt' && <FileText className="h-3.5 w-3.5" />}
                                  .{fmt.toUpperCase()}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => setDeleteTarget(list)}
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-red-400 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Create New List"
        size="lg"
        footer={
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setShowCreateModal(false)}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={importing || !createName.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {importing ? 'Creating...' : 'Create'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="flex gap-2">
            {['import', 'scrape'].map((mode) => (
              <button
                key={mode}
                onClick={() => setCreateMode(mode)}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  createMode === mode
                    ? 'bg-primary-600 text-white'
                    : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'
                }`}
              >
                {mode === 'import' ? 'Import File' : 'From Scrape Job'}
              </button>
            ))}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">List Name</label>
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="e.g., Crypto Whale Contacts"
              className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
          </div>

          {createMode === 'import' && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-300">File (CSV / JSON / TXT)</label>
              <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-white/10 bg-dark-900 p-8 text-center transition-colors hover:border-primary-500/50 hover:bg-dark-900/80">
                <input type="file" accept=".csv,.json,.txt" onChange={handleFileSelect} className="hidden" />
                <Upload className="mb-3 h-8 w-8 text-gray-500" />
                {importFileName ? (
                  <div className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-400" />
                    <span className="text-sm font-medium text-white">{importFileName}</span>
                  </div>
                ) : (
                  <>
                    <p className="text-sm font-medium text-gray-300">Click to upload or drag and drop</p>
                    <p className="mt-1 text-xs text-gray-500">CSV, JSON, or TXT files</p>
                  </>
                )}
              </label>
            </div>
          )}

          {createMode === 'scrape' && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-300">Scrape Job ID</label>
              <input
                type="text"
                value={createScrapeJob}
                onChange={(e) => setCreateScrapeJob(e.target.value)}
                placeholder="e.g., 24"
                className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
              <p className="mt-1.5 text-xs text-gray-500">
                Enter the ID of a completed scrape job to create a list from its results.
              </p>
            </div>
          )}
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal
        isOpen={!!detailList}
        onClose={() => { setDetailList(null); setDetailItems([]); }}
        title={detailList ? detailList.name : ''}
        size="xl"
      >
        {detailList && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-4 rounded-lg bg-dark-900 p-3">
              <TypeBadge type={detailList.type} />
              <span className="text-sm text-gray-400">
                {formatNumber(detailList.items_count || detailList.itemCount)} items
              </span>
              <span className="text-sm text-gray-500">|</span>
              <span className="text-sm text-gray-400">Source: {detailList.source}</span>
            </div>

            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
              <input
                type="text"
                value={detailSearch}
                onChange={(e) => { setDetailSearch(e.target.value); setDetailPage(1); }}
                placeholder="Search items..."
                className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 pl-10 pr-4 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
            </div>

            {detailLoading ? (
              <div className="flex flex-col items-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
                <p className="mt-3 text-sm text-gray-400">Loading items...</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-white/5">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-white/5">
                      <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">User ID</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Username</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 hidden sm:table-cell">Name</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 hidden md:table-cell">Phone</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {pagedDetailItems.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-8 text-center text-sm text-gray-400">
                          {detailItems.length === 0 ? 'No items in this list yet' : 'No items match your search'}
                        </td>
                      </tr>
                    ) : (
                      pagedDetailItems.map((item) => (
                        <tr key={item.id} className="transition-colors hover:bg-white/[0.02]">
                          <td className="px-4 py-2.5 text-sm font-mono text-gray-300">{item.telegram_id || item.userId}</td>
                          <td className="px-4 py-2.5 text-sm text-blue-400">{item.username ? `@${item.username}` : '—'}</td>
                          <td className="px-4 py-2.5 text-sm text-gray-300 hidden sm:table-cell">{item.first_name || item.firstName} {item.last_name || item.lastName}</td>
                          <td className="px-4 py-2.5 text-sm text-gray-400 hidden md:table-cell">{item.phone || '—'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {totalDetailPages > 1 && (
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-400">
                  Showing {(detailPage - 1) * detailPageSize + 1}–{Math.min(detailPage * detailPageSize, filteredDetailItems.length)} of {filteredDetailItems.length}
                </p>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setDetailPage((p) => Math.max(1, p - 1))}
                    disabled={detailPage === 1}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setDetailPage((p) => Math.min(totalDetailPages, p + 1))}
                    disabled={detailPage === totalDetailPages}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Merge Modal */}
      <Modal
        isOpen={showMergeModal}
        onClose={() => { setShowMergeModal(false); setMergeSelected([]); setMergeName(''); }}
        title="Merge Lists"
        size="md"
        footer={
          <div className="flex justify-end gap-3">
            <button
              onClick={() => { setShowMergeModal(false); setMergeSelected([]); setMergeName(''); }}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleMerge}
              disabled={merging || mergeSelected.length < 2 || !mergeName.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              {merging ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
              {merging ? 'Merging...' : 'Merge'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              Select Lists to Merge ({mergeSelected.length} selected)
            </label>
            <div className="max-h-48 overflow-y-auto rounded-lg border border-white/10 bg-dark-900 p-2 space-y-1">
              {lists.map((list) => (
                <label
                  key={list.id}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                    mergeSelected.includes(list.id) ? 'bg-primary-600/10' : 'hover:bg-white/5'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={mergeSelected.includes(list.id)}
                    onChange={() => toggleMergeSelection(list.id)}
                    className="rounded border-white/20 bg-dark-800 text-primary-600 focus:ring-primary-500"
                  />
                  <span className="flex-1 text-sm text-white">{list.name}</span>
                  <span className="text-xs text-gray-500">{formatNumber(list.items_count || list.itemCount)}</span>
                  <TypeBadge type={list.type} />
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">Merged List Name</label>
            <input
              type="text"
              value={mergeName}
              onChange={(e) => setMergeName(e.target.value)}
              placeholder="e.g., Combined Crypto Contacts"
              className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
          </div>
        </div>
      </Modal>

      {/* Delete Confirm */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) handleDelete(deleteTarget); }}
        title="Delete List"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
      />
    </div>
  );
}
