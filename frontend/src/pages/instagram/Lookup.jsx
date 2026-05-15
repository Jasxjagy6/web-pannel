import { useEffect, useMemo, useState } from 'react';
import {
  Search,
  Globe,
  Mail,
  Phone,
  MapPin,
  AlertTriangle,
  Play,
  Trash2,
  X,
  Download,
  RefreshCw,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  ExternalLink,
  FileText,
} from 'lucide-react';
import { apiError } from '../../utils/apiError';
import {
  createLookupJob,
  listLookupJobs,
  getLookupProgress,
  cancelLookupJob,
  deleteLookupJob,
  exportLookupJob,
} from '@/api/lookup';
import { useToast } from '../../components/common/Toast';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

// Method options exposed in the UI. `enabled` here controls whether
// the checkbox is render-active in the React form; the backend
// capability map is the final authority — methods with the matching
// `lookup_*` flag set to false return a `not_implemented` finding so
// the operator sees exactly which gates are off.
const LOOKUP_METHODS = [
  { code: 'profile_info',   label: 'Public profile (§2.1)',          icon: Search,    desc: 'Bio, business email/phone, address, full_name, external link.', enabled: true },
  { code: 'reset_oracle',   label: 'Recovery masks (§2.9 / Oracles 1-3)', icon: ShieldAlert, desc: 'Obfuscated email/phone, recovery-methods bitmap, account status. Single-pass, never triggers a real reset.', enabled: true },
  { code: 'cross_platform', label: 'Cross-platform handles (§2.5)',  icon: Globe,     desc: 'Sherlock-style probe of ~16 services (GitHub, GitLab, Reddit, YouTube, SoundCloud, Patreon, Behance, Substack, …) for the same handle. Per-site detection rules — biased toward false negatives, not false positives.', enabled: true },
  { code: 'geo_from_posts', label: 'Geo from posts (§2.8)',          icon: MapPin,    desc: 'Top-N city/area signal from the target\'s most recent tagged-location posts. Needs a logged-in IG session.', enabled: true },
  { code: 'dork',           label: 'Google dork (§2.7)',             icon: FileText,  desc: 'Targeted Google searches via SerpAPI. Skipped silently if no SERPAPI_KEY is set.', enabled: true },
  { code: 'email_enum',     label: 'Email enumeration (§2.2 / PR #4)',   icon: Mail,  desc: 'Validate mask-derived email candidates against IG\'s signup form. Requires burner-cookie pool (PR #4).', enabled: false },
  { code: 'phone_enum',     label: 'Phone enumeration (§2.2 / PR #4)',   icon: Phone, desc: 'Validate mask-derived phone candidates. Requires burner-cookie pool (PR #4).', enabled: false },
  { code: 'breach',         label: 'Breach correlation (§2.3 / PR #5)',  icon: AlertTriangle, desc: 'Query Dehashed / LeakCheck / Snusbase / IntelligenceX / HIBP. Requires per-org API keys (PR #5).', enabled: false },
  { code: 'link_expand',    label: 'Link expansion + WHOIS (§2.4 / PR #5)', icon: ExternalLink, desc: 'Expand bio links + WHOIS + DNS + cert transparency. (PR #5).', enabled: false },
  { code: 'reverse_image',  label: 'Reverse image (§2.6 / PR #6)',       icon: Search, desc: 'Yandex + PimEyes reverse-image probes against profile photos. (PR #6).', enabled: false },
];

const DEFAULT_METHODS = new Set([
  'profile_info', 'reset_oracle', 'cross_platform', 'geo_from_posts', 'dork',
]);

const KIND_META = {
  email:       { label: 'Email',       icon: Mail,         color: 'bg-blue-50 text-blue-700' },
  phone:       { label: 'Phone',       icon: Phone,        color: 'bg-emerald-50 text-emerald-700' },
  url:         { label: 'URL',         icon: ExternalLink, color: 'bg-purple-50 text-purple-700' },
  location:    { label: 'Location',    icon: MapPin,       color: 'bg-amber-50 text-amber-700' },
  address:     { label: 'Address',     icon: MapPin,       color: 'bg-amber-50 text-amber-700' },
  name:        { label: 'Name',        icon: Search,       color: 'bg-gray-100 text-gray-700' },
  profile_url: { label: 'Profile pic', icon: Search,       color: 'bg-pink-50 text-pink-700' },
  note:        { label: 'Note',        icon: FileText,     color: 'bg-slate-50 text-slate-600' },
};

function StatusPill({ status }) {
  const map = {
    completed: 'bg-green-100 text-green-700',
    running:   'bg-blue-100 text-blue-700',
    queued:    'bg-indigo-100 text-indigo-700',
    pending:   'bg-amber-100 text-amber-700',
    failed:    'bg-red-100 text-red-700',
    cancelled: 'bg-gray-100 text-gray-600',
  };
  const cls = map[status] || 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{status}</span>
  );
}

function ConfidencePill({ value }) {
  const v = Number(value) || 0;
  const cls = v >= 80 ? 'bg-green-100 text-green-700'
    : v >= 60 ? 'bg-blue-100 text-blue-700'
    : v >= 40 ? 'bg-amber-100 text-amber-700'
    : 'bg-gray-100 text-gray-600';
  return <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{v}</span>;
}

function FindingRow({ finding }) {
  const meta = KIND_META[finding.kind] || KIND_META.note;
  const Icon = meta.icon;
  return (
    <div className="flex items-start gap-2 rounded-md border border-gray-100 bg-white p-2 text-sm">
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded ${meta.color}`}>
        <Icon size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-gray-500">{meta.label}</span>
          <ConfidencePill value={finding.confidence} />
          {finding.verified ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-green-700">
              <CheckCircle2 size={12} /> verified
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 break-words text-sm text-gray-800">{finding.value || '—'}</div>
        {finding.source_url ? (
          <a
            href={finding.source_url}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-pink-600 hover:underline"
          >
            <ExternalLink size={11} /> source
          </a>
        ) : null}
      </div>
    </div>
  );
}

export default function Lookup() {
  const { showToast } = useToast();

  const [username, setUsername] = useState('');
  const [statedPurpose, setStatedPurpose] = useState('');
  const [methods, setMethods] = useState(() => new Set(DEFAULT_METHODS));
  const [budgetCap, setBudgetCap] = useState('0.50');
  const [acceptedTos, setAcceptedTos] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [jobs, setJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(true);

  const [activeId, setActiveId] = useState(null);
  const [activeJob, setActiveJob] = useState(null);
  const [findings, setFindings] = useState([]);
  const [loadingActive, setLoadingActive] = useState(false);

  const toggleMethod = (code) => {
    setMethods((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  const fetchJobs = async () => {
    try {
      setLoadingJobs(true);
      const res = await listLookupJobs({ limit: 50 });
      setJobs(res?.data?.data?.jobs || []);
    } catch (err) {
      showToast(apiError(err, 'Failed to load lookup jobs'), 'error');
    } finally {
      setLoadingJobs(false);
    }
  };

  const fetchActive = async (id) => {
    if (!id) return;
    try {
      setLoadingActive(true);
      const res = await getLookupProgress(id);
      const data = res?.data?.data;
      if (data) {
        setActiveJob(data.job);
        setFindings(data.findings || []);
      }
    } catch (err) {
      showToast(apiError(err, 'Failed to load lookup'), 'error');
    } finally {
      setLoadingActive(false);
    }
  };

  useEffect(() => {
    fetchJobs();
  }, []);

  useEffect(() => {
    if (!activeId) {
      setActiveJob(null);
      setFindings([]);
      return undefined;
    }
    fetchActive(activeId);
    const t = setInterval(() => {
      // Light polling while the job is still in flight.
      setActiveJob((prev) => {
        if (prev && ['completed', 'failed', 'cancelled'].includes(prev.status)) {
          return prev;
        }
        fetchActive(activeId);
        return prev;
      });
    }, 3500);
    return () => clearInterval(t);
  }, [activeId]);

  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (!acceptedTos) return false;
    if (!username || !/^@?[a-z0-9._]{1,30}$/i.test(username.trim())) return false;
    if (!statedPurpose || statedPurpose.trim().length < 8) return false;
    if (!methods.size) return false;
    return true;
  }, [submitting, acceptedTos, username, statedPurpose, methods]);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      setSubmitting(true);
      const payload = {
        username: username.trim(),
        statedPurpose: statedPurpose.trim(),
        methods: Array.from(methods),
        options: { budgetUsdCap: Number(budgetCap) || 0 },
      };
      const res = await createLookupJob(payload);
      const newJob = res?.data?.data?.job;
      showToast(`Lookup queued for @${payload.username}`, 'success');
      if (newJob) {
        setActiveId(newJob.id);
      }
      await fetchJobs();
    } catch (err) {
      showToast(apiError(err, 'Failed to start lookup'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const onCancel = async (id) => {
    try {
      await cancelLookupJob(id);
      showToast('Lookup cancelled', 'success');
      await fetchJobs();
      if (id === activeId) await fetchActive(id);
    } catch (err) {
      showToast(apiError(err, 'Failed to cancel'), 'error');
    }
  };

  const onDelete = async (id) => {
    if (!window.confirm('Delete this lookup job and all of its findings? This cannot be undone.')) return;
    try {
      await deleteLookupJob(id);
      showToast('Lookup deleted', 'success');
      if (id === activeId) setActiveId(null);
      await fetchJobs();
    } catch (err) {
      showToast(apiError(err, 'Failed to delete'), 'error');
    }
  };

  const onExport = async (id, format) => {
    try {
      const res = await exportLookupJob(id, { format });
      const blob = res.data;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lookup_${id}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(apiError(err, 'Failed to export'), 'error');
    }
  };

  const groupedFindings = useMemo(() => {
    const out = new Map();
    for (const f of findings) {
      const k = f.kind || 'note';
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(f);
    }
    return out;
  }, [findings]);

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg text-white ${IG_GRADIENT}`}>
            <Search size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Identity lookup</h1>
            <p className="text-sm text-gray-600">
              Multi-method OSINT against a public Instagram handle — public profile, recovery masks
              (single-pass, never triggers a real reset), cross-platform handles, post geo, and
              Google dorks.
            </p>
          </div>
        </div>

        {/* Legal banner */}
        <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="flex items-start gap-2">
            <ShieldAlert size={18} className="mt-0.5 shrink-0" />
            <div>
              <strong>Audit notice.</strong> Every lookup creates an audit record (operator + IP + stated
              purpose + methods) per §8 of the upgrade plan. Forbidden use-cases (phishing-trackers,
              credential stuffing, password-reset triggering, IP-fakery, bulk unrate-limited fan-out)
              are blocked at the runner level. Recovery probes return obfuscated masks only —
              never raw email/phone, never a real reset email.
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* New-lookup form */}
          <form onSubmit={onSubmit} className="lg:col-span-1 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-gray-900">New lookup</h2>
            <div className="mt-3">
              <label className="block text-xs font-medium text-gray-700">Instagram username</label>
              <div className="mt-1 flex items-center rounded-md border border-gray-300 bg-white">
                <span className="px-2 text-gray-400">@</span>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="targetuser"
                  className="flex-1 rounded-md border-0 bg-transparent py-2 pr-2 text-sm focus:outline-none"
                />
              </div>
            </div>

            <div className="mt-3">
              <label className="block text-xs font-medium text-gray-700">Stated purpose (required, audit)</label>
              <textarea
                value={statedPurpose}
                onChange={(e) => setStatedPurpose(e.target.value)}
                placeholder="e.g. KYC verification for client onboarding ticket #1234"
                rows={2}
                className="mt-1 w-full rounded-md border border-gray-300 bg-white p-2 text-sm focus:outline-none focus:ring-1 focus:ring-pink-500"
              />
              <p className="mt-1 text-[11px] text-gray-500">Recorded in the lookup_jobs row alongside operator + IP + methods.</p>
            </div>

            <div className="mt-3">
              <label className="block text-xs font-medium text-gray-700">Budget cap (USD, paid APIs only)</label>
              <input
                type="number"
                step="0.10"
                min="0"
                value={budgetCap}
                onChange={(e) => setBudgetCap(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-300 bg-white p-2 text-sm focus:outline-none focus:ring-1 focus:ring-pink-500"
              />
              <p className="mt-1 text-[11px] text-gray-500">SerpAPI / breach lookups stop once this cap is reached. Public methods are always free.</p>
            </div>

            <fieldset className="mt-4">
              <legend className="text-xs font-medium text-gray-700">Methods</legend>
              <div className="mt-1 space-y-1.5">
                {LOOKUP_METHODS.map((m) => (
                  <label key={m.code} className={`flex items-start gap-2 rounded-md border p-2 text-sm ${methods.has(m.code) ? 'border-pink-300 bg-pink-50/40' : 'border-gray-200 bg-white'}`}>
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={methods.has(m.code)}
                      disabled={!m.enabled}
                      onChange={() => toggleMethod(m.code)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm text-gray-900">
                        <m.icon size={14} className="text-gray-500" />
                        {m.label}
                        {!m.enabled ? (
                          <span className="ml-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-gray-500">soon</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-gray-600">{m.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="mt-3 flex items-start gap-2 text-xs text-gray-700">
              <input type="checkbox" checked={acceptedTos} onChange={(e) => setAcceptedTos(e.target.checked)} />
              <span>
                I confirm I have a legitimate, documented authorisation to perform this lookup
                and that I will respect the local privacy laws applicable to the operator and the target.
              </span>
            </label>

            <button
              type="submit"
              disabled={!canSubmit}
              className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-white ${canSubmit ? IG_GRADIENT + ' hover:opacity-95' : 'bg-gray-300 cursor-not-allowed'}`}
            >
              <Play size={14} />
              {submitting ? 'Submitting…' : 'Run lookup'}
            </button>
          </form>

          {/* Recent jobs */}
          <div className="lg:col-span-2 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Recent lookups</h2>
              <button type="button" onClick={fetchJobs} className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900">
                <RefreshCw size={12} /> Refresh
              </button>
            </div>
            {loadingJobs ? (
              <div className="mt-4 text-sm text-gray-500">Loading…</div>
            ) : !jobs.length ? (
              <div className="mt-4 rounded-md border border-dashed border-gray-200 p-6 text-center text-sm text-gray-500">
                No lookup jobs yet. Run one from the form on the left.
              </div>
            ) : (
              <div className="mt-3 divide-y divide-gray-100">
                {jobs.map((job) => (
                  <button
                    type="button"
                    key={job.id}
                    onClick={() => setActiveId(job.id)}
                    className={`flex w-full items-center gap-3 px-1 py-2 text-left transition ${activeId === job.id ? 'bg-pink-50/50' : 'hover:bg-gray-50'}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900">@{job.username}</span>
                        <StatusPill status={job.status} />
                      </div>
                      <div className="text-[11px] text-gray-500">
                        #{job.id} • {(Array.isArray(job.methods) ? job.methods : []).length} methods
                        {' '}• {job.completed_methods}/{job.total_methods} done
                        {' '}• {job.total_findings} findings
                        {Number(job.budget_usd_spent) > 0 ? ` • $${Number(job.budget_usd_spent).toFixed(4)} spent` : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {['running', 'queued', 'pending'].includes(job.status) ? (
                        <span title="Cancel" onClick={(e) => { e.stopPropagation(); onCancel(job.id); }} className="rounded p-1 text-amber-600 hover:bg-amber-50">
                          <X size={14} />
                        </span>
                      ) : null}
                      <span title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(job.id); }} className="rounded p-1 text-red-600 hover:bg-red-50">
                        <Trash2 size={14} />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Active job detail */}
        {activeId ? (
          <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            {!activeJob ? (
              <div className="text-sm text-gray-500">{loadingActive ? 'Loading…' : 'Select a lookup to view findings.'}</div>
            ) : (
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold text-gray-900">@{activeJob.username}</h2>
                      <StatusPill status={activeJob.status} />
                    </div>
                    <div className="text-[12px] text-gray-500">
                      Job #{activeJob.id} • {activeJob.completed_methods}/{activeJob.total_methods} methods
                      {' '}• {activeJob.error_methods} errors
                      {' '}• {activeJob.total_findings} findings
                      {Number(activeJob.budget_usd_spent) > 0 ? ` • $${Number(activeJob.budget_usd_spent).toFixed(4)} spent` : ''}
                    </div>
                    {activeJob.stated_purpose ? (
                      <div className="mt-1 text-[12px] italic text-gray-600">
                        Stated purpose: {activeJob.stated_purpose}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button type="button" onClick={() => onExport(activeJob.id, 'csv')} className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50">
                      <Download size={12} /> CSV
                    </button>
                    <button type="button" onClick={() => onExport(activeJob.id, 'json')} className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50">
                      <Download size={12} /> JSON
                    </button>
                  </div>
                </div>

                {!findings.length ? (
                  <div className="mt-4 rounded-md border border-dashed border-gray-200 p-6 text-center text-sm text-gray-500">
                    {activeJob.status === 'completed'
                      ? 'No findings were extracted for this username.'
                      : 'Findings will appear here as methods complete.'}
                  </div>
                ) : (
                  <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                    {Array.from(groupedFindings.entries()).map(([kind, list]) => {
                      const meta = KIND_META[kind] || KIND_META.note;
                      const Icon = meta.icon;
                      return (
                        <div key={kind} className="rounded-md border border-gray-100 bg-gray-50 p-3">
                          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-800">
                            <Icon size={14} /> {meta.label} <span className="text-[11px] text-gray-500">({list.length})</span>
                          </div>
                          <div className="space-y-1.5">
                            {list.map((f) => <FindingRow key={f.id || `${f.method}-${f.value}`} finding={f} />)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
