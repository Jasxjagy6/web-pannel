import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Upload,
  Instagram,
  FileJson,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Copy,
  Code2,
  Terminal,
  ShieldCheck,
} from 'lucide-react';
import { uploadSessions } from '@/api/sessions';
import { useToast } from '../../components/common/Toast';
import { apiError } from '../../utils/apiError';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

const SAMPLE_JSON = JSON.stringify(
  {
    username: 'your.username',
    sessionBlob: {
      cookies: {
        version: 'tough-cookie@4.0.0',
        storeType: 'MemoryCookieStore',
        rejectPublicSuffixes: true,
        cookies: [
          {
            key: 'sessionid',
            value: 'PASTE_YOUR_SESSIONID_FROM_DEV_TOOLS',
            domain: 'instagram.com',
            path: '/',
            secure: true,
            httpOnly: true,
            hostOnly: false,
            creation: '2026-05-02T00:00:00.000Z',
            lastAccessed: '2026-05-02T00:00:00.000Z',
          },
          {
            key: 'ds_user_id',
            value: 'PASTE_YOUR_DS_USER_ID',
            domain: 'instagram.com',
            path: '/',
            secure: true,
            httpOnly: false,
            hostOnly: false,
            creation: '2026-05-02T00:00:00.000Z',
            lastAccessed: '2026-05-02T00:00:00.000Z',
          },
          {
            key: 'csrftoken',
            value: 'PASTE_YOUR_CSRFTOKEN',
            domain: 'instagram.com',
            path: '/',
            secure: true,
            httpOnly: false,
            hostOnly: false,
            creation: '2026-05-02T00:00:00.000Z',
            lastAccessed: '2026-05-02T00:00:00.000Z',
          },
        ],
      },
      deviceString: 'android-aaaaaaaaaaaaaaaa; 24/7.0; en_US; samsung; SM-G960F; 480dpi; 1080x1920; SM-G960F-user; samsung',
      deviceId: 'android-aaaaaaaaaaaaaaaa',
      uuid: '00000000-0000-0000-0000-000000000000',
      phoneId: '00000000-0000-0000-0000-000000000000',
      adid: '00000000-0000-0000-0000-000000000000',
      build: 'samsung/SM-G960F:8.0.0/R16NW.G960FXXU1ARDX/1517332533:user/release-keys',
    },
    proxyUrl: null,
  },
  null,
  2
);

export default function InstagramUploadSession() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const fileInputRef = useRef(null);

  const [files, setFiles] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState(null);
  const [showSample, setShowSample] = useState(false);

  const processFiles = useCallback((fileList) => {
    const all = Array.from(fileList);
    const valid = all.filter((f) => /\.json$/i.test(f.name));
    const skipped = all.length - valid.length;
    if (skipped > 0) {
      showToast(`${skipped} file${skipped === 1 ? '' : 's'} skipped (only .json allowed)`, 'warning');
    }
    setFiles(valid);
  }, [showToast]);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault(); e.stopPropagation();
    setIsDragging(true);
  }, []);
  const handleDragLeave = useCallback((e) => {
    e.preventDefault(); e.stopPropagation();
    setIsDragging(false);
  }, []);
  const handleDragOver = useCallback((e) => {
    e.preventDefault(); e.stopPropagation();
  }, []);
  const handleDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files?.length > 0) processFiles(e.dataTransfer.files);
  }, [processFiles]);

  const handleInputChange = (e) => {
    if (e.target.files?.length > 0) processFiles(e.target.files);
  };

  const removeFile = (idx) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  const handleUpload = async () => {
    if (files.length === 0) return;
    setUploading(true);
    setResults(null);
    const formData = new FormData();
    files.forEach((f) => formData.append('sessions', f));
    try {
      const res = await uploadSessions(formData);
      const data = res.data?.data || res.data;
      setResults(data);
      if (data?.successful > 0) {
        showToast(`Uploaded ${data.successful} session${data.successful === 1 ? '' : 's'}`, 'success');
      }
      if (data?.failed > 0) {
        showToast(`${data.failed} session${data.failed === 1 ? '' : 's'} failed — see results`, 'warning');
      }
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      showToast(apiError(err, 'Failed to upload sessions'), 'error');
    } finally {
      setUploading(false);
    }
  };

  const copySample = async () => {
    try {
      await navigator.clipboard.writeText(SAMPLE_JSON);
      showToast('Sample JSON copied to clipboard', 'success');
    } catch (_) {
      showToast('Could not access clipboard', 'error');
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className={`rounded-xl ${IG_GRADIENT} px-6 py-5 text-white shadow-lg`}>
        <div className="flex items-start gap-3">
          <Instagram className="mt-0.5 h-7 w-7" />
          <div>
            <div className="text-lg font-semibold">Upload Instagram session</div>
            <div className="text-sm text-white/85">
              Already logged-in elsewhere? Upload a JSON session blob and we'll attach it to the panel
              without going through the username + password + 2FA flow. Your session stays active for as
              long as the panel runs (same lifecycle as Telegram sessions).
            </div>
          </div>
        </div>
      </div>

      {/* Drag & drop area */}
      <div className="rounded-xl border border-pink-100 bg-white p-6 shadow-sm dark:border-pink-900/30 dark:bg-dark-800">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
          <Upload className="h-4 w-4 text-pink-500" />
          Bulk upload session JSON files
        </h3>

        <div
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`relative flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
            isDragging
              ? 'border-pink-500 bg-pink-50 dark:bg-pink-900/10'
              : 'border-pink-200 bg-pink-50/40 hover:border-pink-300 hover:bg-pink-50 dark:border-pink-900/40 dark:bg-pink-900/5 dark:hover:bg-pink-900/10'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".json,application/json"
            onChange={handleInputChange}
            className="hidden"
          />
          <FileJson className="mb-2 h-9 w-9 text-pink-500" />
          <div className="text-sm font-medium text-gray-900 dark:text-white">
            Drop .json files here, or click to choose
          </div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            One file may contain a single record or an array of records.
          </div>
        </div>

        {files.length > 0 && (
          <div className="mt-4 space-y-2">
            {files.map((f, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between rounded-lg border border-pink-100 bg-pink-50/40 px-3 py-2 text-sm dark:border-pink-900/30 dark:bg-pink-900/10"
              >
                <div className="flex items-center gap-2">
                  <FileJson className="h-4 w-4 text-pink-500" />
                  <span className="truncate text-gray-900 dark:text-white">{f.name}</span>
                  <span className="text-xs text-gray-500">({(f.size / 1024).toFixed(1)} KB)</span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(idx);
                  }}
                  className="text-pink-500 hover:text-pink-700"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setFiles([])}
                disabled={uploading}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-dark-600 dark:text-gray-300 dark:hover:bg-dark-700"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={handleUpload}
                disabled={uploading || files.length === 0}
                className={`flex items-center gap-2 rounded-lg ${IG_GRADIENT} px-4 py-2 text-sm font-medium text-white shadow-md transition hover:opacity-95 disabled:opacity-50`}
              >
                {uploading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    Upload {files.length} file{files.length === 1 ? '' : 's'}
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Upload results */}
      {results && (
        <div className="rounded-xl border border-pink-100 bg-white p-6 shadow-sm dark:border-pink-900/30 dark:bg-dark-800">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            Upload complete — {results.successful} successful, {results.failed} failed
          </h3>
          <div className="space-y-1 text-sm">
            {(results.results || []).map((r, idx) => (
              <div
                key={idx}
                className={`flex items-start gap-2 rounded border px-3 py-2 ${
                  r.status === 'success'
                    ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900/30 dark:bg-green-900/10 dark:text-green-200'
                    : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/30 dark:bg-red-900/10 dark:text-red-200'
                }`}
              >
                {r.status === 'success' ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" />
                ) : (
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-none" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{r.filename}</div>
                  {r.status === 'success' ? (
                    <div className="text-xs opacity-90">
                      Created session #{r.sessionId} for @{r.username}
                    </div>
                  ) : (
                    <div className="text-xs opacity-90">{r.error}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
          {results.successful > 0 && (
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => navigate('/instagram/sessions')}
                className={`rounded-lg ${IG_GRADIENT} px-4 py-2 text-sm font-medium text-white shadow-md hover:opacity-95`}
              >
                View accounts
              </button>
            </div>
          )}
        </div>
      )}

      {/* How-to guide */}
      <div className="rounded-xl border border-pink-100 bg-white p-6 shadow-sm dark:border-pink-900/30 dark:bg-dark-800">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
          <ShieldCheck className="h-4 w-4 text-pink-500" />
          How to generate the session JSON
        </h3>

        <div className="space-y-4 text-sm text-gray-700 dark:text-gray-300">
          <p>
            Instagram doesn't expose a one-click "export session" button, so you have to produce the
            JSON yourself. There are two officially supported paths:
          </p>

          <div className="rounded-lg border border-pink-100 bg-pink-50/40 p-4 dark:border-pink-900/30 dark:bg-pink-900/10">
            <div className="mb-2 flex items-center gap-2 font-medium text-gray-900 dark:text-white">
              <Terminal className="h-4 w-4 text-pink-500" />
              Option A — Use our CLI helper (recommended)
            </div>
            <p className="mb-2">
              Clone this repo on your laptop and run the helper script. It logs into Instagram once
              from your home IP (so the device gets pre-authorised) and writes a clean
              <code className="mx-1 rounded bg-pink-100 px-1.5 py-0.5 font-mono text-xs dark:bg-pink-900/30">
                session.json
              </code>
              you can drag into the box above:
            </p>
            <pre className="overflow-x-auto rounded-md bg-gray-900 p-3 font-mono text-xs text-gray-100">
{`# from the repo root, with Node 20+ installed locally
node scripts/ig-export-session.js \\
  --username YOUR_USERNAME \\
  --password 'YOUR_PASSWORD' \\
  --out      ./session.json

# if your account uses 2FA, the script will prompt for the code
# you can also pass it inline:
node scripts/ig-export-session.js \\
  --username YOUR_USERNAME \\
  --password 'YOUR_PASSWORD' \\
  --otp      123456 \\
  --out      ./session.json`}
            </pre>
          </div>

          <div className="rounded-lg border border-pink-100 bg-pink-50/40 p-4 dark:border-pink-900/30 dark:bg-pink-900/10">
            <div className="mb-2 flex items-center gap-2 font-medium text-gray-900 dark:text-white">
              <Code2 className="h-4 w-4 text-pink-500" />
              Option B — Hand-craft from browser cookies
            </div>
            <p className="mb-2">
              Log into Instagram in a desktop browser, open DevTools → Application → Cookies →
              <code className="mx-1 rounded bg-pink-100 px-1.5 py-0.5 font-mono text-xs dark:bg-pink-900/30">
                https://www.instagram.com
              </code>
              and copy the values for <strong>sessionid</strong>, <strong>ds_user_id</strong>, and
              <strong>csrftoken</strong>. Paste them into the JSON template:
            </p>
            <button
              type="button"
              onClick={() => setShowSample((s) => !s)}
              className="mb-2 flex items-center gap-2 rounded-lg border border-pink-200 px-3 py-1.5 text-xs font-medium text-pink-700 hover:bg-pink-50 dark:border-pink-900/30 dark:text-pink-300 dark:hover:bg-pink-900/10"
            >
              {showSample ? 'Hide template' : 'Show template'}
            </button>
            {showSample && (
              <div className="space-y-2">
                <pre className="overflow-x-auto rounded-md bg-gray-900 p-3 font-mono text-[11px] text-gray-100">
{SAMPLE_JSON}
                </pre>
                <button
                  type="button"
                  onClick={copySample}
                  className="flex items-center gap-2 rounded-lg border border-pink-200 px-3 py-1.5 text-xs font-medium text-pink-700 hover:bg-pink-50 dark:border-pink-900/30 dark:text-pink-300 dark:hover:bg-pink-900/10"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy template
                </button>
              </div>
            )}
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            Once a session row is created, this panel will keep it alive for as long as the server is
            running — the same way Telegram sessions stay logged-in across panel logins.
          </p>
        </div>
      </div>
    </div>
  );
}
