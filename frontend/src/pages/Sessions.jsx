import { useState, useEffect, useCallback, useRef } from 'react';
import { usePolling } from '../hooks/usePolling';
import {
  listSessions,
  uploadSessions,
  loginSession,
  logoutSession,
  deleteSession,
  bulkDeleteSessions,
  downloadSession,
} from '../api/sessions';
import { parseApiError, formatRelativeTime, formatNumber } from '../utils/formatters';
import { useToast } from '../components/common/Toast';
import { Modal } from '../components/common/Modal';
import StatusBadge from '../components/common/StatusBadge';
import {
  CloudArrowUpIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  ArrowRightOnRectangleIcon,
  ArrowLeftOnRectangleIcon,
  EyeIcon,
  XMarkIcon,
  PhoneIcon,
  ShieldCheckIcon,
  ClockIcon,
  UserIcon,
  ChatBubbleLeftIcon,
  PaperClipIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Search,
  Upload,
  Trash2,
  LogIn,
  LogOut,
  Eye,
  X,
  FileText,
  AlertTriangle,
  Download,
} from 'lucide-react';

// --- Helper: format file size ---
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// --- Drag & Drop Upload Area ---
function SessionUploadArea({ onUpload, uploading }) {
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState([]);
  const [uploadingLocal, setUploadingLocal] = useState(false);
  const fileInputRef = useRef(null);

  const { showWarning } = useToast();
  const processFiles = useCallback((fileList) => {
    const all = Array.from(fileList);
    const valid = all.filter(
      (f) => /\.(session|txt|json)$/i.test(f.name)
    );
    const skipped = all.length - valid.length;
    if (skipped > 0 && showWarning) {
      showWarning(
        `${skipped} file${skipped === 1 ? '' : 's'} skipped (only .session, .txt, .json allowed).`
      );
    }
    setFiles(valid);
  }, [showWarning]);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        processFiles(e.dataTransfer.files);
      }
    },
    [processFiles]
  );

  const handleInputChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
    }
  };

  const handleUpload = async () => {
    if (files.length === 0) return;
    setUploadingLocal(true);
    const formData = new FormData();
    files.forEach((file) => formData.append('sessions', file));
    try {
      await uploadSessions(formData);
      onUpload(files.length, null);
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      onUpload(0, err);
    } finally {
      setUploadingLocal(false);
    }
  };

  const removeFile = (index) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
      <h3 className="mb-3 text-sm font-semibold text-white flex items-center gap-2">
        <Upload className="w-4 h-4 text-primary-500" />
        Bulk Upload Sessions
      </h3>

      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
          isDragging
            ? 'border-primary-500 bg-primary-500/10'
            : 'border-white/10 bg-dark-900 hover:border-white/20 hover:bg-dark-900/80'
        }`}
      >
        {/*
          NOTE: iOS Files / iCloud Drive cannot tap files whose extension
          isn't a recognized UTI — `.session` has no UTI, so a strict
          `accept=".session,..."` attribute makes those files appear
          dimmed/un-tappable in the iOS picker. We intentionally allow
          any file here; processFiles() filters to .session/.txt/.json
          on the JS side, and the backend re-validates on upload.
         */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleInputChange}
          className="hidden"
        />
        <CloudArrowUpIcon
          className={`mb-2 h-8 w-8 ${
            isDragging ? 'text-primary-500' : 'text-gray-500'
          }`}
        />
        <p className="text-sm font-medium text-gray-300">
          {isDragging ? 'Drop files here' : 'Drag & drop session files here'}
        </p>
        <p className="mt-1 text-xs text-gray-500">
          or click to browse &middot; .session, .txt, .json
        </p>
      </div>

      {files.length > 0 && (
        <div className="mt-3 space-y-2">
          {files.map((file, index) => (
            <div
              key={index}
              className="flex items-center justify-between rounded-lg border border-white/5 bg-dark-900 px-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <PaperClipIcon className="h-4 w-4 flex-shrink-0 text-gray-500" />
                <div className="min-w-0">
                  <p className="truncate text-sm text-gray-300">{file.name}</p>
                  <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeFile(index);
                }}
                className="flex-shrink-0 rounded p-1 text-gray-500 hover:text-white hover:bg-white/10 transition"
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleUpload();
            }}
            disabled={uploadingLocal || uploading}
            className="w-full mt-2 flex items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {(uploadingLocal || uploading) ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" />
                Upload {files.length} file{files.length > 1 ? 's' : ''}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

// --- Session Detail Modal ---
function SessionDetailModal({ session, isOpen, onClose }) {
  if (!session) return null;

  const statusInfo = {
    active: { color: 'emerald', label: 'Active' },
    inactive: { color: 'gray', label: 'Inactive' },
    error: { color: 'red', label: 'Error' },
    logged_out: { color: 'gray', label: 'Logged Out' },
  };

  const info = statusInfo[session.status?.toLowerCase()] || {
    color: 'indigo',
    label: session.status || 'Unknown',
  };

  const colorMap = {
    emerald: 'bg-emerald-500/15 text-emerald-400',
    gray: 'bg-gray-500/15 text-gray-400',
    red: 'bg-red-500/15 text-red-400',
    indigo: 'bg-indigo-500/15 text-indigo-400',
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Session Details" size="lg">
      <div className="space-y-6">
        {/* Account Info */}
        <div>
          <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Account Information
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-lg border border-white/5 bg-dark-900 p-4">
              <div className="flex items-center gap-2 text-gray-400 mb-1">
                <UserIcon className="w-4 h-4" />
                <span className="text-xs uppercase tracking-wider">Phone</span>
              </div>
              <p className="text-white font-medium text-lg">{session.phone || 'N/A'}</p>
            </div>
            <div className="rounded-lg border border-white/5 bg-dark-900 p-4">
              <div className="flex items-center gap-2 text-gray-400 mb-1">
                <span className="text-xs uppercase tracking-wider">Username</span>
              </div>
              <p className="text-white font-medium text-lg">
                {session.username || 'N/A'}
              </p>
            </div>
            <div className="rounded-lg border border-white/5 bg-dark-900 p-4">
              <div className="flex items-center gap-2 text-gray-400 mb-1">
                <span className="text-xs uppercase tracking-wider">Status</span>
              </div>
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${
                  colorMap[info.color] || colorMap.gray
                }`}
              >
                {info.label}
              </span>
            </div>
            <div className="rounded-lg border border-white/5 bg-dark-900 p-4">
              <div className="flex items-center gap-2 text-gray-400 mb-1">
                <ShieldCheckIcon className="w-4 h-4" />
                <span className="text-xs uppercase tracking-wider">2FA</span>
              </div>
              <p className="text-white font-medium">
                {session.has_2fa ? (
                  <span className="text-amber-400 flex items-center gap-1">
                    <ShieldCheckIcon className="w-4 h-4" />
                    Enabled
                  </span>
                ) : (
                  <span className="text-gray-400">Disabled</span>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div>
          <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Statistics
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg border border-white/5 bg-dark-900 p-3 text-center">
              <p className="text-2xl font-bold text-white">
                {formatNumber(session.messages_sent ?? 0)}
              </p>
              <p className="text-xs text-gray-500 mt-1">Messages Sent</p>
            </div>
            <div className="rounded-lg border border-white/5 bg-dark-900 p-3 text-center">
              <p className="text-2xl font-bold text-white">
                {formatNumber(session.groups_joined ?? 0)}
              </p>
              <p className="text-xs text-gray-500 mt-1">Groups Joined</p>
            </div>
            <div className="rounded-lg border border-white/5 bg-dark-900 p-3 text-center">
              <p className="text-2xl font-bold text-white">
                {formatNumber(session.scrape_count ?? 0)}
              </p>
              <p className="text-xs text-gray-500 mt-1">Scrapes Done</p>
            </div>
            <div className="rounded-lg border border-white/5 bg-dark-900 p-3 text-center">
              <p className="text-2xl font-bold text-white">
                {formatNumber(session.errors_count ?? 0)}
              </p>
              <p className="text-xs text-gray-500 mt-1">Errors</p>
            </div>
          </div>
        </div>

        {/* Metadata */}
        <div>
          <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Metadata
          </h4>
          <div className="rounded-lg border border-white/5 bg-dark-900 divide-y divide-white/5">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-2 text-gray-400">
                <ClockIcon className="w-4 h-4" />
                <span className="text-sm">Last Active</span>
              </div>
              <span className="text-sm text-white">
                {session.last_active
                  ? formatRelativeTime(session.last_active)
                  : 'Never'}
              </span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-2 text-gray-400">
                <ClockIcon className="w-4 h-4" />
                <span className="text-sm">Created</span>
              </div>
              <span className="text-sm text-white">
                {session.created_at
                  ? formatRelativeTime(session.created_at)
                  : 'N/A'}
              </span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-2 text-gray-400">
                <FileText className="w-4 h-4" />
                <span className="text-sm">Session ID</span>
              </div>
              <span className="text-sm text-gray-300 font-mono">{session.id}</span>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// --- Main Sessions Page ---
export default function Sessions() {
  const { success: showSuccess, error: showError, info: showInfo } = useToast();

  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [actionLoading, setActionLoading] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [detailSession, setDetailSession] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const pageSize = 10;

  const fetchSessions = useCallback(async () => {
    try {
      const response = await listSessions({
        page: currentPage,
        limit: pageSize,
        filter: searchTerm || undefined,
        status: statusFilter !== 'all' ? statusFilter : undefined,
      });
      setSessions(response.data.data?.sessions || []);
    } catch (err) {
      console.warn('Failed to fetch sessions:', parseApiError(err));
    } finally {
      setLoading(false);
    }
  }, [currentPage, searchTerm, statusFilter]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Poll every 10 seconds for live updates
  usePolling(fetchSessions, 10000, true);

  // --- Actions ---
  const handleUploadComplete = async (count, error) => {
    if (error) {
      showError(parseApiError(error), 'Upload Failed');
      return;
    }
    setUploading(true);
    try {
      await fetchSessions();
      showSuccess(`${count} session file${count > 1 ? 's' : ''} uploaded successfully.`, 'Upload');
    } catch (err) {
      showError(parseApiError(err), 'Upload Failed');
    } finally {
      setUploading(false);
    }
  };

  const handleLogin = async (id) => {
    setActionLoading((prev) => ({ ...prev, [id]: 'login' }));
    try {
      const response = await loginSession(id);
      // Check if login actually succeeded (backend now throws error if it fails)
      if (response.data?.success) {
        const phone = response.data.data?.accountInfo?.phone || 'OK';
        showSuccess(`Session logged in: ${phone}`, 'Login');
        // Reset to page 1 to show the newly logged in session
        setCurrentPage(1);
        await fetchSessions();
      } else {
        showError('Login completed but response was invalid.', 'Login Warning');
      }
    } catch (err) {
      showError(parseApiError(err), 'Login Failed');
    } finally {
      setActionLoading((prev) => ({ ...prev, [id]: null }));
    }
  };

  const handleLogout = async (id) => {
    setActionLoading((prev) => ({ ...prev, [id]: 'logout' }));
    try {
      await logoutSession(id);
      showSuccess('Session logged out.', 'Logout');
      await fetchSessions();
    } catch (err) {
      showError(parseApiError(err), 'Logout Failed');
    } finally {
      setActionLoading((prev) => ({ ...prev, [id]: null }));
    }
  };

  const handleDelete = async (id) => {
    setActionLoading((prev) => ({ ...prev, [id]: 'delete' }));
    try {
      await deleteSession(id);
      showSuccess('Session deleted.', 'Delete');
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await fetchSessions();
    } catch (err) {
      showError(parseApiError(err), 'Delete Failed');
    } finally {
      setActionLoading((prev) => ({ ...prev, [id]: null }));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    try {
      await bulkDeleteSessions(Array.from(selectedIds));
      showSuccess(`${selectedIds.size} session(s) deleted.`, 'Bulk Delete');
      setSelectedIds(new Set());
      await fetchSessions();
    } catch (err) {
      showError(parseApiError(err), 'Bulk Delete Failed');
    }
  };

  const handleBulkLogin = async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    let successCount = 0;
    let failCount = 0;

    // Process sessions sequentially with small delay to avoid rate limiting
    for (const id of ids) {
      try {
        await loginSession(id);
        successCount++;
        // Small delay between logins to prevent flooding Telegram API
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        failCount++;
        console.warn(`Failed to login session ${id}:`, parseApiError(err));
      }
    }

    if (failCount > 0) {
      showError(`${successCount} succeeded, ${failCount} failed.`, 'Bulk Login Partial');
    } else {
      showSuccess(`Bulk login complete: ${successCount} session(s) logged.`, 'Bulk Login');
    }
    setCurrentPage(1);
    await fetchSessions();
  };

  const handleBulkLogout = async () => {
    if (selectedIds.size === 0) return;
    showInfo(`Logging out ${selectedIds.size} session(s)...`, 'Bulk Logout');
    const ids = Array.from(selectedIds);
    await Promise.allSettled(
      ids.map((id) => logoutSession(id).catch(() => {}))
    );
    showSuccess(`Bulk logout complete for ${ids.length} session(s).`, 'Bulk Logout');
    await fetchSessions();
  };

  // --- Selection ---
  const toggleSelectAll = () => {
    if (selectedIds.size === sessions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sessions.map((s) => s.id)));
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const isAllSelected = sessions.length > 0 && selectedIds.size === sessions.length;
  const isSomeSelected = selectedIds.size > 0 && selectedIds.size < sessions.length;

  // --- Filtered data (client-side search as additional layer) ---
  const filteredSessions = sessions.filter((s) => {
    const matchesSearch =
      !searchTerm ||
      (s.phone && s.phone.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (s.username && s.username.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (s.id && String(s.id).toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesStatus =
      statusFilter === 'all' ||
      s.status?.toLowerCase() === statusFilter;
    return matchesSearch && matchesStatus;
  });

  // --- Pagination ---
  const totalPages = Math.ceil(filteredSessions.length / pageSize);
  const paginatedSessions = filteredSessions.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    if (totalPages <= maxVisible + 2) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (currentPage > 3) pages.push('...');
      const start = Math.max(2, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (currentPage < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    return pages;
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Sessions</h1>
          <p className="mt-1 text-sm text-gray-400">
            Manage your Telegram sessions &middot; {sessions.length} total
          </p>
        </div>
      </div>

      {/* Upload Area */}
      <SessionUploadArea onUpload={handleUploadComplete} uploading={uploading} />

      {/* Search & Filter Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setCurrentPage(1);
            }}
            placeholder="Search by phone, username, or ID..."
            className="w-full pl-10 pr-4 py-2 bg-dark-900 border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition"
          />
        </div>
        <div className="flex items-center gap-2">
          {['all', 'active', 'inactive', 'error'].map((status) => (
            <button
              key={status}
              onClick={() => {
                setStatusFilter(status);
                setCurrentPage(1);
              }}
              className={`px-3 py-2 rounded-lg text-sm font-medium border transition ${
                statusFilter === status
                  ? 'bg-primary-500/15 border-primary-500/30 text-primary-400'
                  : 'bg-dark-900 border-white/10 text-gray-400 hover:text-white hover:border-white/20'
              }`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk Actions Bar */}
      {selectedIds.size > 0 && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-lg border border-primary-500/20 bg-primary-500/5 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-primary-400">
              {selectedIds.size} selected
            </span>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-gray-400 hover:text-white transition"
            >
              Clear selection
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleBulkLogin}
              disabled={uploading}
              className="flex items-center gap-1.5 rounded-lg bg-green-600/20 border border-green-500/30 px-3 py-1.5 text-sm font-medium text-green-400 hover:bg-green-600/30 transition disabled:opacity-50"
            >
              <LogIn className="w-3.5 h-3.5" />
              Login All
            </button>
            <button
              onClick={handleBulkLogout}
              disabled={uploading}
              className="flex items-center gap-1.5 rounded-lg bg-amber-600/20 border border-amber-500/30 px-3 py-1.5 text-sm font-medium text-amber-400 hover:bg-amber-600/30 transition disabled:opacity-50"
            >
              <LogOut className="w-3.5 h-3.5" />
              Logout All
            </button>
            <button
              onClick={handleBulkDelete}
              disabled={uploading}
              className="flex items-center gap-1.5 rounded-lg bg-red-600/20 border border-red-500/30 px-3 py-1.5 text-sm font-medium text-red-400 hover:bg-red-600/30 transition disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete Selected
            </button>
          </div>
        </div>
      )}

      {/* Session Table */}
      <div className="rounded-xl border border-white/5 bg-dark-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-4 py-3 text-left w-12">
                  <input
                    type="checkbox"
                    checked={isAllSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = isSomeSelected;
                    }}
                    onChange={toggleSelectAll}
                    className="rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500/50 focus:ring-offset-0 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Phone
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  2FA
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Last Active
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16">
                    <div className="flex flex-col items-center justify-center">
                      <Loader2 className="w-8 h-8 text-primary-500 animate-spin mb-3" />
                      <p className="text-gray-400 text-sm">Loading sessions...</p>
                    </div>
                  </td>
                </tr>
              ) : paginatedSessions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16">
                    <div className="flex flex-col items-center justify-center">
                      <div className="w-12 h-12 rounded-full bg-dark-900 flex items-center justify-center mb-3">
                        <PhoneIcon className="w-5 h-5 text-gray-600" />
                      </div>
                      <p className="text-gray-400 font-medium">No sessions found</p>
                      <p className="text-gray-500 text-sm mt-1">
                        Upload session files to get started
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedSessions.map((session) => {
                  const isSelected = selectedIds.has(session.id);
                  const isLoading = actionLoading[session.id];
                  return (
                    <tr
                      key={session.id}
                      className={`transition-colors ${
                        isSelected ? 'bg-primary-500/5' : 'hover:bg-white/[0.02]'
                      }`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(session.id)}
                          className="rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500/50 focus:ring-offset-0 cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-white">
                            {session.phone || 'N/A'}
                          </p>
                          {session.username && (
                            <p className="text-xs text-gray-500">@{session.username}</p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge
                          status={session.status || 'inactive'}
                          size="sm"
                        />
                      </td>
                      <td className="px-4 py-3">
                        {session.has_2fa ? (
                          <span className="inline-flex items-center gap-1 text-xs text-amber-400">
                            <ShieldCheckIcon className="w-3.5 h-3.5" />
                            On
                          </span>
                        ) : (
                          <span className="text-xs text-gray-500">Off</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-gray-400">
                          {session.last_active
                            ? formatRelativeTime(session.last_active)
                            : 'Never'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            onClick={() => {
                              setDetailSession(session);
                              setDetailOpen(true);
                            }}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-primary-400 hover:bg-primary-500/10 transition"
                            title="View Details"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                const phone = session.phone ? `${session.phone.replace(/^\+/, '+')}.json` : `session-${session.id}.json`;
                                await downloadSession(session.id, phone);
                              } catch (err) {
                                showError(parseApiError(err));
                              }
                            }}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition"
                            title="Download session file"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          {session.status?.toLowerCase() === 'active' ? (
                            <button
                              onClick={() => handleLogout(session.id)}
                              disabled={isLoading === 'logout'}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-amber-400 hover:bg-amber-500/10 transition disabled:opacity-50"
                              title="Logout"
                            >
                              {isLoading === 'logout' ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <LogOut className="w-4 h-4" />
                              )}
                            </button>
                          ) : (
                            <button
                              onClick={() => handleLogin(session.id)}
                              disabled={isLoading === 'login'}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-green-400 hover:bg-green-500/10 transition disabled:opacity-50"
                              title="Login"
                            >
                              {isLoading === 'login' ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <LogIn className="w-4 h-4" />
                              )}
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(session.id)}
                            disabled={isLoading === 'delete'}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                            title="Delete"
                          >
                            {isLoading === 'delete' ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        {!loading && totalPages > 1 && (
          <div className="px-4 py-3 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-sm text-gray-400">
              Showing{' '}
              <span className="text-gray-200 font-medium">
                {(currentPage - 1) * pageSize + 1}
              </span>{' '}
              to{' '}
              <span className="text-gray-200 font-medium">
                {Math.min(currentPage * pageSize, filteredSessions.length)}
              </span>{' '}
              of{' '}
              <span className="text-gray-200 font-medium">
                {filteredSessions.length}
              </span>{' '}
              results
            </p>
            <nav className="flex items-center gap-1" aria-label="Pagination">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition"
                aria-label="Previous page"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              {getPageNumbers().map((page, i) =>
                typeof page === 'number' ? (
                  <button
                    key={i}
                    onClick={() => setCurrentPage(page)}
                    className={`min-w-[2rem] h-8 rounded-lg text-sm font-medium transition ${
                      page === currentPage
                        ? 'bg-primary-600 text-white'
                        : 'text-gray-400 hover:text-white hover:bg-white/5'
                    }`}
                    aria-current={page === currentPage ? 'page' : undefined}
                  >
                    {page}
                  </button>
                ) : (
                  <span key={i} className="px-1 text-gray-500 text-sm">
                    ...
                  </span>
                )
              )}
              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition"
                aria-label="Next page"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </nav>
          </div>
        )}
      </div>

      {/* Session Detail Modal */}
      <SessionDetailModal
        session={detailSession}
        isOpen={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setDetailSession(null);
        }}
      />
    </div>
  );
}
