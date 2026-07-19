import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Clapperboard,
  Upload,
  Loader2,
  Link as LinkIcon,
  Image as ImageIcon,
  Video,
  Check,
  X,
  Clock,
  RefreshCw,
  Ban,
  Crown,
} from 'lucide-react';
import {
  uploadStoryMedia,
  createStoryJob,
  listStoryJobs,
  getStoryJobItems,
  cancelStoryJob,
} from '../../api/stories';
import { parseApiError } from '../../utils/formatters';

const PERIOD_OPTIONS = [
  { value: 6 * 3600, label: '6 hours' },
  { value: 12 * 3600, label: '12 hours' },
  { value: 24 * 3600, label: '24 hours' },
  { value: 48 * 3600, label: '48 hours' },
];
const PRIVACY_OPTIONS = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'close_friends', label: 'Close Friends' },
];

const STATUS_STYLE = {
  completed: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  running: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  pending: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  failed: 'text-red-300 bg-red-500/10 border-red-500/30',
  cancelled: 'text-gray-400 bg-gray-500/10 border-gray-500/30',
};

const SKIP_LABEL = {
  not_premium: 'Not Premium',
  not_connected: 'Not logged in',
  cannot_send: "Can't post",
  limit_reached: 'Story limit',
  cancelled: 'Cancelled',
  worker_crashed: 'Worker error',
};

export default function AccountStoryPanel({
  selectedSessions = [],
  sessionPickMode = 'sessions',
  selectedSessionListId = '',
  showSuccess,
  showError,
}) {
  const [media, setMedia] = useState(null); // { mediaPath, mediaName, mediaType }
  const [localPreview, setLocalPreview] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [caption, setCaption] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [privacy, setPrivacy] = useState('everyone');
  const [period, setPeriod] = useState(24 * 3600);
  const [pinToProfile, setPinToProfile] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef(null);

  // History
  const [jobs, setJobs] = useState([]);
  const [expandedJob, setExpandedJob] = useState(null);
  const [jobItems, setJobItems] = useState({});

  const premiumCount = selectedSessions.filter(
    (s) => (s.accountInfo?.isPremium ?? s.account_info?.isPremium) === true
  ).length;

  const fetchJobs = useCallback(async () => {
    try {
      const res = await listStoryJobs({ limit: 20 });
      setJobs(res.data?.data?.jobs || []);
    } catch (err) {
      // non-fatal
      console.warn('story jobs fetch failed', parseApiError(err));
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Poll while any job is active.
  useEffect(() => {
    const hasActive = jobs.some((j) => j.status === 'pending' || j.status === 'running');
    if (!hasActive) return undefined;
    const t = setInterval(fetchJobs, 4000);
    return () => clearInterval(t);
  }, [jobs, fetchJobs]);

  const handleFile = async (file) => {
    if (!file) return;
    const isVideo = /^video\//.test(file.type) || /\.(mp4|mov|webm|m4v)$/i.test(file.name);
    const isImage = /^image\//.test(file.type) || /\.(jpe?g|png|webp|gif)$/i.test(file.name);
    if (!isVideo && !isImage) {
      showError('Please choose a JPG/PNG image or an MP4 video.', 'Unsupported file');
      return;
    }
    setUploading(true);
    setLocalPreview({ url: URL.createObjectURL(file), isVideo });
    try {
      const form = new FormData();
      form.append('media', file);
      const res = await uploadStoryMedia(form);
      setMedia(res.data?.data || null);
    } catch (err) {
      showError(parseApiError(err), 'Upload failed');
      setMedia(null);
      setLocalPreview(null);
    } finally {
      setUploading(false);
    }
  };

  const clearMedia = () => {
    setMedia(null);
    setLocalPreview(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleSubmit = async () => {
    if (!media) {
      showError('Upload a photo or video first.', 'No media');
      return;
    }
    const usingList = sessionPickMode === 'list';
    if (usingList && !selectedSessionListId) {
      showError('Select a session list.', 'No sessions');
      return;
    }
    if (!usingList && selectedSessions.length === 0) {
      showError('Select at least one session.', 'No sessions');
      return;
    }
    if (linkUrl.trim() && !/^https?:\/\//i.test(linkUrl.trim())) {
      showError('Link must start with http:// or https://', 'Invalid link');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        mediaPath: media.mediaPath,
        mediaType: media.mediaType,
        mediaName: media.mediaName,
        caption: caption.trim() || undefined,
        linkUrl: linkUrl.trim() || undefined,
        privacy,
        periodSeconds: period,
        pinToProfile,
      };
      if (usingList) payload.sessionListId = Number(selectedSessionListId);
      else payload.sessionIds = selectedSessions.map((s) => s.id);

      const res = await createStoryJob(payload);
      const d = res.data?.data || {};
      showSuccess(
        `Story job queued — ${d.eligible} eligible session(s)` +
          (d.skippedNonPremium ? `, ${d.skippedNonPremium} non-premium skipped` : '') + '.',
        'Story queued'
      );
      // Reset the composer but keep options.
      clearMedia();
      setCaption('');
      setLinkUrl('');
      fetchJobs();
    } catch (err) {
      showError(parseApiError(err), 'Could not queue story');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleJob = async (jobId) => {
    if (expandedJob === jobId) {
      setExpandedJob(null);
      return;
    }
    setExpandedJob(jobId);
    if (!jobItems[jobId]) {
      try {
        const res = await getStoryJobItems(jobId);
        setJobItems((prev) => ({ ...prev, [jobId]: res.data?.data?.items || [] }));
      } catch (err) {
        showError(parseApiError(err), 'Could not load results');
      }
    }
  };

  const handleCancel = async (jobId) => {
    try {
      await cancelStoryJob(jobId);
      showSuccess(`Job #${jobId} cancellation requested.`, 'Cancelling');
      fetchJobs();
    } catch (err) {
      showError(parseApiError(err), 'Cancel failed');
    }
  };

  return (
    <div className="space-y-6">
      {/* Composer */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
        <h3 className="mb-1 text-sm font-semibold text-white flex items-center gap-2">
          <Clapperboard className="w-4 h-4 text-primary-500" />
          Upload Story
        </h3>
        <p className="mb-4 text-xs text-gray-500 flex items-center gap-1.5">
          <Crown className="w-3.5 h-3.5 text-amber-400" />
          Stories are Premium-only. Non-premium sessions are skipped automatically.
          {selectedSessions.length > 0 && (
            <span className="ml-1 text-gray-400">
              ({premiumCount}/{selectedSessions.length} selected are Premium)
            </span>
          )}
        </p>

        {/* Media dropzone */}
        {!localPreview ? (
          <div
            onClick={() => fileRef.current?.click()}
            className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-white/10 bg-dark-900 p-6 text-center hover:border-white/20 transition"
          >
            <Upload className="mb-2 h-8 w-8 text-gray-500" />
            <p className="text-sm text-gray-300">Click to select a photo or video</p>
            <p className="mt-1 text-xs text-gray-500">JPG, PNG, or MP4 · up to 50MB</p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </div>
        ) : (
          <div className="relative rounded-lg border border-white/10 bg-dark-900 p-3">
            <div className="flex items-center gap-3">
              <div className="h-24 w-24 flex-shrink-0 overflow-hidden rounded-md bg-black/40 flex items-center justify-center">
                {localPreview.isVideo ? (
                  <video src={localPreview.url} className="h-full w-full object-cover" muted />
                ) : (
                  <img src={localPreview.url} alt="preview" className="h-full w-full object-cover" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-sm text-gray-200">
                  {localPreview.isVideo ? <Video className="w-4 h-4" /> : <ImageIcon className="w-4 h-4" />}
                  {media?.mediaName || 'media'}
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {uploading ? 'Uploading…' : media ? 'Ready to post' : 'Not uploaded'}
                </p>
                {uploading && <Loader2 className="mt-1 h-4 w-4 animate-spin text-primary-400" />}
              </div>
              <button
                type="button"
                onClick={clearMedia}
                className="rounded-md p-1.5 text-gray-400 hover:bg-white/5 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Caption + link */}
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">Caption (optional)</label>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={2}
              maxLength={2048}
              placeholder="Add text to your story…"
              className="w-full resize-none rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400 flex items-center gap-1.5">
              <LinkIcon className="w-3.5 h-3.5" /> Link (optional)
            </label>
            <input
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://example.com"
              className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-gray-600">
              Appended to the caption as a tappable link.
            </p>
          </div>

          {/* Options */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-400">Visible to</label>
              <select
                value={privacy}
                onChange={(e) => setPrivacy(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-200 focus:border-primary-500 focus:outline-none"
              >
                {PRIVACY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-400">Duration</label>
              <select
                value={period}
                onChange={(e) => setPeriod(Number(e.target.value))}
                className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-200 focus:border-primary-500 focus:outline-none"
              >
                {PERIOD_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={pinToProfile}
              onChange={(e) => setPinToProfile(e.target.checked)}
              className="rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500"
            />
            Keep on profile after it expires
          </label>
        </div>

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || uploading || !media}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-500 disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
          Post Story to Selected Sessions
        </button>
      </div>

      {/* History */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary-500" />
            Story History
          </h3>
          <button
            type="button"
            onClick={fetchJobs}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        {jobs.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">No story jobs yet.</p>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-lg border border-white/5 bg-dark-900">
                <div
                  className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2.5"
                  onClick={() => toggleJob(job.id)}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {job.media_type === 'video' ? (
                      <Video className="w-4 h-4 flex-shrink-0 text-gray-400" />
                    ) : (
                      <ImageIcon className="w-4 h-4 flex-shrink-0 text-gray-400" />
                    )}
                    <span className="text-sm font-mono text-gray-300">#{job.id}</span>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                        STATUS_STYLE[job.status] || STATUS_STYLE.pending
                      }`}
                    >
                      {job.status}
                    </span>
                    {job.caption && (
                      <span className="truncate text-xs text-gray-500">{job.caption}</span>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2 text-xs">
                    <span className="text-emerald-400">{job.succeeded_count}✓</span>
                    {job.failed_count > 0 && <span className="text-red-400">{job.failed_count}✗</span>}
                    {job.skipped_count > 0 && (
                      <span className="text-gray-500">{job.skipped_count} skip</span>
                    )}
                    <span className="text-gray-600">/ {job.total_sessions}</span>
                    {(job.status === 'pending' || job.status === 'running') && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleCancel(job.id); }}
                        className="ml-1 rounded p-1 text-gray-400 hover:bg-red-500/10 hover:text-red-400"
                        title="Cancel"
                      >
                        <Ban className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {expandedJob === job.id && (
                  <div className="border-t border-white/5 px-3 py-2">
                    {!jobItems[job.id] ? (
                      <div className="flex items-center gap-2 py-2 text-xs text-gray-500">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading results…
                      </div>
                    ) : (
                      <div className="max-h-64 space-y-1 overflow-auto">
                        {jobItems[job.id].map((it) => (
                          <div
                            key={it.session_id}
                            className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-white/[0.02]"
                          >
                            <span className="truncate text-gray-300">{it.session_label}</span>
                            <span className="flex-shrink-0">
                              {it.status === 'posted' ? (
                                <span className="flex items-center gap-1 text-emerald-400">
                                  <Check className="w-3.5 h-3.5" /> posted
                                </span>
                              ) : it.status === 'skipped' ? (
                                <span className="text-gray-500">
                                  {SKIP_LABEL[it.skip_reason] || 'skipped'}
                                </span>
                              ) : it.status === 'failed' ? (
                                <span className="flex items-center gap-1 text-red-400" title={it.error_message || ''}>
                                  <X className="w-3.5 h-3.5" /> failed
                                </span>
                              ) : (
                                <span className="text-amber-400">{it.status}</span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
