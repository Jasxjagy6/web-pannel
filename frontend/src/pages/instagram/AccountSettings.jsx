/**
 * Instagram Account Settings — per-session profile editor.
 *
 * Telegram exposes first/last name + username + bio. Instagram has a
 * different field set (full_name, biography, external_url, gender,
 * phone_number, email, username) plus a binary profile picture. Each
 * field has its own cooldown (renames + profile-text edits + PFP),
 * enforced backend-side via accountSettings.update gates.
 *
 * The UI mirrors that surface 1:1 — there is no bulk-update mode
 * because IG-side cooldowns make it pointless to fan out the same
 * profile patch to many accounts at once.
 */

import { apiError } from '../../utils/apiError';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  UserCog,
  AtSign,
  Globe,
  Phone,
  Mail,
  ImageIcon,
  Save,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Info,
  CheckCircle2,
  Upload,
} from 'lucide-react';
import { listSessions } from '../../api/sessions';
import { getAccount, updateAccount, uploadPhoto } from '../../api/instagramAccount';
import { useToast } from '../../components/common/Toast';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';

const IG_GRADIENT_BTN =
  'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

const GENDER_OPTIONS = [
  { value: '', label: 'No change' },
  { value: '1', label: 'Female' },
  { value: '2', label: 'Male' },
  { value: '3', label: 'Custom' },
  { value: '4', label: 'Prefer not to say' },
];

export default function InstagramAccountSettings() {
  const { showToast } = useToast();
  const fileInputRef = useRef(null);

  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);

  const [account, setAccount] = useState(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [error, setError] = useState(null);

  const [draft, setDraft] = useState({
    username: '',
    full_name: '',
    biography: '',
    external_url: '',
    phone_number: '',
    email: '',
    gender: '',
  });
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  async function reloadSessions() {
    setSessionsLoading(true);
    try {
      const r = await listSessions({ page: 1, limit: 200 });
      const data = r.data?.data || r.data || {};
      const list = (data.sessions || []).filter(
        (s) => s.is_logged_in && s.platform === 'instagram'
      );
      setSessions(list);
      if (!selectedId && list.length) setSelectedId(list[0].id);
    } catch (err) {
      showToast(apiError(err, 'Failed to load Instagram sessions'), 'error');
    } finally {
      setSessionsLoading(false);
    }
  }

  async function loadAccount(id) {
    if (!id) return;
    setAccountLoading(true);
    setError(null);
    try {
      const r = await getAccount(id);
      const data = r.data?.data || null;
      setAccount(data);
      setDraft({
        username: '',
        full_name: '',
        biography: '',
        external_url: '',
        phone_number: '',
        email: '',
        gender: '',
      });
    } catch (err) {
      setAccount(null);
      setError(apiError(err, 'Failed to load account profile'));
    } finally {
      setAccountLoading(false);
    }
  }

  useEffect(() => { reloadSessions(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (selectedId) loadAccount(selectedId); }, [selectedId]);

  function setField(key, value) {
    setDraft((p) => ({ ...p, [key]: value }));
  }

  function _trim(v) {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    return t === '' ? undefined : t;
  }

  async function handleSave(evt) {
    evt?.preventDefault();
    if (!selectedId) return;
    const patch = {};
    if (draft.username && draft.username !== account?.username) patch.username = _trim(draft.username);
    if (draft.full_name) patch.full_name = _trim(draft.full_name);
    if (draft.biography) patch.biography = _trim(draft.biography);
    if (draft.external_url) patch.external_url = _trim(draft.external_url);
    if (draft.phone_number) patch.phone_number = _trim(draft.phone_number);
    if (draft.email) patch.email = _trim(draft.email);
    if (draft.gender) patch.gender = _trim(draft.gender);

    if (Object.keys(patch).length === 0) {
      showToast('Nothing to update — fill in at least one field.', 'info');
      return;
    }
    setSaving(true);
    try {
      const r = await updateAccount(selectedId, patch);
      const out = r.data?.data || {};
      const errors = [];
      if (out.username_error) errors.push(`Username: ${out.username_error}`);
      if (out.profile_error) errors.push(`Profile: ${out.profile_error}`);
      if (errors.length) {
        showToast(errors.join(' · '), 'warning');
      } else {
        showToast('Profile updated on Instagram.', 'success');
      }
      await loadAccount(selectedId);
    } catch (err) {
      showToast(apiError(err, 'Failed to update profile'), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handlePhotoUpload(file) {
    if (!file || !selectedId) return;
    if (!file.type.startsWith('image/')) {
      showToast('Profile picture must be an image.', 'error');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showToast('Profile picture must be smaller than 8 MB.', 'error');
      return;
    }
    setUploadingPhoto(true);
    try {
      const r = await uploadPhoto(selectedId, file);
      const out = r.data?.data || {};
      if (out.profile_picture_error) {
        showToast(`Picture rejected: ${out.profile_picture_error}`, 'error');
      } else {
        showToast('Profile picture updated.', 'success');
      }
      await loadAccount(selectedId);
    } catch (err) {
      showToast(apiError(err, 'Failed to upload photo'), 'error');
    } finally {
      setUploadingPhoto(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedId) || null,
    [sessions, selectedId]
  );

  return (
    <InstagramFeatureShell
      icon={UserCog}
      title="Account settings"
      subtitle="Edit your Instagram profile, biography, contact info, and picture per account."
      actions={
        <button
          type="button"
          onClick={() => loadAccount(selectedId)}
          disabled={!selectedId || accountLoading}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium ring-1 ring-white/25 hover:bg-white/25 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${accountLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
        {/* Session picker */}
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="mb-2 px-1 text-xs uppercase tracking-wide text-white/60">
            Instagram accounts
          </div>
          {sessionsLoading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-white/60">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : sessions.length === 0 ? (
            <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
              No logged-in Instagram sessions. Create one from the Sessions page.
            </div>
          ) : (
            <ul className="max-h-[420px] space-y-1 overflow-y-auto">
              {sessions.map((s) => {
                const active = s.id === selectedId;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(s.id)}
                      className={[
                        'flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition',
                        active ? `${IG_GRADIENT_BTN} text-white shadow` : 'text-white/85 hover:bg-white/10',
                      ].join(' ')}
                    >
                      <span className="truncate">@{s.username || `session_${s.id}`}</span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide opacity-80">
                        #{s.id}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Profile form */}
        <div className="rounded-xl border border-white/10 bg-black/20 p-5">
          {!selectedId ? (
            <div className="flex h-40 items-center justify-center text-sm text-white/60">
              Pick an Instagram account on the left to edit its profile.
            </div>
          ) : accountLoading ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-white/60">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading profile…
            </div>
          ) : error ? (
            <div className="flex items-start gap-3 rounded-lg border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-medium">Couldn't read profile</div>
                <div className="text-xs opacity-90">{error}</div>
                <button
                  type="button"
                  onClick={() => loadAccount(selectedId)}
                  className="mt-2 inline-flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1 text-xs"
                >
                  <RefreshCw className="h-3 w-3" /> Retry
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Header card with PFP */}
              <div className="flex flex-wrap items-center gap-4 rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="relative h-16 w-16 overflow-hidden rounded-full ring-2 ring-white/20">
                  {account?.profile_pic_url ? (
                    /* eslint-disable-next-line jsx-a11y/img-redundant-alt */
                    <img
                      src={account.profile_pic_url}
                      alt="Profile picture"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-white/10 text-white/70">
                      <ImageIcon className="h-6 w-6" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-white">
                    @{account?.username || (selectedSession?.username ?? '—')}
                  </div>
                  <div className="text-xs text-white/70">
                    {account?.full_name || 'No display name'}
                    {account?.is_verified && (
                      <span className="ml-2 inline-flex items-center gap-1 text-blue-300">
                        <CheckCircle2 className="h-3 w-3" /> Verified
                      </span>
                    )}
                    {account?.is_private && (
                      <span className="ml-2 inline-flex items-center gap-1 text-pink-200">Private</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => handlePhotoUpload(e.target.files?.[0])}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingPhoto}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium ring-1 ring-white/25 hover:bg-white/25 disabled:opacity-50"
                  >
                    {uploadingPhoto ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                    {uploadingPhoto ? 'Uploading…' : 'Change picture'}
                  </button>
                </div>
              </div>

              {/* Edit form */}
              <form onSubmit={handleSave} className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    icon={AtSign}
                    label="Username"
                    placeholder={account?.username || 'username'}
                    value={draft.username}
                    onChange={(v) => setField('username', v)}
                    hint="Subject to IG's 14-day rename cooldown."
                  />
                  <Field
                    icon={UserCog}
                    label="Full name"
                    placeholder={account?.full_name || 'Full name'}
                    value={draft.full_name}
                    onChange={(v) => setField('full_name', v)}
                  />
                  <Field
                    icon={Globe}
                    label="Website"
                    placeholder={account?.external_url || 'https://example.com'}
                    value={draft.external_url}
                    onChange={(v) => setField('external_url', v)}
                  />
                  <Field
                    icon={Phone}
                    label="Phone number"
                    placeholder="+1 555 555 5555"
                    value={draft.phone_number}
                    onChange={(v) => setField('phone_number', v)}
                  />
                  <Field
                    icon={Mail}
                    label="Email"
                    type="email"
                    placeholder="you@example.com"
                    value={draft.email}
                    onChange={(v) => setField('email', v)}
                  />
                  <div>
                    <label className="block text-xs font-medium text-white/70 mb-1.5">Gender</label>
                    <select
                      value={draft.gender}
                      onChange={(e) => setField('gender', e.target.value)}
                      className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white focus:border-pink-300 focus:outline-none focus:ring-1 focus:ring-pink-300"
                    >
                      {GENDER_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-white/70 mb-1.5">Biography</label>
                  <textarea
                    rows={3}
                    placeholder={account?.biography || 'Bio (max 150 chars)'}
                    value={draft.biography}
                    maxLength={150}
                    onChange={(e) => setField('biography', e.target.value)}
                    className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-pink-300 focus:outline-none focus:ring-1 focus:ring-pink-300"
                  />
                  <div className="mt-1 text-[11px] text-white/50">
                    {draft.biography.length}/150
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70">
                  <div className="flex items-start gap-2">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Username, profile-text and picture changes are gated by
                      IG-side cooldowns. The backend will reject edits that fall
                      inside a cooldown window with a clear error.
                    </span>
                  </div>
                  <button
                    type="submit"
                    disabled={saving}
                    className={`${IG_GRADIENT_BTN} inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow disabled:opacity-50`}
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    Save changes
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </InstagramFeatureShell>
  );
}

function Field({ icon: Icon, label, value, onChange, placeholder, type = 'text', hint }) {
  return (
    <div>
      <label className="block text-xs font-medium text-white/70 mb-1.5">{label}</label>
      <div className="relative">
        {Icon && (
          <Icon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
        )}
        <input
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={[
            'w-full rounded-lg border border-white/15 bg-black/30 py-2 text-sm text-white placeholder:text-white/40 focus:border-pink-300 focus:outline-none focus:ring-1 focus:ring-pink-300',
            Icon ? 'pl-9 pr-3' : 'px-3',
          ].join(' ')}
        />
      </div>
      {hint && <div className="mt-1 text-[11px] text-white/50">{hint}</div>}
    </div>
  );
}
