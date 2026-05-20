import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  RefreshCw, Plus, Trash2, Cookie, Download, ShieldCheck, ShieldAlert,
  Loader2, Lock, KeyRound, FileText, Copy, Check, Search, ChevronRight,
  AlertTriangle, Clock, Globe, Eye, EyeOff, X, ListChecks, FileJson,
  Terminal, Code2, FileCode, FileSpreadsheet, FileDown,
} from 'lucide-react';
import {
  listFormats,
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  triggerScrape,
  listJobs,
  listJobCookies,
  previewExport,
  downloadExport,
} from '../api/redditScraper';
import { useToast } from '../components/common/Toast';
import { Modal } from '../components/common/Modal';
import apiError from '../utils/apiError';

// ---------------------------------------------------------------------------
// Format catalogue — mirrors backend `redditCookieFormatService.SUPPORTED`
// but adds display metadata so the export modal can render an icon +
// description per entry instead of a flat list of codes.
// ---------------------------------------------------------------------------
const FORMAT_CATALOGUE = {
  json: {
    label: 'JSON',
    description: 'Machine-readable bundle. Every cookie attribute + profile snapshot.',
    icon: FileJson,
    ext: 'json',
  },
  netscape: {
    label: 'Netscape cookies.txt',
    description: 'curl --cookie-jar / wget compatible. Old-school but universal.',
    icon: FileText,
    ext: 'txt',
  },
  editthiscookie: {
    label: 'EditThisCookie / Cookie-Editor',
    description: 'Drop straight into the browser extension importer.',
    icon: Cookie,
    ext: 'json',
  },
  cookieheader: {
    label: 'Cookie: header',
    description: 'Single line. Paste into any HTTP client that takes a header value.',
    icon: Code2,
    ext: 'txt',
  },
  curl: {
    label: 'cURL one-liner',
    description: 'bash script that re-uses every cookie against /api/v1/me.',
    icon: Terminal,
    ext: 'sh',
  },
  selenium: {
    label: 'Selenium WebDriver',
    description: 'driver.add_cookie(…) bundle.',
    icon: FileCode,
    ext: 'json',
  },
  puppeteer: {
    label: 'Puppeteer / Playwright',
    description: 'page.setCookie(…spread) shape — Playwright accepts the same.',
    icon: FileCode,
    ext: 'json',
  },
  har: {
    label: 'HAR (HTTP Archive)',
    description: 'Replay-able .har with a representative authenticated request.',
    icon: FileDown,
    ext: 'har',
  },
  csv: {
    label: 'CSV (spreadsheet)',
    description: 'Excel / Sheets friendly. Every attribute is its own column.',
    icon: FileSpreadsheet,
    ext: 'csv',
  },
  python_requests: {
    label: 'Python (requests)',
    description: 'Drop-in script using the requests library + session.cookies.set.',
    icon: FileCode,
    ext: 'py',
  },
  powershell: {
    label: 'PowerShell',
    description: 'Invoke-WebRequest -WebSession pre-loaded with every cookie.',
    icon: Terminal,
    ext: 'ps1',
  },
  dotenv: {
    label: '.env file',
    description: 'REDDIT_USERNAME / REDDIT_COOKIE + each named cookie as its own var.',
    icon: FileText,
    ext: 'env',
  },
  js_document_cookie: {
    label: 'document.cookie (browser console)',
    description: 'Paste into DevTools on reddit.com to hydrate a brand-new tab.',
    icon: Code2,
    ext: 'js',
  },
};
const FORMAT_ORDER = [
  'json', 'netscape', 'editthiscookie', 'cookieheader', 'curl',
  'selenium', 'puppeteer', 'har', 'csv', 'python_requests', 'powershell',
  'dotenv', 'js_document_cookie',
];

const STATUS_TONE = {
  idle:           { label: 'idle',           tone: 'bg-slate-700 text-slate-200',  icon: Clock },
  queued:         { label: 'queued',         tone: 'bg-amber-700/40 text-amber-200', icon: Clock },
  scraping:       { label: 'scraping…',      tone: 'bg-sky-700/40 text-sky-200',   icon: Loader2 },
  ok:             { label: 'ok',             tone: 'bg-emerald-700/40 text-emerald-200', icon: ShieldCheck },
  error:          { label: 'error',          tone: 'bg-rose-700/40 text-rose-200', icon: ShieldAlert },
  locked:         { label: 'account locked', tone: 'bg-rose-800/50 text-rose-100', icon: Lock },
  needs_2fa:      { label: 'needs 2FA',      tone: 'bg-amber-700/40 text-amber-200', icon: KeyRound },
  needs_captcha:  { label: 'needs captcha',  tone: 'bg-amber-700/40 text-amber-200', icon: AlertTriangle },
};

const JOB_STATUS_TONE = {
  queued:    'bg-amber-700/40 text-amber-200',
  running:   'bg-sky-700/40 text-sky-200',
  succeeded: 'bg-emerald-700/40 text-emerald-200',
  failed:    'bg-rose-700/40 text-rose-200',
  cancelled: 'bg-slate-700 text-slate-200',
};

function formatTime(s) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleString();
  } catch (_e) { return s; }
}

function StatusPill({ status }) {
  const cfg = STATUS_TONE[status] || STATUS_TONE.idle;
  const Icon = cfg.icon;
  const spin = status === 'scraping';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cfg.tone}`}>
      <Icon className={`h-3.5 w-3.5 ${spin ? 'animate-spin' : ''}`} />
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function RedditCookieScraper() {
  const { showToast } = useToast();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [formats, setFormats] = useState(FORMAT_ORDER);
  const [showAdd, setShowAdd] = useState(false);
  const [drawerAccountId, setDrawerAccountId] = useState(null);
  const [filter, setFilter] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await listAccounts();
      setAccounts(resp.data?.data?.accounts || []);
    } catch (err) {
      showToast(apiError(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    reload();
    listFormats()
      .then((r) => setFormats(r.data?.data?.formats || FORMAT_ORDER))
      .catch(() => { /* keep default order */ });
  }, [reload]);

  // Cheap 3-second poll while any account is queued/scraping so the
  // status pill stays accurate without depending on Socket.IO wiring.
  useEffect(() => {
    const anyPending = accounts.some((a) => a.status === 'queued' || a.status === 'scraping');
    if (!anyPending) return undefined;
    const t = setInterval(() => { reload(); }, 3000);
    return () => clearInterval(t);
  }, [accounts, reload]);

  async function onScrape(id) {
    try {
      await triggerScrape(id);
      showToast('Scrape job queued', 'success');
      reload();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  async function onDelete(id) {
    if (!window.confirm('Delete this Reddit account and all captured cookies?')) return;
    try {
      await deleteAccount(id);
      showToast('Account deleted', 'success');
      if (drawerAccountId === id) setDrawerAccountId(null);
      reload();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  const filteredAccounts = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return accounts;
    return accounts.filter((a) =>
      a.username.toLowerCase().includes(f) ||
      (a.label || '').toLowerCase().includes(f) ||
      (a.status || '').toLowerCase().includes(f)
    );
  }, [accounts, filter]);

  const counts = useMemo(() => {
    const out = { total: accounts.length, ok: 0, error: 0, needs_2fa: 0, needs_captcha: 0, scraping: 0 };
    for (const a of accounts) {
      if (a.status === 'ok') out.ok += 1;
      else if (a.status === 'error' || a.status === 'locked') out.error += 1;
      else if (a.status === 'needs_2fa') out.needs_2fa += 1;
      else if (a.status === 'needs_captcha') out.needs_captcha += 1;
      else if (a.status === 'scraping' || a.status === 'queued') out.scraping += 1;
    }
    return out;
  }, [accounts]);

  return (
    <div className="min-h-screen bg-dark-900 text-slate-100 p-6">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* HERO */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-3">
              <span className="inline-flex items-center justify-center h-10 w-10 rounded-xl bg-orange-500/20 text-orange-300">
                <Cookie className="h-6 w-6" />
              </span>
              Reddit Cookie Scraper
            </h1>
            <p className="text-sm text-slate-400 mt-1 max-w-2xl">
              Real Reddit login + cookie capture. Stores credentials encrypted at rest,
              solves TOTP-based 2FA automatically, and exports cookies in {formats.length} formats
              (JSON, Netscape <code className="text-orange-300">cookies.txt</code>, EditThisCookie,
              cURL, Selenium, Puppeteer, HAR, CSV, PowerShell, Python <code className="text-orange-300">requests</code>, .env, document.cookie).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={reload}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-2 text-sm"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-orange-500 hover:bg-orange-400 px-3 py-2 text-sm text-slate-900 font-medium shadow"
            >
              <Plus className="h-4 w-4" />
              Add Reddit account
            </button>
          </div>
        </div>

        {/* STATS STRIP */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <StatCard label="Accounts"   value={counts.total} tone="bg-slate-800" />
          <StatCard label="OK"         value={counts.ok}    tone="bg-emerald-700/30" />
          <StatCard label="Scraping"   value={counts.scraping}  tone="bg-sky-700/30" />
          <StatCard label="Needs 2FA"  value={counts.needs_2fa} tone="bg-amber-700/30" />
          <StatCard label="Captcha"    value={counts.needs_captcha} tone="bg-amber-700/30" />
          <StatCard label="Errors"     value={counts.error} tone="bg-rose-700/30" />
        </div>

        {/* SEARCH */}
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Filter by username, label, status…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full rounded-lg bg-slate-800 border border-white/10 pl-9 pr-3 py-2 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-500/60"
          />
        </div>

        {/* TABLE */}
        <div className="rounded-xl border border-white/10 bg-slate-900/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-800/60 text-slate-300 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-3">Username</th>
                <th className="text-left px-4 py-3">Label</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">2FA</th>
                <th className="text-left px-4 py-3">Last cookies</th>
                <th className="text-left px-4 py-3">Last scrape</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="inline h-4 w-4 animate-spin mr-2" /> Loading accounts…
                </td></tr>
              )}
              {!loading && filteredAccounts.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                  <Cookie className="inline h-6 w-6 mr-2 text-orange-400/70" />
                  No Reddit accounts yet — click <b className="text-orange-300">Add Reddit account</b> to start.
                </td></tr>
              )}
              {!loading && filteredAccounts.map((a) => (
                <tr key={a.id} className="border-t border-white/5 hover:bg-slate-800/40">
                  <td className="px-4 py-3 font-medium text-slate-100">
                    <button onClick={() => setDrawerAccountId(a.id)} className="hover:text-orange-300">
                      u/{a.username}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{a.label || <span className="text-slate-500">—</span>}</td>
                  <td className="px-4 py-3"><StatusPill status={a.status} /></td>
                  <td className="px-4 py-3">
                    {a.has_totp
                      ? <span className="inline-flex items-center gap-1 text-emerald-300"><KeyRound className="h-3.5 w-3.5" />stored</span>
                      : <span className="text-slate-500">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {a.metadata && a.metadata.link_karma !== undefined
                      ? <span className="text-slate-400">karma {a.metadata.link_karma}/{a.metadata.comment_karma}</span>
                      : <span className="text-slate-500">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-400">{formatTime(a.last_scraped_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-2 justify-end">
                      <button
                        onClick={() => onScrape(a.id)}
                        disabled={a.status === 'scraping' || a.status === 'queued'}
                        className="rounded-lg bg-orange-500/20 hover:bg-orange-500/30 disabled:opacity-50 text-orange-200 px-2.5 py-1.5 text-xs inline-flex items-center gap-1"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        {a.last_job_id ? 'Re-scrape' : 'Scrape'}
                      </button>
                      <button
                        onClick={() => setDrawerAccountId(a.id)}
                        className="rounded-lg bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 text-xs inline-flex items-center gap-1"
                      >
                        <ChevronRight className="h-3.5 w-3.5" /> Inspect
                      </button>
                      <button
                        onClick={() => onDelete(a.id)}
                        className="rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 px-2.5 py-1.5 text-xs inline-flex items-center gap-1"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footnote on safety */}
        <div className="text-xs text-slate-500 rounded-lg border border-white/5 bg-slate-900/40 p-3">
          <b className="text-slate-300">Security:</b> passwords + TOTP secrets are encrypted at rest with AES-256-GCM
          (panel key). Captured cookie <i>values</i> are encrypted; metadata (name, domain, path, attributes) is stored plaintext
          for query / export performance. Every scrape attempt records operator user id, client IP, user-agent, and
          proxy snapshot (password-masked) for the audit trail.
        </div>
      </div>

      {showAdd && (
        <AddAccountModal
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); reload(); }}
        />
      )}

      {drawerAccountId && (
        <AccountDetailDrawer
          accountId={drawerAccountId}
          accounts={accounts}
          formats={formats}
          onClose={() => setDrawerAccountId(null)}
          onReload={reload}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, tone }) {
  return (
    <div className={`rounded-xl ${tone} px-4 py-3 border border-white/5`}>
      <div className="text-xs uppercase text-slate-300">{label}</div>
      <div className="text-2xl font-semibold mt-1 text-slate-50">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-account modal
// ---------------------------------------------------------------------------

function AddAccountModal({ onClose, onCreated }) {
  const { showToast } = useToast();
  const [form, setForm] = useState({
    username: '', password: '', totpSecret: '', label: '', notes: '', proxyId: '',
  });
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);

  function update(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function onSubmit(e) {
    e.preventDefault();
    if (!form.username || !form.password) {
      showToast('username and password are required', 'error');
      return;
    }
    setBusy(true);
    try {
      await createAccount({
        username: form.username.trim().replace(/^u\//i, ''),
        password: form.password,
        totpSecret: form.totpSecret || null,
        label: form.label || null,
        notes: form.notes || null,
        proxyId: form.proxyId ? Number(form.proxyId) : null,
      });
      showToast('Reddit account added', 'success');
      onCreated();
    } catch (err) {
      showToast(apiError(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="Add Reddit account" size="md">
      <form onSubmit={onSubmit} className="space-y-3 text-sm">
        <Field label="Reddit username" hint="2-32 chars, A-Z 0-9 _ -. Leading u/ is stripped automatically.">
          <input
            required
            value={form.username}
            onChange={(e) => update('username', e.target.value)}
            placeholder="xjashan_"
            className="w-full rounded-lg bg-slate-800 border border-white/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500/60"
          />
        </Field>

        <Field label="Password" hint="Encrypted at rest with AES-256-GCM. Never displayed back.">
          <div className="relative">
            <input
              required
              type={showPw ? 'text' : 'password'}
              value={form.password}
              onChange={(e) => update('password', e.target.value)}
              className="w-full rounded-lg bg-slate-800 border border-white/10 px-3 py-2 pr-10 focus:outline-none focus:ring-2 focus:ring-orange-500/60"
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              className="absolute right-2 top-1.5 p-1.5 text-slate-400 hover:text-slate-200"
              tabIndex={-1}
            >
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>

        <Field label="TOTP secret (optional)" hint="Base32 shared secret from your Reddit 2FA setup. The worker generates the 6-digit code at login time.">
          <input
            value={form.totpSecret}
            onChange={(e) => update('totpSecret', e.target.value.toUpperCase().replace(/\s+/g, ''))}
            placeholder="JBSWY3DPEHPK3PXP"
            className="w-full rounded-lg bg-slate-800 border border-white/10 px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-orange-500/60"
          />
        </Field>

        <Field label="Label (optional)">
          <input
            value={form.label}
            onChange={(e) => update('label', e.target.value)}
            placeholder="growth burner #4"
            className="w-full rounded-lg bg-slate-800 border border-white/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500/60"
          />
        </Field>

        <Field label="Proxy ID (optional)" hint="Numeric id from /proxies. Leaving this blank uses a direct connection.">
          <input
            value={form.proxyId}
            onChange={(e) => update('proxyId', e.target.value.replace(/[^0-9]/g, ''))}
            placeholder=""
            className="w-full rounded-lg bg-slate-800 border border-white/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500/60"
          />
        </Field>

        <Field label="Notes (optional)">
          <textarea
            value={form.notes}
            onChange={(e) => update('notes', e.target.value)}
            rows={3}
            className="w-full rounded-lg bg-slate-800 border border-white/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500/60"
          />
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-2 text-sm">Cancel</button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-50 px-4 py-2 text-sm text-slate-900 font-medium"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add account
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="text-xs uppercase tracking-wider text-slate-300 mb-1">{label}</div>
      {children}
      {hint && <div className="text-xs text-slate-500 mt-1">{hint}</div>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Account detail drawer — jobs, cookies, export
// ---------------------------------------------------------------------------

function AccountDetailDrawer({ accountId, accounts, formats, onClose, onReload }) {
  const { showToast } = useToast();
  const account = accounts.find((a) => a.id === accountId) || null;
  const [jobs, setJobs] = useState([]);
  const [selectedJob, setSelectedJob] = useState(null);
  const [cookies, setCookies] = useState([]);
  const [cookiesLoading, setCookiesLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ password: '', totpSecret: '', label: '', notes: '' });
  const [exportFormat, setExportFormat] = useState('json');
  const [exportPreview, setExportPreview] = useState(null);
  const [showAllCookies, setShowAllCookies] = useState(false);

  const loadJobs = useCallback(async () => {
    if (!accountId) return;
    try {
      const r = await listJobs(accountId, { limit: 50 });
      const rows = r.data?.data?.jobs || [];
      setJobs(rows);
      const latest = rows.find((j) => j.status === 'succeeded') || rows[0] || null;
      if (latest) setSelectedJob(latest.id);
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }, [accountId, showToast]);

  const loadCookies = useCallback(async (jobId) => {
    if (!jobId) { setCookies([]); return; }
    setCookiesLoading(true);
    try {
      const r = await listJobCookies(jobId);
      setCookies(r.data?.data?.cookies || []);
    } catch (err) {
      showToast(apiError(err), 'error');
    } finally {
      setCookiesLoading(false);
    }
  }, [showToast]);

  useEffect(() => { loadJobs(); }, [loadJobs]);
  useEffect(() => { loadCookies(selectedJob); }, [selectedJob, loadCookies]);

  // Poll while a job is running so the UI converges without a refresh.
  useEffect(() => {
    if (!selectedJob) return undefined;
    const j = jobs.find((x) => x.id === selectedJob);
    if (!j) return undefined;
    if (j.status !== 'running' && j.status !== 'queued') return undefined;
    const t = setInterval(() => { loadJobs(); }, 2500);
    return () => clearInterval(t);
  }, [jobs, selectedJob, loadJobs]);

  async function onScrape() {
    try {
      await triggerScrape(accountId);
      showToast('Scrape job queued', 'success');
      onReload();
      setTimeout(loadJobs, 700);
    } catch (err) { showToast(apiError(err), 'error'); }
  }

  async function onSaveEdit(e) {
    e.preventDefault();
    try {
      await updateAccount(accountId, {
        password: editForm.password || undefined,
        totpSecret: editForm.totpSecret !== '' ? editForm.totpSecret : undefined,
        label: editForm.label,
        notes: editForm.notes,
      });
      showToast('Account updated', 'success');
      setEditing(false);
      onReload();
    } catch (err) { showToast(apiError(err), 'error'); }
  }

  async function onPreview() {
    if (!selectedJob) return;
    try {
      const r = await previewExport(selectedJob, exportFormat);
      setExportPreview({ format: exportFormat, body: r.data });
    } catch (err) { showToast(apiError(err), 'error'); }
  }

  async function onDownload() {
    if (!selectedJob) { showToast('Pick a job first', 'error'); return; }
    try {
      await downloadExport(selectedJob, exportFormat);
    } catch (err) { showToast(apiError(err), 'error'); }
  }

  async function copyValue(v) {
    try {
      await navigator.clipboard.writeText(v);
      showToast('Copied', 'success');
    } catch (_e) { showToast('Could not copy to clipboard', 'error'); }
  }

  const selectedJobRow = jobs.find((j) => j.id === selectedJob) || null;
  const meta = selectedJobRow?.meta_snapshot || {};

  return (
    <div className="fixed inset-0 z-50 flex" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="flex-1 bg-black/50" onClick={onClose} />
      <div className="w-full max-w-4xl bg-dark-900 border-l border-white/10 overflow-y-auto">
        <div className="sticky top-0 bg-dark-900 border-b border-white/10 px-5 py-3 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700">
              <X className="h-4 w-4" />
            </button>
            <div>
              <div className="text-lg font-semibold">u/{account?.username}</div>
              <div className="text-xs text-slate-400">{account?.label || 'no label'} · created {formatTime(account?.created_at)}</div>
            </div>
            <StatusPill status={account?.status || 'idle'} />
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setEditing((v) => !v)} className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-1.5 text-sm">
              {editing ? 'Cancel edit' : 'Edit'}
            </button>
            <button onClick={onScrape} className="rounded-lg bg-orange-500 hover:bg-orange-400 text-slate-900 px-3 py-1.5 text-sm font-medium inline-flex items-center gap-1">
              <RefreshCw className="h-4 w-4" /> Re-scrape
            </button>
          </div>
        </div>

        <div className="p-5 space-y-6">
          {editing && (
            <form onSubmit={onSaveEdit} className="rounded-xl border border-white/10 bg-slate-900/60 p-4 space-y-3 text-sm">
              <div className="font-semibold text-slate-200">Update credentials</div>
              <Field label="New password" hint="Leave blank to keep the existing password.">
                <input
                  type="password"
                  value={editForm.password}
                  onChange={(e) => setEditForm((f) => ({ ...f, password: e.target.value }))}
                  className="w-full rounded-lg bg-slate-800 border border-white/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500/60"
                />
              </Field>
              <Field label="TOTP secret" hint="Leave blank to keep, or set to empty by typing then clearing.">
                <input
                  value={editForm.totpSecret}
                  onChange={(e) => setEditForm((f) => ({ ...f, totpSecret: e.target.value.toUpperCase().replace(/\s+/g, '') }))}
                  className="w-full rounded-lg bg-slate-800 border border-white/10 px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-orange-500/60"
                />
              </Field>
              <Field label="Label">
                <input
                  value={editForm.label}
                  onChange={(e) => setEditForm((f) => ({ ...f, label: e.target.value }))}
                  className="w-full rounded-lg bg-slate-800 border border-white/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500/60"
                />
              </Field>
              <Field label="Notes">
                <textarea
                  value={editForm.notes}
                  onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={3}
                  className="w-full rounded-lg bg-slate-800 border border-white/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500/60"
                />
              </Field>
              <div className="flex justify-end gap-2">
                <button type="submit" className="rounded-lg bg-orange-500 hover:bg-orange-400 text-slate-900 px-3 py-2 text-sm font-medium">Save</button>
              </div>
            </form>
          )}

          {/* PROFILE / META PANEL */}
          {selectedJobRow && meta && meta.me_endpoint && (
            <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <MetaCell label="Profile id" value={meta.me_endpoint.id} />
              <MetaCell label="Account name" value={meta.me_endpoint.name} />
              <MetaCell label="Link karma" value={meta.me_endpoint.link_karma} />
              <MetaCell label="Comment karma" value={meta.me_endpoint.comment_karma} />
              <MetaCell label="Verified email" value={String(meta.me_endpoint.has_verified_email)} />
              <MetaCell label="Gold" value={String(meta.me_endpoint.is_gold)} />
              <MetaCell label="Mod" value={String(meta.me_endpoint.is_mod)} />
              <MetaCell label="Created"
                value={meta.me_endpoint.created_utc
                  ? new Date(meta.me_endpoint.created_utc * 1000).toLocaleDateString()
                  : '—'} />
              <MetaCell label="reddit_session"  value={meta.reddit_session_set ? 'set' : '—'} />
              <MetaCell label="token_v2"         value={meta.token_v2_set ? 'set' : '—'} />
              <MetaCell label="edgebucket"       value={meta.edgebucket_set ? 'set' : '—'} />
              <MetaCell label="OAuth token"      value={meta.oauth_token_present ? 'captured' : '—'} />
            </div>
          )}

          {/* JOBS TABLE */}
          <div className="rounded-xl border border-white/10 bg-slate-900/60 overflow-hidden">
            <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
              <div className="font-semibold inline-flex items-center gap-2"><ListChecks className="h-4 w-4 text-orange-300" /> Scrape history</div>
              <div className="text-xs text-slate-500">{jobs.length} job(s)</div>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-800/60 text-xs uppercase text-slate-300">
                <tr>
                  <th className="text-left px-3 py-2">#</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Cookies</th>
                  <th className="text-left px-3 py-2">Started</th>
                  <th className="text-left px-3 py-2">Took</th>
                  <th className="text-left px-3 py-2">Error</th>
                  <th className="text-left px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">No jobs yet — hit <b>Re-scrape</b> to start one.</td></tr>
                )}
                {jobs.map((j) => (
                  <tr key={j.id} className={`border-t border-white/5 cursor-pointer ${selectedJob === j.id ? 'bg-orange-500/10' : 'hover:bg-slate-800/50'}`}
                      onClick={() => setSelectedJob(j.id)}>
                    <td className="px-3 py-2 text-slate-300">#{j.id}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${JOB_STATUS_TONE[j.status] || 'bg-slate-700 text-slate-200'}`}>
                        {j.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-200">{j.cookies_count}</td>
                    <td className="px-3 py-2 text-slate-400">{formatTime(j.started_at || j.created_at)}</td>
                    <td className="px-3 py-2 text-slate-400">{j.duration_ms ? `${j.duration_ms} ms` : '—'}</td>
                    <td className="px-3 py-2 text-rose-300 text-xs">{j.error_code ? `${j.error_code}` : ''}</td>
                    <td className="px-3 py-2 text-slate-400 text-xs">
                      {j.error_message ? <span title={j.error_message}>{j.error_message.slice(0, 64)}{j.error_message.length > 64 ? '…' : ''}</span> : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* EXPORT PANEL */}
          {selectedJob && (
            <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="font-semibold inline-flex items-center gap-2"><Download className="h-4 w-4 text-orange-300" /> Export job #{selectedJob}</div>
                <div className="text-xs text-slate-400">{cookies.length} cookies</div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {formats.map((f) => {
                  const cfg = FORMAT_CATALOGUE[f] || { label: f, description: '', icon: FileText, ext: 'txt' };
                  const Icon = cfg.icon;
                  const selected = exportFormat === f;
                  return (
                    <button
                      key={f}
                      onClick={() => setExportFormat(f)}
                      className={`text-left rounded-lg border p-3 transition ${selected ? 'border-orange-400 bg-orange-500/10' : 'border-white/10 bg-slate-800/40 hover:border-white/20'}`}
                    >
                      <div className="flex items-center gap-2 font-medium">
                        <Icon className="h-4 w-4 text-orange-300" />
                        {cfg.label}
                      </div>
                      <div className="text-xs text-slate-400 mt-1">{cfg.description}</div>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button onClick={onPreview} className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-2 text-sm inline-flex items-center gap-2">
                  <Eye className="h-4 w-4" /> Preview
                </button>
                <button onClick={onDownload} className="rounded-lg bg-orange-500 hover:bg-orange-400 text-slate-900 px-3 py-2 text-sm font-medium inline-flex items-center gap-2">
                  <Download className="h-4 w-4" /> Download {exportFormat}
                </button>
                {exportPreview && exportPreview.format === exportFormat && (
                  <button onClick={() => copyValue(exportPreview.body)} className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-2 text-sm inline-flex items-center gap-2">
                    <Copy className="h-4 w-4" /> Copy preview
                  </button>
                )}
              </div>
              {exportPreview && exportPreview.format === exportFormat && (
                <pre className="rounded-lg bg-black/40 border border-white/10 p-3 text-xs text-slate-200 overflow-auto max-h-80">{exportPreview.body}</pre>
              )}
            </div>
          )}

          {/* RAW COOKIE TABLE */}
          {selectedJob && (
            <div className="rounded-xl border border-white/10 bg-slate-900/60 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
                <div className="font-semibold inline-flex items-center gap-2">
                  <Cookie className="h-4 w-4 text-orange-300" /> Captured cookies
                </div>
                <div className="text-xs text-slate-500">
                  <button onClick={() => setShowAllCookies((v) => !v)} className="hover:text-slate-200">
                    {showAllCookies ? 'Hide values' : 'Show values'}
                  </button>
                </div>
              </div>
              {cookiesLoading ? (
                <div className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="inline h-4 w-4 animate-spin mr-2" /> Loading cookies…
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-800/60 text-slate-300 uppercase">
                      <tr>
                        <th className="text-left px-3 py-2">Name</th>
                        <th className="text-left px-3 py-2">Domain</th>
                        <th className="text-left px-3 py-2">Path</th>
                        <th className="text-left px-3 py-2">Value</th>
                        <th className="text-left px-3 py-2">Attrs</th>
                        <th className="text-left px-3 py-2">Expires</th>
                        <th className="text-left px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {cookies.map((c) => (
                        <tr key={c.id} className="border-t border-white/5 hover:bg-slate-800/40">
                          <td className="px-3 py-2 font-mono text-slate-200">{c.name}</td>
                          <td className="px-3 py-2 text-slate-300">{c.domain}</td>
                          <td className="px-3 py-2 text-slate-400">{c.path}</td>
                          <td className="px-3 py-2 font-mono">
                            {showAllCookies
                              ? <span className="break-all">{c.value}</span>
                              : <span className="text-slate-500">[{c.value_len} chars]</span>}
                          </td>
                          <td className="px-3 py-2 text-slate-400">
                            {c.secure ? 'Secure ' : ''}{c.http_only ? 'HttpOnly ' : ''}{c.same_site ? `SameSite=${c.same_site} ` : ''}{c.host_only ? 'HostOnly' : ''}
                          </td>
                          <td className="px-3 py-2 text-slate-400">{formatTime(c.expires_at)}</td>
                          <td className="px-3 py-2 text-right">
                            <button onClick={() => copyValue(c.value)} className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1" title="Copy value">
                              <Copy className="h-3 w-3" />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {cookies.length === 0 && (
                        <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">No cookies captured for this job.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetaCell({ label, value }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-400">{label}</div>
      <div className="text-slate-100 font-mono text-sm">{value === null || value === undefined || value === '' ? '—' : String(value)}</div>
    </div>
  );
}
