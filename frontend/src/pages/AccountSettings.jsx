import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Users,
  User,
  AtSign,
  FileText,
  Upload,
  Save,
  Loader2,
  Check,
  X,
  Eye,
  AlertTriangle,
  Shield,
  Sparkles,
  Pencil,
  ListChecks,
  Trash2,
  Image as ImageIcon,
  Plus,
  AlertCircle,
} from 'lucide-react';
import { useToast } from '../components/common/Toast';
import { listSessions } from '../api/sessions';
import {
  updateAccountSettings,
  uploadProfilePhoto,
  removeAllProfilePhotos,
  applyPhotoAssignments,
} from '../api/accountSettings';
import { parseApiError } from '../utils/formatters';
import SessionListSwitcher from '../components/common/SessionListSwitcher';
import AccountRandomizePanel from '../components/settings/AccountRandomizePanel';
import AccountProfileListPanel from '../components/settings/AccountProfileListPanel';

export default function AccountSettings() {
  const { showSuccess, showError } = useToast();

  // Top-level mode: 'manual' applies a single value to every selected
  // session; 'randomize' picks a different value per session from curated
  // pools (see AccountRandomizePanel).
  const [mode, setMode] = useState('manual');

  // Sessions
  const [sessions, setSessions] = useState([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
  const [sessionPickMode, setSessionPickMode] = useState('sessions');
  const [selectedSessionListId, setSelectedSessionListId] = useState('');
  const [showAllSessions, setShowAllSessions] = useState(false);

  // Form fields
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [profilePhoto, setProfilePhoto] = useState(null);
  const [profilePhotoPreview, setProfilePhotoPreview] = useState(null);

  // Update flags (which fields to update)
  const [updateFlags, setUpdateFlags] = useState({
    firstName: false,
    lastName: false,
    username: false,
    bio: false,
    profilePhoto: false,
  });

  // Per-field action mode in Manual mode: 'set' applies the typed value,
  // 'remove' clears the field on Telegram. firstName is always 'set'
  // because Telegram rejects an empty first name (FIRSTNAME_INVALID).
  const [fieldModes, setFieldModes] = useState({
    firstName: 'set',
    lastName: 'set',
    username: 'set',
    bio: 'set',
    profilePhoto: 'set',
  });

  const [submitting, setSubmitting] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  // "Remove all profile photos" destructive bulk action.
  // Two-step confirm so an accidental click can't nuke everyone.
  const [removingPhotos, setRemovingPhotos] = useState(false);
  const [showRemovePhotosConfirm, setShowRemovePhotosConfirm] = useState(false);
  const [removePhotosResult, setRemovePhotosResult] = useState(null);

  // ---- Per-session Photo Queue (Manual mode) ----
  //
  // Operator builds a list of {photo, sessionIds} pairs and clicks Apply
  // Queue. Each entry stores the on-disk path returned by /upload-photo
  // plus a snapshot of which sessions should receive that photo.
  // photoQueueDraftFile is the photo currently being staged for the
  // "Add to queue" button — once added, it's cleared so the operator can
  // upload the next one.
  const [photoQueueDraftFile, setPhotoQueueDraftFile] = useState(null);
  const [photoQueueDraftPreview, setPhotoQueueDraftPreview] = useState(null);
  const [photoQueueUploading, setPhotoQueueUploading] = useState(false);
  // Each entry: { id, fileName, photoPath, previewUrl, sessionIds, sessionPhones }
  const [photoQueue, setPhotoQueue] = useState([]);
  const [photoQueueApplying, setPhotoQueueApplying] = useState(false);
  const [photoQueueResult, setPhotoQueueResult] = useState(null);

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    try {
      const response = await listSessions({ limit: 100 });
      setSessions(response.data.data?.sessions || []);
    } catch (err) {
      console.warn('Failed to fetch sessions:', parseApiError(err));
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, []);

  const activeSessions = sessions.filter((s) => s.status?.toLowerCase() === 'active' || s.is_logged_in);
  const displayedSessions = showAllSessions ? sessions : activeSessions;

  const toggleSession = (sessionId) => {
    setSelectedSessionIds(prev =>
      prev.includes(sessionId)
        ? prev.filter(id => id !== sessionId)
        : [...prev, sessionId]
    );
  };

  const selectAllSessions = () => {
    const activeIds = activeSessions.map(s => s.id);
    setSelectedSessionIds(activeIds);
  };

  const deselectAllSessions = () => {
    setSelectedSessionIds([]);
  };

  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      showError('Please select an image file', 'Invalid File');
      return;
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      showError('Image must be less than 5MB', 'File Too Large');
      return;
    }

    setUploadingPhoto(true);
    try {
      const formData = new FormData();
      formData.append('photo', file);

      await uploadProfilePhoto(formData);

      setProfilePhoto(file);
      setProfilePhotoPreview(URL.createObjectURL(file));
      setUpdateFlags(prev => ({ ...prev, profilePhoto: true }));
      
      showSuccess('Photo uploaded successfully', 'Success');
    } catch (err) {
      showError(parseApiError(err), 'Upload Failed');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Validation
    const usingList = sessionPickMode === 'list' && selectedSessionListId;
    if (!usingList && selectedSessionIds.length === 0) {
      showError('Please select at least one session (or pick a session list)', 'Validation Error');
      return;
    }
    if (sessionPickMode === 'list' && !selectedSessionListId) {
      showError('Please pick a session list', 'Validation Error');
      return;
    }

    const hasUpdates = Object.values(updateFlags).some(flag => flag);
    if (!hasUpdates) {
      showError('Please select at least one field to update', 'Validation Error');
      return;
    }

    // Block the obvious mistake before hitting the backend: any field
    // checked in 'set' mode must have a value (except photo which has
    // its own upload flow).
    if (updateFlags.firstName && fieldModes.firstName === 'set' && !firstName.trim()) {
      showError('Enter a first name or uncheck "First Name"', 'Validation Error');
      return;
    }
    if (updateFlags.lastName && fieldModes.lastName === 'set' && !lastName.trim()) {
      showError('Enter a last name or switch the toggle to Remove', 'Validation Error');
      return;
    }
    if (updateFlags.username && fieldModes.username === 'set' && !username.trim()) {
      showError('Enter a username or switch the toggle to Remove', 'Validation Error');
      return;
    }
    if (updateFlags.bio && fieldModes.bio === 'set' && !bio.trim()) {
      showError('Enter a bio or switch the toggle to Remove', 'Validation Error');
      return;
    }
    if (
      updateFlags.profilePhoto &&
      fieldModes.profilePhoto === 'set' &&
      !profilePhoto
    ) {
      showError(
        'Upload a photo first or switch the toggle to Remove',
        'Validation Error'
      );
      return;
    }

    setSubmitting(true);
    try {
      const updatePayload = {
        firstName: updateFlags.firstName ? firstName : undefined,
        lastName: updateFlags.lastName ? lastName : undefined,
        username: updateFlags.username ? username : undefined,
        bio: updateFlags.bio ? bio : undefined,
        // In Remove mode the backend ignores profilePhotoPath and calls
        // removeAllProfilePhotos instead.
        profilePhotoPath:
          updateFlags.profilePhoto &&
          fieldModes.profilePhoto === 'set' &&
          profilePhoto
            ? profilePhoto.path
            : undefined,
        updateFlags,
        fieldModes,
      };
      if (usingList) {
        updatePayload.sessionListId = Number(selectedSessionListId);
      } else {
        updatePayload.sessionIds = selectedSessionIds;
      }
      const result = await updateAccountSettings(updatePayload);

      const { success, failed } = result.data.data;
      
      if (failed === 0) {
        showSuccess(`Successfully updated ${success} session(s)`, 'Success');
      } else {
        showSuccess(`Updated ${success} session(s), ${failed} failed`, 'Partial Success');
      }

      // Reset form
      resetForm();
    } catch (err) {
      showError(parseApiError(err), 'Update Failed');
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setFirstName('');
    setLastName('');
    setUsername('');
    setBio('');
    setProfilePhoto(null);
    setProfilePhotoPreview(null);
    setUpdateFlags({
      firstName: false,
      lastName: false,
      username: false,
      bio: false,
      profilePhoto: false,
    });
    setFieldModes({
      firstName: 'set',
      lastName: 'set',
      username: 'set',
      bio: 'set',
      profilePhoto: 'set',
    });
    setSelectedSessionIds([]);
  };

  const toggleUpdateFlag = (field) => {
    setUpdateFlags(prev => ({ ...prev, [field]: !prev[field] }));
  };

  // Flip a single field between 'set' and 'remove'. firstName is locked
  // to 'set' because Telegram requires a non-empty first name.
  const setFieldMode = (field, mode) => {
    if (field === 'firstName') return;
    setFieldModes((prev) => ({ ...prev, [field]: mode }));
  };

  // Compact Set ↔ Remove pill toggle rendered next to each field's
  // checkbox. Disabled when the field's checkbox itself is unchecked
  // so the operator has to opt in to the field first. firstName always
  // renders a single, locked "Set" pill because Telegram rejects an
  // empty first name (FIRSTNAME_INVALID).
  const renderModeToggle = (field) => {
    const enabled = !!updateFlags[field];
    const mode = fieldModes[field];
    const isFirstName = field === 'firstName';

    const baseBtn =
      'px-2 py-0.5 text-[10px] font-semibold rounded-md transition border';
    const activeSet = 'bg-primary-500/30 text-primary-100 border-primary-500/50';
    const activeRemove = 'bg-red-500/30 text-red-100 border-red-500/50';
    const inactive =
      'bg-transparent text-gray-400 border-white/10 hover:bg-white/5';

    if (isFirstName) {
      return (
        <span
          className="ml-auto inline-flex items-center gap-1 text-[10px] text-gray-500 italic"
          title="Telegram requires a non-empty first name on every account, so it can't be cleared from the panel."
        >
          (Set only)
        </span>
      );
    }

    return (
      <span className="ml-auto inline-flex items-center gap-1 rounded-md border border-white/10 bg-dark-900 p-0.5">
        <button
          type="button"
          disabled={!enabled}
          onClick={() => setFieldMode(field, 'set')}
          className={`${baseBtn} ${
            mode === 'set' ? activeSet : inactive
          } ${!enabled ? 'opacity-40 cursor-not-allowed' : ''}`}
          title="Apply the value below to every selected session"
        >
          Set
        </button>
        <button
          type="button"
          disabled={!enabled}
          onClick={() => setFieldMode(field, 'remove')}
          className={`${baseBtn} ${
            mode === 'remove' ? activeRemove : inactive
          } ${!enabled ? 'opacity-40 cursor-not-allowed' : ''}`}
          title="Clear this field on every selected session — for profile photo this removes every photo (avatar + history)"
        >
          Remove
        </button>
      </span>
    );
  };

  // ---- "Remove all profile photos" destructive bulk action ----
  //
  // Builds the same { sessionIds | sessionListId } shape the other
  // bulk endpoints accept, then POSTs to /account-settings/remove-photos.
  // Failures on individual sessions are reported per-session in the
  // result payload so we surface them in a follow-up toast.
  const handleRemoveAllPhotos = async () => {
    const usingList = sessionPickMode === 'list';

    // Validate selection before showing destructive UI.
    if (usingList && !selectedSessionListId) {
      showError('Please pick a session list first.');
      return;
    }
    if (!usingList && selectedSessionIds.length === 0) {
      showError('Please select at least one session.');
      return;
    }

    setRemovingPhotos(true);
    setRemovePhotosResult(null);
    try {
      const payload = usingList
        ? { sessionListId: selectedSessionListId }
        : { sessionIds: selectedSessionIds };
      const resp = await removeAllProfilePhotos(payload);
      const data = resp.data?.data || {};
      setRemovePhotosResult(data);
      const { total = 0, success = 0, failed = 0, totalDeleted = 0 } = data;
      if (failed === 0) {
        showSuccess(
          `Removed ${totalDeleted} profile photo(s) across ${success}/${total} session(s).`
        );
      } else {
        showError(
          `Removed photos on ${success}/${total} session(s); ${failed} failed. See details below.`
        );
      }
    } catch (err) {
      showError(parseApiError(err));
    } finally {
      setRemovingPhotos(false);
      setShowRemovePhotosConfirm(false);
    }
  };

  // ---- Per-session Photo Queue handlers ----
  //
  // Upload a new draft photo without touching the rest of the form. The
  // file is saved to the panel's upload dir; we hold on to the returned
  // path so the Apply Queue request can reference it later. We also keep
  // a local object URL for the live preview.
  const handlePhotoQueueDraftUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showError('Please select an image file', 'Invalid File');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showError('Image must be less than 5MB', 'File Too Large');
      return;
    }
    setPhotoQueueUploading(true);
    try {
      const formData = new FormData();
      formData.append('photo', file);
      const resp = await uploadProfilePhoto(formData);
      const filePath = resp.data?.data?.filePath;
      if (!filePath) throw new Error('Upload returned no path');
      setPhotoQueueDraftFile({ name: file.name, path: filePath });
      setPhotoQueueDraftPreview(URL.createObjectURL(file));
    } catch (err) {
      showError(parseApiError(err), 'Upload Failed');
    } finally {
      setPhotoQueueUploading(false);
      // Clear the input so the same file can be re-selected if needed.
      if (e.target) e.target.value = '';
    }
  };

  // Capture the current selection + draft photo as a new queue entry.
  // Snapshots the session IDs so subsequent picker changes don't affect
  // an already-queued assignment.
  const handleAddPhotoQueueEntry = () => {
    if (!photoQueueDraftFile) {
      showError('Upload a photo first.', 'Validation Error');
      return;
    }
    if (sessionPickMode === 'list') {
      showError(
        'Session lists are not supported in the photo queue. Pick individual sessions instead.',
        'Validation Error'
      );
      return;
    }
    if (selectedSessionIds.length === 0) {
      showError(
        'Pick at least one session in the right column before adding.',
        'Validation Error'
      );
      return;
    }
    const sessionPhones = selectedSessionIds
      .map((id) => sessions.find((s) => s.id === id)?.phone || `#${id}`)
      .slice(0, 6);
    setPhotoQueue((prev) => [
      ...prev,
      {
        id:
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        fileName: photoQueueDraftFile.name,
        photoPath: photoQueueDraftFile.path,
        previewUrl: photoQueueDraftPreview,
        sessionIds: selectedSessionIds.slice(),
        sessionPhones,
      },
    ]);
    // Clear the draft so the operator can upload the next photo. We
    // intentionally keep the session selection so they can deselect /
    // tweak before the next add — quicker than re-selecting from scratch.
    setPhotoQueueDraftFile(null);
    setPhotoQueueDraftPreview(null);
    setPhotoQueueResult(null);
  };

  // Drop a row from the queue. Revokes the object URL to avoid a small
  // memory leak when many photos are queued.
  const handleRemovePhotoQueueEntry = (entryId) => {
    setPhotoQueue((prev) => {
      const out = prev.filter((e) => e.id !== entryId);
      const dropped = prev.find((e) => e.id === entryId);
      if (dropped?.previewUrl) {
        try { URL.revokeObjectURL(dropped.previewUrl); } catch (_) {}
      }
      return out;
    });
  };

  // Wipe the entire queue and the draft. Used by the "Clear queue" button.
  const handleClearPhotoQueue = () => {
    photoQueue.forEach((e) => {
      if (e.previewUrl) {
        try { URL.revokeObjectURL(e.previewUrl); } catch (_) {}
      }
    });
    setPhotoQueue([]);
    setPhotoQueueDraftFile(null);
    if (photoQueueDraftPreview) {
      try { URL.revokeObjectURL(photoQueueDraftPreview); } catch (_) {}
    }
    setPhotoQueueDraftPreview(null);
    setPhotoQueueResult(null);
  };

  // POST the queue to the backend. Server applies each assignment in
  // order; the last one wins for any session that appears more than once.
  const handleApplyPhotoQueue = async () => {
    if (photoQueue.length === 0) {
      showError('Add at least one assignment first.', 'Validation Error');
      return;
    }
    setPhotoQueueApplying(true);
    setPhotoQueueResult(null);
    try {
      const assignments = photoQueue.map((e) => ({
        photoPath: e.photoPath,
        sessionIds: e.sessionIds,
      }));
      const resp = await applyPhotoAssignments(assignments);
      const data = resp.data?.data || {};
      setPhotoQueueResult(data);
      const {
        totalAssignments = 0,
        totalSessions = 0,
        success = 0,
        failed = 0,
      } = data;
      if (failed === 0) {
        showSuccess(
          `Applied ${totalAssignments} photo assignment(s) across ${success}/${totalSessions} session(s).`
        );
      } else {
        showError(
          `Applied ${success}/${totalSessions} session(s) across ${totalAssignments} assignment(s); ${failed} failed. See details below.`
        );
      }
    } catch (err) {
      showError(parseApiError(err), 'Apply Failed');
    } finally {
      setPhotoQueueApplying(false);
    }
  };

  // Compute overlap warning: sessions that appear in more than one queue
  // entry will only receive the LAST assignment's photo (because Telegram
  // only renders the most recent UploadProfilePhoto).
  const computePhotoQueueOverlaps = () => {
    const seen = new Map(); // sessionId -> [entryIndex]
    photoQueue.forEach((entry, idx) => {
      entry.sessionIds.forEach((sid) => {
        const arr = seen.get(sid) || [];
        arr.push(idx);
        seen.set(sid, arr);
      });
    });
    const overlaps = [];
    seen.forEach((indices, sid) => {
      if (indices.length > 1) overlaps.push({ sessionId: sid, indices });
    });
    return overlaps;
  };
  const photoQueueOverlaps = computePhotoQueueOverlaps();

  // Sessions targeted by the destructive action, for the confirm dialog copy.
  const removePhotosTargetCount =
    sessionPickMode === 'list'
      ? (selectedSessionListId ? '(session list)' : '0')
      : selectedSessionIds.length;

  const inputBase = 'w-full rounded-lg border bg-dark-900 py-2.5 px-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition';

  // Full session objects (with phone) for the currently-selected IDs.
  // Order matches the user's click order so the @x, @x2, @x3 sequence in
  // Randomize Mode is predictable.
  const selectedSessionObjects = selectedSessionIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter(Boolean);

  // ---- Shared right-column: session selection panel (reused in both modes).
  const renderSessionPicker = () => (
    <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
      <SessionListSwitcher
        mode={sessionPickMode}
        onModeChange={setSessionPickMode}
        selectedSessionListId={selectedSessionListId}
        onSelectedSessionListIdChange={setSelectedSessionListId}
        className="mb-4"
      />
      {sessionPickMode === 'list' ? null : (
        <>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Users className="w-4 h-4 text-primary-500" />
              Sessions ({selectedSessionIds.length} selected)
            </h3>
          </div>

          <div className="flex gap-2 mb-3">
            <button
              type="button"
              onClick={selectAllSessions}
              className="text-xs text-primary-400 hover:text-primary-300"
            >
              Select All Active
            </button>
            <span className="text-xs text-gray-600">|</span>
            <button
              type="button"
              onClick={deselectAllSessions}
              className="text-xs text-gray-400 hover:text-gray-300"
            >
              Deselect All
            </button>
            <span className="text-xs text-gray-600">|</span>
            <button
              type="button"
              onClick={() => setShowAllSessions(!showAllSessions)}
              className="text-xs text-gray-400 hover:text-gray-300"
            >
              {showAllSessions ? 'Show Active Only' : 'Show All'}
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto rounded-lg border border-white/10 bg-dark-900 p-2 space-y-1">
            {displayedSessions.map((s) => {
              const isSelected = selectedSessionIds.includes(s.id);
              const isActive = s.status?.toLowerCase() === 'active' || s.is_logged_in;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleSession(s.id)}
                  disabled={!isActive}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition ${
                    isSelected
                      ? 'bg-primary-500/20 text-primary-300 border border-primary-500/30'
                      : 'hover:bg-white/5 text-gray-300 border border-transparent'
                  } ${!isActive ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                    isSelected ? 'border-primary-500 bg-primary-500/30' : 'border-gray-600'
                  }`}>
                    {isSelected && <Check className="w-3 h-3 text-primary-400" />}
                  </div>
                  <span className="truncate">{s.phone || s.id}</span>
                  {s.username && <span className="text-gray-500 text-xs">@{s.username}</span>}
                  {!isActive && <span className="text-xs text-gray-500">(inactive)</span>}
                </button>
              );
            })}
          </div>

          {activeSessions.length === 0 && (
            <p className="mt-2 text-xs text-amber-400">No active sessions. Please login first.</p>
          )}
        </>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Account Settings</h1>
        <p className="mt-1 text-sm text-gray-400">
          Update name, username, bio, and profile picture for multiple sessions at once
        </p>
      </div>

      {/* Sub-menu link card: Privacy */}
      <Link
        to="/privacy"
        className="block rounded-xl border border-white/5 bg-gradient-to-br from-primary-500/10 via-dark-800 to-dark-800 p-5 hover:border-primary-500/40 transition group"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="rounded-xl bg-primary-500/15 p-3 text-primary-300">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Privacy</h3>
              <p className="text-xs text-gray-400 max-w-xl">
                Bulk-set who can see your phone, last seen, profile picture,
                bio, gifts, birthday, forwards, calls, messages and group invites
                across many accounts at once.
              </p>
            </div>
          </div>
          <span className="text-xs text-primary-300 group-hover:translate-x-0.5 transition">
            Open  &rarr;
          </span>
        </div>
      </Link>

      {/* Destructive: remove all profile photos for the selected sessions.
          Visible in every mode so it's reachable without switching tabs.
          Uses the same selection (sessionIds OR sessionListId) as the
          other bulk actions on this page. */}
      <div className="rounded-xl border border-red-500/30 bg-gradient-to-br from-red-500/10 via-dark-800 to-dark-800 p-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-red-500/15 p-3 text-red-300 flex-shrink-0">
              <Trash2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                Remove all profile photos
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/30">
                  Destructive
                </span>
              </h3>
              <p className="mt-1 text-xs text-gray-400 max-w-xl">
                Wipes <strong>every</strong> profile photo (visible avatar
                + full history) on each selected session. Telegram will
                render the default monogram afterwards. There is no undo.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowRemovePhotosConfirm(true)}
            disabled={removingPhotos}
            className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/20 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-500/30 hover:border-red-500/60 transition disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
          >
            {removingPhotos ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Removing&hellip;
              </>
            ) : (
              <>
                <Trash2 className="w-4 h-4" />
                Remove all photos
              </>
            )}
          </button>
        </div>

        {/* Per-session report after the bulk run.
            Only renders if the operator ran the action at least once. */}
        {removePhotosResult && (
          <div className="mt-4 rounded-lg border border-white/10 bg-dark-900/60 p-3 text-xs text-gray-300">
            <div className="flex items-center gap-2 mb-2 text-gray-200">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                {removePhotosResult.success}/{removePhotosResult.total}{' '}
                session(s) cleaned&nbsp;&middot;&nbsp;
                {removePhotosResult.totalDeleted} photo(s) deleted
                {removePhotosResult.failed > 0 && (
                  <span className="text-red-300">
                    {' '}&middot; {removePhotosResult.failed} failed
                  </span>
                )}
              </span>
            </div>
            {Array.isArray(removePhotosResult.results) &&
              removePhotosResult.results.some((r) => !r.success) && (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {removePhotosResult.results
                    .filter((r) => !r.success)
                    .map((r) => (
                      <div
                        key={r.sessionId}
                        className="flex items-start gap-2 text-red-300"
                      >
                        <X className="w-3 h-3 mt-0.5 flex-shrink-0" />
                        <span className="break-words">
                          {r.phone || `Session ${r.sessionId}`}:{' '}
                          {(r.errors || []).join('; ') || 'Failed'}
                        </span>
                      </div>
                    ))}
                </div>
              )}
          </div>
        )}
      </div>

      {/* Per-session Photo Queue — Manual-mode bulk action that lets the
          operator stage MULTIPLE {photo, sessionIds} pairs before hitting
          Apply. Different from the single-photo flow above on the Manual
          form, which sends one photo to every selected session. */}
      {mode === 'manual' && (
        <div className="rounded-xl border border-primary-500/20 bg-gradient-to-br from-primary-500/5 via-dark-800 to-dark-800 p-5">
          <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-4">
            <div className="flex items-start gap-4">
              <div className="rounded-xl bg-primary-500/15 p-3 text-primary-300 flex-shrink-0">
                <ImageIcon className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  Per-session photo queue
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary-500/20 text-primary-200 border border-primary-500/30">
                    Manual mode
                  </span>
                </h3>
                <p className="mt-1 text-xs text-gray-400 max-w-2xl leading-relaxed">
                  Want different photos on different sessions? Upload a photo, pick
                  the sessions in the right column, click <strong>Add to queue</strong>.
                  Repeat with new photos / new sessions. When you're done, hit
                  <strong> Apply queue</strong> and each photo is uploaded to its
                  specific sessions. Session lists aren't supported here — only
                  the individual-session picker.
                </p>
              </div>
            </div>
            {photoQueue.length > 0 && (
              <button
                type="button"
                onClick={handleClearPhotoQueue}
                className="text-xs text-gray-400 hover:text-red-300 transition flex-shrink-0 underline-offset-2 hover:underline"
              >
                Clear queue
              </button>
            )}
          </div>

          {/* Draft builder: upload photo + Add to queue */}
          <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] items-stretch gap-3 mb-4">
            {/* Upload dropzone */}
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-white/10 bg-dark-900 p-3 text-center transition-colors hover:border-primary-500/50 min-h-[100px]">
              <input
                type="file"
                accept="image/*"
                onChange={handlePhotoQueueDraftUpload}
                disabled={photoQueueUploading || photoQueueApplying}
                className="hidden"
              />
              {photoQueueUploading ? (
                <Loader2 className="w-6 h-6 text-primary-500 animate-spin mb-1" />
              ) : photoQueueDraftPreview ? (
                <img
                  src={photoQueueDraftPreview}
                  alt="draft"
                  className="w-16 h-16 rounded-full object-cover border-2 border-primary-500 mb-1"
                />
              ) : (
                <Upload className="w-6 h-6 text-gray-500 mb-1" />
              )}
              <p className="text-xs text-gray-300 truncate max-w-full">
                {photoQueueUploading
                  ? 'Uploading…'
                  : photoQueueDraftFile
                  ? photoQueueDraftFile.name
                  : 'Upload photo'}
              </p>
            </label>

            {/* Status line + selection summary */}
            <div className="flex flex-col justify-center text-xs text-gray-400 px-1">
              <p className="text-gray-300 mb-1">
                {photoQueueDraftFile ? (
                  <>
                    <span className="text-primary-300">Photo ready.</span>{' '}
                    Now pick sessions on the right.
                  </>
                ) : (
                  <>Upload a photo to start the next queue entry.</>
                )}
              </p>
              <p>
                Current selection:{' '}
                <span className="text-white">
                  {sessionPickMode === 'list'
                    ? '(session list — not supported here)'
                    : `${selectedSessionIds.length} session(s)`}
                </span>
              </p>
              {photoQueue.length > 0 && (
                <p className="mt-1">
                  Queue:{' '}
                  <span className="text-white">
                    {photoQueue.length} assignment(s) covering{' '}
                    {
                      new Set(
                        photoQueue.flatMap((e) => e.sessionIds)
                      ).size
                    }{' '}
                    unique session(s)
                  </span>
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={handleAddPhotoQueueEntry}
              disabled={
                !photoQueueDraftFile ||
                photoQueueUploading ||
                photoQueueApplying ||
                sessionPickMode === 'list' ||
                selectedSessionIds.length === 0
              }
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-primary-500/40 bg-primary-500/20 px-4 py-2 text-sm font-medium text-primary-100 hover:bg-primary-500/30 hover:border-primary-500/60 transition disabled:opacity-50 disabled:cursor-not-allowed self-stretch"
              title="Capture the current photo + selected sessions as a queue entry"
            >
              <Plus className="w-4 h-4" />
              Add to queue
            </button>
          </div>

          {/* Queue table */}
          {photoQueue.length > 0 ? (
            <div className="space-y-2 mb-4">
              {photoQueue.map((entry, idx) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-3 rounded-lg border border-white/10 bg-dark-900/60 p-2.5"
                >
                  <div className="flex flex-col items-center flex-shrink-0">
                    <img
                      src={entry.previewUrl}
                      alt={entry.fileName}
                      className="w-12 h-12 rounded-full object-cover border border-white/10"
                    />
                    <span className="text-[10px] text-gray-500 mt-1">
                      #{idx + 1}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-white truncate" title={entry.fileName}>
                      {entry.fileName}
                    </p>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {entry.sessionIds.length} session(s):{' '}
                      {entry.sessionPhones.join(', ')}
                      {entry.sessionIds.length > entry.sessionPhones.length &&
                        ` … +${
                          entry.sessionIds.length - entry.sessionPhones.length
                        } more`}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemovePhotoQueueEntry(entry.id)}
                    disabled={photoQueueApplying}
                    className="text-gray-400 hover:text-red-300 transition p-1 disabled:opacity-50"
                    title="Remove from queue"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center text-xs text-gray-500 italic mb-4 py-2 border border-dashed border-white/5 rounded-lg">
              Queue is empty. Build entries above, then click Apply queue.
            </div>
          )}

          {/* Overlap warning — when the same session is in multiple
              entries, only the LAST entry's photo will end up visible
              because Telegram only renders the most recent upload. */}
          {photoQueueOverlaps.length > 0 && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 text-xs text-yellow-200 leading-relaxed mb-4">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <div>
                  <strong>
                    {photoQueueOverlaps.length} session(s) appear in multiple
                    queue entries.
                  </strong>{' '}
                  Telegram only renders the most recent photo, so for those
                  sessions only the LAST matching assignment's photo will end
                  up visible. (Earlier assignments still upload but get
                  immediately overwritten.)
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleApplyPhotoQueue}
              disabled={photoQueueApplying || photoQueue.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-primary-600 to-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-primary-600/25 transition hover:from-primary-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {photoQueueApplying ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Applying queue&hellip;
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  Apply queue ({photoQueue.length})
                </>
              )}
            </button>
          </div>

          {/* Per-(assignment, session) report after the queue run. */}
          {photoQueueResult && (
            <div className="mt-4 rounded-lg border border-white/10 bg-dark-900/60 p-3 text-xs text-gray-300">
              <div className="flex items-center gap-2 mb-2 text-gray-200">
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span>
                  {photoQueueResult.success}/{photoQueueResult.totalSessions}{' '}
                  session-photo apply(s) succeeded across{' '}
                  {photoQueueResult.totalAssignments} assignment(s)
                  {photoQueueResult.failed > 0 && (
                    <span className="text-red-300">
                      {' '}&middot; {photoQueueResult.failed} failed
                    </span>
                  )}
                </span>
              </div>
              {Array.isArray(photoQueueResult.results) &&
                photoQueueResult.results.some((r) => !r.success) && (
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {photoQueueResult.results
                      .filter((r) => !r.success)
                      .map((r, i) => (
                        <div
                          key={`${r.assignmentIndex}-${r.sessionId}-${i}`}
                          className="flex items-start gap-2 text-red-300"
                        >
                          <X className="w-3 h-3 mt-0.5 flex-shrink-0" />
                          <span className="break-words">
                            Assignment #{r.assignmentIndex + 1} →{' '}
                            {r.phone || `Session ${r.sessionId}`}:{' '}
                            {(r.errors || []).join('; ') || 'Failed'}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
            </div>
          )}
        </div>
      )}

      {/* Confirm dialog: explicit count + double-confirm so an accidental
          click can't nuke every photo across 40 sessions. */}
      {showRemovePhotosConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-red-500/40 bg-dark-800 p-6 shadow-2xl">
            <div className="flex items-start gap-3 mb-4">
              <div className="rounded-lg bg-red-500/15 p-2 text-red-300">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-white">
                  Remove all profile photos?
                </h3>
                <p className="mt-1 text-sm text-gray-400">
                  This will wipe every profile photo on{' '}
                  <strong className="text-white">
                    {removePhotosTargetCount}
                  </strong>{' '}
                  session(s) (visible avatar plus the entire photo
                  history). The accounts will show the default Telegram
                  monogram afterwards. <strong>This cannot be undone.</strong>
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowRemovePhotosConfirm(false)}
                disabled={removingPhotos}
                className="rounded-lg border border-white/10 bg-dark-900 px-4 py-2 text-sm text-gray-300 hover:bg-dark-700 transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRemoveAllPhotos}
                disabled={removingPhotos}
                className="inline-flex items-center gap-2 rounded-lg border border-red-500/50 bg-red-500/30 px-4 py-2 text-sm font-medium text-red-100 hover:bg-red-500/50 transition disabled:opacity-50"
              >
                {removingPhotos ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Removing&hellip;
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    Yes, remove all photos
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mode tabs */}
      <div className="inline-flex rounded-xl border border-white/10 bg-dark-800 p-1">
        <button
          type="button"
          onClick={() => setMode('manual')}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
            mode === 'manual'
              ? 'bg-primary-500/20 text-primary-200 border border-primary-500/30'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          <Pencil className="w-4 h-4" />
          Manual
        </button>
        <button
          type="button"
          onClick={() => setMode('randomize')}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
            mode === 'randomize'
              ? 'bg-primary-500/20 text-primary-200 border border-primary-500/30'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          <Sparkles className="w-4 h-4" />
          Randomize
        </button>
        <button
          type="button"
          onClick={() => setMode('profileList')}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
            mode === 'profileList'
              ? 'bg-primary-500/20 text-primary-200 border border-primary-500/30'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          <ListChecks className="w-4 h-4" />
          Profile List
        </button>
      </div>

      {mode === 'profileList' ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div className="space-y-6">
            <AccountProfileListPanel
              selectedSessions={selectedSessionObjects}
              showSuccess={showSuccess}
              showError={showError}
              onApplied={() => fetchSessions()}
            />
          </div>
          <div className="space-y-6">{renderSessionPicker()}</div>
        </div>
      ) : mode === 'randomize' ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div className="space-y-6">
            <AccountRandomizePanel
              selectedSessions={selectedSessionObjects}
              showSuccess={showSuccess}
              showError={showError}
              onApplied={() => {
                // Refresh session list so any username changes show up.
                fetchSessions();
              }}
            />
          </div>
          <div className="space-y-6">{renderSessionPicker()}</div>
        </div>
      ) : (
      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* Left Column: Update Fields */}
          <div className="space-y-6">
            {/* Name Settings */}
            <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <User className="w-4 h-4 text-primary-500" />
                  Name Settings
                </h3>
              </div>

              <div className="space-y-4">
                {/* First Name */}
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <input
                      type="checkbox"
                      checked={updateFlags.firstName}
                      onChange={() => toggleUpdateFlag('firstName')}
                      className="rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500"
                    />
                    <label className="text-sm font-medium text-gray-300">
                      First Name
                    </label>
                    {renderModeToggle('firstName')}
                  </div>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Enter first name"
                    disabled={!updateFlags.firstName}
                    className={`${inputBase} ${!updateFlags.firstName ? 'opacity-50 cursor-not-allowed' : ''}`}
                  />
                </div>

                {/* Last Name */}
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <input
                      type="checkbox"
                      checked={updateFlags.lastName}
                      onChange={() => toggleUpdateFlag('lastName')}
                      className="rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500"
                    />
                    <label className="text-sm font-medium text-gray-300">
                      Last Name
                    </label>
                    {renderModeToggle('lastName')}
                  </div>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder={
                      updateFlags.lastName && fieldModes.lastName === 'remove'
                        ? 'Last name will be cleared on every selected session'
                        : 'Enter last name'
                    }
                    disabled={
                      !updateFlags.lastName ||
                      fieldModes.lastName === 'remove'
                    }
                    className={`${inputBase} ${
                      !updateFlags.lastName ||
                      fieldModes.lastName === 'remove'
                        ? 'opacity-50 cursor-not-allowed'
                        : ''
                    }`}
                  />
                </div>
              </div>
            </div>

            {/* Username & Bio */}
            <div className="rounded-xl border border-white/5 bg-dark-800 p-5 space-y-4">
              {/* Username */}
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <input
                    type="checkbox"
                    checked={updateFlags.username}
                    onChange={() => toggleUpdateFlag('username')}
                    className="rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500"
                  />
                  <label className="text-sm font-medium text-gray-300 flex items-center gap-2">
                    <AtSign className="w-4 h-4" />
                    Username
                  </label>
                  {renderModeToggle('username')}
                </div>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/^@/, ''))}
                  placeholder={
                    updateFlags.username && fieldModes.username === 'remove'
                      ? 'Username will be cleared on every selected session'
                      : 'username (without @)'
                  }
                  disabled={
                    !updateFlags.username ||
                    fieldModes.username === 'remove'
                  }
                  className={`${inputBase} ${
                    !updateFlags.username || fieldModes.username === 'remove'
                      ? 'opacity-50 cursor-not-allowed'
                      : ''
                  }`}
                />
              </div>

              {/* Bio */}
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <input
                    type="checkbox"
                    checked={updateFlags.bio}
                    onChange={() => toggleUpdateFlag('bio')}
                    className="rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500"
                  />
                  <label className="text-sm font-medium text-gray-300 flex items-center gap-2">
                    <FileText className="w-4 h-4" />
                    Bio / About
                  </label>
                  <span className="text-xs text-gray-500">{bio.length} / 70</span>
                  {renderModeToggle('bio')}
                </div>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value.slice(0, 70))}
                  placeholder={
                    updateFlags.bio && fieldModes.bio === 'remove'
                      ? 'Bio will be cleared on every selected session'
                      : 'Write a short bio (max 70 characters)'
                  }
                  disabled={
                    !updateFlags.bio || fieldModes.bio === 'remove'
                  }
                  rows={3}
                  className={`${inputBase} ${
                    !updateFlags.bio || fieldModes.bio === 'remove'
                      ? 'opacity-50 cursor-not-allowed'
                      : ''
                  } resize-none`}
                />
              </div>
            </div>

            {/* Profile Photo */}
            <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
              <div className="flex items-center gap-2 mb-3">
                <input
                  type="checkbox"
                  checked={updateFlags.profilePhoto}
                  onChange={() => toggleUpdateFlag('profilePhoto')}
                  className="rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500"
                />
                <label className="text-sm font-medium text-gray-300 flex items-center gap-2">
                  <Upload className="w-4 h-4" />
                  Profile Photo
                </label>
                {renderModeToggle('profilePhoto')}
              </div>

              {/* In Remove mode the upload UI is hidden and we show a
                  destructive notice instead. The Apply button at the
                  bottom of the form routes this to the same
                  removeAllProfilePhotos backend the standalone card uses. */}
              {updateFlags.profilePhoto && fieldModes.profilePhoto === 'remove' ? (
                <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-xs text-red-200 leading-relaxed">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <div>
                      <strong>Remove mode active.</strong> When you click
                      <em> Apply Settings</em>, every profile photo
                      (visible avatar + full history) will be deleted
                      from each selected session. Telegram will render
                      the default monogram afterwards. This cannot be
                      undone.
                    </div>
                  </div>
                </div>
              ) : (
                <div className={`space-y-3 ${!updateFlags.profilePhoto ? 'opacity-50' : ''}`}>
                  {profilePhotoPreview && (
                    <div className="flex items-center gap-3 mb-3">
                      <img
                        src={profilePhotoPreview}
                        alt="Preview"
                        className="w-16 h-16 rounded-full object-cover border-2 border-primary-500"
                      />
                      <div className="flex-1">
                        <p className="text-sm text-white">{profilePhoto?.name}</p>
                        <button
                          type="button"
                          onClick={() => {
                            setProfilePhoto(null);
                            setProfilePhotoPreview(null);
                            setUpdateFlags(prev => ({ ...prev, profilePhoto: false }));
                          }}
                          className="text-xs text-red-400 hover:text-red-300"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )}

                  <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-white/10 bg-dark-900 p-6 text-center transition-colors hover:border-primary-500/50">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handlePhotoUpload}
                      disabled={!updateFlags.profilePhoto}
                      className="hidden"
                    />
                    {uploadingPhoto ? (
                      <Loader2 className="w-8 h-8 text-primary-500 animate-spin mb-2" />
                    ) : (
                      <Upload className="w-8 h-8 text-gray-500 mb-2" />
                    )}
                    <p className="text-sm text-gray-300">
                      {uploadingPhoto ? 'Uploading...' : 'Click to upload photo'}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">PNG, JPG or GIF (max 5MB)</p>
                  </label>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Session Selection */}
          <div className="space-y-6">
            {renderSessionPicker()}

            {/* Summary */}
            <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <Eye className="w-4 h-4 text-primary-500" />
                Update Summary
              </h3>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Sessions:</span>
                  <span className="text-white">
                    {sessionPickMode === 'list' ? 'session list' : selectedSessionIds.length}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Fields to update:</span>
                  <span className="text-white">
                    {Object.values(updateFlags).filter(Boolean).length}
                  </span>
                </div>
                <div className="mt-3 pt-3 border-t border-white/10">
                  <p className="text-xs text-gray-500">
                    Selected fields will be updated for all selected sessions
                  </p>
                </div>
              </div>

              {/* Selected fields list. Remove-mode rows show in red so
                  the operator can spot a destructive change at a glance. */}
              <div className="mt-3 space-y-1">
                {updateFlags.firstName && (
                  <div className="flex items-center gap-2 text-xs text-green-400">
                    <Check className="w-3 h-3" />
                    <span>First Name: {firstName || '(empty)'}</span>
                  </div>
                )}
                {updateFlags.lastName && (
                  <div
                    className={`flex items-center gap-2 text-xs ${
                      fieldModes.lastName === 'remove'
                        ? 'text-red-300'
                        : 'text-green-400'
                    }`}
                  >
                    {fieldModes.lastName === 'remove' ? (
                      <Trash2 className="w-3 h-3" />
                    ) : (
                      <Check className="w-3 h-3" />
                    )}
                    <span>
                      Last Name:{' '}
                      {fieldModes.lastName === 'remove'
                        ? '(will be cleared)'
                        : lastName || '(empty)'}
                    </span>
                  </div>
                )}
                {updateFlags.username && (
                  <div
                    className={`flex items-center gap-2 text-xs ${
                      fieldModes.username === 'remove'
                        ? 'text-red-300'
                        : 'text-green-400'
                    }`}
                  >
                    {fieldModes.username === 'remove' ? (
                      <Trash2 className="w-3 h-3" />
                    ) : (
                      <Check className="w-3 h-3" />
                    )}
                    <span>
                      Username:{' '}
                      {fieldModes.username === 'remove'
                        ? '(will be cleared)'
                        : `@${username || '(empty)'}`}
                    </span>
                  </div>
                )}
                {updateFlags.bio && (
                  <div
                    className={`flex items-center gap-2 text-xs ${
                      fieldModes.bio === 'remove'
                        ? 'text-red-300'
                        : 'text-green-400'
                    }`}
                  >
                    {fieldModes.bio === 'remove' ? (
                      <Trash2 className="w-3 h-3" />
                    ) : (
                      <Check className="w-3 h-3" />
                    )}
                    <span>
                      Bio:{' '}
                      {fieldModes.bio === 'remove'
                        ? '(will be cleared)'
                        : bio || '(empty)'}
                    </span>
                  </div>
                )}
                {updateFlags.profilePhoto &&
                  fieldModes.profilePhoto === 'remove' && (
                    <div className="flex items-center gap-2 text-xs text-red-300">
                      <Trash2 className="w-3 h-3" />
                      <span>Profile Photo: (all photos will be removed)</span>
                    </div>
                  )}
                {updateFlags.profilePhoto &&
                  fieldModes.profilePhoto === 'set' &&
                  profilePhoto && (
                    <div className="flex items-center gap-2 text-xs text-green-400">
                      <Check className="w-3 h-3" />
                      <span>Profile Photo: {profilePhoto.name}</span>
                    </div>
                  )}
              </div>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={resetForm}
            className="rounded-lg border border-white/10 px-6 py-2.5 text-sm font-medium text-gray-300 hover:bg-white/5 transition-colors"
          >
            Reset
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-primary-600 to-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-600/25 transition-all duration-200 hover:from-primary-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Updating...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Update All Selected
              </>
            )}
          </button>
        </div>
      </form>
      )}
    </div>
  );
}
