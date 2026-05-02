import { apiError } from '../../utils/apiError';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Instagram,
  Users,
  UserPlus,
  Heart,
  AtSign,
  Camera,
  Play,
  Download,
  X,
  Trash2,
  RefreshCw,
} from 'lucide-react';
import {
  scrapeGroup,
  listScrapeJobs,
  getScrapeProgress,
  cancelScrapeJob,
  exportScrapeJob,
  deleteScrapeJob,
} from '@/api/scrape';
import { listSessions } from '@/api/sessions';
import { useToast } from '../../components/common/Toast';
import { formatNumber } from '@/utils/formatters';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

const TARGET_TYPES = [
  { id: 'followers',  label: 'Followers',     icon: Users,    desc: "An account's followers list" },
  { id: 'following',  label: 'Following',     icon: UserPlus, desc: "Accounts followed by a user" },
  { id: 'likers',     label: 'Post likers',   icon: Heart,    desc: "Users who liked a media (PK)" },
  { id: 'commenters', label: 'Commenters',    icon: AtSign,   desc: "Users who commented on a media" },
  { id: 'tagged',     label: 'Tagged in',     icon: Camera,   desc: "Posts tagging an account" },
];

function StatusPill({ status }) {
  const map = {
    completed: 'bg-green-100 text-green-700',
    running:   'bg-blue-100 text-blue-700',
    pending:   'bg-amber-100 text-amber-700',
    failed:    'bg-red-100 text-red-700',
    cancelled: 'bg-gray-100 text-gray-600',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${map[status] || 'bg-gray-100 text-gray-600'}`}>
      {status || 'unknown'}
    </span>
  );
}

export default function InstagramScrape() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [sessions, setSessions] = useState([]);
  const [selectedSessions, setSelectedSessions] = useState([]);
  const [targetType, setTargetType] = useState('followers');
  const [targetUsernames, setTargetUsernames] = useState('');
  const [limit, setLimit] = useState(1000);
  const [submitting, setSubmitting] = useState(false);

  const [jobs, setJobs] = useState([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const pollRef = useRef(null);

  async function reloadSessions() {
    try {
      const r = await listSessions({ page: 1, limit: 100 });
      const data = r.data?.data || r.data || {};
      const list = (data.sessions || []).filter((s) => s.is_logged_in);
      setSessions(list);
      // Auto-pick the first logged-in session if nothing is selected.
      setSelectedSessions((prev) => {
        if (prev.length) return prev;
        return list.length ? [list[0].id] : [];
      });
    } catch (err) {
      showToast(apiError(err, 'Failed to load sessions'), 'error');
    }
  }

  async function reloadJobs() {
    setJobsLoading(true);
    try {
      const r = await listScrapeJobs({ page: 1, limit: 50 });
      const data = r.data?.data || r.data || {};
      setJobs(data.jobs || []);
    } catch (err) {
      showToast(apiError(err, 'Failed to load scrape jobs'), 'error');
    } finally {
      setJobsLoading(false);
    }
  }

  useEffect(() => {
    reloadSessions();
    reloadJobs();
  }, []);

  // Poll active jobs every 4s.
  useEffect(() => {
    const hasActive = jobs.some((j) => ['pending', 'running'].includes(j.status));
    if (!hasActive) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(reloadJobs, 4000);
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [jobs]);

  function toggleSession(id) {
    setSelectedSessions((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  async function startJob(evt) {
    evt?.preventDefault();
    const targets = targetUsernames
      .split(/[\s,;\n]+/)
      .map((x) => x.trim().replace(/^@/, ''))
      .filter(Boolean);
    if (!targets.length) {
      showToast('Enter at least one Instagram username (or media PK for likers)', 'error');
      return;
    }
    if (!selectedSessions.length) {
      showToast('Select at least one logged-in Instagram session', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await scrapeGroup({
        sessionIds: selectedSessions,
        targetIds: targets,
        targetType,
        limit: Number(limit) || 1000,
      });
      showToast('Scrape job queued', 'success');
      setTargetUsernames('');
      await reloadJobs();
    } catch (err) {
      showToast(apiError(err, 'Failed to start job'), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function doCancel(id) {
    try {
      await cancelScrapeJob(id);
      showToast('Job cancelled', 'info');
      await reloadJobs();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  async function doDelete(id) {
    if (!window.confirm('Delete this job and all scraped users?')) return;
    try {
      await deleteScrapeJob(id);
      showToast('Job deleted', 'info');
      await reloadJobs();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  async function doExport(id) {
    try {
      const r = await exportScrapeJob(id, { format: 'csv' });
      const blob = r.data;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `instagram-scrape-${id}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  const placeholderHint = useMemo(() => {
    if (targetType === 'likers' || targetType === 'commenters') {
      return 'media PK (numeric, one per line) — e.g. 3092834593582345';
    }
    return 'Instagram username (one per line) — e.g. instagram, nasa';
  }, [targetType]);

  return (
    <div className="space-y-6">
      <div className={`rounded-xl ${IG_GRADIENT} px-6 py-5 text-white shadow-lg`}>
        <div className="flex items-center gap-3">
          <Instagram className="h-7 w-7" />
          <div>
            <div className="text-lg font-semibold">Instagram scraping</div>
            <div className="text-sm text-white/85">
              Scrape followers, following, post likers, commenters and tagged users from any public Instagram account.
            </div>
          </div>
        </div>
      </div>

      <form
        onSubmit={startJob}
        className="rounded-xl border border-pink-100 bg-white p-6 shadow-sm dark:border-pink-900/30 dark:bg-dark-800"
      >
        <div className="space-y-5">
          <div>
            <div className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-200">Target type</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {TARGET_TYPES.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  onClick={() => setTargetType(t.id)}
                  className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition ${
                    targetType === t.id
                      ? `${IG_GRADIENT} border-transparent text-white shadow`
                      : 'border-gray-200 bg-white text-gray-700 hover:border-pink-200 dark:border-dark-600 dark:bg-dark-700 dark:text-gray-200'
                  }`}
                >
                  <t.icon className="h-4 w-4" />
                  <div className="text-sm font-semibold">{t.label}</div>
                  <div className={`text-[11px] ${targetType === t.id ? 'text-white/85' : 'text-gray-500 dark:text-gray-400'}`}>
                    {t.desc}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <label className="block">
                <div className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">Targets</div>
                <textarea
                  rows={4}
                  value={targetUsernames}
                  onChange={(e) => setTargetUsernames(e.target.value)}
                  placeholder={placeholderHint}
                  className="block w-full rounded-lg border border-gray-200 bg-white p-2.5 text-sm focus:border-pink-500 focus:outline-none focus:ring-2 focus:ring-pink-200 dark:border-dark-600 dark:bg-dark-700 dark:text-white"
                />
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  One per line, comma separated, or space separated.
                </div>
              </label>
            </div>

            <div>
              <label className="block">
                <div className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">Limit per target</div>
                <input
                  type="number"
                  min={1}
                  max={500000}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  className="block w-full rounded-lg border border-gray-200 bg-white p-2.5 text-sm focus:border-pink-500 focus:outline-none focus:ring-2 focus:ring-pink-200 dark:border-dark-600 dark:bg-dark-700 dark:text-white"
                />
              </label>

              <div className="mt-3">
                <div className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">Sessions to use</div>
                <div className="max-h-32 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 dark:border-dark-600 dark:bg-dark-700">
                  {sessions.length === 0 && (
                    <div className="px-2 py-3 text-xs text-gray-500 dark:text-gray-400">
                      No logged-in Instagram sessions. <button type="button" onClick={() => navigate('/instagram/create-session')} className="text-pink-500 underline">Create one</button>.
                    </div>
                  )}
                  {sessions.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 px-1 py-1 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedSessions.includes(s.id)}
                        onChange={() => toggleSession(s.id)}
                      />
                      <span className="truncate text-gray-700 dark:text-gray-200">@{s.username}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="submit"
              disabled={submitting || sessions.length === 0}
              className={`flex items-center gap-2 rounded-lg ${IG_GRADIENT} px-5 py-2 text-sm font-semibold text-white shadow disabled:opacity-50`}
            >
              <Play className="h-4 w-4" /> {submitting ? 'Starting…' : 'Start scrape'}
            </button>
          </div>
        </div>
      </form>

      <div className="rounded-xl border border-pink-100 bg-white p-5 shadow-sm dark:border-pink-900/30 dark:bg-dark-800">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 dark:text-white">Recent jobs</h3>
          <button
            onClick={reloadJobs}
            disabled={jobsLoading}
            className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 transition hover:bg-gray-50 dark:border-dark-600 dark:text-gray-300"
          >
            <RefreshCw className={`h-3 w-3 ${jobsLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-pink-100 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-pink-900/30 dark:text-gray-400">
              <th className="px-3 py-2">Job</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Targets</th>
              <th className="px-3 py-2">Progress</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobsLoading && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>
            )}
            {!jobsLoading && jobs.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">No jobs yet.</td></tr>
            )}
            {jobs.map((j) => {
              const limit = Number(j.options?.limit || 1000);
              const total = Number(j.total_found || 0);
              const pct = limit > 0 ? Math.min(100, Math.round((total / limit) * 100)) : 0;
              const targets = j.target_ids || (j.target_id ? [j.target_id] : []);
              return (
                <tr key={j.id} className="border-b border-pink-50 last:border-0 dark:border-pink-900/30">
                  <td className="px-3 py-2 font-mono text-xs text-gray-500">#{j.id}</td>
                  <td className="px-3 py-2">{j.target_type}</td>
                  <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-200">
                    {targets.slice(0, 3).map((t) => `@${t}`).join(', ')}
                    {targets.length > 3 ? ` +${targets.length - 3}` : ''}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 text-xs">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-pink-100">
                        <div className={`h-full ${IG_GRADIENT}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-gray-500">{formatNumber(total)} / {formatNumber(limit)}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2"><StatusPill status={j.status} /></td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {(j.status === 'pending' || j.status === 'running') && (
                        <button onClick={() => doCancel(j.id)} title="Cancel" className="rounded-md border border-amber-200 p-1.5 text-amber-600 hover:bg-amber-50">
                          <X className="h-4 w-4" />
                        </button>
                      )}
                      {j.status === 'completed' && (
                        <button onClick={() => doExport(j.id)} title="Download CSV" className="rounded-md border border-pink-200 bg-pink-50 p-1.5 text-pink-600 hover:bg-pink-100">
                          <Download className="h-4 w-4" />
                        </button>
                      )}
                      <button onClick={() => doDelete(j.id)} title="Delete" className="rounded-md border border-red-200 p-1.5 text-red-500 hover:bg-red-50">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
