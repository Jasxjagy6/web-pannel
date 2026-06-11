import { useState, useEffect, useCallback } from 'react';
import { Mail, Loader2, Play, RefreshCw, X, Clock, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { useToast } from '../components/common/Toast';
import { parseApiError, formatRelativeTime } from '../utils/formatters';
import { listSessions } from '../api/sessions';

function StatusBadge({ status }) {
  const meta = {
    pending:    { icon: Clock,         color: 'text-gray-400 bg-gray-500/10 border-gray-500/30' },
    requesting_code: { icon: Loader2,  color: 'text-blue-300 bg-blue-500/10 border-blue-500/30', spin: true },
    waiting_for_email: { icon: Loader2,color: 'text-blue-300 bg-blue-500/10 border-blue-500/30', spin: true },
    verifying:  { icon: Loader2,       color: 'text-blue-300 bg-blue-500/10 border-blue-500/30', spin: true },
    running:    { icon: Loader2,       color: 'text-blue-300 bg-blue-500/10 border-blue-500/30', spin: true },
    completed:  { icon: CheckCircle2,  color: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
    succeeded:  { icon: CheckCircle2,  color: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
    failed:     { icon: XCircle,       color: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
    cancelled:  { icon: X,             color: 'text-gray-300 bg-gray-500/10 border-gray-500/30' },
  }[status] || { icon: Clock, color: 'text-gray-400 bg-gray-500/10 border-gray-500/30' };
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium ${meta.color}`}>
      <Icon className={`h-3 w-3 ${meta.spin ? 'animate-spin' : ''}`} />
      {status}
    </span>
  );
}

function JobItemDrawer({ job, onClose, token }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!job) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/login-email/jobs/${job.id}/items`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setItems(data?.data?.items || []);
    } finally {
      setLoading(false);
    }
  }, [job, token]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!job) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl max-h-[85vh] overflow-hidden rounded-2xl border border-white/10 bg-dark-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Job #{job.id} · per-session results
            </h3>
            <p className="text-[12px] text-gray-500">
              {job.total_sessions} sessions · {formatRelativeTime(job.created_at)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md border border-white/10 px-2 py-1 text-xs text-gray-300 hover:bg-white/5"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-gray-400 text-xs uppercase tracking-wider sticky top-0">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Session</th>
                <th className="text-left px-4 py-2 font-medium">Email</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                    <Loader2 className="inline h-4 w-4 animate-spin" /> loading…
                  </td>
                </tr>
              )}
              {items.map((it) => {
                const display =
                  it.username ||
                  [it.first_name, it.last_name].filter(Boolean).join(' ') ||
                  it.phone ||
                  `Session ${it.session_id}`;
                return (
                  <tr
                    key={it.id}
                    className="border-t border-white/5 hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-2.5">
                      <div className="text-white text-sm">{display}</div>
                      <div className="text-[11px] text-gray-500">{it.phone}</div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-300">{it.email}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={it.status} /></td>
                    <td className="px-4 py-2.5 text-[12px] text-gray-400">
                      {it.error_code && (
                        <code className="rounded bg-white/5 px-1.5 py-0.5 text-rose-300">
                          {it.error_code}
                        </code>
                      )}
                      {it.error_message && (
                        <div className="text-gray-500 truncate max-w-xs" title={it.error_message}>
                          {it.error_message}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!loading && items.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                    No items yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function LoginEmailTab() {
  const { showSuccess, showError, showInfo } = useToast();
  const [sessions, setSessions] = useState([]);
  const [csvText, setCsvText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [drawerJob, setDrawerJob] = useState(null);
  
  const token = localStorage.getItem('token');

  const fetchSessions = useCallback(async () => {
    try {
      const r = await listSessions({ limit: 1000 });
      setSessions(r.data?.data?.sessions || []);
    } catch (err) {
      console.warn('listSessions failed', parseApiError(err));
    }
  }, []);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/login-email/jobs', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setJobs(data?.data?.items || []);
    } catch (err) {
      console.warn('listJobs failed', parseApiError(err));
    }
  }, [token]);

  useEffect(() => {
    fetchSessions();
    fetchJobs();
  }, [fetchSessions, fetchJobs]);

  useEffect(() => {
    const hasActive = jobs.some(
      (j) => j.status === 'pending' || j.status === 'running'
    );
    if (!hasActive) return;
    const id = setInterval(fetchJobs, 3000);
    return () => clearInterval(id);
  }, [jobs, fetchJobs]);

  const submit = async () => {
    if (!csvText.trim()) {
      showError('Please provide CSV data', 'Empty Input');
      return;
    }

    const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
    const items = [];

    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 5) continue; // phone,email,password,imap_host,imap_port
      const phone = parts[0].trim();
      const session = sessions.find(s => s.phone === phone || s.phone === '+' + phone.replace('+', ''));
      if (session) {
        items.push({
          sessionId: session.id,
          email: parts[1].trim(),
          imapPassword: parts[2].trim(),
          imapHost: parts[3].trim(),
          imapPort: parseInt(parts[4].trim(), 10)
        });
      }
    }

    if (items.length === 0) {
      showError('No matching active sessions found for the provided phones', 'Invalid Data');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/login-email/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ items })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to submit');

      showSuccess(`Job queued for ${data.data.sessionCount} session(s)`, 'Success');
      setCsvText('');
      fetchJobs();
    } catch (err) {
      showError(err.message, 'Submission Failed');
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (id) => {
    if (!confirm(`Cancel job #${id}?`)) return;
    try {
      await fetch(`/api/login-email/jobs/${id}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      showInfo('Cancellation requested', `Job #${id}`);
      fetchJobs();
    } catch (err) {
      showError(err.message, 'Cancel failed');
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="rounded-2xl border border-white/5 bg-dark-800/40 p-5">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-2">
          <Mail className="w-4 h-4 text-primary-500" />
          Add Login Email (Bulk Setup)
        </h3>
        <p className="text-[12px] text-gray-500 mb-4">
          Upload a CSV-like text of sessions and IMAP credentials. The system will automatically
          request a code, read the IMAP inbox, and verify the email for each session.
          <br />
          Format: <code>Phone, Email, Password, IMAP Host, IMAP Port</code>
        </p>

        <textarea
          className="w-full h-40 bg-dark-900 border border-white/10 rounded-xl p-3 text-sm text-gray-300 font-mono focus:border-primary-500/50 focus:outline-none transition"
          placeholder="1234567890, test@example.com, mypassword, imap.example.com, 993"
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
        />

        <div className="mt-4 flex justify-end">
          <button
            onClick={submit}
            disabled={submitting || !csvText.trim()}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-primary-600 to-primary-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-500/20 hover:shadow-primary-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Start Bulk Setup
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-white/5 bg-dark-800 overflow-hidden">
        <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary-500" />
            Job history ({jobs.length})
          </h3>
          <button
            onClick={fetchJobs}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-gray-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Job</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Sessions</th>
                <th className="text-left px-4 py-2 font-medium">Created</th>
                <th className="text-right px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-500">
                    No jobs yet.
                  </td>
                </tr>
              )}
              {jobs.map((j) => {
                const summary = `${j.succeeded_count}/${j.total_sessions} ok`;
                const failed = j.failed_count > 0 ? ` · ${j.failed_count} failed` : '';
                return (
                  <tr key={j.id} className="border-t border-white/5 hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5 text-white">#{j.id}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={j.status} /></td>
                    <td className="px-4 py-2.5 text-[12px] text-gray-300">
                      {summary}
                      <span className="text-rose-300">{failed}</span>
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-gray-500">
                      {formatRelativeTime(j.created_at)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          onClick={() => setDrawerJob(j)}
                          className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-gray-300 hover:bg-white/5"
                        >
                          View
                        </button>
                        {(j.status === 'pending' || j.status === 'running') && !j.cancel_requested && (
                          <button
                            onClick={() => cancel(j.id)}
                            className="rounded-md border border-rose-500/30 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      
      <JobItemDrawer job={drawerJob} onClose={() => setDrawerJob(null)} token={token} />
    </div>
  );
}
