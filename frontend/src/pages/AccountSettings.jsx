import { useState, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import { useToast } from '../components/common/Toast';
import { listSessions } from '../api/sessions';
import { updateAccountSettings, uploadProfilePhoto } from '../api/accountSettings';
import { parseApiError } from '../utils/formatters';

export default function AccountSettings() {
  const { showSuccess, showError } = useToast();

  // Sessions
  const [sessions, setSessions] = useState([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
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

  const [submitting, setSubmitting] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

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
    if (selectedSessionIds.length === 0) {
      showError('Please select at least one session', 'Validation Error');
      return;
    }

    const hasUpdates = Object.values(updateFlags).some(flag => flag);
    if (!hasUpdates) {
      showError('Please select at least one field to update', 'Validation Error');
      return;
    }

    setSubmitting(true);
    try {
      const result = await updateAccountSettings({
        sessionIds: selectedSessionIds,
        firstName: updateFlags.firstName ? firstName : undefined,
        lastName: updateFlags.lastName ? lastName : undefined,
        username: updateFlags.username ? username : undefined,
        bio: updateFlags.bio ? bio : undefined,
        profilePhotoPath: updateFlags.profilePhoto && profilePhoto ? profilePhoto.path : undefined,
        updateFlags,
      });

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
    setSelectedSessionIds([]);
  };

  const toggleUpdateFlag = (field) => {
    setUpdateFlags(prev => ({ ...prev, [field]: !prev[field] }));
  };

  const inputBase = 'w-full rounded-lg border bg-dark-900 py-2.5 px-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition';

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Account Settings</h1>
        <p className="mt-1 text-sm text-gray-400">
          Update name, username, bio, and profile picture for multiple sessions at once
        </p>
      </div>

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
                  </div>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Enter last name"
                    disabled={!updateFlags.lastName}
                    className={`${inputBase} ${!updateFlags.lastName ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                </div>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/^@/, ''))}
                  placeholder="username (without @)"
                  disabled={!updateFlags.username}
                  className={`${inputBase} ${!updateFlags.username ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                  <span className="text-xs text-gray-500 ml-auto">{bio.length} / 70</span>
                </div>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value.slice(0, 70))}
                  placeholder="Write a short bio (max 70 characters)"
                  disabled={!updateFlags.bio}
                  rows={3}
                  className={`${inputBase} ${!updateFlags.bio ? 'opacity-50 cursor-not-allowed' : ''} resize-none`}
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
              </div>

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
            </div>
          </div>

          {/* Right Column: Session Selection */}
          <div className="space-y-6">
            {/* Session Selection */}
            <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
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
            </div>

            {/* Summary */}
            <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <Eye className="w-4 h-4 text-primary-500" />
                Update Summary
              </h3>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Sessions:</span>
                  <span className="text-white">{selectedSessionIds.length}</span>
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

              {/* Selected fields list */}
              <div className="mt-3 space-y-1">
                {updateFlags.firstName && (
                  <div className="flex items-center gap-2 text-xs text-green-400">
                    <Check className="w-3 h-3" />
                    <span>First Name: {firstName || '(empty)'}</span>
                  </div>
                )}
                {updateFlags.lastName && (
                  <div className="flex items-center gap-2 text-xs text-green-400">
                    <Check className="w-3 h-3" />
                    <span>Last Name: {lastName || '(empty)'}</span>
                  </div>
                )}
                {updateFlags.username && (
                  <div className="flex items-center gap-2 text-xs text-green-400">
                    <Check className="w-3 h-3" />
                    <span>Username: @{username || '(empty)'}</span>
                  </div>
                )}
                {updateFlags.bio && (
                  <div className="flex items-center gap-2 text-xs text-green-400">
                    <Check className="w-3 h-3" />
                    <span>Bio: {bio || '(empty)'}</span>
                  </div>
                )}
                {updateFlags.profilePhoto && profilePhoto && (
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
    </div>
  );
}
