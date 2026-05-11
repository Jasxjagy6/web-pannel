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
  recoverSession,
} from '../api/sessions';
import { sessionListsAPI } from '../api/sessionLists';
import { parseApiError, formatRelativeTime, formatNumber } from '../utils/formatters';
import { useToast } from '../components/common/Toast';
import { Modal } from '../components/common/Modal';
import StatusBadge from '../components/common/StatusBadge';
import SessionCloneExportModal from '../components/common/SessionCloneExportModal';
import SessionBulkLoginModal from '../components/common/SessionBulkLoginModal';
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
  LifeBuoy,
  ShieldAlert,
  Clock,
} from 'lucide-react';

// --- Helper: format file size ---
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Derive a human-friendly account-status descriptor from the row.
 *
 * The list endpoint returns the row in camelCase; older callers (and the
 * detail modal that takes a single session via getSessionById) sometimes
 * pass through the raw snake_case shape. Normalize both so this helper
 * works regardless of where the session object came from.
 *
 * Returns one of:
 *   - { tone: 'red',     icon: '⛔', label: 'Banned'     }   (status=revoked, USER_DEACTIVATED, etc.)
 *   - { tone: 'red',     icon: '⛔', label: 'Auth revoked' } (Telegram revoked the auth key)
 *   - { tone: 'amber',   icon: '⚠',  label: 'Restricted' }  (account_info.isRestricted)
 *   - { tone: 'amber',   icon: '⚠',  label: 'Login error' } (status=error)
 *   - { tone: 'sky',     icon: '★',  label: 'Premium'    }  (account_info.isPremium)
 *   - { tone: 'emerald', icon: '✓',  label: 'Verified'   }  (account_info.isVerified)
 *   - { tone: 'emerald', icon: '●',  label: 'Active'     }  (is_logged_in & status=active)
 *   - { tone: 'gray',    icon: '○',  label: 'Uploaded'   }  (status=uploaded, never logged in)
 *   - { tone: 'gray',    icon: '○',  label: 'Inactive'   }  (default)
 */
function deriveAccountState(session) {
  if (!session) return { tone: 'gray', icon: '○', label: 'Unknown' };
  const info =
    (typeof session.accountInfo === 'string'
      ? safeParseJSON(session.accountInfo)
      : session.accountInfo) ||
    (typeof session.account_info === 'string'
      ? safeParseJSON(session.account_info)
      : session.account_info) ||
    {};
  const status = (session.status || '').toLowerCase();
  const loggedIn = session.isLoggedIn ?? session.is_logged_in ?? false;

  if (status === 'revoked') {
    const reason =
      (info.lastErrorCode && /USER_DEACTIVATED/i.test(info.lastErrorCode)) ||
      /USER_DEACTIVATED|BANNED/i.test(String(info.lastError || ''))
        ? 'Banned'
        : 'Auth revoked';
    return { tone: 'red', icon: '⛔', label: reason };
  }
  if (status === 'expired') return { tone: 'red', icon: '⛔', label: 'Expired' };
  if (info.isRestricted) return { tone: 'amber', icon: '⚠', label: 'Restricted' };
  if (status === 'error') return { tone: 'amber', icon: '⚠', label: 'Login error' };
  if (loggedIn) {
    if (info.isPremium) return { tone: 'sky', icon: '★', label: 'Premium' };
    if (info.isVerified) return { tone: 'emerald', icon: '✓', label: 'Verified' };
    return { tone: 'emerald', icon: '●', label: 'Active' };
  }
  if (status === 'uploaded') return { tone: 'gray', icon: '○', label: 'Uploaded' };
  return { tone: 'gray', icon: '○', label: 'Inactive' };
}

const ACCOUNT_TONE_CLASSES = {
  red: 'text-red-400',
  amber: 'text-amber-400',
  sky: 'text-sky-400',
  emerald: 'text-emerald-400',
  gray: 'text-gray-500',
};

/**
 * One-line account status indicator shown directly under each session
 * row's phone+username. Compact (single line, no background pill) so it
 * doesn't crowd the row layout but still clearly visible at a glance.
 */
function AccountStatusLine({ session }) {
  const state = deriveAccountState(session);
  return (
    <p className={`mt-0.5 text-[11px] font-medium flex items-center gap-1 ${ACCOUNT_TONE_CLASSES[state.tone] || ACCOUNT_TONE_CLASSES.gray}`}>
      <span aria-hidden>{state.icon}</span>
      <span>{state.label}</span>
    </p>
  );
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
      (f) => /\.(session|txt|json|zip)$/i.test(f.name)
    );
    const skipped = all.length - valid.length;
    if (skipped > 0 && showWarning) {
      showWarning(
        `${skipped} file${skipped === 1 ? '' : 's'} skipped (only .session, .txt, .json, .zip allowed).`
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
      // Capture the per-file results so the parent can offer to
      // group every successfully-uploaded session into a session
      // list right after the upload finishes (the "organise" prompt).
      const resp = await uploadSessions(formData);
      const result = resp?.data?.data || {};
      const successfulIds = Array.isArray(result.results)
        ? result.results
            .filter((r) => r && (r.success || r.sessionId) && !r.error)
            .map((r) => r.sessionId)
            .filter((v) => v != null)
        : [];
      onUpload(files.length, null, {
        successful: result.successful ?? successfulIds.length,
        failed: result.failed ?? 0,
        sessionIds: successfulIds,
      });
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
          or click to browse &middot; .session, .txt, .json, .zip
        </p>
        <p className="mt-1 text-[11px] text-gray-600">
          Drop a .zip and we'll auto-extract every session inside.
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
            {/*
              Cooldown card — always rendered so the operator can see
              whether this session is currently locked out by Telegram
              flood/peer-flood protection. When on cooldown the card
              shows the remaining time and the reason; otherwise it
              shows "Eligible" so the field is visibly tracked.
            */}
            <div className="rounded-lg border border-white/5 bg-dark-900 p-4 sm:col-span-2">
              <div className="flex items-center gap-2 text-gray-400 mb-1">
                <Clock className="w-4 h-4" />
                <span className="text-xs uppercase tracking-wider">Cooldown</span>
              </div>
              {(() => {
                const onCooldown =
                  !!session.is_on_cooldown ||
                  !!(session.cooldown_until && new Date(session.cooldown_until).getTime() > Date.now());
                const remaining = (() => {
                  if (typeof session.cooldown_remaining_seconds === 'number') {
                    return session.cooldown_remaining_seconds;
                  }
                  if (session.cooldown_until) {
                    const ms = new Date(session.cooldown_until).getTime() - Date.now();
                    return Math.max(0, Math.ceil(ms / 1000));
                  }
                  return 0;
                })();
                if (!onCooldown || remaining <= 0) {
                  return (
                    <p className="text-emerald-400 font-medium flex items-center gap-2">
                      <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
                      Eligible — no active cooldown
                    </p>
                  );
                }
                return (
                  <div>
                    <p className="text-amber-300 font-medium flex items-center gap-2">
                      <Clock className="w-4 h-4" />
                      {formatCooldownLabel(remaining)} remaining
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      Reason: <span className="text-gray-400">{session.cooldown_reason || 'flood'}</span>
                      {session.cooldown_set_at ? (
                        <>
                          <span className="mx-1.5">·</span>
                          Set at <span className="text-gray-400">
                            {new Date(session.cooldown_set_at).toLocaleString()}
                          </span>
                        </>
                      ) : null}
                    </p>
                    <p className="text-xs text-gray-500 mt-2 leading-relaxed">
                      Group-add and bulk-message jobs will skip this session
                      until the cooldown expires. Login, 2FA, privacy and
                      delete actions remain enabled.
                    </p>
                  </div>
                );
              })()}
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

        {/* Account status (ban / premium / verified / restricted / etc.) */}
        <SessionAccountStatusBlock session={session} />

        {/* Anti-revoke Phase 1+3: device + DC + risk visibility */}
        <SessionAntiRevokeBlock session={session} />
      </div>
    </Modal>
  );
}

/**
 * Account-status block shown when the eye icon is tapped.
 *
 * Pulls everything we know about the underlying Telegram account from
 * the row + account_info JSONB and renders it as a key/value table:
 *
 *   - Health pill (Banned / Auth revoked / Restricted / Active / Premium / etc.)
 *   - Telegram numeric ID, first/last name, username, phone
 *   - Premium / verified / restricted booleans
 *   - Last login attempt timestamp + outcome
 *   - Last error code / message (if revoked or errored)
 *
 * This is the "tap the eye icon to see proper account status" surface
 * the user asked for — read-only, dense, and tolerant of whichever shape
 * the parent passed (camelCase from listSessions, or snake_case from
 * getSessionById / SSE).
 */
function SessionAccountStatusBlock({ session }) {
  const state = deriveAccountState(session);
  const info =
    (typeof session.accountInfo === 'string'
      ? safeParseJSON(session.accountInfo)
      : session.accountInfo) ||
    (typeof session.account_info === 'string'
      ? safeParseJSON(session.account_info)
      : session.account_info) ||
    {};

  const tonePill = {
    red: 'bg-red-500/15 text-red-400 border-red-500/30',
    amber: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    sky: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
    emerald: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    gray: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  }[state.tone] || 'bg-gray-500/15 text-gray-400 border-gray-500/30';

  const bool = (v, yes = 'Yes', no = 'No') => (v ? yes : no);
  const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

  const rows = [
    ['Telegram ID', info.telegramId ?? info.telegram_id ?? '—'],
    ['First name', info.firstName ?? info.first_name ?? '—'],
    ['Last name', info.lastName ?? info.last_name ?? '—'],
    ['Username', info.username ? `@${info.username}` : '—'],
    ['Phone', info.phone || session.phone || '—'],
    ['Premium', bool(truthy(info.isPremium ?? info.is_premium))],
    ['Verified', bool(truthy(info.isVerified ?? info.is_verified))],
    ['Restricted', bool(truthy(info.isRestricted ?? info.is_restricted))],
    [
      'Last login attempt',
      info.lastLoginAttempt
        ? formatRelativeTime(info.lastLoginAttempt)
        : '—',
    ],
    [
      'Last login outcome',
      info.lastLoginAttempt
        ? truthy(info.loginSuccess ?? info.login_success)
          ? 'Success'
          : 'Failed'
        : '—',
    ],
  ];
  if (info.lastErrorCode || info.lastError) {
    rows.push([
      'Last error',
      `${info.lastErrorCode || ''}${info.lastErrorCode && info.lastError ? ' — ' : ''}${info.lastError || ''}`,
    ]);
  }

  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
        Account Status
      </h4>
      <div className="rounded-lg border border-white/5 bg-dark-900 p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-sm font-medium ${tonePill}`}>
            <span aria-hidden>{state.icon}</span>
            <span>{state.label}</span>
          </span>
          {(session.isLoggedIn ?? session.is_logged_in) ? (
            <span className="text-xs text-gray-500">Logged in</span>
          ) : (
            <span className="text-xs text-gray-500">Not logged in</span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3">
              <span className="text-xs uppercase tracking-wider text-gray-500">{k}</span>
              <span className="text-gray-200 truncate text-right">{v ?? '—'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Anti-revoke (Telegram) — surfaces what device + DC + proxy country
 * the session is bound to, plus the live risk score (Phase 3 §B16).
 *
 * Reads `device_identity` JSONB if present (set by identityService) +
 * `dc_id`/`dc_ip`/`dc_port` (Phase 1 §B4) + `risk_score` from the
 * tg_session_health row (joined into the GET /api/sessions response).
 */
function SessionAntiRevokeBlock({ session }) {
  const id =
    typeof session.device_identity === 'string'
      ? safeParseJSON(session.device_identity)
      : session.device_identity || null;

  const platform = id?.platform || '—';
  const deviceModel = id?.deviceModel || '—';
  const systemVersion = id?.systemVersion || '—';
  const appVersion = id?.appVersion || '—';
  const langCode = id?.langCode || '—';
  const country = id?.country ? String(id.country).toUpperCase() : '—';
  const tz = id?.timezone || '—';

  const dcText = session.dc_id
    ? `DC${session.dc_id}${session.dc_ip ? ` (${session.dc_ip}:${session.dc_port || 443})` : ''}`
    : 'unpinned';

  const riskScore = Number(session.risk_score ?? session?.tg_health?.risk_score ?? 0) || 0;
  const riskColor =
    riskScore >= 0.65
      ? 'text-red-400 bg-red-500/15'
      : riskScore >= 0.4
      ? 'text-amber-400 bg-amber-500/15'
      : 'text-emerald-400 bg-emerald-500/15';
  const riskLabel = riskScore >= 0.65 ? 'High' : riskScore >= 0.4 ? 'Watch' : 'Healthy';

  const platformPill =
    {
      android: 'bg-emerald-500/15 text-emerald-300',
      ios: 'bg-sky-500/15 text-sky-300',
      desktop: 'bg-violet-500/15 text-violet-300',
      web: 'bg-orange-500/15 text-orange-300',
    }[platform] || 'bg-gray-500/15 text-gray-300';

  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
        Anti-revoke posture
      </h4>
      <div className="rounded-lg border border-white/5 bg-dark-900 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${platformPill}`}>
            {platform.toUpperCase()}
          </span>
          <span className="inline-flex items-center rounded-full px-2.5 py-1 text-xs bg-gray-700 text-gray-200">
            {deviceModel}
          </span>
          <span className="inline-flex items-center rounded-full px-2.5 py-1 text-xs bg-gray-700 text-gray-200">
            {systemVersion} · v{appVersion}
          </span>
          <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${riskColor}`}>
            Risk {riskScore.toFixed(2)} ({riskLabel})
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Locale</div>
            <div className="text-gray-200">
              {langCode}{country !== '—' ? ` · ${country}` : ''}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Timezone</div>
            <div className="text-gray-200">{tz}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Pinned DC</div>
            <div className="text-gray-200 font-mono">{dcText}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Last ping</div>
            <div className="text-gray-200">
              {session.last_ping_at ? formatRelativeTime(session.last_ping_at) : '—'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Compact device + DC cell for the desktop sessions table.
 */
function DeviceDcCell({ session }) {
  const id =
    typeof session.device_identity === 'string'
      ? safeParseJSON(session.device_identity)
      : session.device_identity || null;
  if (!id) {
    return <span className="text-xs text-gray-500">unknown</span>;
  }
  const platform = id.platform || '—';
  const deviceModel = id.deviceModel || '—';
  const dcText = session.dc_id
    ? `DC${session.dc_id}`
    : '—';
  const platformPill =
    {
      android: 'bg-emerald-500/15 text-emerald-300',
      ios: 'bg-sky-500/15 text-sky-300',
      desktop: 'bg-violet-500/15 text-violet-300',
      web: 'bg-orange-500/15 text-orange-300',
    }[platform] || 'bg-gray-500/15 text-gray-300';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className={`text-[10px] font-medium uppercase tracking-wider rounded px-1.5 py-0.5 ${platformPill}`}>
          {platform}
        </span>
        <span className="text-xs text-gray-300 truncate max-w-[140px]" title={deviceModel}>
          {deviceModel}
        </span>
      </div>
      <span className="text-[11px] text-gray-500 font-mono">{dcText}</span>
    </div>
  );
}

/**
 * BYO Proxy (Phase 3 §5.4): per-session pinned proxy summary cell.
 *
 * - Country flag + label/host
 * - Egress IP (from proxies.metadata.egress_ip)
 * - Health dot:
 *     green   → last_health_ok = true and last_health_check < 1h ago
 *     yellow  → stale (last_health_check older than 1h)
 *     red     → not bound or last_health_ok = false
 */
function ProxyCell({ session }) {
  const proxy = session.proxy;
  if (!proxy || !proxy.host) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-red-400">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500" />
        no proxy
      </span>
    );
  }
  const cc = proxy.country_code || '';
  const flag = cc && /^[a-zA-Z]{2}$/.test(cc)
    ? String.fromCodePoint(...[...cc.toLowerCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 97))
    : '🌐';
  const last = proxy.last_health_check ? new Date(proxy.last_health_check).getTime() : 0;
  const ageMs = last ? Date.now() - last : Infinity;
  let dot = 'bg-red-500';
  if (proxy.is_working && proxy.last_health_ok && ageMs < 60 * 60 * 1000) dot = 'bg-green-500';
  else if (proxy.is_working && proxy.last_health_ok) dot = 'bg-yellow-400';
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{}}>
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
        </span>
        <span className="text-base leading-none">{flag}</span>
        <span className="text-xs text-gray-200 truncate max-w-[120px]" title={`${proxy.host}:${proxy.port}`}>
          {proxy.label || `${proxy.host}:${proxy.port}`}
        </span>
      </div>
      <span className="text-[10px] text-gray-500 font-mono truncate max-w-[140px]">
        {proxy.protocol?.toUpperCase()}{proxy.egress_ip ? ` · ${proxy.egress_ip}` : ''}
      </span>
    </div>
  );
}

/**
 * Compact risk pill driven by tg_session_health.risk_score.
 * Tooltip explains the color thresholds (matches the §B16 weights).
 */
/**
 * Anti-revoke summary banner shown at the top of the sessions page.
 * Aggregates risk score + re-link state so operators see one number
 * instead of having to scan every row.
 */
function AntiRevokeSummary({ sessions }) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  const total = sessions.length;
  let highRisk = 0;
  let watch = 0;
  let needReauth = 0;
  for (const s of sessions) {
    const status = String(s.status || '').toLowerCase();
    if (status === 'revoked' || s?.tg_health?.last_reauth_required_at) {
      needReauth++;
      continue;
    }
    const score = Number(s.risk_score ?? s?.tg_health?.risk_score ?? 0) || 0;
    if (score >= 0.65) highRisk++;
    else if (score >= 0.4) watch++;
  }
  if (highRisk === 0 && needReauth === 0 && watch === 0) {
    return (
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm">
        <div className="flex items-center gap-2 text-emerald-300">
          <ShieldCheckIcon className="w-4 h-4" />
          <span className="font-medium">Anti-revoke posture: healthy</span>
        </div>
        <div className="mt-1 text-xs text-emerald-200/70">
          All {total} session{total === 1 ? '' : 's'} below the 0.65 risk gate. No re-link required.
        </div>
      </div>
    );
  }
  const tone =
    needReauth > 0 || highRisk > 0
      ? 'border-red-500/30 bg-red-500/10 text-red-200'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  return (
    <div className={`rounded-xl border ${tone} px-4 py-3 text-sm`}>
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="w-4 h-4" />
        Anti-revoke posture: action recommended
      </div>
      <div className="mt-1 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
        <div>
          <span className="font-semibold">{needReauth}</span>
          <span className="opacity-80"> session{needReauth === 1 ? '' : 's'} need re-link (revoked).</span>
        </div>
        <div>
          <span className="font-semibold">{highRisk}</span>
          <span className="opacity-80"> high-risk (≥0.65) — scrape/messaging will be throttled.</span>
        </div>
        <div>
          <span className="font-semibold">{watch}</span>
          <span className="opacity-80"> watch-list (0.40–0.65) — still safe to use.</span>
        </div>
      </div>
    </div>
  );
}

function RiskPill({ session }) {
  const score = Number(session.risk_score ?? session?.tg_health?.risk_score ?? 0) || 0;
  const isReauth =
    String(session.status || '').toLowerCase() === 'revoked' ||
    !!session?.tg_health?.last_reauth_required_at;
  if (isReauth) {
    return (
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-red-500/20 text-red-300"
        title="Telegram revoked or removed this session — re-link required."
      >
        Re-link
      </span>
    );
  }
  const cls =
    score >= 0.65
      ? 'bg-red-500/20 text-red-300'
      : score >= 0.4
      ? 'bg-amber-500/20 text-amber-300'
      : 'bg-emerald-500/15 text-emerald-300';
  const label = score >= 0.65 ? 'High' : score >= 0.4 ? 'Watch' : 'OK';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}
      title={`Anti-revoke risk score: ${score.toFixed(3)} — High≥0.65 throttles scrape/messaging.`}
    >
      {label}
      <span className="ml-1 text-[10px] font-mono opacity-75">{score.toFixed(2)}</span>
    </span>
  );
}

/**
 * Format a remaining-seconds value into a short, human-friendly
 * cooldown label ("12m 03s" / "1h 12m" / "2d 03h"). Used by both the
 * Sessions row badge and the bulk-action banner.
 */
function formatCooldownLabel(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return `${m}m ${rs.toString().padStart(2, '0')}s`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m.toString().padStart(2, '0')}m`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return `${d}d ${h.toString().padStart(2, '0')}h`;
}

/**
 * Render an inline "Cooldown 12m" pill if the session row is currently
 * locked out by `sessionCooldown.markFloodCooldown(...)` (PEER_FLOOD /
 * FLOOD_WAIT). The pill is intentionally distinct from RiskPill /
 * StatusBadge so operators can see at a glance which sessions will be
 * skipped by group-add / bulk-message jobs.
 *
 * Backend-side, `groupService.validateSessionsOwnership` and
 * `messageService._verifyMultipleSessionsOwnership` already filter
 * cooldown rows out of every job — this badge is the user-facing
 * counterpart so the operator knows why a particular session was
 * dropped from the eligible set.
 *
 * Returns null when the session is not on cooldown.
 */
function CooldownBadge({ session, alwaysShow = true }) {
  // Prefer the precomputed remaining-seconds the backend ships in the
  // list payload; fall back to the raw `cooldown_until` timestamp so
  // older snapshots still render correctly (e.g. cached responses).
  const onCooldown =
    !!session?.is_on_cooldown ||
    !!(session?.cooldown_until && new Date(session.cooldown_until).getTime() > Date.now());

  const remaining = (() => {
    if (typeof session?.cooldown_remaining_seconds === 'number') {
      return session.cooldown_remaining_seconds;
    }
    if (session?.cooldown_until) {
      const ms = new Date(session.cooldown_until).getTime() - Date.now();
      return Math.max(0, Math.ceil(ms / 1000));
    }
    return 0;
  })();

  // Active cooldown — render the prominent amber pill with the
  // remaining time so operators can see exactly how long the session
  // will be skipped from group-add / bulk-message jobs.
  if (onCooldown && remaining > 0) {
    const reason = session?.cooldown_reason || 'flood';
    const tooltip =
      `Telegram rate-limited this session (${reason}). ` +
      `It will be skipped by group-add / bulk-message jobs for ` +
      `${formatCooldownLabel(remaining)}. Login / 2FA / privacy / delete actions still work.`;
    return (
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-400/30 animate-pulse"
        title={tooltip}
      >
        <Clock className="w-3 h-3 mr-1" />
        Cooldown {formatCooldownLabel(remaining)}
      </span>
    );
  }

  // Not on cooldown — render a subtle "Cooldown: none" indicator so
  // the operator can see at a glance that the field is tracked and the
  // session is currently eligible for jobs. Set `alwaysShow={false}`
  // for compact layouts that don't have room for the always-on
  // indicator.
  if (!alwaysShow) return null;
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-gray-500/10 text-gray-400 border border-gray-500/20"
      title="No active cooldown. This session is eligible for group-add / bulk-message jobs."
    >
      <Clock className="w-3 h-3 mr-1" />
      Cooldown: none
    </span>
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
  const [serverPagination, setServerPagination] = useState(null);
  const [detailSession, setDetailSession] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // After a bulk upload finishes the user is offered to group every
  // successfully-uploaded session into a single session_list (the
  // "organise" flow). The modal is held in two pieces: an "ask"
  // dialog (yes/no) and a "name" dialog (asks for a list name).
  // `pendingOrganize` carries the session IDs that the modals will
  // act on; the user can dismiss either dialog without losing the
  // uploaded sessions themselves.
  const [pendingOrganize, setPendingOrganize] = useState(null);
  const [organizeStage, setOrganizeStage] = useState(null);
  const [organizeName, setOrganizeName] = useState('');
  const [organizeLoading, setOrganizeLoading] = useState(false);

  // QR-Login clone export modal. When opened we snapshot which
  // sessions were selected so the modal stays consistent even if the
  // operator clicks rows in the background.
  const [cloneExportOpen, setCloneExportOpen] = useState(false);
  const [cloneExportSelection, setCloneExportSelection] = useState([]);

  // Bulk-login job modal. Mirrors the clone-export modal so the
  // operator gets per-row progress instead of a single end-of-loop
  // toast (legacy behaviour the operator explicitly asked us to
  // replace: "in the sessions menu when users selects all the
  // session and tap on login the pannel login started but it's
  // doesn't show anything on the front-end. It should show the same
  // menu and ui as it shows while during the job running of the
  // export session feature").
  const [bulkLoginOpen, setBulkLoginOpen] = useState(false);
  const [bulkLoginSelection, setBulkLoginSelection] = useState([]);

  // The Sessions tab lists every uploaded row in one shot — operators
  // routinely upload hundreds at a time and have asked for "no limit, list
  // all". The backend honours `limit=0` as "unbounded" (capped at
  // MAX_UNBOUNDED_LIST as a safety belt) and the table renders fine into
  // the thousands. `pageSize` is kept for the paginate-when-tiny fallback
  // path used by the count summary line.
  const pageSize = 50;

  const fetchSessions = useCallback(async () => {
    try {
      const response = await listSessions({
        page: 1,
        limit: 0,
        filter: searchTerm || undefined,
        status: statusFilter !== 'all' ? statusFilter : undefined,
      });
      setSessions(response.data.data?.sessions || []);
      setServerPagination(response.data.data?.pagination || null);
    } catch (err) {
      console.warn('Failed to fetch sessions:', parseApiError(err));
    } finally {
      setLoading(false);
    }
  }, [searchTerm, statusFilter]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Poll every 10 seconds for live updates
  usePolling(fetchSessions, 10000, true);

  // --- Actions ---
  const handleUploadComplete = async (count, error, meta) => {
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

    // Offer to organise the just-uploaded sessions into a single
    // session_list. We only show the prompt when there are at least
    // two successful uploads — grouping a single session into a list
    // is operationally meaningless.
    const ids = Array.isArray(meta?.sessionIds) ? meta.sessionIds : [];
    if (ids.length >= 2) {
      setPendingOrganize({
        sessionIds: ids,
        successful: meta?.successful ?? ids.length,
      });
      setOrganizeStage('ask');
    }
  };

  const dismissOrganize = () => {
    setOrganizeStage(null);
    setPendingOrganize(null);
    setOrganizeName('');
  };

  const handleConfirmOrganize = async () => {
    if (!pendingOrganize?.sessionIds?.length) {
      dismissOrganize();
      return;
    }
    const name = organizeName.trim();
    if (!name) {
      showError('Please enter a name for the list.', 'Organise');
      return;
    }
    setOrganizeLoading(true);
    try {
      // 1. Create an empty session list, 2. attach every uploaded
      // session id to it. The dedicated /session-lists endpoint
      // doesn't take inline session ids on create, so we do it in two
      // calls. The list shows up on the Lists page immediately.
      const created = await sessionListsAPI.create({
        name,
        description: `Organised from upload (${pendingOrganize.sessionIds.length} sessions)`,
      });
      const listId = created?.data?.data?.list?.id
        ?? created?.data?.data?.id
        ?? created?.data?.id;
      if (!listId) {
        throw new Error('Server did not return a list id.');
      }
      await sessionListsAPI.addSessions(listId, pendingOrganize.sessionIds);
      showSuccess(
        `Organised ${pendingOrganize.sessionIds.length} sessions into "${name}".`,
        'Organise',
      );
      dismissOrganize();
    } catch (err) {
      showError(parseApiError(err), 'Organise failed');
    } finally {
      setOrganizeLoading(false);
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

  // Anti-revoke Phase 4 — try to bring a session marked status='revoked'
  // back to life. The backend re-loads the encrypted session file (or
  // the most recent backup), runs getMe, and flips the row back to
  // active if Telegram still accepts the auth_key. Useful for the
  // "the panel said revoked but I'm still logged in on my phone"
  // false-positive scenario.
  const handleRecover = async (id) => {
    setActionLoading((prev) => ({ ...prev, [id]: 'recover' }));
    try {
      const resp = await recoverSession(id);
      if (resp.data?.data?.recovered) {
        showSuccess('Session recovered. Heartbeat resumed.', 'Recover');
      } else {
        const reason = resp.data?.data?.reason || 'auth key no longer valid';
        showError(
          `Recovery failed: ${reason}. The Telegram-side auth_key is genuinely dead — re-link the session via Create Session.`,
          'Recover Failed'
        );
      }
      await fetchSessions();
    } catch (err) {
      showError(parseApiError(err), 'Recover Failed');
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

  // The bulk-login flow now drives a backend job runner with a
  // progress modal identical in shape to the clone-export one. We
  // snapshot the selection up-front so subsequent row clicks don't
  // mutate the rows the job is operating on.
  const handleBulkLogin = () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setBulkLoginSelection(
      ids
        .map((id) => sessions.find((s) => s.id === id))
        .filter(Boolean)
        .map((s) => ({ id: s.id, phone: s.phone }))
    );
    setBulkLoginOpen(true);
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

  // Open the clone-export modal for the currently-selected sessions.
  // We exclude only sessions Telegram has clearly revoked / expired /
  // errored on, because those can't perform `auth.AcceptLoginToken`
  // anyway. Everything else is forwarded — the backend will surface
  // the real error per-row if anything is off.
  //
  // Field-name notes:
  //   - listSessions returns the row with `isLoggedIn` (camelCase)
  //     from the API serializer, but a couple of legacy code paths
  //     also expose the raw `is_logged_in` (snake_case). Check both.
  //   - A session can be `is_logged_in=true` while status is
  //     'uploaded' (not yet hit by /connect) — the backend's own
  //     "active" filter uses `status IN ('active','uploaded')`, so we
  //     match that semantics here.
  const handleBulkCloneExport = () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const isAlive = (s) => {
      const loggedIn = s.isLoggedIn ?? s.is_logged_in ?? false;
      const blockedStatuses = new Set(['revoked', 'expired', 'error']);
      return loggedIn && !blockedStatuses.has(s.status);
    };
    const rows = sessions.filter((s) => ids.includes(s.id) && isAlive(s));
    if (rows.length === 0) {
      showError(
        'None of the selected sessions look alive — they are either revoked, expired, errored, or not logged in. Try logging them in from the Sessions tab first.',
        'Clone export'
      );
      return;
    }
    if (rows.length < ids.length) {
      showInfo(
        `${ids.length - rows.length} session(s) were excluded (revoked/expired/not logged in).`,
        'Clone export'
      );
    }
    setCloneExportSelection(
      rows.map((s) => ({ id: s.id, phone: s.phone || `session-${s.id}` }))
    );
    setCloneExportOpen(true);
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
  //
  // The backend already paginated for us — we just render the page it
  // returned. Total counts come from the server's pagination metadata so
  // the footer reflects the *whole dataset* (e.g. 50/50, not 10/10).
  // The client-side filtered list narrows the current page; if the operator
  // wants to search across the whole set, they should rely on the
  // backend-side `filter` param (which is wired into `searchTerm`).
  const totalPages = Math.max(
    1,
    serverPagination?.totalPages || Math.ceil(filteredSessions.length / pageSize)
  );
  const totalResults =
    typeof serverPagination?.total === 'number'
      ? serverPagination.total
      : filteredSessions.length;
  const paginatedSessions = filteredSessions;

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
            Manage your Telegram sessions &middot; {totalResults} total
          </p>
        </div>
      </div>

      {/* Anti-revoke summary banner (Phase 3 §B16/§B17): surfaces
          high-risk sessions + revoked rows so the user can act before
          opening individual modals. */}
      <AntiRevokeSummary sessions={sessions} />

      {/* Anti-revoke Phase 4 — operator education banner. The single
          biggest cause of the panel losing a session is the user
          tapping "Terminate all other sessions" on their phone, which
          Telegram treats as an explicit instruction to wipe every
          other authorization including ours. We can't override that
          tap, but we CAN make sure the user knows what NOT to do. */}
      <div
        className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-100"
        role="region"
        aria-label="Keep your panel sessions alive"
      >
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400" />
          <div className="space-y-2 leading-relaxed">
            <p className="font-semibold text-amber-200">
              Keep your panel sessions alive — read this once.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-amber-100/90">
              <li>
                <span className="font-semibold text-amber-200">DO NOT</span>{' '}
                tap <em>Settings &rarr; Devices &rarr; Terminate all
                other sessions</em> on your phone. That command is a
                global wipe; Telegram will kill the panel session along
                with everything else, and no panel-side code can prevent
                it.
              </li>
              <li>
                <span className="font-semibold text-amber-200">DO</span>{' '}
                terminate individual unfamiliar sessions one at a time
                if you see something suspicious.
              </li>
              <li>
                <span className="font-semibold text-amber-200">DO</span>{' '}
                enable a 2FA Cloud Password (Settings &rarr; Privacy &amp;
                Security &rarr; Two-Step Verification). Without it,
                anyone with your SIM can wipe every session — panel
                included.
              </li>
              <li>
                If a session does get marked{' '}
                <code className="rounded bg-amber-500/10 px-1">revoked</code>,
                click <span className="font-semibold">Recover</span> on
                its row first — if Telegram still accepts the auth_key
                (false-positive case) the panel will rejoin without a
                new SMS.
              </li>
            </ul>
          </div>
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
              onClick={handleBulkCloneExport}
              disabled={uploading}
              className="flex items-center gap-1.5 rounded-lg bg-primary-600/20 border border-primary-500/30 px-3 py-1.5 text-sm font-medium text-primary-300 hover:bg-primary-600/30 transition disabled:opacity-50"
              title="Mint a brand-new authorization for each selected session via Telegram QR-login RPCs and download as ZIP. Original sessions stay live."
            >
              <Download className="w-3.5 h-3.5" />
              Export Cloned Sessions
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
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider hidden lg:table-cell">
                  Device · DC
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider hidden xl:table-cell">
                  Proxy
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Risk
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
                  <td colSpan={9} className="px-4 py-16">
                    <div className="flex flex-col items-center justify-center">
                      <Loader2 className="w-8 h-8 text-primary-500 animate-spin mb-3" />
                      <p className="text-gray-400 text-sm">Loading sessions...</p>
                    </div>
                  </td>
                </tr>
              ) : paginatedSessions.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16">
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
                          {/*
                            Surface the account-level status (banned, premium,
                            verified, restricted, etc.) under the phone number
                            so operators can see at a glance which sessions are
                            healthy without opening the detail modal.
                          */}
                          <AccountStatusLine session={session} />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge
                            status={session.status || 'inactive'}
                            size="sm"
                          />
                          {/*
                            Cooldown badge — surfaces PEER_FLOOD /
                            FLOOD_WAIT lockouts marked by
                            sessionCooldown.markFloodCooldown(...). The
                            backend already filters cooldown rows out
                            of every job; this is the visual marker so
                            operators understand why a session was
                            skipped without opening the detail modal.
                          */}
                          <CooldownBadge session={session} />
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <DeviceDcCell session={session} />
                      </td>
                      <td className="px-4 py-3 hidden xl:table-cell">
                        <ProxyCell session={session} />
                      </td>
                      <td className="px-4 py-3">
                        <RiskPill session={session} />
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
                          {/*
                            "Already logged in" is canonically tracked by the
                            `is_logged_in` boolean, NOT by `status`. A session
                            can be `is_logged_in=true` while `status` is
                            transiently 'inactive' (e.g. between a heartbeat
                            cycle), and we still must NOT offer to log in
                            again — Telegram revokes the auth key when a
                            second client connects with the same string.

                            The list API returns the field as `isLoggedIn`
                            (camelCase) but several legacy callers still
                            pass through the raw `is_logged_in`; check both
                            so this works regardless of upstream shape.
                          */}
                          {session.isLoggedIn ||
                          session.is_logged_in ||
                          session.status?.toLowerCase() === 'active' ? (
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
                          ) : session.status?.toLowerCase() === 'revoked' ? (
                            // Anti-revoke Phase 4 — Recover button replaces
                            // Login for revoked rows. We never let the user
                            // hit /login on a revoked row anyway (the
                            // backend will fail it), and Recover is the
                            // mode-appropriate primary action.
                            <button
                              onClick={() => handleRecover(session.id)}
                              disabled={isLoading === 'recover'}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition disabled:opacity-50"
                              title="Recover (re-import the encrypted session string and re-run getMe)"
                            >
                              {isLoading === 'recover' ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <LifeBuoy className="w-4 h-4" />
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
                {totalResults === 0 ? 0 : (currentPage - 1) * pageSize + 1}
              </span>{' '}
              to{' '}
              <span className="text-gray-200 font-medium">
                {Math.min(currentPage * pageSize, totalResults)}
              </span>{' '}
              of{' '}
              <span className="text-gray-200 font-medium">
                {totalResults}
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

      {/*
        Upload -> organise prompt. Two stages:
          1) "ask"  - Yes/No "do you want to organise these N sessions?"
          2) "name" - collect the session_list name and create it.
        Dismissing either stage just leaves the uploaded sessions
        ungrouped - it does NOT delete them. The user can always
        organise them later from the Lists page.
      */}
      {organizeStage === 'ask' && pendingOrganize && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="organize-ask-title"
        >
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={dismissOrganize} />
          <div className="relative w-full max-w-md rounded-xl border border-white/10 bg-dark-800 p-6 shadow-2xl">
            <h3 id="organize-ask-title" className="text-lg font-semibold text-white">
              Organise these sessions?
            </h3>
            <p className="mt-2 text-sm text-gray-300">
              You just uploaded{' '}
              <span className="font-medium text-white">
                {pendingOrganize.sessionIds.length} session{pendingOrganize.sessionIds.length === 1 ? '' : 's'}
              </span>
              . Do you want to group them into a single session list so you can
              bulk-login or bulk-delete them later by selecting just the list?
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={dismissOrganize}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 transition-colors"
              >
                No, leave them ungrouped
              </button>
              <button
                onClick={() => setOrganizeStage('name')}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500 transition-colors"
              >
                Yes, organise
              </button>
            </div>
          </div>
        </div>
      )}

      {organizeStage === 'name' && pendingOrganize && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="organize-name-title"
        >
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={dismissOrganize} />
          <div className="relative w-full max-w-md rounded-xl border border-white/10 bg-dark-800 p-6 shadow-2xl">
            <h3 id="organize-name-title" className="text-lg font-semibold text-white">
              Name your session list
            </h3>
            <p className="mt-1 text-sm text-gray-400">
              {pendingOrganize.sessionIds.length} session{pendingOrganize.sessionIds.length === 1 ? '' : 's'} will be added to this list.
            </p>
            <input
              type="text"
              autoFocus
              value={organizeName}
              onChange={(e) => setOrganizeName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !organizeLoading && organizeName.trim()) {
                  handleConfirmOrganize();
                }
              }}
              placeholder="e.g. Batch 2025-01-15"
              className="mt-4 w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-primary-500"
            />
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setOrganizeStage('ask')}
                disabled={organizeLoading}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 transition-colors disabled:opacity-60"
              >
                Back
              </button>
              <button
                onClick={dismissOrganize}
                disabled={organizeLoading}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 transition-colors disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmOrganize}
                disabled={organizeLoading || !organizeName.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {organizeLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Create list
              </button>
            </div>
          </div>
        </div>
      )}

      <SessionCloneExportModal
        isOpen={cloneExportOpen}
        onClose={() => setCloneExportOpen(false)}
        selectedSessions={cloneExportSelection}
      />

      <SessionBulkLoginModal
        isOpen={bulkLoginOpen}
        onClose={() => {
          setBulkLoginOpen(false);
          setCurrentPage(1);
          fetchSessions();
        }}
        selectedSessions={bulkLoginSelection}
        onCompleted={() => {
          // Refresh the table whenever a job finishes so the new
          // is_logged_in / account_info / status values land in the
          // UI without the operator having to manually refresh.
          fetchSessions();
        }}
      />
    </div>
  );
}
