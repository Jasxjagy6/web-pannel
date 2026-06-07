import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Shield,
  Phone,
  UserPlus,
  Eye,
  Image as ImageIcon,
  FileText,
  Gift,
  Cake,
  Forward,
  PhoneCall,
  MessageSquare,
  Users,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Play,
  RefreshCw,
  X,
  ChevronRight,
  ChevronDown,
  Globe,
  UserCheck,
  UserX,
  Crown,
  Hourglass,
  Power,
  Mail,
  SkipForward,
} from 'lucide-react';
import { useToast } from '../components/common/Toast';
import { listSessions } from '../api/sessions';
import {
  getPrivacyKeys,
  createPrivacyJob,
  listPrivacyJobs,
  getPrivacyJobItems,
  cancelPrivacyJob,
  sendEmailCode,
  verifyEmailCode,
} from '../api/privacy';
import { parseApiError, formatRelativeTime } from '../utils/formatters';
import SessionListSwitcher from '../components/common/SessionListSwitcher';

// ---------------------------------------------------------------------
// Static metadata for the 11 privacy keys exposed by the panel
// ---------------------------------------------------------------------
const PRIVACY_KEY_META = [
  {
    id: 'phone_number',
    label: 'Phone number',
    icon: Phone,
    description: 'Who can see your phone number on Telegram.',
    rules: ['everybody', 'contacts', 'nobody'],
  },
  {
    id: 'added_by_phone',
    label: 'Find me by phone',
    icon: UserPlus,
    description: 'Who can find your account by importing your phone number.',
    rules: ['everybody', 'contacts'],
  },
  {
    id: 'last_seen',
    label: 'Last seen & online',
    icon: Eye,
    description: 'Who can see when you were last on Telegram.',
    rules: ['everybody', 'contacts', 'nobody'],
  },
  {
    id: 'profile_photo',
    label: 'Profile picture',
    icon: ImageIcon,
    description: 'Who can see your profile picture.',
    rules: ['everybody', 'contacts', 'nobody'],
  },
  {
    id: 'bio',
    label: 'Bio',
    icon: FileText,
    description: 'Who can see your bio.',
    rules: ['everybody', 'contacts', 'nobody'],
  },
  {
    id: 'gifts',
    label: 'Gifts',
    icon: Gift,
    description: 'Who can send you gifts and see your gift collection.',
    rules: ['everybody', 'contacts', 'nobody'],
  },
  {
    id: 'birthday',
    label: 'Birthday',
    icon: Cake,
    description: 'Who can see your birthday.',
    rules: ['everybody', 'contacts', 'nobody'],
  },
  {
    id: 'forwards',
    label: 'Forwarded messages',
    icon: Forward,
    description: 'Who can link to your account when forwarding your messages.',
    rules: ['everybody', 'contacts', 'nobody'],
  },
  {
    id: 'calls',
    label: 'Voice calls',
    icon: PhoneCall,
    description: 'Who can call you on Telegram.',
    rules: ['everybody', 'contacts', 'nobody'],
  },
  {
    id: 'messages',
    label: 'Messages',
    icon: MessageSquare,
    description: 'Who can send you messages without you adding them first.',
    rules: ['everybody', 'premium', 'contacts', 'nobody'],
  },
  {
    id: 'invites',
    label: 'Group & channel invites',
    icon: Users,
    description: 'Who can add you to groups and channels.',
    rules: ['everybody', 'contacts', 'nobody'],
  },
];

const RULE_META = {
  everybody: { label: 'Everybody', icon: Globe, color: 'emerald' },
  contacts:  { label: 'Contacts',  icon: UserCheck, color: 'blue' },
  nobody:    { label: 'Nobody',    icon: UserX, color: 'rose' },
  premium:   { label: 'Premium',   icon: Crown, color: 'amber' },
};

// Auto-terminate-inactive-sessions presets. Mirrors Telegram's stock
// "If away for…" choices under Settings → Devices. Numeric values are
// the day-counts the backend will hand to account.SetAuthorizationTTL.
const AUTH_TTL_OPTIONS = [
  { value: 7,   label: '1 week'   },
  { value: 90,  label: '3 months' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year'   },
];

const RULE_COLOR_CLASSES = {
  emerald: {
    active: 'bg-emerald-500 text-white border-emerald-500 shadow-emerald-500/40',
    idle:   'border-white/5 text-gray-400 hover:border-emerald-500/40 hover:text-emerald-300',
  },
  blue: {
    active: 'bg-blue-500 text-white border-blue-500 shadow-blue-500/40',
    idle:   'border-white/5 text-gray-400 hover:border-blue-500/40 hover:text-blue-300',
  },
  rose: {
    active: 'bg-rose-500 text-white border-rose-500 shadow-rose-500/40',
    idle:   'border-white/5 text-gray-400 hover:border-rose-500/40 hover:text-rose-300',
  },
  amber: {
    active: 'bg-amber-500 text-white border-amber-500 shadow-amber-500/40',
    idle:   'border-white/5 text-gray-400 hover:border-amber-500/40 hover:text-amber-300',
  },
};

// ---------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------
function StatusBadge({ status }) {
  const meta = {
    pending:    { icon: Clock,         color: 'text-gray-400 bg-gray-500/10 border-gray-500/30' },
    running:    { icon: Loader2,       color: 'text-blue-300 bg-blue-500/10 border-blue-500/30', spin: true },
    completed:  { icon: CheckCircle2,  color: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
    succeeded:  { icon: CheckCircle2,  color: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
    failed:     { icon: XCircle,       color: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
    cancelled:  { icon: X,             color: 'text-gray-300 bg-gray-500/10 border-gray-500/30' },
    skipped:    { icon: AlertTriangle, color: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  }[status] || { icon: Clock, color: 'text-gray-400 bg-gray-500/10 border-gray-500/30' };
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium ${meta.color}`}>
      <Icon className={`h-3 w-3 ${meta.spin ? 'animate-spin' : ''}`} />
      {status}
    </span>
  );
}

function RuleSegment({ keyId, rules, value, onChange }) {
  return (
    <div className="grid grid-flow-col auto-cols-fr gap-2 mt-3">
      {rules.map((rule) => {
        const m = RULE_META[rule];
        const Icon = m.icon;
        const active = value === rule;
        const cls = RULE_COLOR_CLASSES[m.color];
        return (
          <button
            key={rule}
            type="button"
            onClick={() => onChange(keyId, rule)}
            className={`flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition-all ${
              active ? `${cls.active} shadow-md` : `bg-dark-900/40 ${cls.idle}`
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

function PrivacyKeyCard({ meta, value, onChange }) {
  const Icon = meta.icon;
  return (
    <div className="rounded-xl border border-white/5 bg-dark-800 p-4 hover:border-primary-500/20 transition">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary-500/10 p-2 text-primary-300 shrink-0">
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-white truncate">{meta.label}</h4>
            {value && (
              <span className="text-[11px] text-primary-300 font-medium">
                {RULE_META[value]?.label}
              </span>
            )}
          </div>
          <p className="text-[12px] text-gray-500 mt-0.5">{meta.description}</p>
          <RuleSegment
            keyId={meta.id}
            rules={meta.rules}
            value={value}
            onChange={onChange}
          />
        </div>
      </div>
    </div>
  );
}

function SessionPicker({ sessions, selected, onToggle, onSelectAll, onClear }) {
  // Backend listSessions returns camelCase fields (isLoggedIn / accountInfo)
  // — match both shapes defensively in case other call sites are added.
  const usable = sessions.filter((s) => {
    const loggedIn = s.isLoggedIn ?? s.is_logged_in;
    const status = String(s.status || '').toLowerCase();
    return loggedIn && ['active', 'uploaded'].includes(status);
  });
  return (
    <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Users className="w-4 h-4 text-primary-500" />
            Active sessions ({selected.length}/{usable.length} selected)
          </h3>
          <p className="text-[12px] text-gray-500 mt-0.5">
            Pick the accounts to apply these privacy settings to. Each account
            uses its bound proxy and persisted device identity.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onSelectAll(usable.map((s) => s.id))}
            className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-gray-300 hover:bg-white/5"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={onClear}
            className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-gray-300 hover:bg-white/5"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="mt-4 max-h-72 overflow-y-auto pr-1 space-y-2">
        {usable.length === 0 && (
          <div className="rounded-lg border border-dashed border-white/10 bg-dark-900/40 px-3 py-6 text-center text-xs text-gray-500">
            No logged-in sessions yet. Upload or create one first.
          </div>
        )}
        {usable.map((s) => {
          const isSelected = selected.includes(s.id);
          const info = s.accountInfo || s.account_info || {};
          const display =
            info.username ||
            [info.firstName, info.lastName].filter(Boolean).join(' ') ||
            s.phone ||
            `Session ${s.id}`;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onToggle(s.id)}
              className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition ${
                isSelected
                  ? 'border-primary-500/60 bg-primary-500/10'
                  : 'border-white/5 bg-dark-900/40 hover:border-white/10'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <input
                  type="checkbox"
                  checked={isSelected}
                  readOnly
                  className="rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500 shrink-0"
                />
                <div className="min-w-0">
                  <div className="text-sm text-white truncate">{display}</div>
                  <div className="text-[11px] text-gray-500 truncate">
                    {s.phone}{' '}
                    {info.username ? `· @${info.username}` : ''}
                  </div>
                </div>
              </div>
              <StatusBadge status={(s.status || '').toLowerCase()} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function JobItemDrawer({ job, onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!job) return;
    setLoading(true);
    try {
      const r = await getPrivacyJobItems(job.id);
      setItems(r.data?.data?.items || []);
    } finally {
      setLoading(false);
    }
  }, [job]);

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
              {job.total_sessions} sessions · {Object.keys(job.settings || {}).length} keys ·{' '}
              {formatRelativeTime(job.created_at)}
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
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Keys</th>
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
                const results = it.results || {};
                const okKeys = Object.entries(results).filter(
                  ([, v]) => v === 'ok'
                );
                const failKeys = Object.entries(results).filter(
                  ([, v]) => v !== 'ok'
                );
                return (
                  <tr
                    key={it.id}
                    className="border-t border-white/5 hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-2.5">
                      <div className="text-white text-sm">{display}</div>
                      <div className="text-[11px] text-gray-500">{it.phone}</div>
                    </td>
                    <td className="px-4 py-2.5"><StatusBadge status={it.status} /></td>
                    <td className="px-4 py-2.5 text-[12px]">
                      <div className="text-emerald-300">
                        {okKeys.length} ok
                      </div>
                      {failKeys.length > 0 && (
                        <div className="text-rose-300 truncate max-w-xs" title={failKeys.map(([k,v])=>`${k}: ${v}`).join('\n')}>
                          {failKeys.length} failed
                        </div>
                      )}
                    </td>
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

// ---------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------
export default function Privacy() {
  const { showSuccess, showError, showInfo } = useToast();
  const [sessions, setSessions] = useState([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
  const [sessionPickMode, setSessionPickMode] = useState('sessions');
  const [selectedSessionListId, setSelectedSessionListId] = useState('');
  const [settings, setSettings] = useState({});
  const [submitting, setSubmitting] = useState(false);
  // Auto-terminate (account.SetAuthorizationTTL) is its own pseudo-job
  // — it shares the session selector with the privacy bulk-set above
  // but has a single integer value (days), not a key/rule grid, so it
  // gets its own Apply button. Default unselected: nothing is picked.
  const [authTtlDays, setAuthTtlDays] = useState(null);
  const [authTtlSubmitting, setAuthTtlSubmitting] = useState(false);

  const [jobs, setJobs] = useState([]);
  const [drawerJob, setDrawerJob] = useState(null);
  const [openSettings, setOpenSettings] = useState(true);

  // Recovery email flow state
  const [emailAddress, setEmailAddress] = useState('');
  const [twoFAPassword, setTwoFAPassword] = useState('');
  const [emailFlowActive, setEmailFlowActive] = useState(false);
  const [emailQueue, setEmailQueue] = useState([]);
  const [emailCurrentIndex, setEmailCurrentIndex] = useState(0);
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  const [emailProcessing, setEmailProcessing] = useState(false);
  const [emailError, setEmailError] = useState('');

  const fetchSessions = useCallback(async () => {
    try {
      const r = await listSessions({ limit: 200 });
      setSessions(r.data?.data?.sessions || []);
    } catch (err) {
      console.warn('listSessions failed', parseApiError(err));
    }
  }, []);

  const fetchJobs = useCallback(async () => {
    try {
      const r = await listPrivacyJobs({ limit: 50 });
      setJobs(r.data?.data?.items || []);
    } catch (err) {
      console.warn('listPrivacyJobs failed', parseApiError(err));
    }
  }, []);

  useEffect(() => {
    // Pre-warm the keys endpoint as a connectivity check.
    getPrivacyKeys().catch(() => {});
    fetchSessions();
    fetchJobs();
  }, [fetchSessions, fetchJobs]);

  // Auto-refresh job table while there is an in-flight job.
  useEffect(() => {
    const hasActive = jobs.some(
      (j) => j.status === 'pending' || j.status === 'running'
    );
    if (!hasActive) return;
    const id = setInterval(fetchJobs, 3000);
    return () => clearInterval(id);
  }, [jobs, fetchJobs]);

  const setRule = (keyId, value) => {
    setSettings((prev) => {
      // Toggle off if user clicks the active rule again.
      if (prev[keyId] === value) {
        const { [keyId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [keyId]: value };
    });
  };

  const toggleSession = (id) =>
    setSelectedSessionIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const selectedKeyCount = useMemo(
    () => Object.keys(settings).length,
    [settings]
  );

  const submit = async () => {
    if (selectedKeyCount === 0) {
      showError('Pick at least one privacy option', 'Nothing to apply');
      return;
    }
    const usingList = sessionPickMode === 'list' && selectedSessionListId;
    if (!usingList && selectedSessionIds.length === 0) {
      showError('Pick at least one session (or pick a session list)', 'No targets');
      return;
    }
    if (sessionPickMode === 'list' && !selectedSessionListId) {
      showError('Pick a session list', 'No targets');
      return;
    }
    setSubmitting(true);
    try {
      const r = usingList
        ? await createPrivacyJob(settings, { sessionListId: Number(selectedSessionListId) })
        : await createPrivacyJob(settings, selectedSessionIds);
      const data = r.data?.data || {};
      showSuccess(
        `Job #${data.jobId} queued for ${data.sessionCount} session(s)` +
          (data.skipped ? ` (${data.skipped} skipped)` : ''),
        'Privacy job queued'
      );
      setSettings({});
      setSelectedSessionIds([]);
      setSelectedSessionListId('');
      setOpenSettings(false);
      fetchJobs();
    } catch (err) {
      showError(parseApiError(err), 'Could not queue privacy job');
    } finally {
      setSubmitting(false);
    }
  };

  const submitAuthTtl = async () => {
    if (!authTtlDays) {
      showError('Pick an auto-terminate interval first', 'Nothing to apply');
      return;
    }
    const usingList = sessionPickMode === 'list' && selectedSessionListId;
    if (!usingList && selectedSessionIds.length === 0) {
      showError('Pick at least one session (or pick a session list)', 'No targets');
      return;
    }
    if (sessionPickMode === 'list' && !selectedSessionListId) {
      showError('Pick a session list', 'No targets');
      return;
    }
    setAuthTtlSubmitting(true);
    try {
      const payload = { auth_ttl: authTtlDays };
      const r = usingList
        ? await createPrivacyJob(payload, { sessionListId: Number(selectedSessionListId) })
        : await createPrivacyJob(payload, selectedSessionIds);
      const data = r.data?.data || {};
      const labelMatch = AUTH_TTL_OPTIONS.find((o) => o.value === authTtlDays);
      const label = labelMatch ? labelMatch.label : `${authTtlDays} days`;
      showSuccess(
        `Auto-terminate (${label}) queued for ${data.sessionCount} session(s)` +
          (data.skipped ? ` (${data.skipped} skipped)` : ''),
        `Privacy job #${data.jobId}`
      );
      fetchJobs();
    } catch (err) {
      showError(parseApiError(err), 'Could not queue auto-terminate');
    } finally {
      setAuthTtlSubmitting(false);
    }
  };

  const currentEmailSession = useMemo(() => {
    if (!emailFlowActive || emailQueue.length === 0) return null;
    const item = emailQueue[emailCurrentIndex];
    if (!item) return null;
    return sessions.find((s) => s.id === item.sessionId) || null;
  }, [emailFlowActive, emailQueue, emailCurrentIndex, sessions]);

  const startEmailFlow = async () => {
    if (!emailAddress.trim() || !emailAddress.includes('@')) {
      showError('Enter a valid email address', 'Invalid email');
      return;
    }
    const usingList = sessionPickMode === 'list' && selectedSessionListId;
    if (!usingList && selectedSessionIds.length === 0) {
      showError('Pick at least one session (or pick a session list)', 'No targets');
      return;
    }
    const queue = selectedSessionIds.map((sid) => ({
      sessionId: sid,
      status: 'pending',
      error: null,
    }));
    setEmailQueue(queue);
    setEmailCurrentIndex(0);
    setEmailCodeSent(false);
    setEmailCode('');
    setEmailError('');
    setEmailFlowActive(true);
  };

  const advanceToNext = (queue) => {
    const nextIdx = queue.findIndex(
      (item, idx) => idx > emailCurrentIndex && item.status === 'pending'
    );
    if (nextIdx === -1) {
      const done = queue.filter((q) => q.status === 'done').length;
      const failed = queue.filter((q) => q.status === 'failed').length;
      showSuccess(
        `Email added to ${done} session(s)${failed ? `, ${failed} failed` : ''}`,
        'Recovery email complete'
      );
      setEmailFlowActive(false);
      setEmailQueue([]);
      setEmailCurrentIndex(0);
      setEmailCodeSent(false);
      setEmailCode('');
      setEmailError('');
      setEmailAddress('');
      setTwoFAPassword('');
    } else {
      setEmailCurrentIndex(nextIdx);
      setEmailCodeSent(false);
      setEmailCode('');
      setEmailError('');
    }
  };

  const handleSendEmailCode = async () => {
    const item = emailQueue[emailCurrentIndex];
    if (!item) return;
    setEmailProcessing(true);
    setEmailError('');
    setEmailCodeSent(false);
    setEmailCode('');
    try {
      await sendEmailCode(item.sessionId, emailAddress.trim(), twoFAPassword || undefined);
      setEmailCodeSent(true);
    } catch (err) {
      const msg = parseApiError(err);
      setEmailError(msg);
    } finally {
      setEmailProcessing(false);
    }
  };

  const handleVerifyEmailCode = async () => {
    if (!emailCode.trim()) {
      showError('Enter the verification code from the email', 'Code required');
      return;
    }
    const item = emailQueue[emailCurrentIndex];
    if (!item) return;
    setEmailProcessing(true);
    setEmailError('');
    try {
      await verifyEmailCode(item.sessionId, emailAddress.trim(), emailCode.trim());
      const updated = emailQueue.map((q, i) =>
        i === emailCurrentIndex ? { ...q, status: 'done' } : q
      );
      setEmailQueue(updated);
      advanceToNext(updated);
    } catch (err) {
      const msg = parseApiError(err);
      setEmailError(msg);
    } finally {
      setEmailProcessing(false);
    }
  };

  const skipCurrentSession = () => {
    const updated = emailQueue.map((q, i) =>
      i === emailCurrentIndex ? { ...q, status: 'skipped', error: 'Skipped by user' } : q
    );
    setEmailQueue(updated);
    advanceToNext(updated);
  };

  const cancelEmailFlow = () => {
    setEmailFlowActive(false);
    setEmailQueue([]);
    setEmailCurrentIndex(0);
    setEmailCodeSent(false);
    setEmailCode('');
    setEmailError('');
    showInfo('Email flow cancelled', '');
  };

  const cancel = async (id) => {
    if (!confirm(`Cancel privacy job #${id}? Pending sessions will be skipped.`)) return;
    try {
      await cancelPrivacyJob(id);
      showInfo('Cancellation requested', `Job #${id}`);
      fetchJobs();
    } catch (err) {
      showError(parseApiError(err), 'Cancel failed');
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary-500" />
            Privacy
          </h2>
          <p className="text-sm text-gray-400">
            Bulk-apply Telegram privacy settings (last seen, calls, invites,
            messages, &nbsp;…) across many accounts at once. Each account
            connects through its bound proxy and persisted device identity.
          </p>
        </div>
        <button
          onClick={fetchJobs}
          className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/5"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh history
        </button>
      </div>

      {/* Auto-terminate inactive sessions card.
          This wraps account.SetAuthorizationTTL — the same Telegram
          setting as Settings → Devices → "If away for…" on the
          official client. It re-uses the session picker below so the
          operator can apply the same TTL to one, many, or a saved list
          of accounts in a single click. */}
      <div className="rounded-2xl border border-white/5 bg-dark-800/40 p-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary-500/10 p-2 text-primary-300 shrink-0">
              <Hourglass className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white">
                Auto-terminate inactive sessions
              </h3>
              <p className="text-[12px] text-gray-500 mt-0.5 max-w-2xl">
                Mirrors Telegram’s “If away for…” setting under
                Settings → Devices. Pick how long an authorization
                (any device logged into the account) may stay inactive
                before Telegram auto-terminates it. Applies to every
                account picked below in one MTProto round-trip per
                session.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 lg:flex-nowrap lg:items-center">
            {AUTH_TTL_OPTIONS.map((opt) => {
              const active = authTtlDays === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setAuthTtlDays(active ? null : opt.value)}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-all ${
                    active
                      ? 'bg-primary-500 text-white border-primary-500 shadow-md shadow-primary-500/30'
                      : 'bg-dark-900/40 border-white/5 text-gray-400 hover:border-primary-500/40 hover:text-primary-300'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={submitAuthTtl}
              disabled={
                authTtlSubmitting ||
                !authTtlDays ||
                (sessionPickMode === 'list'
                  ? !selectedSessionListId
                  : selectedSessionIds.length === 0)
              }
              className="flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-primary-600 to-primary-500 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-primary-500/20 hover:shadow-primary-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {authTtlSubmitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Power className="w-3.5 h-3.5" />
              )}
              {sessionPickMode === 'list'
                ? 'Apply to session list'
                : `Apply to ${selectedSessionIds.length} session${selectedSessionIds.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>

      {/* Add Recovery Email card.
          Interactive, one-at-a-time flow: for each selected session the
          panel sends a verification code to the email via Telegram's
          MTProto API, then asks the user to enter the code. Once
          verified the email is set as recovery on that account and the
          panel moves to the next session. */}
      <div className="rounded-2xl border border-white/5 bg-dark-800/40 p-5">
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary-500/10 p-2 text-primary-300 shrink-0">
              <Mail className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white">
                Add recovery email
              </h3>
              <p className="text-[12px] text-gray-500 mt-0.5 max-w-2xl">
                Add a recovery email to selected sessions one at a time.
                Telegram sends a verification code to the email — you enter
                it here to confirm. If a session has 2FA (cloud password)
                enabled, enter it below so the panel can authorize the change.
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-400 mb-1.5">
                Recovery email
              </label>
              <input
                type="email"
                value={emailAddress}
                onChange={(e) => setEmailAddress(e.target.value)}
                placeholder="recovery@example.com"
                disabled={emailFlowActive}
                className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:opacity-40"
              />
            </div>
            <div className="sm:w-56">
              <label className="block text-xs font-medium text-gray-400 mb-1.5">
                2FA password (if needed)
              </label>
              <input
                type="password"
                value={twoFAPassword}
                onChange={(e) => setTwoFAPassword(e.target.value)}
                placeholder="Cloud password"
                disabled={emailFlowActive}
                className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:opacity-40"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={startEmailFlow}
            disabled={
              emailFlowActive ||
              !emailAddress.trim() ||
              (sessionPickMode === 'list'
                ? !selectedSessionListId
                : selectedSessionIds.length === 0)
            }
            className="flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-primary-600 to-primary-500 px-4 py-2.5 text-xs font-semibold text-white shadow-md shadow-primary-500/20 hover:shadow-primary-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition w-full sm:w-auto"
          >
            <Mail className="w-3.5 h-3.5" />
            {sessionPickMode === 'list'
              ? 'Start for session list'
              : `Start for ${selectedSessionIds.length} session${selectedSessionIds.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>

      {/* Settings + Sessions */}
      <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-6">
        {/* Privacy options */}
        <div className="rounded-2xl border border-white/5 bg-dark-800/40 p-5">
          <button
            type="button"
            onClick={() => setOpenSettings((v) => !v)}
            className="flex items-center justify-between w-full text-left"
          >
            <div className="flex items-center gap-2">
              {openSettings ? (
                <ChevronDown className="w-4 h-4 text-gray-400" />
              ) : (
                <ChevronRight className="w-4 h-4 text-gray-400" />
              )}
              <h3 className="text-sm font-semibold text-white">
                Privacy options
              </h3>
              <span className="text-xs text-gray-500">
                ({selectedKeyCount}/{PRIVACY_KEY_META.length} configured)
              </span>
            </div>
          </button>

          {openSettings && (
            <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
              {PRIVACY_KEY_META.map((meta) => (
                <PrivacyKeyCard
                  key={meta.id}
                  meta={meta}
                  value={settings[meta.id]}
                  onChange={setRule}
                />
              ))}
            </div>
          )}
        </div>

        {/* Sessions + submit */}
        <div className="space-y-4">
          <SessionListSwitcher
            mode={sessionPickMode}
            onModeChange={setSessionPickMode}
            selectedSessionListId={selectedSessionListId}
            onSelectedSessionListIdChange={setSelectedSessionListId}
          />
          {sessionPickMode === 'sessions' && (
            <SessionPicker
              sessions={sessions}
              selected={selectedSessionIds}
              onToggle={toggleSession}
              onSelectAll={setSelectedSessionIds}
              onClear={() => setSelectedSessionIds([])}
            />
          )}
          <button
            onClick={submit}
            disabled={
              submitting ||
              selectedKeyCount === 0 ||
              (sessionPickMode === 'list'
                ? !selectedSessionListId
                : selectedSessionIds.length === 0)
            }
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary-600 to-primary-500 py-3 text-sm font-semibold text-white shadow-lg shadow-primary-500/20 hover:shadow-primary-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {sessionPickMode === 'list'
              ? 'Apply to session list'
              : `Apply to ${selectedSessionIds.length} session${selectedSessionIds.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>

      {/* Job history */}
      <div className="rounded-2xl border border-white/5 bg-dark-800 overflow-hidden">
        <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary-500" />
            Job history ({jobs.length})
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-gray-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Job</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Sessions</th>
                <th className="text-left px-4 py-2 font-medium">Keys</th>
                <th className="text-left px-4 py-2 font-medium">Created</th>
                <th className="text-right px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-sm text-gray-500"
                  >
                    No jobs yet. Pick options + sessions above and hit Apply.
                  </td>
                </tr>
              )}
              {jobs.map((j) => {
                const settingsCount = Object.keys(j.settings || {}).length;
                const summary = `${j.succeeded_count}/${j.total_sessions} ok`;
                const failed = j.failed_count > 0 ? ` · ${j.failed_count} failed` : '';
                const skipped = j.skipped_count > 0 ? ` · ${j.skipped_count} skipped` : '';
                return (
                  <tr key={j.id} className="border-t border-white/5 hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5">
                      <div className="text-white">#{j.id}</div>
                      {j.error_message && (
                        <div className="text-[11px] text-rose-300 max-w-xs truncate" title={j.error_message}>
                          {j.error_message}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5"><StatusBadge status={j.status} /></td>
                    <td className="px-4 py-2.5 text-[12px] text-gray-300">
                      {summary}
                      <span className="text-rose-300">{failed}</span>
                      <span className="text-amber-300">{skipped}</span>
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-gray-400">{settingsCount}</td>
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

      {/* Recovery email interactive modal */}
      {emailFlowActive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div
            className="relative w-full max-w-2xl max-h-[90vh] overflow-hidden rounded-2xl border border-white/10 bg-dark-800 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
              <div>
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Mail className="w-4 h-4 text-primary-500" />
                  Add recovery email
                </h3>
                <p className="text-[12px] text-gray-500">
                  {emailAddress} — Session {emailCurrentIndex + 1} of {emailQueue.length}
                </p>
              </div>
              <button
                onClick={cancelEmailFlow}
                className="rounded-md border border-white/10 px-2 py-1 text-xs text-gray-300 hover:bg-white/5"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {currentEmailSession && (
                <div className="rounded-lg border border-white/5 bg-dark-900/60 p-4">
                  <div className="text-sm text-white font-medium">
                    {currentEmailSession.phone}
                    {(currentEmailSession.account_info?.username || currentEmailSession.accountInfo?.username) && (
                      <span className="text-gray-400 ml-2">
                        @{currentEmailSession.account_info?.username || currentEmailSession.accountInfo?.username}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    {((currentEmailSession.account_info?.firstName || currentEmailSession.accountInfo?.firstName) || '') +
                     ' ' +
                     ((currentEmailSession.account_info?.lastName || currentEmailSession.accountInfo?.lastName) || '')}
                  </div>
                </div>
              )}

              {!emailCodeSent && (
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSendEmailCode}
                    disabled={emailProcessing}
                    className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-primary-600 to-primary-500 px-4 py-2.5 text-sm font-semibold text-white shadow-md disabled:opacity-40 transition"
                  >
                    {emailProcessing ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Mail className="w-4 h-4" />
                    )}
                    {emailProcessing ? 'Sending code...' : 'Send verification code'}
                  </button>
                  <button
                    onClick={skipCurrentSession}
                    disabled={emailProcessing}
                    className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2.5 text-sm text-gray-300 hover:bg-white/5 disabled:opacity-40 transition"
                  >
                    <SkipForward className="w-4 h-4" />
                    Skip
                  </button>
                </div>
              )}

              {emailCodeSent && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm text-emerald-300">
                    <CheckCircle2 className="w-4 h-4" />
                    Code sent! Check your email inbox.
                  </div>
                  <div className="flex gap-3">
                    <input
                      type="text"
                      value={emailCode}
                      onChange={(e) => setEmailCode(e.target.value)}
                      placeholder="Enter verification code"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && emailCode.trim()) handleVerifyEmailCode();
                      }}
                      className="flex-1 rounded-lg border border-white/10 bg-dark-900 px-3 py-2.5 text-sm text-white placeholder:text-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                    />
                    <button
                      onClick={handleVerifyEmailCode}
                      disabled={emailProcessing || !emailCode.trim()}
                      className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-primary-600 to-primary-500 px-4 py-2.5 text-sm font-semibold text-white shadow-md disabled:opacity-40 transition"
                    >
                      {emailProcessing ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4" />
                      )}
                      Verify
                    </button>
                    <button
                      onClick={skipCurrentSession}
                      disabled={emailProcessing}
                      className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2.5 text-sm text-gray-300 hover:bg-white/5 disabled:opacity-40 transition"
                    >
                      <SkipForward className="w-4 h-4" />
                      Skip
                    </button>
                  </div>
                  <button
                    onClick={handleSendEmailCode}
                    disabled={emailProcessing}
                    className="text-xs text-primary-400 hover:text-primary-300 underline"
                  >
                    Resend code
                  </button>
                </div>
              )}

              {emailError && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3">
                  <XCircle className="w-4 h-4 text-rose-300 mt-0.5 shrink-0" />
                  <div className="text-sm text-rose-300">{emailError}</div>
                </div>
              )}

              <div className="border-t border-white/5 pt-3">
                <div className="text-xs font-medium text-gray-400 mb-2">
                  Progress ({emailQueue.filter((q) => q.status === 'done').length} done,{' '}
                  {emailQueue.filter((q) => q.status === 'failed').length} failed,{' '}
                  {emailQueue.filter((q) => q.status === 'skipped').length} skipped)
                </div>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {emailQueue.map((item, idx) => {
                    const s = sessions.find((sess) => sess.id === item.sessionId);
                    const display = s?.phone || `Session ${item.sessionId}`;
                    const isCurrent = idx === emailCurrentIndex;
                    return (
                      <div
                        key={item.sessionId}
                        className={`flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-xs ${
                          isCurrent
                            ? 'bg-primary-500/10 border border-primary-500/30'
                            : 'bg-dark-900/40'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {item.status === 'pending' && <Clock className="w-3 h-3 text-gray-500 shrink-0" />}
                          {item.status === 'done' && <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />}
                          {item.status === 'failed' && <XCircle className="w-3 h-3 text-rose-400 shrink-0" />}
                          {item.status === 'skipped' && <SkipForward className="w-3 h-3 text-amber-400 shrink-0" />}
                          {isCurrent && item.status === 'pending' && emailProcessing && (
                            <Loader2 className="w-3 h-3 text-blue-400 animate-spin shrink-0" />
                          )}
                          <span className="text-white truncate">{display}</span>
                        </div>
                        {item.error && (
                          <span className="text-rose-400 truncate max-w-[180px]" title={item.error}>
                            {item.error}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <JobItemDrawer job={drawerJob} onClose={() => setDrawerJob(null)} />
    </div>
  );
}
