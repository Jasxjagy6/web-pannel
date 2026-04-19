import { useState, useEffect, useCallback } from 'react';
import {
  BarChart3,
  TrendingUp,
  Users,
  MessageSquare,
  Layers,
  Calendar,
  Download,
  Eye,
  Trash2,
  Plus,
  Loader2,
  Search,
  X,
  FileText,
  FileJson,
  AlertTriangle,
  Target,
  ChevronLeft,
  ChevronRight,
  Activity,
  UserCheck,
  Send,
  Clock,
} from 'lucide-react';
import { Modal } from '../components/common/Modal';
import { useToast } from '../components/common/Toast';
import { reportsAPI } from '@/api';
import { parseApiError, formatNumber, formatDate, formatDateTime, formatRelativeTime, exportToFile } from '@/utils/formatters';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from 'recharts';

// ---------- mock data ----------

const REPORT_TYPES = [
  { value: 'channel', label: 'Channel', icon: Send, color: '#6366f1' },
  { value: 'group', label: 'Group', icon: Users, color: '#8b5cf6' },
  { value: 'user', label: 'User', icon: UserCheck, color: '#22c55e' },
  { value: 'session', label: 'Session', icon: Layers, color: '#f97316' },
];

const PIE_COLORS = ['#6366f1', '#8b5cf6', '#22c55e', '#f97316', '#ef4444', '#06b6d4'];

const chartTooltipStyle = {
  backgroundColor: '#1e293b',
  border: '1px solid #334155',
  borderRadius: '8px',
  padding: '8px 12px',
  color: '#f8fafc',
  fontSize: '13px',
};

// ---------- Type Badge ----------

function TypeBadge({ type }) {
  const config = {
    channel: { bg: 'bg-indigo-500/15', text: 'text-indigo-400', label: 'Channel' },
    group: { bg: 'bg-purple-500/15', text: 'text-purple-400', label: 'Group' },
    user: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', label: 'User' },
    session: { bg: 'bg-orange-500/15', text: 'text-orange-400', label: 'Session' },
  };
  const c = config[type] || config.channel;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${c.bg} ${c.text}`}>
      {c.label}
    </span>
  );
}

// ---------- Confirm Dialog ----------

function ConfirmDialog({ isOpen, onClose, onConfirm, title, message, confirmLabel = 'Confirm' }) {
  if (!isOpen) return null;
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
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-dark-800"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ========== MAIN PAGE ==========

export default function Reports() {
  const { error: showError, success: showSuccess } = useToast();

  // Report generator state
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [genType, setGenType] = useState('channel');
  const [genTargetId, setGenTargetId] = useState('');
  const [genDateFrom, setGenDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [genDateTo, setGenDateTo] = useState(() => new Date().toISOString().split('T')[0]);
  const [generating, setGenerating] = useState(false);

  // Saved reports state
  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsSearch, setReportsSearch] = useState('');
  const [reportsPage, setReportsPage] = useState(1);
  const reportsPageSize = 8;

  // View modal state
  const [viewReport, setViewReport] = useState(null);

  // Export dropdown
  const [exportTarget, setExportTarget] = useState(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState(null);

  // ---------- Fetch reports ----------
  const fetchReports = async () => {
    setReportsLoading(true);
    try {
      const response = await reportsAPI.saved();
      setReports(response.data.data?.reports || []);
    } catch (err) {
      console.error('Failed to load reports:', err);
      setReports([]);
    } finally {
      setReportsLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
  }, []);

  // ---------- Filtered / paginated ----------
  const filteredReports = reports.filter((r) => {
    const target = r?.target || '';
    const type = r?.type || '';
    return target.toLowerCase().includes(reportsSearch.toLowerCase()) ||
           type.toLowerCase().includes(reportsSearch.toLowerCase());
  });

  const totalReportPages = Math.ceil(filteredReports.length / reportsPageSize);
  const pagedReports = filteredReports.slice(
    (reportsPage - 1) * reportsPageSize,
    reportsPage * reportsPageSize
  );

  // ---------- Generate ----------
  const handleGenerate = async () => {
    if (!genTargetId.trim()) {
      showError('Please enter a target ID.', 'Validation Error');
      return;
    }
    setGenerating(true);
    try {
      const apiFn = reportsAPI[genType];
      if (apiFn) {
        const params = {};
        // Use proper date range params if dates are set
        if (genDateFrom && genDateTo) {
          params.period = 'custom';
          params.periodStart = genDateFrom;
          params.periodEnd = genDateTo;
        }
        const response = await apiFn(genTargetId.trim(), params);
        // Save the generated report to database
        if (response.data.data) {
          try {
            const reportData = response.data.data;
            await reportsAPI.save({
              reportType: genType,
              targetId: genTargetId.trim(),
              targetTitle: genTargetId.trim(),
              periodStart: params.periodStart || reportData.period?.start,
              periodEnd: params.periodEnd || reportData.period?.end,
              data: reportData,
            });
          } catch (saveErr) {
            console.warn('Failed to save report:', saveErr);
          }
        }
        showSuccess(`Report generated for "${genTargetId}".`, 'Report Ready');
        setShowGenerateModal(false);
        resetGenerator();
        fetchReports();
      } else {
        showError('Unknown report type.');
      }
    } catch (err) {
      showError(parseApiError(err), 'Failed to generate report');
    } finally {
      setGenerating(false);
    }
  };

  const resetGenerator = () => {
    setGenType('channel');
    setGenTargetId('');
    setGenDateFrom(() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString().split('T')[0];
    });
    setGenDateTo(() => new Date().toISOString().split('T')[0]);
  };

  // ---------- Export ----------
  const handleExport = async (report, format) => {
    try {
      const response = await reportsAPI.exportReport(report.id, format);
      // Determine correct MIME type based on format
      const mimeType = format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/plain';
      const blob = new Blob([response.data], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `report_${report.target_id || report.id}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      showSuccess(`Exported as ${format.toUpperCase()}.`, 'Export Complete');
    } catch (err) {
      showError(parseApiError(err), 'Export failed');
    }
    setExportTarget(null);
  };

  // ---------- Delete ----------
  const handleDelete = async (report) => {
    try {
      await reportsAPI.deleteSaved(report.id);
      showSuccess('Report deleted.', 'Deleted');
      fetchReports();
    } catch (err) {
      showError(parseApiError(err), 'Delete failed');
    }
  };

  // ---------- View modal ----------
  const selectedTypeConfig = REPORT_TYPES.find((t) => t.value === genType);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Reports</h1>
          <p className="mt-1 text-sm text-gray-400">
            Generate and view analytics reports for channels, groups, users, and sessions.
          </p>
        </div>
        <button
          onClick={() => { setShowGenerateModal(true); resetGenerator(); }}
          className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 focus:ring-offset-dark-950"
        >
          <Plus className="h-4 w-4" />
          Generate Report
        </button>
      </div>

      {/* Reports Table */}
      <div className="rounded-xl border border-white/5 bg-dark-800 shadow-sm">
        {/* Search */}
        <div className="border-b border-white/5 p-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <input
              type="text"
              value={reportsSearch}
              onChange={(e) => { setReportsSearch(e.target.value); setReportsPage(1); }}
              placeholder="Search reports..."
              className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 pl-10 pr-4 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Type</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Target</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 hidden md:table-cell">Period</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 hidden lg:table-cell">Generated</th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {reportsLoading ? (
                <tr>
                  <td colSpan={5} className="py-16 text-center">
                    <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary-500" />
                    <p className="mt-3 text-sm text-gray-400">Loading reports...</p>
                  </td>
                </tr>
              ) : pagedReports.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-16 text-center">
                    <FileText className="mx-auto mb-3 h-10 w-10 text-gray-600" />
                    <p className="text-sm text-gray-400">No reports found</p>
                    <p className="mt-1 text-xs text-gray-500">Generate a report to get started</p>
                  </td>
                </tr>
              ) : (
                pagedReports.map((report) => (
                  <tr key={report.id} className="transition-colors hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <TypeBadge type={report.type || 'session'} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Target className="h-3.5 w-3.5 text-gray-500 shrink-0" />
                        <span className="text-sm font-medium text-white">{report.target || 'Unknown'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-400 hidden md:table-cell">
                      {report.period ? `${formatDate(report.period.from)} — ${formatDate(report.period.to)}` : 'N/A'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-400 hidden lg:table-cell">
                      {report.generatedAt ? formatRelativeTime(report.generatedAt) : 'N/A'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => setViewReport(report)}
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-blue-400 transition-colors"
                          title="View report"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        <div className="relative">
                          <button
                            onClick={() => setExportTarget(exportTarget?.id === report.id ? null : report)}
                            className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-green-400 transition-colors"
                            title="Export"
                          >
                            <Download className="h-4 w-4" />
                          </button>
                          {exportTarget?.id === report.id && (
                            <div className="absolute right-0 top-full mt-1 z-20 w-36 rounded-lg border border-white/10 bg-dark-800 p-1 shadow-xl">
                              {['csv', 'json', 'txt'].map((fmt) => (
                                <button
                                  key={fmt}
                                  onClick={() => handleExport(report, fmt)}
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
                          onClick={() => setDeleteTarget(report)}
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

        {/* Pagination */}
        {totalReportPages > 1 && (
          <div className="px-4 py-3 border-t border-white/5 flex items-center justify-between">
            <p className="text-sm text-gray-400">
              Showing {(reportsPage - 1) * reportsPageSize + 1}–{Math.min(reportsPage * reportsPageSize, filteredReports.length)} of {filteredReports.length}
            </p>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setReportsPage((p) => Math.max(1, p - 1))}
                disabled={reportsPage === 1}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              {Array.from({ length: Math.min(totalReportPages, 5) }, (_, i) => {
                const page = Math.max(1, Math.min(reportsPage - 2, totalReportPages - 4)) + i;
                if (page > totalReportPages) return null;
                return (
                  <button
                    key={page}
                    onClick={() => setReportsPage(page)}
                    className={`h-8 w-8 rounded-lg text-sm font-medium transition-colors ${
                      page === reportsPage
                        ? 'bg-primary-600 text-white'
                        : 'text-gray-400 hover:bg-white/5'
                    }`}
                  >
                    {page}
                  </button>
                );
              })}
              <button
                onClick={() => setReportsPage((p) => Math.min(totalReportPages, p + 1))}
                disabled={reportsPage === totalReportPages}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ========== GENERATE MODAL ========== */}
      <Modal
        isOpen={showGenerateModal}
        onClose={() => setShowGenerateModal(false)}
        title="Generate Report"
        size="md"
        footer={
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setShowGenerateModal(false)}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleGenerate}
              disabled={generating || !genTargetId.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}
              {generating ? 'Generating...' : 'Generate'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          {/* Report Type */}
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-300">Report Type</label>
            <div className="grid grid-cols-2 gap-2">
              {REPORT_TYPES.map((type) => {
                const Icon = type.icon;
                const selected = genType === type.value;
                return (
                  <button
                    key={type.value}
                    onClick={() => setGenType(type.value)}
                    className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium transition-all ${
                      selected
                        ? 'border-primary-500 bg-primary-600/10 text-white'
                        : 'border-white/10 bg-dark-900 text-gray-400 hover:bg-white/5 hover:text-white'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {type.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Target ID */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">Target ID</label>
            <input
              type="text"
              value={genTargetId}
              onChange={(e) => setGenTargetId(e.target.value)}
              placeholder={
                genType === 'user' ? 'e.g., @username or user ID' :
                genType === 'session' ? 'e.g., session-7' :
                'e.g., -1001234567890'
              }
              className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
          </div>

          {/* Date Range */}
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-300">Date Range</label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-gray-500">From</label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                  <input
                    type="date"
                    value={genDateFrom}
                    onChange={(e) => setGenDateFrom(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 pl-10 pr-3 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">To</label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                  <input
                    type="date"
                    value={genDateTo}
                    onChange={(e) => setGenDateTo(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 pl-10 pr-3 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </Modal>

      {/* ========== VIEW MODAL ========== */}
      <Modal
        isOpen={!!viewReport}
        onClose={() => setViewReport(null)}
        title={viewReport ? `Report: ${viewReport.target || 'Unknown'}` : 'Report Details'}
        size="xl"
      >
        {viewReport && (
          <div className="space-y-6">
            {/* Report metadata */}
            <div className="flex flex-wrap items-center gap-4 rounded-lg bg-dark-900 p-4">
              <TypeBadge type={viewReport.type} />
              <div className="flex items-center gap-1.5 text-sm text-gray-400">
                <Target className="h-3.5 w-3.5" />
                <span>{viewReport.target || 'Unknown'}</span>
              </div>
              <span className="text-sm text-gray-500">|</span>
              <div className="flex items-center gap-1.5 text-sm text-gray-400">
                <Calendar className="h-3.5 w-3.5" />
                <span>{viewReport.period ? `${formatDate(viewReport.period.from)} — ${formatDate(viewReport.period.to)}` : 'N/A'}</span>
              </div>
              <span className="text-sm text-gray-500">|</span>
              <div className="flex items-center gap-1.5 text-sm text-gray-400">
                <Clock className="h-3.5 w-3.5" />
                <span>{viewReport.generatedAt ? formatDateTime(viewReport.generatedAt) : 'N/A'}</span>
              </div>
            </div>

            {/* Stats cards */}
            {viewReport.stats ? (
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <div className="rounded-lg border border-white/5 bg-dark-900 p-4">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-blue-400" />
                    <span className="text-xs font-medium text-gray-400">Messages</span>
                  </div>
                  <p className="mt-2 text-2xl font-bold text-white">{formatNumber(viewReport.stats.messages ?? 0)}</p>
                </div>
                <div className="rounded-lg border border-white/5 bg-dark-900 p-4">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-purple-400" />
                    <span className="text-xs font-medium text-gray-400">Members</span>
                  </div>
                  <p className="mt-2 text-2xl font-bold text-white">{formatNumber(viewReport.stats.members ?? 0)}</p>
                </div>
                <div className="rounded-lg border border-white/5 bg-dark-900 p-4">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-green-400" />
                    <span className="text-xs font-medium text-gray-400">Growth</span>
                  </div>
                  <p className="mt-2 text-2xl font-bold text-white">+{formatNumber(viewReport.stats.growth ?? 0)}</p>
                </div>
                <div className="rounded-lg border border-white/5 bg-dark-900 p-4">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-amber-400" />
                    <span className="text-xs font-medium text-gray-400">Engagement</span>
                  </div>
                  <p className="mt-2 text-2xl font-bold text-white">{viewReport.stats.engagement ?? 0}%</p>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-white/5 bg-dark-900 p-8 text-center">
                <p className="text-gray-400">No statistics available for this report</p>
              </div>
            )}

            {/* Charts */}
            {viewReport.stats?.topHours?.length > 0 && (
              <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
                <h3 className="mb-4 text-sm font-semibold text-gray-300 flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-primary-500" />
                  Messages by Hour
                </h3>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={viewReport.stats.topHours} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="hour" tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                    <RechartsTooltip contentStyle={chartTooltipStyle} />
                    <Bar dataKey="messages" fill="#6366f1" radius={[4, 4, 0, 0]} maxBarSize={36} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {viewReport.stats?.memberGrowth?.length > 0 && (
              <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
                <h3 className="mb-4 text-sm font-semibold text-gray-300 flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-500" />
                  Member Growth
                </h3>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={viewReport.stats.memberGrowth} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                    <RechartsTooltip contentStyle={chartTooltipStyle} />
                    <Line
                      type="monotone"
                      dataKey="members"
                      stroke="#22c55e"
                      strokeWidth={2.5}
                      dot={{ fill: '#22c55e', strokeWidth: 2, r: 4, stroke: '#0f172a' }}
                      activeDot={{ r: 6, stroke: '#22c55e', strokeWidth: 2, fill: '#0f172a' }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Engagement Donut */}
            {viewReport.stats.engagement > 0 && (
              <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
                <h3 className="mb-4 text-sm font-semibold text-gray-300 flex items-center gap-2">
                  <Activity className="h-4 w-4 text-amber-500" />
                  Engagement Breakdown
                </h3>
                <div className="flex items-center justify-center">
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie
                        data={[
                          { name: 'Engaged', value: viewReport.stats.engagement, color: '#f97316' },
                          { name: 'Inactive', value: 100 - viewReport.stats.engagement, color: '#334155' },
                        ]}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={85}
                        paddingAngle={3}
                        dataKey="value"
                        stroke="none"
                      >
                        <Cell key="engaged" fill="#f97316" />
                        <Cell key="inactive" fill="#334155" />
                      </Pie>
                      <RechartsTooltip contentStyle={chartTooltipStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex items-center justify-center gap-6 mt-2">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
                    <span className="text-sm text-gray-300">Engaged: {viewReport.stats.engagement}%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
                    <span className="text-sm text-gray-300">Inactive: {(100 - viewReport.stats.engagement).toFixed(1)}%</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ========== DELETE CONFIRM ========== */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) handleDelete(deleteTarget); }}
        title="Delete Report"
        message={`Are you sure you want to delete the report for "${deleteTarget?.target}"? This action cannot be undone.`}
        confirmLabel="Delete"
      />
    </div>
  );
}
