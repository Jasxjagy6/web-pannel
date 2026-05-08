const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const { encrypt, decrypt } = require('../utils/crypto');
const { convertTelethonToGramJS } = require('../utils/telethonConverter');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
// telegramService is already exported as a singleton - all services share the same instance
const tgService = require('./telegramService');
const { uploadDir } = require('../middleware/upload');

/**
 * Known status values for sessions in the database.
 */
const VALID_STATUSES = ['uploaded', 'active', 'inactive', 'error', 'revoked', 'expired'];

/**
 * Supported upload file extensions.
 *
 * `.zip` is handled by `_expandZipUploads` BEFORE the per-file loop runs,
 * so it never reaches the main extension-validation gate. The contents of
 * each zip are unpacked into virtual file entries that match the existing
 * `.session` / `.json` / `.bin` / `.txt` shapes.
 */
const SUPPORTED_EXTENSIONS = ['.session', '.json', '.bin', '.txt'];

/**
 * Extensions accepted as session entries inside an uploaded `.zip`.
 *
 * Anything else (READMEs, screenshots, .csv exports, OS metadata, etc.)
 * is silently skipped so users can drop the unmodified zip they got from
 * a Telethon → GramJS migration tool without having to clean it up first.
 */
const ZIP_ENTRY_EXTENSIONS = ['.session', '.json', '.bin', '.txt'];

/**
 * Hard ceiling on a single decompressed entry inside a zip. Independently
 * enforced from the per-file MAX_SESSION_FILE_SIZE so a zip-bomb crafted
 * to expand to many gigabytes can't OOM the backend before validation
 * runs. 100MB matches the legacy per-file limit; the assumption is that
 * a real GramJS string session is < 4KB even with metadata.
 */
const ZIP_ENTRY_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Hard ceiling on the total decompressed payload of one zip. We cap at
 * 1GB to prevent a multi-thousand-entry archive from filling disk during
 * extraction. Operators can raise this via SESSION_ZIP_TOTAL_MAX_BYTES.
 */
const ZIP_TOTAL_MAX_BYTES = parseInt(
  process.env.SESSION_ZIP_TOTAL_MAX_BYTES || String(1024 * 1024 * 1024),
  10
);

/**
 * Maximum file size for individual session uploads (100MB).
 */
const MAX_SESSION_FILE_SIZE = 100 * 1024 * 1024;

/**
 * Timeout for Telegram connection during login.
 *
 * Sessions whose proxy/route to Telegram is slow (proxy reassignment, DC
 * fallback after a TCP RST, MTProto auth-key handshake under packet loss)
 * frequently take 25–45s to complete the connect+getMe round-trip. The
 * legacy 30s ceiling tripped on those sessions and surfaced as the
 * (frequently-reported) "max login time reached" / "Login timeout
 * exceeded (30s)" error even though the session itself was perfectly
 * valid.
 *
 * Default raised to 90s and made tunable via env so operators can dial it
 * up further on slower VPS regions without a code change.
 */
const LOGIN_TIMEOUT_MS = parseInt(
  process.env.SESSION_LOGIN_TIMEOUT_MS || '90000',
  10
);

/**
 * Timeout for the per-call `getMe()` round-trip after the connect+handshake
 * has completed. This is a separate budget from LOGIN_TIMEOUT_MS so a
 * stalled getMe doesn't get conflated with a connect failure in the error
 * message.
 */
const GET_ME_TIMEOUT_MS = parseInt(
  process.env.SESSION_GET_ME_TIMEOUT_MS || '30000',
  10
);

/**
 * SQLite magic header bytes used to detect Telethon session files.
 */
const SQLITE_HEADER = Buffer.from('SQLite format 3\0');

/**
 * Subdirectory under uploadDir where session files are stored.
 */
const SESSION_SUBDIR = 'sessions';

/**
 * Chunk size for streaming batch file processing (number of files per chunk).
 */
const DEFAULT_BATCH_CHUNK_SIZE = 100;

/**
 * Timeout in milliseconds for Telegram client connection attempts during
 * session validation and login operations.
 */
const CONNECTION_TIMEOUT_MS = 15000;

/**
 * SessionService - Handles session file uploads, validation, storage,
 * and batch processing for Telegram session management.
 *
 * Manages the full lifecycle of session files including upload parsing,
 * encrypted storage, database persistence, batch processing with streaming,
 * and telegram client lifecycle management.
 */
class SessionService {
  constructor() {
    /**
     * Lazily-created TelegramService instance for session operations.
     * @type {TelegramService|null}
     */
    this._telegramService = null;
  }

  // Uses the shared singleton TelegramService instance (tgService)
  // No need for _getTelegramService - just use tgService directly

  // =========================================================================
  // File Upload and Parsing
  // =========================================================================

  /**
   * Handle bulk session file uploads.
   *
   * Accepts an array of multer file objects. Each file is parsed based on its
   * extension:
   *   - .json: Expected to contain one or more session strings (as JSON array
   *     or plain string). Each session string becomes a separate database record.
   *   - .session / .bin: Telethon binary session files. These are copied to the
   *     upload directory and their path is stored in the database.
   *
   * Session strings are encrypted before database storage. File paths are stored
   * relative to uploadDir. All database inserts are wrapped in a single
   * transaction per file.
   *
   * @param {object[]} files - Array of multer file objects
   * @param {number|string} userId - The user who owns these sessions
   * @param {object} options - Upload options
   * @param {number} options.apiId - Telegram API ID (optional, uses config default)
   * @param {string} options.apiHash - Telegram API Hash (optional)
   * @param {boolean} options.autoLogin - Whether to attempt auto-login after upload
   * @returns {Promise<{
   *   total: number,
   *   successful: number,
   *   failed: number,
   *   results: Array<{
   *     filename: string,
   *     status: 'success' | 'error',
   *     sessionId?: number,
   *     sessionString?: boolean,
   *     error?: string
   *   }>,
   *   duration: number
   * }>}
   */
  async uploadSessions(files, userId, options = {}) {
    const startTime = Date.now();
    let { apiId, apiHash, autoLogin = false } = options;
    let userApiCredentialId = null;

    // v8: every uploaded session must be tied to one of the user's
    // per-user Telegram credentials. If the user didn't pass an
    // explicit override, we pick one credential up-front and bind every
    // file in this batch to it. We deliberately allocate ONE
    // credential for the whole batch so the rotation cap counts the
    // batch as one logical group rather than racing N times.
    if (!apiId || !apiHash) {
      try {
        const userApiCredentials = require('./userApiCredentialsService');
        const pick = await userApiCredentials.pickForNewSession(userId);
        apiId = pick.apiId;
        apiHash = pick.apiHash;
        userApiCredentialId = pick.id;
      } catch (err) {
        if (err && err.code === 'API_CREDENTIALS_REQUIRED') throw err;
        if (err && err.code === 'NO_CREDENTIAL_CAPACITY') throw err;
        // Fall through to legacy behaviour if no credentials and no
        // override — sessionService will reject the upload via the
        // existing api_id/api_hash NULL handling.
      }
    }

    logger.info(`Starting bulk session upload for user ${userId}`, {
      fileCount: files.length,
      autoLogin,
    });

    if (!files || files.length === 0) {
      throw new AppError('No files provided for upload', 400, 'NO_FILES');
    }

    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    const results = [];
    let successfulCount = 0;
    let failedCount = 0;

    // Expand any uploaded `.zip` archives into virtual per-entry file
    // objects BEFORE the main loop runs. This keeps the rest of the
    // upload pipeline ignorant of the zip path entirely — every zip
    // entry is processed by exactly the same code path that handles a
    // directly-uploaded `.json` / `.session` / `.bin` / `.txt` file.
    let expandedFiles;
    const cleanupTempDirs = [];
    try {
      const expansion = await this._expandZipUploads(files, results);
      expandedFiles = expansion.files;
      cleanupTempDirs.push(...expansion.tempDirs);
      // `results` already contains zip-level summary rows ('zip:foo.zip ok / X
      // entries'); the entries themselves are now in `expandedFiles`.
    } catch (zipErr) {
      // Hard zip-level failures (e.g. corrupt archive) bubble up so the
      // caller gets a clear 4xx instead of an opaque 'no entries' message.
      throw zipErr;
    }

    for (const file of expandedFiles) {
      const fileResult = {
        filename: file.originalname,
        status: 'error',
      };

      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const ext = path.extname(file.originalname).toLowerCase();

          if (!SUPPORTED_EXTENSIONS.includes(ext)) {
            throw new AppError(
              `Unsupported file type: ${ext}. Allowed: ${SUPPORTED_EXTENSIONS.join(', ')}`,
              400,
              'UNSUPPORTED_FILE_TYPE'
            );
          }

          if (file.size > MAX_SESSION_FILE_SIZE) {
            throw new AppError(
              `File ${file.originalname} exceeds maximum size of ${MAX_SESSION_FILE_SIZE / 1024 / 1024}MB`,
              400,
              'FILE_TOO_LARGE'
            );
          }

          if (ext === '.json' || ext === '.txt') {
            const inserted = await this._processJsonUpload(
              client,
              file,
              userId,
              apiId,
              apiHash,
              autoLogin,
              userApiCredentialId
            );
            fileResult.status = 'success';
            fileResult.sessionId = inserted.length > 0 ? inserted[0] : null;
            fileResult.sessionsCreated = inserted.length;
            successfulCount++;
            results.push(fileResult);
          } else {
            const sessionId = await this._processBinaryUpload(
              client,
              file,
              userId,
              ext,
              apiId,
              apiHash,
              userApiCredentialId
            );
            fileResult.status = 'success';
            fileResult.sessionId = sessionId;
            successfulCount++;
            results.push(fileResult);
          }

          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        logger.error(`Failed to process upload for file ${file.originalname}`, {
          userId,
          error: error.message,
        });
        fileResult.error = error.message || 'Unknown upload error';
        failedCount++;
        results.push(fileResult);
      }
    }

    // Best-effort cleanup of any temp dirs we created while extracting
    // zips. The actual session payloads have already been written to the
    // user's permanent session dir by `_processJsonUpload` /
    // `_processBinaryUpload`, so blowing away these temp scratch dirs is
    // safe regardless of whether the loop above succeeded or failed.
    for (const tmp of cleanupTempDirs) {
      fs.remove(tmp).catch((cleanupErr) => {
        logger.warn(`Failed to clean zip temp dir ${tmp}: ${cleanupErr.message}`);
      });
    }

    const duration = Date.now() - startTime;
    const totalProcessed = expandedFiles.length;

    logger.info(`Bulk session upload complete for user ${userId}`, {
      uploadedItems: files.length,
      processedItems: totalProcessed,
      successful: successfulCount,
      failed: failedCount,
      durationMs: duration,
    });

    return {
      total: totalProcessed,
      successful: successfulCount,
      failed: failedCount,
      results,
      duration,
    };
  }

  /**
   * Expand any `.zip` files in the uploaded set into virtual per-entry
   * file objects.
   *
   * Each zip is extracted to a fresh temp directory under the OS tmpdir,
   * then each session-eligible entry is wrapped in a multer-shaped
   * `{ originalname, path, size, mimetype }` object and added to the
   * returned `files` array. Non-zip uploads pass through unchanged.
   *
   * Side effects:
   *   - Pushes one summary row per zip into `results` so the caller's
   *     batch report shows whether the archive was readable and how many
   *     entries it produced.
   *   - Returns a `tempDirs` array — the caller is responsible for
   *     removing them after the per-file processing loop finishes.
   *
   * Safety:
   *   - Per-entry decompressed size capped at ZIP_ENTRY_MAX_BYTES.
   *   - Total decompressed size across all zips capped at
   *     ZIP_TOTAL_MAX_BYTES (zip-bomb mitigation).
   *   - Path traversal protected: any entry whose normalized path
   *     escapes the temp dir is skipped with a warning.
   *
   * @param {object[]} files
   * @param {object[]} results - mutated; one summary row pushed per zip
   * @returns {Promise<{ files: object[], tempDirs: string[] }>}
   * @private
   */
  async _expandZipUploads(files, results) {
    const out = [];
    const tempDirs = [];
    let cumulative = 0;

    for (const file of files) {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const looksLikeZip =
        ext === '.zip' ||
        (file.mimetype &&
          (file.mimetype === 'application/zip' ||
            file.mimetype === 'application/x-zip' ||
            file.mimetype === 'application/x-zip-compressed'));

      if (!looksLikeZip) {
        out.push(file);
        continue;
      }

      const summary = {
        filename: file.originalname,
        status: 'error',
        kind: 'zip',
        entries: 0,
      };

      let zip;
      try {
        zip = new AdmZip(file.path);
      } catch (err) {
        summary.error = `Invalid zip archive: ${err.message}`;
        results.push(summary);
        // Best-effort delete of the corrupt upload.
        fs.unlink(file.path).catch(() => {});
        continue;
      }

      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), `web-pannel-zip-${uuidv4()}-`)
      );
      tempDirs.push(tempDir);

      const entries = zip.getEntries();
      let extractedCount = 0;
      let skippedCount = 0;

      for (const entry of entries) {
        if (entry.isDirectory) continue;

        const entryName = entry.entryName.replace(/\\/g, '/');
        const baseName = path.basename(entryName);
        // Skip dotfiles and OS metadata (__MACOSX, .DS_Store, Thumbs.db).
        if (
          !baseName ||
          baseName.startsWith('.') ||
          entryName.startsWith('__MACOSX/') ||
          /Thumbs\.db$/i.test(baseName)
        ) {
          skippedCount++;
          continue;
        }

        const entryExt = path.extname(baseName).toLowerCase();
        if (!ZIP_ENTRY_EXTENSIONS.includes(entryExt)) {
          skippedCount++;
          continue;
        }

        // Path-traversal guard: resolve where the entry would land and
        // make sure it stays inside `tempDir`.
        const safeName = `${uuidv4()}${entryExt}`;
        const targetPath = path.join(tempDir, safeName);
        const resolved = path.resolve(targetPath);
        if (!resolved.startsWith(path.resolve(tempDir) + path.sep)) {
          logger.warn(`Skipping zip entry with unsafe path: ${entryName}`);
          skippedCount++;
          continue;
        }

        let buf;
        try {
          buf = entry.getData();
        } catch (err) {
          logger.warn(`Failed to read zip entry ${entryName}: ${err.message}`);
          skippedCount++;
          continue;
        }

        if (buf.length > ZIP_ENTRY_MAX_BYTES) {
          logger.warn(
            `Zip entry ${entryName} exceeds per-entry cap (${buf.length} bytes); skipping`
          );
          skippedCount++;
          continue;
        }

        cumulative += buf.length;
        if (cumulative > ZIP_TOTAL_MAX_BYTES) {
          summary.error =
            `Aggregate decompressed size exceeded ${ZIP_TOTAL_MAX_BYTES} bytes — ` +
            'aborting zip extraction (possible zip bomb).';
          results.push(summary);
          throw new AppError(summary.error, 400, 'ZIP_TOO_LARGE');
        }

        await fs.writeFile(targetPath, buf);
        out.push({
          originalname: baseName,
          path: targetPath,
          size: buf.length,
          mimetype:
            entryExt === '.json'
              ? 'application/json'
              : 'application/octet-stream',
          // Trace back to the parent zip in case downstream callers want
          // to log it; the existing pipeline ignores extra fields.
          _zipSource: file.originalname,
        });
        extractedCount++;
      }

      summary.entries = extractedCount;
      if (extractedCount > 0) {
        summary.status = 'success';
      } else {
        summary.error =
          skippedCount > 0
            ? `Zip contained ${skippedCount} non-session file(s) and no eligible session entries`
            : 'Zip is empty';
      }
      results.push(summary);

      // Delete the original uploaded zip from the user's upload dir; we
      // don't need it anymore and keeping it would clutter the per-user
      // upload area with binary blobs that the rest of the app has no
      // reason to look at.
      fs.unlink(file.path).catch(() => {});
    }

    return { files: out, tempDirs };
  }

  /**
   * Process a JSON upload file. JSON files may contain:
   *   - A single session string
   *   - An array of session strings
   *   - An object with a "sessions" array
   *   - An object with a "session" string
   *
   * Each session string found becomes a separate database record.
   *
   * @param {object} client - Database client with active transaction
   * @param {object} file - Multer file object
   * @param {number|string} userId - Owner user ID
   * @param {number} apiId - Telegram API ID
   * @param {string} apiHash - Telegram API Hash
   * @param {boolean} autoLogin - Whether to auto-login
   * @returns {Promise<number[]>} Array of inserted session IDs
   * @private
   */
  async _processJsonUpload(client, file, userId, apiId, apiHash, autoLogin, userApiCredentialId = null) {
    const content = await fs.readFile(file.path, 'utf8');

    // Per-item session records. Each entry carries the session string
    // and any per-item credential overrides we extracted from the JSON.
    // Falling back to the batch-level apiId/apiHash only when the
    // per-item object doesn't supply its own (root cause for
    // AUTH_KEY_UNREGISTERED on uploaded sessions: when a session was
    // generated against api_id A but is then logged in with api_id B
    // Telegram revokes the auth key on first contact).
    /** @type {{session:string, apiId:?number, apiHash:?string, phone:?string}[]} */
    let sessionRecords = [];

    const pickSession = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      const raw =
        obj.session_string ||
        obj.sessionString ||
        obj.string_session ||
        obj.stringSession ||
        obj.session ||
        obj.data ||
        null;
      return raw && typeof raw === 'string' ? raw.trim() : null;
    };
    const pickApiId = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      const v = obj.api_id ?? obj.apiId ?? obj.app_id ?? obj.appId ?? obj.API_ID;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const pickApiHash = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      const v = obj.api_hash || obj.apiHash || obj.app_hash || obj.appHash || obj.API_HASH;
      return v && typeof v === 'string' ? v.trim() : null;
    };
    const pickPhone = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      const v = obj.phone || obj.phone_number || obj.phoneNumber || obj.number;
      return v && typeof v === 'string' ? v.trim() : null;
    };
    const recordFromObject = (obj) => {
      const session = pickSession(obj);
      if (!session) return null;
      return {
        session,
        apiId: pickApiId(obj),
        apiHash: pickApiHash(obj),
        phone: pickPhone(obj),
      };
    };

    try {
      const parsed = JSON.parse(content);

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string') {
            sessionRecords.push({ session: item.trim(), apiId: null, apiHash: null, phone: null });
          } else {
            const rec = recordFromObject(item);
            if (rec) sessionRecords.push(rec);
          }
        }
      } else if (typeof parsed === 'string') {
        sessionRecords.push({ session: parsed.trim(), apiId: null, apiHash: null, phone: null });
      } else if (parsed && typeof parsed === 'object') {
        if (parsed.sessions && Array.isArray(parsed.sessions)) {
          // Wrapper object — top-level may carry default api_id/api_hash
          // that applies to every nested session unless overridden.
          const defaultApiId = pickApiId(parsed);
          const defaultApiHash = pickApiHash(parsed);
          for (const s of parsed.sessions) {
            if (typeof s === 'string') {
              sessionRecords.push({
                session: s.trim(),
                apiId: defaultApiId,
                apiHash: defaultApiHash,
                phone: null,
              });
            } else {
              const rec = recordFromObject(s);
              if (rec) {
                sessionRecords.push({
                  ...rec,
                  apiId: rec.apiId ?? defaultApiId,
                  apiHash: rec.apiHash ?? defaultApiHash,
                });
              }
            }
          }
        } else {
          const rec = recordFromObject(parsed);
          if (rec) sessionRecords.push(rec);
        }
      }
    } catch (parseError) {
      // If JSON parsing fails, treat the entire content as a raw session string
      const trimmed = content.trim();
      if (trimmed.length > 10) {
        sessionRecords.push({ session: trimmed, apiId: null, apiHash: null, phone: null });
      } else {
        throw new AppError(
          `Invalid JSON file: ${file.originalname}. Could not extract session strings.`,
          400,
          'INVALID_JSON_SESSION'
        );
      }
    }

    // Drop empties and de-duplicate by session string while keeping the
    // first occurrence's per-item credentials.
    const seen = new Set();
    sessionRecords = sessionRecords.filter((r) => {
      if (!r || !r.session || r.session.length <= 10) return false;
      if (seen.has(r.session)) return false;
      seen.add(r.session);
      return true;
    });

    if (sessionRecords.length === 0) {
      throw new AppError(
        `No valid session strings found in JSON file: ${file.originalname}`,
        400,
        'NO_SESSION_STRINGS'
      );
    }

    const insertedIds = [];
    const sessionDir = this._getUserSessionDir(userId);
    await fs.ensureDir(sessionDir);

    for (const rec of sessionRecords) {
      const sessionStr = rec.session;
      // Validate session string format (GramJS strings start with "1" or "2" and are base64-encoded)
      if (!this._isValidSessionString(sessionStr)) {
        logger.warn(`Skipping invalid session string in ${file.originalname}`, {
          userId,
          prefix: sessionStr.substring(0, 10),
        });
        continue;
      }

      const sessionId = uuidv4();
      const fileName = `${sessionId}.json`;
      const filePath = path.join(sessionDir, fileName);
      const relativePath = path.relative(uploadDir, filePath);

      // Encrypt the session string for database storage
      const encryptedSession = encrypt(sessionStr);

      // Also write the encrypted session to disk for backup
      await fs.writeFile(filePath, JSON.stringify({
        session: encryptedSession,
        uploadedAt: new Date().toISOString(),
        originalName: file.originalname,
      }), 'utf8');

      const status = autoLogin ? 'active' : 'uploaded';

      // Per-item credentials win over the batch defaults so each session
      // is logged in with the api_id/api_hash it was originally created
      // with. Mismatched credentials make Telegram return
      // AUTH_KEY_UNREGISTERED on the very first call.
      const effectiveApiId = rec.apiId ?? (apiId || null);
      const effectiveApiHash = rec.apiHash ?? (apiHash || null);
      // If the JSON brought its own credentials, the row's
      // user_api_credential_id no longer represents the truth — null it
      // out so heartbeat/login code treats `sessions.api_id/api_hash`
      // as authoritative.
      const effectiveCredentialId =
        rec.apiId || rec.apiHash ? null : userApiCredentialId || null;

      const result = await client.query(
        `INSERT INTO sessions (
          user_id, phone, session_file_path, api_id, api_hash,
          user_api_credential_id,
          status, is_2fa_enabled, is_logged_in, account_info, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        RETURNING id`,
        [
          userId,
          rec.phone || null, // phone may be supplied per-item; otherwise unknown until login
          relativePath,
          effectiveApiId,
          effectiveApiHash,
          effectiveCredentialId,
          status,
          false,
          autoLogin,
          JSON.stringify({
            uploadedFrom: file.originalname,
            sessionType: 'string',
            uploadedAt: new Date().toISOString(),
            credentialsFromJson: !!(rec.apiId || rec.apiHash),
          }),
        ]
      );

      const dbId = result.rows[0].id;
      insertedIds.push(dbId);

      logger.info(`Session string stored for user ${userId}`, {
        sessionId: dbId,
        file: file.originalname,
        status,
        credentialsFromJson: !!(rec.apiId || rec.apiHash),
      });
    }

    // Clean up the temporary upload file
    await fs.unlink(file.path).catch(() => {});

    return insertedIds;
  }

  /**
   * Process a binary session file (.session or .bin).
   * These are Telethon-style SQLite session files.
   *
   * @param {object} client - Database client with active transaction
   * @param {object} file - Multer file object
   * @param {number|string} userId - Owner user ID
   * @param {string} ext - File extension (.session or .bin)
   * @param {number} apiId - Telegram API ID
   * @param {string} apiHash - Telegram API Hash
   * @returns {Promise<number>} Inserted session database ID
   * @private
   */
  async _processBinaryUpload(client, file, userId, ext, apiId, apiHash, userApiCredentialId = null) {
    const sessionDir = this._getUserSessionDir(userId);
    await fs.ensureDir(sessionDir);

    // Copy the file from the temporary upload location to the session directory
    const sessionId = uuidv4();
    const fileName = `${sessionId}${ext}`;
    const destPath = path.join(sessionDir, fileName);
    const relativePath = path.relative(uploadDir, destPath);

    await fs.copyFile(file.path, destPath);

    // Clean up the temporary upload file
    await fs.unlink(file.path).catch(() => {});

    // Determine if this is a valid SQLite-based Telethon session
    const isTelethon = await this._isTelethonSession(destPath);

    // If it's a Telethon session, auto-convert to GramJS string format
    let sessionType = 'binary';
    let storagePath = relativePath;
    let accountInfo = {
      uploadedFrom: file.originalname,
      sessionType: 'binary',
      fileSize: file.size,
      uploadedAt: new Date().toISOString(),
    };

    if (isTelethon) {
      sessionType = 'telethon_binary';
      
      try {
        // Convert Telethon binary session to GramJS string session
        logger.info(`Auto-converting Telethon binary session to GramJS format`, {
          sessionId,
          file: file.originalname,
        });

        const gramjsStringSession = convertTelethonToGramJS(destPath);
        
        // Encrypt the string session and store it as a JSON file
        const encryptedSession = encrypt(gramjsStringSession);
        const stringFileName = `${sessionId}.json`;
        const stringFilePath = path.join(sessionDir, stringFileName);
        const stringRelativePath = path.relative(uploadDir, stringFilePath);

        await fs.writeFile(stringFilePath, JSON.stringify({
          session: encryptedSession,
          uploadedAt: new Date().toISOString(),
          originalName: file.originalname,
          convertedFrom: 'telethon_binary',
        }), 'utf8');

        // Delete the original binary file (we now have the string version)
        await fs.unlink(destPath).catch(() => {});

        storagePath = stringRelativePath;
        accountInfo = {
          uploadedFrom: file.originalname,
          sessionType: 'gramjs_string',
          originalType: 'telethon_binary',
          convertedAt: new Date().toISOString(),
          fileSize: file.size,
        };

        logger.info(`Telethon session auto-converted successfully`, {
          sessionId,
          file: file.originalname,
        });
      } catch (convertError) {
        logger.warn(`Failed to auto-convert Telethon session, keeping binary file`, {
          sessionId,
          file: file.originalname,
          error: convertError.message,
        });
        // Keep the binary file but mark it as telethon_binary
        accountInfo.sessionType = 'telethon_binary';
        accountInfo.conversionError = convertError.message;
      }
    } else {
      // Non-Telethon binary file - store as-is
      const fileBuffer = await fs.readFile(destPath);
      const fileBase64 = fileBuffer.toString('base64');
      const encryptedData = encrypt(fileBase64);
    }

    const result = await client.query(
      `INSERT INTO sessions (
        user_id, phone, session_file_path, api_id, api_hash,
        user_api_credential_id,
        status, is_2fa_enabled, is_logged_in, account_info, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING id`,
      [
        userId,
        null,
        storagePath,
        apiId || null,
        apiHash || null,
        userApiCredentialId || null,
        'uploaded',
        false,
        false,
        JSON.stringify(accountInfo),
      ]
    );

    const dbId = result.rows[0].id;

    logger.info(`Binary session file processed for user ${userId}`, {
      sessionId: dbId,
      file: file.originalname,
      ext,
      sessionType,
      size: file.size,
    });

    return dbId;
  }

  // =========================================================================
  // Session Validation
  // =========================================================================

  /**
   * Validate a session file or session string.
   *
   * Checks file format, verifies session integrity, and tests login status
   * by attempting to connect to Telegram.
   *
   * @param {object} file - Multer file object or file path string
   * @returns {Promise<{
   *   valid: boolean,
   *   type: 'string' | 'telethon_binary' | 'binary' | 'unknown',
   *   loginStatus: 'valid' | 'expired' | 'revoked' | 'unknown',
   *   details: object,
   *   errors: string[]
   * }>}
   */
  async validateSession(file) {
    const result = {
      valid: false,
      type: 'unknown',
      loginStatus: 'unknown',
      details: {},
      errors: [],
    };

    try {
      let filePath;
      let fileName;

      if (typeof file === 'string') {
        filePath = file;
        fileName = path.basename(file);
      } else if (file && file.path) {
        filePath = file.path;
        fileName = file.originalname || path.basename(file.path);
      } else {
        throw new AppError('Invalid file parameter', 400, 'INVALID_FILE_PARAM');
      }

      if (!await fs.pathExists(filePath)) {
        throw new AppError(`File not found: ${filePath}`, 404, 'FILE_NOT_FOUND');
      }

      const fileStat = await fs.stat(filePath);
      result.details.fileSize = fileStat.size;
      result.details.fileName = fileName;

      const ext = path.extname(fileName).toLowerCase();

      if (ext === '.json') {
        await this._validateJsonSession(filePath, result);
      } else if (ext === '.session' || ext === '.bin') {
        await this._validateBinarySession(filePath, result);
      } else {
        result.errors.push(`Unsupported file extension: ${ext}`);
      }

      if (result.errors.length === 0) {
        result.valid = true;
      }
    } catch (error) {
      result.errors.push(error.message || 'Validation failed');
      logger.error('Session validation failed', { error: error.message });
    }

    return result;
  }

  /**
   * Validate a JSON session file containing session strings.
   * @param {string} filePath - Path to the JSON file
   * @param {object} result - Validation result object to populate
   * @private
   */
  async _validateJsonSession(filePath, result) {
    try {
      const content = await fs.readFile(filePath, 'utf8');

      if (!content || content.trim().length === 0) {
        result.errors.push('File is empty');
        return;
      }

      let sessionStrings = [];

      try {
        const parsed = JSON.parse(content);

        if (Array.isArray(parsed)) {
          sessionStrings = parsed.filter((s) => typeof s === 'string' && s.length > 10);
        } else if (typeof parsed === 'string') {
          sessionStrings = [parsed];
        } else if (parsed && typeof parsed === 'object') {
          if (parsed.sessions && Array.isArray(parsed.sessions)) {
            sessionStrings = parsed.sessions.filter((s) => typeof s === 'string' && s.length > 10);
          } else if (parsed.session_string || parsed.sessionString || parsed.session || parsed.data) {
            const str = parsed.session_string || parsed.sessionString || parsed.session || parsed.data;
            if (str && str.length > 10) sessionStrings = [str];
          }
        }
      } catch {
        // Treat as raw session string
        const trimmed = content.trim();
        if (trimmed.length > 10) {
          sessionStrings = [trimmed];
        }
      }

      result.type = 'string';
      result.details.sessionCount = sessionStrings.length;

      if (sessionStrings.length === 0) {
        result.errors.push('No valid session strings found in file');
        return;
      }

      // Validate each session string format
      const validStrings = [];
      const invalidStrings = [];

      for (const s of sessionStrings) {
        if (this._isValidSessionString(s)) {
          validStrings.push(s);
        } else {
          invalidStrings.push(s.substring(0, 20) + '...');
        }
      }

      result.details.validCount = validStrings.length;
      result.details.invalidCount = invalidStrings.length;

      if (invalidStrings.length > 0) {
        result.errors.push(`${invalidStrings.length} session string(s) have invalid format`);
      }

      if (validStrings.length > 0) {
        // Test the first valid session string for login status
        try {
          const loginTest = await this._testSessionLogin(validStrings[0]);
          result.loginStatus = loginTest.status;
          result.details.testResult = loginTest.details;
        } catch (testError) {
          result.loginStatus = 'unknown';
          result.details.testError = testError.message;
        }
      }
    } catch (error) {
      result.errors.push(`Failed to read/parse JSON file: ${error.message}`);
    }
  }

  /**
   * Validate a binary Telethon session file.
   * @param {string} filePath - Path to the binary session file
   * @param {object} result - Validation result object to populate
   * @private
   */
  async _validateBinarySession(filePath, result) {
    try {
      const isTelethon = await this._isTelethonSession(filePath);
      result.type = isTelethon ? 'telethon_binary' : 'binary';
      result.details.isTelethonSession = isTelethon;

      const fileBuffer = await fs.readFile(filePath);
      result.details.fileSize = fileBuffer.length;

      // Check minimum file size (Telethon sessions are at least a few KB)
      if (fileBuffer.length < 1024) {
        result.errors.push('File too small to be a valid session file');
        return;
      }

      if (isTelethon) {
        // Telethon sessions cannot be directly tested with GramJS
        // Mark as valid format but login status unknown
        result.loginStatus = 'unknown';
        result.details.note = 'Telethon binary sessions require conversion before login testing';
      } else {
        result.loginStatus = 'unknown';
        result.details.note = 'Unknown binary format';
      }
    } catch (error) {
      result.errors.push(`Failed to validate binary session: ${error.message}`);
    }
  }

  /**
   * Test a session string by attempting to connect to Telegram.
   * @param {string} sessionString - The session string to test
   * @returns {Promise<{ status: string, details: object }>}
   * @private
   */
  async _testSessionLogin(sessionString) {
    const testSessionId = `test_${uuidv4()}`;

    try {
      const connectionPromise = tgService.createSession(
        testSessionId,
        sessionString // Note: this expects encrypted, but we pass raw for testing
      );

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection test timed out')), CONNECTION_TIMEOUT_MS);
      });

      await Promise.race([connectionPromise, timeoutPromise]);

      // If we got here, connection succeeded
      const me = await tgService.getMe(testSessionId);

      await tgService.disconnectSession(testSessionId);

      return {
        status: 'valid',
        details: {
          userId: me ? me.id : null,
          username: me ? me.username : null,
          firstName: me ? me.firstName : null,
          phone: me ? me.phone : null,
          isPremium: me ? me.isPremium : false,
        },
      };
    } catch (error) {
      // Clean up the test client if it was partially created
      try {
        await tgService.disconnectSession(testSessionId);
      } catch {
        // Ignore cleanup errors
      }

      const msg = error.message || '';

      if (msg.includes('SESSION_EXPIRED') || msg.includes('AUTH_KEY_UNREGISTERED')) {
        return { status: 'expired', details: { reason: msg } };
      }
      if (msg.includes('SESSION_REVOKED')) {
        return { status: 'revoked', details: { reason: msg } };
      }

      return { status: 'unknown', details: { error: msg } };
    }
  }

  // =========================================================================
  // Batch Processing
  // =========================================================================

  /**
   * Batch process session files in chunks to avoid memory overflow.
   *
   * This method streams through the provided file paths, processing them in
   * batches of the specified size. It never loads all files into memory at once.
   * Each file is processed individually and the result is yielded via a callback
   * or accumulated into the return value.
   *
   * @param {string[]} filePaths - Array of file paths to process
   * @param {number} batchSize - Number of files to process per chunk (default: 100)
   * @param {object} options - Processing options
   * @param {number|string} options.userId - User ID for database association
   * @param {Function} options.onProgress - Optional callback for progress updates
   * @param {number} options.apiId - Telegram API ID
   * @param {string} options.apiHash - Telegram API Hash
   * @returns {Promise<{
   *   total: number,
   *   processed: number,
   *   successful: number,
   *   failed: number,
   *   results: Array<{ filePath: string, status: string, sessionId?: number, error?: string }>,
   *   duration: number
   * }>}
   */
  async processBatch(filePaths, batchSize = DEFAULT_BATCH_CHUNK_SIZE, options = {}) {
    const { userId, onProgress, apiId, apiHash } = options;
    const startTime = Date.now();

    logger.info(`Starting batch session processing`, {
      totalFiles: filePaths.length,
      batchSize,
      userId,
    });

    if (!filePaths || filePaths.length === 0) {
      return {
        total: 0,
        processed: 0,
        successful: 0,
        failed: 0,
        results: [],
        duration: 0,
      };
    }

    const results = [];
    let processedCount = 0;
    let successfulCount = 0;
    let failedCount = 0;

    // Process in chunks
    for (let i = 0; i < filePaths.length; i += batchSize) {
      const chunk = filePaths.slice(i, i + batchSize);
      const chunkNumber = Math.floor(i / batchSize) + 1;
      const totalChunks = Math.ceil(filePaths.length / batchSize);

      logger.info(`Processing batch chunk ${chunkNumber}/${totalChunks}`, {
        chunkSize: chunk.length,
        startIndex: i,
      });

      for (const filePath of chunk) {
        const fileResult = { filePath, status: 'error' };

        try {
          if (!await fs.pathExists(filePath)) {
            throw new Error(`File not found: ${filePath}`);
          }

          const fileStat = await fs.stat(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const fileName = path.basename(filePath);

          // Create a mock multer-like file object for reuse of upload logic
          const mockFile = {
            path: filePath,
            originalname: fileName,
            size: fileStat.size,
            mimetype: ext === '.json' ? 'application/json' : 'application/octet-stream',
          };

          // Use a database transaction for each file
          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            if (ext === '.json') {
              const inserted = await this._processJsonUpload(
                client, mockFile, userId || 0, apiId, apiHash, false
              );
              fileResult.status = 'success';
              fileResult.sessionId = inserted.length > 0 ? inserted[0] : null;
              fileResult.sessionsCreated = inserted.length;
              successfulCount += inserted.length;
            } else {
              const sessionId = await this._processBinaryUpload(
                client, mockFile, userId || 0, ext, apiId, apiHash
              );
              fileResult.status = 'success';
              fileResult.sessionId = sessionId;
              successfulCount++;
            }

            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }

          processedCount++;
          fileResult.status = fileResult.status || 'success';
        } catch (error) {
          logger.error(`Batch processing failed for file: ${filePath}`, {
            error: error.message,
          });
          fileResult.error = error.message || 'Processing failed';
          failedCount++;
          processedCount++;
        }

        results.push(fileResult);

        // Report progress if callback provided
        if (typeof onProgress === 'function') {
          onProgress({
            processed: processedCount,
            total: filePaths.length,
            successful: successfulCount,
            failed: failedCount,
            currentFile: filePath,
            percentage: Math.round((processedCount / filePaths.length) * 100),
          });
        }
      }

      // Small delay between chunks to allow GC and prevent memory pressure
      if (i + batchSize < filePaths.length) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const duration = Date.now() - startTime;

    logger.info(`Batch processing complete`, {
      total: filePaths.length,
      processed: processedCount,
      successful: successfulCount,
      failed: failedCount,
      durationMs: duration,
    });

    return {
      total: filePaths.length,
      processed: processedCount,
      successful: successfulCount,
      failed: failedCount,
      results,
      duration,
    };
  }

  // =========================================================================
  // Session Status and Retrieval
  // =========================================================================

  /**
   * Get the status of a specific session.
   *
   * Checks the database record and, if the session is a string session,
   * attempts to test the Telegram connection to determine live status.
   *
   * @param {number|string} sessionId - Session database ID
   * @returns {Promise<{
   *   id: number,
   *   status: string,
   *   isLoggedIn: boolean,
   *   is2faEnabled: boolean,
   *   accountInfo: object|null,
   *   liveStatus: 'connected' | 'disconnected' | 'error' | 'unknown',
   *   lastActive: string|null,
   *   createdAt: string
   * }>}
   */
  async getSessionStatus(sessionId) {
    logger.info(`Checking session status`, { sessionId });

    const session = await this._getRawSessionById(sessionId);

    if (!session) {
      throw new AppError(`Session not found: ${sessionId}`, 404, 'SESSION_NOT_FOUND');
    }

    const result = {
      id: session.id,
      status: session.status,
      isLoggedIn: session.is_logged_in,
      is2faEnabled: session.is_2fa_enabled,
      accountInfo: session.account_info,
      liveStatus: 'unknown',
      lastActive: session.last_active,
      createdAt: session.created_at,
      filePath: session.session_file_path,
    };

    // If the session is logged in and has a string session, test the connection
    if (session.is_logged_in && session.account_info) {
      try {
        const accountInfo = typeof session.account_info === 'string'
          ? JSON.parse(session.account_info)
          : session.account_info;

        if (accountInfo.sessionType === 'string') {
          // Try to get the session data and test
          const fullPath = path.join(uploadDir, session.session_file_path);
          if (await fs.pathExists(fullPath)) {
            const fileContent = await fs.readFile(fullPath, 'utf8');
            const fileData = JSON.parse(fileContent);

            if (fileData.session) {
              try {
                const decrypted = decrypt(fileData.session);
                const testResult = await this._testSessionLogin(decrypted);
                result.liveStatus = testResult.status === 'valid' ? 'connected' : 'disconnected';
              } catch {
                result.liveStatus = 'error';
              }
            }
          }
        } else {
          result.liveStatus = 'unknown';
          result.note = 'Binary sessions require manual status check';
        }
      } catch (error) {
        result.liveStatus = 'error';
        logger.warn(`Could not determine live status for session ${sessionId}`, {
          error: error.message,
        });
      }
    } else if (session.status === 'active') {
      result.liveStatus = 'disconnected';
    }

    return result;
  }

  /**
   * Get a session by its database ID.
   *
   * Verifies that the session belongs to the specified user.
   *
   * @param {number|string} sessionId - Session database ID
   * @param {number|string} userId - Owner user ID for authorization check
   * @returns {Promise<{
   *   id: number,
   *   userId: number,
   *   phone: string|null,
   *   sessionFilePath: string,
   *   apiId: number|null,
   *   apiHash: string|null,
   *   status: string,
   *   is2faEnabled: boolean,
   *   isLoggedIn: boolean,
   *   accountInfo: object,
   *   createdAt: string,
   *   lastActive: string|null
   * }>}
   */
  async getSessionById(sessionId, userId) {
    logger.info(`Fetching session by ID`, { sessionId, userId });

    // Scoped to platform = 'telegram' so /api/sessions/:id (legacy) and
    // /api/telegram/sessions/:id never accidentally return an IG row.
    const result = await pool.query(
      `SELECT id, user_id, phone, session_file_path, api_id, api_hash,
              status, is_2fa_enabled, is_logged_in, account_info,
              created_at, last_active
       FROM sessions
       WHERE id = $1 AND user_id = $2 AND platform = 'telegram'`,
      [sessionId, userId]
    );

    if (result.rows.length === 0) {
      throw new AppError(`Session not found or access denied: ${sessionId}`, 404, 'SESSION_NOT_FOUND');
    }

    const row = result.rows[0];

    return {
      id: row.id,
      userId: row.user_id,
      phone: row.phone,
      sessionFilePath: row.session_file_path,
      apiId: row.api_id,
      apiHash: row.api_hash,
      status: row.status,
      is2faEnabled: row.is_2fa_enabled,
      isLoggedIn: row.is_logged_in,
      accountInfo: this._parseJsonField(row.account_info),
      createdAt: row.created_at,
      lastActive: row.last_active,
    };
  }

  /**
   * List sessions for a user with pagination, sorting, and filtering.
   *
   * @param {number|string} userId - Owner user ID
   * @param {object} params - Query parameters
   * @param {number} params.page - Page number (1-based, default: 1)
   * @param {number} params.limit - Items per page (default: 20, max: 100)
   * @param {string} params.sort - Sort field (default: 'created_at')
   * @param {string} params.order - Sort order: ASC or DESC (default: 'DESC')
   * @param {string} params.filter - Status filter: active, inactive, uploaded, error, all
   * @returns {Promise<{
   *   sessions: Array<object>,
   *   pagination: { currentPage, pageSize, totalPages, total, hasNext, hasPrev }
   * }>}
   */
  async listSessions(userId, { page = 1, limit = 20, sort = 'created_at', order = 'DESC', filter, platform } = {}) {
    logger.info(`Listing sessions for user ${userId}`, { page, limit, sort, order, filter, platform });

    const { applyPagination, applySorting } = require('../utils/pagination');

    const validSortFields = ['created_at', 'last_active', 'status', 'phone', 'id'];
    const { field: sortField, order: sortOrder } = applySorting(sort, order, validSortFields);
    // Sessions tab is the only list in the panel that's allowed to render
    // every row at once (operators routinely upload 100s–1000s of session
    // files in one go and want them all visible). Pass allowUnbounded so
    // limit=0 / limit='all' bypass the default 100-row cap and fall back
    // only to the MAX_UNBOUNDED_LIST safety belt.
    const { offset, limit: pageSize, unbounded } =
      applyPagination(null, page, limit, { allowUnbounded: true });

    // Hard-scope to a single platform when requested. Legacy callers
    // (no platform argument) keep their previous Telegram-only behaviour
    // because every TG row has platform='telegram' by default.
    // NOTE: column refs are written with the `s.` alias because the
    // paginated SELECT joins tg_session_health (`tsh`).
    const queryConditions = ['s.user_id = $1'];
    const queryParams = [userId];
    let paramIndex = 2;
    if (platform === 'telegram' || platform === 'instagram') {
      queryConditions.push(`s.platform = $${paramIndex}`);
      queryParams.push(platform);
      paramIndex++;
    } else {
      queryConditions.push("s.platform = 'telegram'");
    }

    if (filter && filter !== 'all') {
      if (VALID_STATUSES.includes(filter)) {
        queryConditions.push(`s.status = $${paramIndex}`);
        queryParams.push(filter);
        paramIndex++;
      } else if (filter === 'active') {
        queryConditions.push("s.status IN ('active', 'uploaded') AND s.is_logged_in = true");
      } else if (filter === 'inactive') {
        queryConditions.push("s.status IN ('inactive', 'error', 'revoked', 'expired') OR s.is_logged_in = false");
      }
    }

    const whereClause = queryConditions.join(' AND ');

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM sessions s WHERE ${whereClause}`,
      queryParams
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated results — joined with tg_session_health (Phase 2)
    // for the per-row anti-revoke posture (risk score, ping age, etc.)
    // so the Sessions UI can render device + DC + risk without an
    // extra round-trip per session.
    const sessionsResult = await pool.query(
      `SELECT s.id, s.user_id, s.phone, s.session_file_path, s.api_id, s.api_hash,
              s.status, s.is_2fa_enabled, s.is_logged_in, s.account_info,
              s.created_at, s.last_active,
              s.device_identity, s.dc_id, s.dc_ip, s.dc_port,
              s.last_online_status_at, s.last_ping_at, s.auth_key_first_seen_at,
              s.bound_proxy_id,
              tsh.risk_score, tsh.consecutive_failed_pings,
              tsh.consecutive_flood_waits, tsh.last_flood_at,
              tsh.last_authorizations_check_at, tsh.last_reauth_required_at,
              tsh.dc_migrate_count_24h, tsh.ip_country_jumps_24h,
              tsh.bootstrapped_at, tsh.active_authorizations,
              tsh.risk_score_updated_at,
              -- BYO Proxy (Phase 3 §5.4): mirror the bound proxy's
              -- per-session metadata so the table can render the
              -- country-flag + label + egress + health-dot column
              -- without an N+1 lookup.
              p.host           AS proxy_host,
              p.port           AS proxy_port,
              p.protocol       AS proxy_protocol,
              p.country_code   AS proxy_country_code,
              p.label          AS proxy_label,
              p.is_working     AS proxy_is_working,
              p.last_health_check AS proxy_last_health_check,
              p.last_health_ok    AS proxy_last_health_ok,
              p.metadata          AS proxy_metadata
       FROM sessions s
       LEFT JOIN tg_session_health tsh ON tsh.session_id = s.id
       LEFT JOIN proxies p              ON p.id          = s.bound_proxy_id
       WHERE ${whereClause}
       ORDER BY s.${sortField} ${sortOrder}
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...queryParams, pageSize, offset]
    );

    const sessions = sessionsResult.rows.map((row) => {
      const accountInfo = this._parseJsonField(row.account_info);
      return {
        id: row.id,
        userId: row.user_id,
        phone: row.phone,
        username: accountInfo?.username || null, // Extract username to top level
        sessionFilePath: row.session_file_path,
        apiId: row.api_id,
        apiHash: row.api_hash,
        status: row.status,
        is2faEnabled: row.is_2fa_enabled,
        isLoggedIn: row.is_logged_in,
        accountInfo,
        createdAt: row.created_at,
        lastActive: row.last_active,
        // Anti-revoke fields (Phase 1 + 3) — read by the frontend
        // SessionAntiRevokeBlock to render device + DC + risk.
        device_identity: row.device_identity,
        dc_id: row.dc_id,
        dc_ip: row.dc_ip,
        dc_port: row.dc_port,
        last_online_status_at: row.last_online_status_at,
        last_ping_at: row.last_ping_at,
        auth_key_first_seen_at: row.auth_key_first_seen_at,
        risk_score: row.risk_score != null ? Number(row.risk_score) : null,
        risk_score_updated_at: row.risk_score_updated_at || null,
        tg_health: row.risk_score == null ? null : {
          risk_score: Number(row.risk_score),
          consecutive_failed_pings: row.consecutive_failed_pings,
          consecutive_flood_waits: row.consecutive_flood_waits,
          last_flood_at: row.last_flood_at,
          last_authorizations_check_at: row.last_authorizations_check_at,
          last_reauth_required_at: row.last_reauth_required_at,
          dc_migrate_count_24h: row.dc_migrate_count_24h,
          ip_country_jumps_24h: row.ip_country_jumps_24h,
          bootstrapped_at: row.bootstrapped_at,
          active_authorizations: row.active_authorizations,
        },
        // BYO Proxy (Phase 3 §5.4): per-session pinned proxy summary.
        bound_proxy_id: row.bound_proxy_id || null,
        proxy: row.bound_proxy_id ? {
          id: row.bound_proxy_id,
          host: row.proxy_host,
          port: row.proxy_port,
          protocol: row.proxy_protocol,
          country_code: row.proxy_country_code,
          label: row.proxy_label,
          is_working: row.proxy_is_working,
          last_health_check: row.proxy_last_health_check,
          last_health_ok: row.proxy_last_health_ok,
          egress_ip: row.proxy_metadata?.egress_ip || null,
        } : null,
      };
    });

    const { buildPagination } = require('../utils/pagination');
    const pagination = buildPagination(page, limit, total, { allowUnbounded: true });
    if (unbounded) {
      pagination.pageSize = sessions.length;
    }

    return {
      sessions,
      pagination,
    };
  }

  // =========================================================================
  // Session Deletion
  // =========================================================================

  /**
   * Delete a single session.
   *
   * Performs the following in a transaction:
   *   1. Fetches the session record
   *   2. If the session has an active telegram client, disconnects it
   *   3. Deletes the database record
   *   4. Deletes the associated session file from disk
   *
   * @param {number|string} sessionId - Session database ID
   * @param {number|string} userId - Owner user ID for authorization
   * @returns {Promise<{ success: boolean, sessionId: number, fileDeleted: boolean }>}
   */
  async deleteSession(sessionId, userId) {
    logger.info(`Deleting session`, { sessionId, userId });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Fetch the session — scoped to platform='telegram' so this
      // service can never accidentally delete an Instagram row.
      const sessionResult = await client.query(
        `SELECT id, user_id, session_file_path, status, is_logged_in
         FROM sessions WHERE id = $1 AND user_id = $2 AND platform = 'telegram' FOR UPDATE`,
        [sessionId, userId]
      );

      if (sessionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new AppError(`Session not found or access denied: ${sessionId}`, 404, 'SESSION_NOT_FOUND');
      }

      const session = sessionResult.rows[0];

      // OTP Relay: tear down any listeners that referenced this
      // session as either watch source or relay destination before
      // we kill the client.
      try {
        const otpRelayService = require('./otpRelayService');
        await otpRelayService.onSessionDisconnected(String(sessionId)).catch(() => {});
      } catch { /* best-effort */ }

      // Disconnect telegram client if active
      if (session.is_logged_in) {
        try {
          await this._disconnectSessionClient(String(sessionId));
          logger.info(`Disconnected telegram client for session ${sessionId}`);
        } catch (disconnectError) {
          logger.warn(`Failed to disconnect client for session ${sessionId}`, {
            error: disconnectError.message,
          });
          // Continue with deletion even if disconnect fails
        }
      }

      // Delete from database. Cascades to tg_otp_relays via the
      // ON DELETE CASCADE FK on watch_session_id / relay_session_id,
      // so attachments referencing this session are automatically
      // cleaned up.
      await client.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

      await client.query('COMMIT');

      // Delete file from disk (outside transaction since file ops can't be rolled back)
      let fileDeleted = false;
      if (session.session_file_path) {
        const fullPath = path.join(uploadDir, session.session_file_path);
        try {
          if (await fs.pathExists(fullPath)) {
            await fs.unlink(fullPath);
            fileDeleted = true;
            logger.info(`Deleted session file: ${fullPath}`);
          }
        } catch (fileError) {
          logger.warn(`Failed to delete session file: ${fullPath}`, {
            error: fileError.message,
          });
        }
      }

      logger.info(`Session deleted successfully`, {
        sessionId,
        fileDeleted,
      });

      return {
        success: true,
        sessionId: session.id,
        fileDeleted,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Bulk delete multiple sessions.
   *
   * Each session is deleted individually with its own transaction to ensure
   * that a failure on one session does not affect others. Returns a summary
   * of successful and failed deletions.
   *
   * @param {number[]} sessionIds - Array of session database IDs
   * @param {number|string} userId - Owner user ID for authorization
   * @returns {Promise<{
   *   total: number,
   *   successful: number,
   *   failed: number,
   *   results: Array<{ sessionId: number, success: boolean, error?: string }>
   * }>}
   */
  async bulkDeleteSessions(sessionIds, userId) {
    logger.info(`Bulk deleting sessions for user ${userId}`, {
      count: sessionIds.length,
    });

    if (!sessionIds || sessionIds.length === 0) {
      throw new AppError('No session IDs provided for deletion', 400, 'NO_SESSION_IDS');
    }

    const results = [];
    let successfulCount = 0;
    let failedCount = 0;

    for (const sessionId of sessionIds) {
      try {
        await this.deleteSession(sessionId, userId);
        results.push({ sessionId: Number(sessionId), success: true });
        successfulCount++;
      } catch (error) {
        logger.error(`Failed to delete session ${sessionId}`, {
          error: error.message,
        });
        results.push({
          sessionId: Number(sessionId),
          success: false,
          error: error.message || 'Deletion failed',
        });
        failedCount++;
      }
    }

    logger.info(`Bulk deletion complete for user ${userId}`, {
      total: sessionIds.length,
      successful: successfulCount,
      failed: failedCount,
    });

    return {
      total: sessionIds.length,
      successful: successfulCount,
      failed: failedCount,
      results,
    };
  }

  // =========================================================================
  // Session Login/Logout
  // =========================================================================

  /**
   * Login a session by loading it into a telegram client and connecting.
   *
   * Only works for string sessions (.json). Binary Telethon sessions
   * cannot be directly loaded into GramJS clients.
   *
   * @param {number|string} sessionId - Session database ID
   * @param {number|string} userId - Owner user ID for authorization
   * @returns {Promise<{
   *   success: boolean,
   *   sessionId: number,
   *   accountInfo: object,
   *   status: string
   * }>}
   */
  async loginSession(sessionId, userId) {
    logger.info(`Logging in session`, { sessionId, userId });

    const client = await pool.connect();
    // Hoisted so the outer catch can preserve any pre-existing fields
    // (telegramId, firstName, etc.) while writing the failure metadata.
    let accountInfo = {};
    try {
      await client.query('BEGIN');

      const sessionResult = await client.query(
        `SELECT id, user_id, session_file_path, api_id, api_hash, status,
                is_logged_in, account_info
         FROM sessions WHERE id = $1 AND user_id = $2 AND platform = 'telegram' FOR UPDATE`,
        [sessionId, userId]
      );

      if (sessionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new AppError(`Session not found or access denied: ${sessionId}`, 404, 'SESSION_NOT_FOUND');
      }

      const session = sessionResult.rows[0];

      if (session.is_logged_in) {
        await client.query('ROLLBACK');
        throw new AppError('Session is already logged in', 409, 'SESSION_ALREADY_LOGGED_IN');
      }

      accountInfo = this._parseJsonField(session.account_info) || {};

      // Handle existing telethon_binary sessions - convert them on-the-fly
      if (accountInfo && accountInfo.sessionType === 'telethon_binary') {
        logger.info(`Converting existing Telethon binary session on-the-fly`, { sessionId });
        
        const fullPath = path.join(uploadDir, session.session_file_path);
        if (!await fs.pathExists(fullPath)) {
          await client.query('ROLLBACK');
          throw new AppError(`Session file not found: ${session.session_file_path}`, 404, 'SESSION_FILE_MISSING');
        }

        try {
          // Convert Telethon binary to GramJS string
          const gramjsStringSession = convertTelethonToGramJS(fullPath);
          
          // Encrypt and save as JSON
          const encryptedSession = encrypt(gramjsStringSession);
          const sessionDir = path.dirname(fullPath);
          const newFileName = path.basename(fullPath).replace('.session', '.json').replace('.bin', '.json');
          const newFilePath = path.join(sessionDir, newFileName);
          const newRelativePath = path.relative(uploadDir, newFilePath);

          await fs.writeFile(newFilePath, JSON.stringify({
            session: encryptedSession,
            uploadedAt: new Date().toISOString(),
            originalName: accountInfo.uploadedFrom || 'unknown',
            convertedFrom: 'telethon_binary',
          }), 'utf8');

          // Delete the old binary file
          await fs.unlink(fullPath).catch(() => {});

          // Update database to point to new file
          await client.query(
            `UPDATE sessions SET session_file_path = $1, account_info = $2 WHERE id = $3`,
            [
              newRelativePath,
              JSON.stringify({
                ...accountInfo,
                sessionType: 'gramjs_string',
                originalType: 'telethon_binary',
                convertedAt: new Date().toISOString(),
              }),
              sessionId,
            ]
          );

          // Update session object to use new path
          session.session_file_path = newRelativePath;

          logger.info(`Telethon session converted on-the-fly`, { sessionId });
        } catch (convertError) {
          await client.query('ROLLBACK');
          throw new AppError(
            `Failed to convert Telethon session: ${convertError.message}`,
            500,
            'TELETHON_CONVERSION_FAILED'
          );
        }
      }

      // Load the session file
      const fullPath = path.join(uploadDir, session.session_file_path);
      if (!await fs.pathExists(fullPath)) {
        await client.query('ROLLBACK');
        throw new AppError(`Session file not found: ${session.session_file_path}`, 404, 'SESSION_FILE_MISSING');
      }

      const fileContent = await fs.readFile(fullPath, 'utf8');
      const fileData = JSON.parse(fileContent);

      if (!fileData.session) {
        await client.query('ROLLBACK');
        throw new AppError('Session file does not contain encrypted session data', 400, 'INVALID_SESSION_FILE');
      }

      // Create and connect the telegram client with timeout
      const tgSessionId = String(sessionId);

      // Allocate a proxy for this session (Upgrade 4 — IP rotation, max 4
      // accounts per IP, VPS direct first then free / manual proxies).
      // We commit the outer transaction's row lock first because the
      // assignment itself inserts into session_proxy_assignments which has
      // an FK to sessions.id, and the FK validation would deadlock-wait on
      // our own SELECT ... FOR UPDATE.
      let assignedProxy = null;
      await client.query('COMMIT');
      try {
        const proxyService = require('./proxyService');
        const row = await proxyService.assignProxyForSession(sessionId);
        assignedProxy = proxyService.buildGramJSProxy(row);
      } catch (proxyErr) {
        logger.warn(`Proxy assignment failed for session ${sessionId}: ${proxyErr.message}`);
      }

      // Anti-Detect: load (or generate) the persisted device identity so
      // every TelegramClient for this row reports the same hardware.
      let identity = null;
      try {
        const identityService = require('./identityService');
        identity = await identityService.loadOrCreate(sessionId);
      } catch (idErr) {
        logger.warn(`Identity load failed for session ${sessionId}: ${idErr.message}`);
      }

      await client.query('BEGIN');
      // Re-acquire our row lock for the rest of the login flow.
      await client.query(
        `SELECT id FROM sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [sessionId, userId]
      );

      // Add a connect-only timeout to prevent indefinite hanging on a
      // dead proxy or unreachable Telegram DC. The error here surfaces as
      // a 504 to the UI so the operator can retry (often with a new proxy
      // assignment) instead of being told the session is bad.
      const loginPromise = tgService.createSession(
        tgSessionId,
        fileData.session,
        session.api_id || undefined,
        session.api_hash || undefined,
        { proxy: assignedProxy, identity }
      );
      let connectTimer;
      const connectTimeout = new Promise((_, reject) => {
        connectTimer = setTimeout(
          () => reject(new Error(
            `Telegram connect timed out after ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s ` +
            `(proxy=${assignedProxy ? assignedProxy.host || 'set' : 'direct'}). ` +
            `The DC route or proxy is unreachable; retry, switch proxy, or raise SESSION_LOGIN_TIMEOUT_MS.`
          )),
          LOGIN_TIMEOUT_MS
        );
      });
      try {
        await Promise.race([loginPromise, connectTimeout]);
      } finally {
        clearTimeout(connectTimer);
      }

      // Get account info - this MUST succeed for login to be valid. The
      // getMe timeout is intentionally separate from the connect timeout
      // so we can give a precise error when the handshake worked but the
      // RPC stalled (rare but happens during DC migration storms).
      let me;
      try {
        let getMeTimer;
        const getMeTimeout = new Promise((_, reject) => {
          getMeTimer = setTimeout(
            () => reject(new Error(
              `Telegram getMe() timed out after ${Math.round(GET_ME_TIMEOUT_MS / 1000)}s — connection alive but RPC stalled.`
            )),
            GET_ME_TIMEOUT_MS
          );
        });
        try {
          me = await Promise.race([
            tgService.getMe(tgSessionId),
            getMeTimeout,
          ]);
        } finally {
          clearTimeout(getMeTimer);
        }
      } catch (meError) {
        // If getMe fails, the session is NOT valid - disconnect and throw error
        await tgService.disconnectSession(tgSessionId).catch(() => {});
        // Persist the failure metadata into account_info so the UI's
        // SessionAccountStatusBlock can render an honest "Banned" /
        // "Auth revoked" / "Login error" badge instead of looking like
        // the session is healthy.
        const failedAt = new Date().toISOString();
        const errorCode =
          meError.errorMessage ||
          (typeof meError.code === 'string' ? meError.code : null) ||
          'TELEGRAM_GET_ME_FAILED';
        const failedInfo = {
          ...accountInfo,
          lastLoginAttempt: failedAt,
          loginSuccess: false,
          lastError: meError.message || String(meError),
          lastErrorCode: errorCode,
        };
        if (tgService.isPermanentAuthError(meError)) {
          // Roll the in-flight txn back, then persist the revoked status
          // in a fresh statement so the UI badge flips and the heartbeat
          // doesn't try this session again.
          await client.query('ROLLBACK').catch(() => {});
          await pool
            .query(
              `UPDATE sessions
                  SET is_logged_in = FALSE,
                      status = 'revoked',
                      account_info = $2
                WHERE id = $1`,
              [sessionId, JSON.stringify(failedInfo)]
            )
            .catch(() => {});
          // Spell out the most common operator-actionable causes for
          // each symbolic Telegram error so the panel UI shows a hint
          // the user can act on, instead of a flat "auth revoked".
          const haystack = [meError.errorMessage, meError.message, errorCode]
            .filter(Boolean)
            .join(' ')
            .toUpperCase();
          let hint;
          if (haystack.includes('AUTH_KEY_UNREGISTERED')) {
            hint =
              'Telegram returned AUTH_KEY_UNREGISTERED for this session. ' +
              'Most common causes: (1) the session was created with a different ' +
              'api_id / api_hash than the one configured here — make sure each ' +
              'uploaded session is logged in with the credentials it was generated ' +
              'against; (2) the user terminated this session from Settings → Active ' +
              'Sessions in their Telegram client; (3) the session has been idle long ' +
              'enough that Telegram pruned it. Re-create or re-upload the session.';
          } else if (haystack.includes('AUTH_KEY_DUPLICATED')) {
            hint =
              'Telegram returned AUTH_KEY_DUPLICATED — the same session string is ' +
              'being used by another connection (another panel / bot / client). ' +
              'Generate a fresh session or stop the other consumer before retrying.';
          } else if (haystack.includes('USER_DEACTIVATED')) {
            hint =
              'Telegram returned USER_DEACTIVATED — the underlying account has been ' +
              'banned or self-deleted. The session cannot be recovered.';
          } else if (haystack.includes('SESSION_REVOKED') || haystack.includes('SESSION_EXPIRED')) {
            hint =
              'Telegram returned ' + errorCode + ' — this session was explicitly ' +
              'revoked / expired. Re-create or re-upload it.';
          } else {
            hint =
              'Telegram revoked this session (auth key invalid). ' +
              'Please re-upload or re-login the session.';
          }
          throw new AppError(
            hint,
            401,
            errorCode || 'AUTH_KEY_REVOKED'
          );
        }
        // Non-permanent failures: set status='error' and record the same
        // error metadata so the UI shows "Login error" with a code the
        // operator can look up.
        await client.query('ROLLBACK').catch(() => {});
        await pool
          .query(
            `UPDATE sessions
                SET is_logged_in = FALSE,
                    status = 'error',
                    account_info = $2
              WHERE id = $1`,
            [sessionId, JSON.stringify(failedInfo)]
          )
          .catch(() => {});
        throw new AppError(
          `Failed to verify session with Telegram API: ${meError.message}`,
          500,
          'TELEGRAM_GET_ME_FAILED'
        );
      }

      // Update the session in the database - me is guaranteed to exist here
      const updatedAccountInfo = {
        ...accountInfo,
        telegramId: me.id,
        username: me.username,
        firstName: me.firstName,
        lastName: me.lastName,
        phone: me.phone,
        isPremium: me.isPremium,
        isVerified: me.isVerified,
        lastLoginAttempt: new Date().toISOString(),
        loginSuccess: true,
      };

      await client.query(
        `UPDATE sessions SET
          is_logged_in = true,
          status = 'active',
          -- Promote parked rows (keep_alive=FALSE because the user
          -- ticked off "Keep this session logged in on the panel" at
          -- create time) into the heartbeat / restore loops so the
          -- session survives backend restarts and the next ZDU flip.
          keep_alive = TRUE,
          phone = $1,
          account_info = $2,
          last_active = NOW(),
          last_heartbeat = NOW()
         WHERE id = $3`,
        [
          me.phone,
          JSON.stringify(updatedAccountInfo),
          sessionId,
        ]
      );

      await client.query('COMMIT');

      logger.info(`Session logged in successfully`, {
        sessionId,
        userId,
        phone: me.phone,
      });

      // Anti-revoke Phase 4: confirm the panel session against
      // Telegram's "unconfirmed authorization" timer AND push the
      // account TTL out to the protocol max so an idle account never
      // auto-prunes all its sessions (including ours). Both calls
      // swallow non-permanent errors — the login itself is already
      // committed, so a transient Telegram-side flake here doesn't
      // need to fail the whole flow.
      try {
        await tgService.hardenSessionAgainstRevocation(tgSessionId);
      } catch (hardenErr) {
        if (tgService.isPermanentAuthError(hardenErr)) {
          // The auth_key just died between getMe and Phase-4. Mark
          // revoked using the same path the heartbeat uses — but only
          // after the consecutive-strike threshold (single transient
          // doesn't kill the row).
          await this._recordRevokeSignal(sessionId, hardenErr).catch(() => {});
        } else {
          logger.debug(`Phase-4 harden failed for ${sessionId}: ${hardenErr.message}`);
        }
      }

      // Anti-revoke Phase 4: snapshot the encrypted session string to
      // the off-DB backups directory so deleting the row never wipes
      // the only copy of the auth_key.
      try {
        await this._writeSessionBackup(sessionId, 'login').catch(() => {});
      } catch { /* best-effort */ }

      // OTP Relay (phase-4 follow-up): if any tg_otp_relays rows
      // reference this session as a watch source, register their
      // listeners now that the GramJS client is connected. Idempotent
      // — re-runs after heartbeat reconnects are no-ops.
      try {
        const otpRelayService = require('./otpRelayService');
        await otpRelayService.onSessionConnected(String(sessionId)).catch(() => {});
      } catch { /* best-effort */ }

      return {
        success: true,
        sessionId: session.id,
        accountInfo: me ? {
          telegramId: me.id,
          username: me.username,
          firstName: me.firstName,
          lastName: me.lastName,
          phone: me.phone,
          isPremium: me.isPremium,
          isVerified: me.isVerified,
        } : null,
        status: me ? 'active' : 'error',
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});

      // Permanent Telegram auth failure (AUTH_KEY_DUPLICATED, etc.) can
      // surface from createSession's connect/handshake just as easily as
      // from getMe. Mark the session revoked and return a 401 with a
      // clear message so the user knows to re-upload or re-login.
      if (tgService.isPermanentAuthError(error)) {
        const code =
          error.errorMessage ||
          (typeof error.code === 'string' ? error.code : null) ||
          'AUTH_KEY_REVOKED';
        // Persist the failure code into account_info so the UI shows
        // "Banned" for USER_DEACTIVATED and "Auth revoked" for everything
        // else, instead of a generic gray pill.
        const failedInfo = {
          ...(accountInfo || {}),
          lastLoginAttempt: new Date().toISOString(),
          loginSuccess: false,
          lastError: error.message || String(error),
          lastErrorCode: code,
        };
        await pool
          .query(
            `UPDATE sessions
                SET is_logged_in = FALSE,
                    status = 'revoked',
                    account_info = $2
              WHERE id = $1`,
            [sessionId, JSON.stringify(failedInfo)]
          )
          .catch(() => {});
        await tgService
          .disconnectSession(String(sessionId))
          .catch(() => {});
        throw new AppError(
          'Telegram revoked this session\'s auth key (' + code + '). ' +
            'The same session is in use by another connection. ' +
            'Please create a fresh session via Create Session, or upload ' +
            'a session file that is not used elsewhere.',
          401,
          code
        );
      }

      // If this is an AppError, re-throw it
      if (error instanceof AppError) throw error;

      throw new AppError(
        `Failed to login session: ${error.message}`,
        500,
        'SESSION_LOGIN_FAILED'
      );
    } finally {
      client.release();
    }
  }

  /**
   * Logout a session by disconnecting the telegram client and updating status.
   *
   * @param {number|string} sessionId - Session database ID
   * @param {number|string} userId - Owner user ID for authorization
   * @returns {Promise<{ success: boolean, sessionId: number }>}
   */
  async logoutSession(sessionId, userId) {
    logger.info(`Logging out session`, { sessionId, userId });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const sessionResult = await client.query(
        `SELECT id, user_id, is_logged_in
         FROM sessions WHERE id = $1 AND user_id = $2 AND platform = 'telegram' FOR UPDATE`,
        [sessionId, userId]
      );

      if (sessionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new AppError(`Session not found or access denied: ${sessionId}`, 404, 'SESSION_NOT_FOUND');
      }

      const session = sessionResult.rows[0];

      if (!session.is_logged_in) {
        await client.query('ROLLBACK');
        throw new AppError('Session is not currently logged in', 409, 'SESSION_NOT_LOGGED_IN');
      }

      // OTP Relay: detach listeners that referenced this session as
      // either watch source or relay destination. Done BEFORE the
      // GramJS disconnect so we cleanly remove handlers from a still-
      // connected client.
      try {
        const otpRelayService = require('./otpRelayService');
        await otpRelayService.onSessionDisconnected(String(sessionId)).catch(() => {});
      } catch { /* best-effort */ }

      // Disconnect the telegram client
      try {
        await this._disconnectSessionClient(String(sessionId));
      } catch (disconnectError) {
        logger.warn(`Disconnect error during logout of session ${sessionId}`, {
          error: disconnectError.message,
        });
        // Continue with status update even if disconnect fails
      }

      // Update session status
      await client.query(
        `UPDATE sessions SET
          is_logged_in = false,
          status = 'inactive',
          last_active = NOW()
         WHERE id = $1`,
        [sessionId]
      );

      await client.query('COMMIT');

      logger.info(`Session logged out successfully`, { sessionId });

      return {
        success: true,
        sessionId: session.id,
      };
    } catch (error) {
      await client.query('ROLLBACK');

      if (error instanceof AppError) throw error;

      throw new AppError(
        `Failed to logout session: ${error.message}`,
        500,
        'SESSION_LOGOUT_FAILED'
      );
    } finally {
      client.release();
    }
  }

  /**
   * Disconnect a telegram client by session ID.
   * @param {string} sessionId - Session identifier
   * @private
   */
  async _disconnectSessionClient(sessionId) {
    if (tgService.isSessionActive(sessionId)) {
      await tgService.disconnectSession(sessionId);
    }
  }

  // =========================================================================
  // Session Info Update
  // =========================================================================

  /**
   * Update session information fields.
   *
   * Updates account_info, last_active, or other metadata fields.
   * Merges the provided info with the existing account_info.
   *
   * @param {number|string} sessionId - Session database ID
   * @param {object} info - Fields to update
   * @param {object} info.accountInfo - Account info to merge
   * @param {string} info.status - New status
   * @param {string} info.phone - Phone number
   * @param {number} info.apiId - API ID
   * @param {string} info.apiHash - API Hash
   * @param {boolean} info.is2faEnabled - 2FA enabled flag
   * @param {boolean} info.isLoggedIn - Logged in flag
   * @returns {Promise<{ success: boolean, sessionId: number, updated: string[] }>}
   */
  async updateSessionInfo(sessionId, info) {
    logger.info(`Updating session info`, { sessionId, fields: Object.keys(info) });

    if (!info || Object.keys(info).length === 0) {
      throw new AppError('No update data provided', 400, 'NO_UPDATE_DATA');
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (info.status !== undefined) {
      if (!VALID_STATUSES.includes(info.status)) {
        throw new AppError(
          `Invalid status: ${info.status}. Must be one of: ${VALID_STATUSES.join(', ')}`,
          400,
          'INVALID_STATUS'
        );
      }
      updates.push(`status = $${paramIndex}`);
      values.push(info.status);
      paramIndex++;
    }

    if (info.phone !== undefined) {
      updates.push(`phone = $${paramIndex}`);
      values.push(info.phone);
      paramIndex++;
    }

    if (info.apiId !== undefined) {
      updates.push(`api_id = $${paramIndex}`);
      values.push(info.apiId);
      paramIndex++;
    }

    if (info.apiHash !== undefined) {
      updates.push(`api_hash = $${paramIndex}`);
      values.push(info.apiHash);
      paramIndex++;
    }

    if (info.is2faEnabled !== undefined) {
      updates.push(`is_2fa_enabled = $${paramIndex}`);
      values.push(info.is2faEnabled);
      paramIndex++;
    }

    if (info.isLoggedIn !== undefined) {
      updates.push(`is_logged_in = $${paramIndex}`);
      values.push(info.isLoggedIn);
      paramIndex++;
    }

    if (info.accountInfo !== undefined) {
      // Merge with existing account info
      const existing = await this._getRawSessionById(sessionId);
      if (!existing) {
        throw new AppError(`Session not found: ${sessionId}`, 404, 'SESSION_NOT_FOUND');
      }

      const existingInfo = this._parseJsonField(existing.account_info);
      const mergedInfo = { ...existingInfo, ...info.accountInfo };
      updates.push(`account_info = $${paramIndex}`);
      values.push(JSON.stringify(mergedInfo));
      paramIndex++;
    }

    // Always update last_active
    updates.push(`last_active = NOW()`);

    if (updates.length === 1) {
      // Only last_active would be updated, which means no real update was requested
      throw new AppError('No valid fields to update', 400, 'NO_UPDATE_DATA');
    }

    values.push(sessionId);

    await pool.query(
      `UPDATE sessions SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

    const updatedFields = Object.keys(info).filter((k) => k !== 'accountInfo');
    if (info.accountInfo) updatedFields.push('accountInfo');

    logger.info(`Session info updated`, { sessionId, updatedFields });

    return {
      success: true,
      sessionId: Number(sessionId),
      updated: updatedFields,
    };
  }

  // =========================================================================
  // Session Statistics
  // =========================================================================

  /**
   * Get session statistics for a user.
   *
   * Returns counts broken down by status, login state, and other metrics.
   *
   * @param {number|string} userId - Owner user ID
   * @returns {Promise<{
   *   total: number,
   *   active: number,
   *   inactive: number,
   *   uploaded: number,
   *   error: number,
   *   revoked: number,
   *   expired: number,
   *   loggedIn: number,
   *   loggedOut: number,
   *   with2FA: number,
   *   without2FA: number,
   *   lastActive: string|null,
   *   totalSessions: number
   * }>}
   */
  async getSessionStats(userId) {
    logger.info(`Fetching session stats for user ${userId}`);

    // Overall count
    // Stats are scoped to platform='telegram' to match the rest of
    // sessionService — IG stats live in the IG provider.
    const totalResult = await pool.query(
      "SELECT COUNT(*) as total FROM sessions WHERE user_id = $1 AND platform = 'telegram'",
      [userId]
    );
    const total = parseInt(totalResult.rows[0].total, 10);

    // Status breakdown
    const statusResult = await pool.query(
      `SELECT status, COUNT(*) as count
       FROM sessions
       WHERE user_id = $1 AND platform = 'telegram'
       GROUP BY status`,
      [userId]
    );

    // Login state breakdown
    const loginResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE is_logged_in = true) as logged_in,
         COUNT(*) FILTER (WHERE is_logged_in = false) as logged_out,
         COUNT(*) FILTER (WHERE is_2fa_enabled = true) as with_2fa,
         COUNT(*) FILTER (WHERE is_2fa_enabled = false) as without_2fa,
         MAX(last_active) as last_active
       FROM sessions
       WHERE user_id = $1 AND platform = 'telegram'`,
      [userId]
    );

    const statusCounts = {};
    for (const row of statusResult.rows) {
      statusCounts[row.status] = parseInt(row.count, 10);
    }

    const loginRow = loginResult.rows[0];

    return {
      total,
      active: statusCounts.active || 0,
      inactive: statusCounts.inactive || 0,
      uploaded: statusCounts.uploaded || 0,
      error: statusCounts.error || 0,
      revoked: statusCounts.revoked || 0,
      expired: statusCounts.expired || 0,
      loggedIn: parseInt(loginRow.logged_in, 10),
      loggedOut: parseInt(loginRow.logged_out, 10),
      with2FA: parseInt(loginRow.with_2fa, 10),
      without2FA: parseInt(loginRow.without_2fa, 10),
      lastActive: loginRow.last_active,
      totalSessions: total,
    };
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  /**
   * Fetch a raw session row from the database by ID (no user restriction).
   * @param {number|string} sessionId - Session database ID
   * @returns {Promise<object|null>}
   * @private
   */
  async _getRawSessionById(sessionId) {
    const result = await pool.query(
      `SELECT id, user_id, phone, session_file_path, api_id, api_hash,
              status, is_2fa_enabled, is_logged_in, account_info,
              created_at, last_active
       FROM sessions WHERE id = $1`,
      [sessionId]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Get the session storage directory for a user.
   * @param {number|string} userId - User ID
   * @returns {string} Full path to the user's session directory
   * @private
   */
  _getUserSessionDir(userId) {
    return path.join(uploadDir, String(userId), SESSION_SUBDIR);
  }

  /**
   * Parse a JSON field from a database row.
   * Handles both string and already-parsed JSONB values.
   * @param {*} value - The field value
   * @returns {object|null} Parsed JSON object or null
   * @private
   */
  _parseJsonField(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value; // Already parsed (JSONB)
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return { raw: value };
      }
    }
    return null;
  }

  /**
   * Check if a file is a valid Telegram GramJS session string.
   *
   * GramJS session strings are base64-encoded and typically start with
   * specific patterns after decoding.
   *
   * @param {string} sessionString - The session string to validate
   * @returns {boolean}
   * @private
   */
  _isValidSessionString(sessionString) {
    if (!sessionString || typeof sessionString !== 'string') return false;

    // GramJS string sessions are base64-encoded and contain specific patterns
    // They are typically at least 100 characters and contain alphanumeric + base64 chars
    const trimmed = sessionString.trim();

    if (trimmed.length < 50) return false;

    // Check that it looks like a valid base64 session string
    // GramJS sessions start with a version byte followed by DC info
    const base64Pattern = /^[A-Za-z0-9+/=]+$/;

    // Some session strings may contain URL-safe base64
    const urlSafeBase64Pattern = /^[A-Za-z0-9_-]+$/;

    // Try standard base64
    if (base64Pattern.test(trimmed)) {
      try {
        const decoded = Buffer.from(trimmed, 'base64');
        // Valid session strings decode to at least 50 bytes
        return decoded.length >= 50;
      } catch {
        return false;
      }
    }

    // Try URL-safe base64
    if (urlSafeBase64Pattern.test(trimmed)) {
      try {
        const converted = trimmed.replace(/-/g, '+').replace(/_/g, '/');
        // Pad if necessary
        const padded = converted + '='.repeat((4 - (converted.length % 4)) % 4);
        const decoded = Buffer.from(padded, 'base64');
        return decoded.length >= 50;
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Check if a binary file is a Telethon SQLite session.
   *
   * Telethon sessions are SQLite databases that start with the SQLite
   * magic header bytes.
   *
   * @param {string} filePath - Path to the binary file
   * @returns {Promise<boolean>}
   * @private
   */
  async _isTelethonSession(filePath) {
    try {
      const fd = await fs.open(filePath, 'r');
      const buffer = Buffer.alloc(SQLITE_HEADER.length);
      await fs.read(fd, buffer, 0, SQLITE_HEADER.length, 0);
      await fs.close(fd);

      return buffer.equals(SQLITE_HEADER);
    } catch {
      return false;
    }
  }

  // =========================================================================
  // Persistent session keep-alive (Upgrade 1)
  // =========================================================================

  /**
   * Restore Telegram clients for every session marked as logged-in in the
   * database. Called once on backend startup so that previously-uploaded
   * sessions remain authenticated until the user explicitly logs them out.
   *
   * Failures on individual sessions are logged and do NOT mark the session
   * as logged-out — Upgrade 1 explicitly requires that logout only happen
   * via an explicit user action.
   */
  async restoreAllLoggedInSessions() {
    logger.info('Restoring persisted logged-in sessions');
    let total = 0;
    let restored = 0;
    let failed = 0;
    try {
      // Restoration here is Telegram-specific — it uses GramJS' session
      // file format, the Telegram proxyService, and behaviour scheduling
      // built around the Telegram client object. Instagram sessions are
      // restored lazily on first use by the IG provider's getClient(),
      // so don't pull them through this loop (otherwise the TG-only
      // _loadSessionFromDB throws "path argument must be of type string").
      const result = await pool.query(
        `SELECT id FROM sessions
         WHERE is_logged_in = TRUE AND COALESCE(keep_alive, TRUE) = TRUE
           AND platform = 'telegram'
         ORDER BY id ASC`
      );
      total = result.rows.length;

      // Anti-revoke Phase 1 (B5): stagger restores over a window so
      // Telegram doesn't see a "data-centre sweep" of N reconnects from
      // one IP in <1 s.
      const telegramConfig = require('../config/telegram');
      const restoreScheduler = require('../utils/restoreScheduler');
      const windowMs = telegramConfig.RESTORE_WINDOW_MS || 0;
      const perMinuteCap = telegramConfig.RESTORE_PER_IP_PER_MIN || 0;

      const restoreOne = async (sessionId) => {
        try {
          // Try to (re)assign a proxy and load the client.
          let proxyConf = null;
          try {
            const proxyService = require('./proxyService');
            const proxyRow = await proxyService.assignProxyForSession(sessionId);
            proxyConf = proxyService.buildGramJSProxy(proxyRow);
          } catch (proxyErr) {
            logger.debug(`Proxy assign failed during restore for ${sessionId}: ${proxyErr.message}`);
          }

          if (tgService.isSessionActive(String(sessionId))) {
            restored++;
            return;
          }
          // Use the lower-level loader and then reset proxy via _ensureConnected.
          await tgService._loadSessionFromDB(sessionId);
          // If a proxy is configured, replace the client with one bound to that proxy.
          if (proxyConf) {
            const sFile = await this._readSessionFile(sessionId);
            if (sFile) {
              // Anti-Detect: replay the persisted device identity.
              let identity = null;
              try {
                const identityService = require('./identityService');
                identity = await identityService.loadOrCreate(sessionId);
              } catch { /* non-fatal */ }
              await tgService.disconnectSession(String(sessionId)).catch(() => {});
              await tgService.createSession(
                String(sessionId),
                sFile.encryptedSession,
                sFile.apiId,
                sFile.apiHash,
                { proxy: proxyConf, identity }
              );
            }
          }

          // Anti-revoke Phase 1 (B4): persist the DC the auth_key landed
          // on so subsequent reconnects pin to the same DC.
          try {
            await tgService.persistDcPinFromClient(String(sessionId));
          } catch (dcErr) {
            logger.debug(`DC pin failed for ${sessionId}: ${dcErr.message}`);
          }

          // Anti-revoke Phase 2 (B9): announce online presence after
          // reconnect (best-effort; ignore failures).
          try {
            await tgService.announceOnlineIfDue(String(sessionId)).catch(() => {});
          } catch { /* non-fatal */ }

          // Confirm the session is actually authenticated; if Telegram
          // has revoked the auth key (AUTH_KEY_DUPLICATED, etc.) we want
          // to mark it logged-out NOW rather than letting the heartbeat
          // discover it minutes later.
          try {
            await tgService.getMe(String(sessionId));
          } catch (pingErr) {
            if (tgService.isPermanentAuthError(pingErr)) {
              // Anti-revoke Phase 4: don't kill on a single strike —
              // record the signal and let the heartbeat threshold
              // logic decide. Restore is also called on every backend
              // boot, where transient connectivity issues are common.
              const r = await this._recordRevokeSignal(sessionId, pingErr).catch(() => null);
              if (r && r.revoked) {
                failed++;
                return;
              }
              // Below threshold — count this restore as failed but
              // leave the row in a recoverable state.
              failed++;
              return;
            }
            // Transient ping failure — let the heartbeat retry.
            logger.debug(`restore getMe failed for ${sessionId}: ${pingErr.message}`);
          }
          await pool.query(`UPDATE sessions SET last_heartbeat = NOW() WHERE id = $1`, [sessionId]);
          await this._clearRevokeSignals(sessionId).catch(() => {});
          // OTP Relay: hook listeners after the client is back up.
          try {
            const otpRelayService = require('./otpRelayService');
            await otpRelayService.onSessionConnected(String(sessionId)).catch(() => {});
          } catch { /* best-effort */ }
          restored++;
        } catch (err) {
          if (tgService.isPermanentAuthError(err)) {
            const r = await this._recordRevokeSignal(sessionId, err).catch(() => null);
            if (r && r.revoked) {
              failed++;
              return;
            }
            failed++;
            return;
          }
          failed++;
          logger.warn(`Failed to restore session ${sessionId}: ${err.message}`);
        }
      };

      const ids = result.rows.map((r) => r.id);
      // Per-session hard timeout. If a single session hangs (DNS, slow
      // proxy, AUTH_KEY_DUPLICATED that drags out the MTProto recv
      // loop) the loop must not block on it indefinitely. The
      // heartbeat retries the row on its next tick. Default 20 s,
      // overridable via env. Set to 0 to disable.
      const restoreTimeoutMs = parseInt(
        process.env.SESSION_RESTORE_PER_SESSION_TIMEOUT_MS || '20000', 10
      );
      const restoreOneWithTimeout = (sessionId) => {
        if (restoreTimeoutMs <= 0) return restoreOne(sessionId);
        return new Promise((resolve) => {
          let settled = false;
          const t = setTimeout(() => {
            if (settled) return;
            settled = true;
            failed++;
            logger.warn(
              `restore timeout for session ${sessionId} after ${restoreTimeoutMs}ms; will retry on heartbeat`
            );
            resolve();
          }, restoreTimeoutMs);
          restoreOne(sessionId).then(
            () => { if (!settled) { settled = true; clearTimeout(t); resolve(); } },
            (err) => {
              if (!settled) {
                settled = true; clearTimeout(t);
                logger.warn(`restoreOne(${sessionId}) rejected: ${err.message}`);
                resolve();
              }
            }
          );
        });
      };

      // If staggering is disabled (windowMs<=0), restore inline; otherwise
      // delegate to the scheduler.
      if (windowMs <= 0 || ids.length <= 1) {
        for (const id of ids) {
          // eslint-disable-next-line no-await-in-loop
          await restoreOneWithTimeout(id);
        }
      } else {
        await restoreScheduler.run({
          items: ids,
          windowMs,
          perMinuteCap,
          handler: (id) => restoreOneWithTimeout(id),
          onProgress: (idx, t, ms) => {
            if (idx === 0 || (idx + 1) % 10 === 0 || idx === t - 1) {
              logger.debug(
                `restoreScheduler tick ${idx + 1}/${t} (delay=${ms}ms)`
              );
            }
          },
        });
      }
    } catch (err) {
      logger.error('restoreAllLoggedInSessions failed', { error: err.message });
    }
    logger.info(`Session restore: total=${total} restored=${restored} failed=${failed}`);
    return { total, restored, failed };
  }

  /**
   * Read the encrypted session payload + api credentials from disk for a
   * given session row. Returns null if the file is missing.
   * @private
   */
  async _readSessionFile(sessionId) {
    try {
      const r = await pool.query(
        `SELECT session_file_path, api_id, api_hash FROM sessions WHERE id = $1`,
        [sessionId]
      );
      const row = r.rows[0];
      if (!row || !row.session_file_path) return null;
      const fullPath = path.join(uploadDir, row.session_file_path);
      if (!await fs.pathExists(fullPath)) return null;
      const data = JSON.parse(await fs.readFile(fullPath, 'utf8'));
      if (!data.session) return null;
      return {
        encryptedSession: data.session,
        apiId: row.api_id || undefined,
        apiHash: row.api_hash || undefined,
      };
    } catch (err) {
      logger.debug(`_readSessionFile error: ${err.message}`);
      return null;
    }
  }

  /**
   * Run a heartbeat sweep over every session marked logged-in: ensure the
   * underlying Telegram client is connected, and update last_heartbeat on
   * success. Keeps clients alive for the duration of the container.
   */
  async heartbeatLoggedInSessions() {
    let pinged = 0;
    let revived = 0;
    let failed = 0;
    let revoked = 0;
    try {
      // Heartbeat is Telegram-specific — `_ensureConnected` and `getMe`
      // talk to GramJS, not the IG provider. IG sessions stay valid as
      // long as their cookies are valid; the IG client is recreated
      // lazily per-request, so it doesn't need a heartbeat.
      const result = await pool.query(
        `SELECT id FROM sessions
          WHERE is_logged_in = TRUE
            AND COALESCE(keep_alive, TRUE) = TRUE
            AND platform = 'telegram'`
      );
      for (const row of result.rows) {
        const sid = String(row.id);
        try {
          const wasActive = tgService.isSessionActive(sid);
          await tgService._ensureConnected(sid);
          if (!wasActive) revived++;
          // Anti-revoke Phase 2 (B8): heartbeat uses MTProto Ping
          // (transport-level keepalive that real clients send), not
          // users.getFullUser. `pingSession` falls back to getMe only if
          // the GramJS PingDelayDisconnect call fails (older client
          // versions); the fallback path still records the same
          // permanent-auth-error semantics.
          try {
            if (typeof tgService.pingSession === 'function') {
              await tgService.pingSession(sid);
            } else {
              await tgService.getMe(sid);
            }
            // Anti-revoke Phase 4: clear any in-flight strike streak
            // — a successful ping means whatever transient glitch
            // bumped the counter is over.
            await this._clearRevokeSignals(row.id).catch(() => {});
          } catch (pingErr) {
            if (tgService.isPermanentAuthError(pingErr)) {
              const r = await this._recordRevokeSignal(row.id, pingErr).catch(() => null);
              if (r && r.revoked) {
                revoked++;
                continue;
              }
              // Below threshold — count this tick as a failure but
              // keep iterating; future ticks will either confirm the
              // permanent revocation or let the streak reset.
              failed++;
              continue;
            }
            logger.debug(`heartbeat ping failed for ${sid}: ${pingErr.message}`);
          }
          // Anti-revoke Phase 4: re-confirm the authorization + push
          // the account TTL out on a slow cadence (handled inside
          // reaffirmHardeningIfDue). Cheap; uses the cadence
          // bookkeeping in tg_session_health.
          try {
            if (typeof tgService.reaffirmHardeningIfDue === 'function') {
              await tgService.reaffirmHardeningIfDue(sid).catch(() => {});
            }
          } catch (rErr) {
            if (tgService.isPermanentAuthError(rErr)) {
              const r = await this._recordRevokeSignal(row.id, rErr).catch(() => null);
              if (r && r.revoked) {
                revoked++;
                continue;
              }
            }
          }
          // Anti-revoke Phase 2 (B9): re-broadcast online presence on a
          // long cadence (handled inside `announceOnlineIfDue`).
          try {
            if (typeof tgService.announceOnlineIfDue === 'function') {
              await tgService.announceOnlineIfDue(sid).catch(() => {});
            }
          } catch { /* non-fatal */ }
          // Anti-revoke Phase 2 (B12): periodic GetAuthorizations
          // probe — early-warning if our session disappeared from
          // Telegram's "Active Sessions" list.
          try {
            if (typeof tgService.checkAuthorizationsIfDue === 'function') {
              const res = await tgService.checkAuthorizationsIfDue(sid).catch(() => null);
              if (res && res.revokedExternally) {
                // Anti-revoke Phase 4: require N consecutive
                // "missing-from-active-sessions" probes before flipping.
                // GetAuthorizations occasionally returns stale lists,
                // and we don't want a single bad probe to wipe a row
                // that's otherwise responding to pings just fine.
                const r = await this._recordExternalRevokeSignal(row.id).catch(() => null);
                if (r && r.revoked) {
                  revoked++;
                  continue;
                }
                // Below threshold — keep the row alive; alert was
                // already sent inside _recordExternalRevokeSignal.
                continue;
              }
            }
          } catch { /* non-fatal */ }

          await pool.query(`UPDATE sessions SET last_heartbeat = NOW(), last_ping_at = NOW() WHERE id = $1`, [row.id]);
          pinged++;
        } catch (err) {
          if (tgService.isPermanentAuthError(err)) {
            await this._markSessionAuthRevoked(row.id, err).catch(() => {});
            revoked++;
            continue;
          }
          failed++;
          logger.debug(`heartbeat failed for session ${sid}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`heartbeatLoggedInSessions sweep failed: ${err.message}`);
    }
    if (pinged || revived || failed || revoked) {
      logger.debug(
        `Heartbeat: pinged=${pinged} revived=${revived} failed=${failed} revoked=${revoked}`
      );
    }
    return { pinged, revived, failed, revoked };
  }

  /**
   * Flip a session out of the logged-in / keep-alive pool after Telegram
   * has permanently rejected its auth key. Idempotent — safe to call from
   * either the restore or the heartbeat loop.
   *
   * @param {number|string} sessionId
   * @param {Error} error - Original Telegram error (for logging only).
   * @private
   */
  async _markSessionAuthRevoked(sessionId, error) {
    const reason = (error && (error.code || error.message)) || 'auth_revoked';
    try {
      await pool.query(
        `UPDATE sessions
            SET is_logged_in = FALSE,
                status = 'revoked',
                last_heartbeat = NOW()
          WHERE id = $1`,
        [sessionId]
      );
    } catch (dbErr) {
      logger.warn(
        `Failed to mark session ${sessionId} as revoked: ${dbErr.message}`
      );
    }
    try {
      await tgService.disconnectSession(String(sessionId));
    } catch {
      // ignore — client may already be gone
    }
    // Anti-revoke Phase 3 (B15): record the revocation in
    // tg_detection_events so the admin dashboard can show what killed
    // the session (and the post-mortem isn't dependent on log retention).
    try {
      const cfg = require('../config/telegram');
      if (cfg.ANTI_REVOKE_PHASE_3_ENABLED) {
        const detectionEvents = require('../providers/telegram/detectionEvents');
        let userId = null;
        try {
          const ur = await pool.query(`SELECT user_id FROM sessions WHERE id = $1`, [sessionId]);
          userId = ur.rows[0] ? ur.rows[0].user_id : null;
        } catch { /* ignore */ }
        await detectionEvents.recordFromError(error || new Error(reason), {
          session_id: sessionId,
          user_id: userId,
          api_method: 'heartbeat',
          fingerprint: { source: 'sessionService', reason },
        });
        try {
          await pool.query(
            `INSERT INTO tg_session_health (session_id, last_reauth_required_at, updated_at)
             VALUES ($1, NOW(), NOW())
             ON CONFLICT (session_id) DO UPDATE SET
               last_reauth_required_at = NOW(),
               updated_at = NOW()`,
            [sessionId]
          );
        } catch { /* tg_session_health may not exist yet */ }
      }
    } catch (recErr) {
      logger.debug(`detection_events insert (revoked) failed for ${sessionId}: ${recErr.message}`);
    }
    logger.warn(
      `Session ${sessionId} auth key revoked by Telegram (${reason}); ` +
        `marked as logged-out so the heartbeat stops retrying. ` +
        `User can click "Re-link" to re-authenticate with the same identity + proxy + DC.`
    );
    // Anti-revoke Phase 4 — push a real-time alert via the admin bot
    // and reset the strike counter so a future recover() doesn't get
    // immediately re-marked.
    try {
      const sessionAlertService = require('./sessionAlertService');
      await sessionAlertService.alertRevoked(sessionId, reason).catch(() => {});
    } catch { /* alert service may be unavailable */ }
    try {
      await pool.query(
        `UPDATE tg_session_health
            SET consecutive_revoke_signals = 0,
                first_revoke_signal_at     = NULL,
                last_revoke_signal_code    = $2,
                updated_at                 = NOW()
          WHERE session_id = $1`,
        [sessionId, reason]
      );
    } catch { /* tg_session_health optional */ }
  }

  /**
   * Anti-revoke Phase 4: record a permanent-auth strike against a
   * session WITHOUT immediately marking it revoked. Increments the
   * tg_session_health.consecutive_revoke_signals counter; only when
   * the counter reaches ANTI_REVOKE_PHASE_4_CONSECUTIVE_REVOKE_THRESHOLD
   * AND the first strike is at least
   * ANTI_REVOKE_PHASE_4_REVOKE_CONFIRM_WINDOW_MS old does the row get
   * flipped to status='revoked'. Single-strike transient errors no
   * longer kill the row.
   *
   * Falls back to the legacy "mark immediately" behaviour when Phase 4
   * is disabled, when the strike row is missing, or when the streak
   * was started so long ago we should give up retrying.
   *
   * @param {number|string} sessionId
   * @param {Error}         error
   * @returns {Promise<{revoked:boolean, streak:number, ageMs:number}>}
   * @private
   */
  async _recordRevokeSignal(sessionId, error) {
    const cfg = require('../config/telegram');
    const code =
      (error && (error.errorMessage || (typeof error.code === 'string' ? error.code : null))) ||
      (error && error.message) ||
      'auth_error';
    if (!cfg.ANTI_REVOKE_PHASE_4_ENABLED) {
      await this._markSessionAuthRevoked(sessionId, error);
      return { revoked: true, streak: 1, ageMs: 0 };
    }
    let streak = 1;
    let ageMs = 0;
    try {
      const upd = await pool.query(
        `INSERT INTO tg_session_health
           (session_id, consecutive_revoke_signals, first_revoke_signal_at,
            last_revoke_signal_code, updated_at)
         VALUES ($1, 1, NOW(), $2, NOW())
         ON CONFLICT (session_id) DO UPDATE SET
           consecutive_revoke_signals = tg_session_health.consecutive_revoke_signals + 1,
           first_revoke_signal_at     = COALESCE(tg_session_health.first_revoke_signal_at, NOW()),
           last_revoke_signal_code    = EXCLUDED.last_revoke_signal_code,
           updated_at                 = NOW()
         RETURNING consecutive_revoke_signals, first_revoke_signal_at`,
        [sessionId, code]
      );
      const row = upd.rows[0];
      if (row) {
        streak = row.consecutive_revoke_signals;
        ageMs = row.first_revoke_signal_at
          ? Date.now() - new Date(row.first_revoke_signal_at).getTime()
          : 0;
      }
    } catch (dbErr) {
      logger.debug(
        `_recordRevokeSignal: tg_session_health update failed for ${sessionId}: ${dbErr.message}`
      );
      // tg_session_health is optional — fall back to immediate revoke
      // so the heartbeat doesn't keep banging on a clearly dead key.
      await this._markSessionAuthRevoked(sessionId, error);
      return { revoked: true, streak: 1, ageMs: 0 };
    }
    const threshold = Math.max(1, cfg.ANTI_REVOKE_PHASE_4_CONSECUTIVE_REVOKE_THRESHOLD || 2);
    const window = Math.max(0, cfg.ANTI_REVOKE_PHASE_4_REVOKE_CONFIRM_WINDOW_MS || 0);
    if (streak >= threshold && ageMs >= window) {
      await this._markSessionAuthRevoked(sessionId, error);
      return { revoked: true, streak, ageMs };
    }
    // Below threshold — alert the user once that we saw a strike, but
    // keep the row alive. The cooldown inside sessionAlertService
    // prevents spam.
    try {
      const sessionAlertService = require('./sessionAlertService');
      await sessionAlertService.alertStrike(sessionId, { code, streak, ageMs, threshold }).catch(() => {});
    } catch { /* best-effort */ }
    logger.info(
      `[anti-revoke phase4] session ${sessionId} strike ${streak}/${threshold} ` +
        `(code=${code}, ageMs=${ageMs}); not yet flipped to 'revoked'.`
    );
    return { revoked: false, streak, ageMs };
  }

  /**
   * Anti-revoke Phase 4: clear the consecutive-strike counters on a
   * successful protocol round-trip. Called from the heartbeat after a
   * successful pingSession so a single later strike doesn't get
   * confused with an in-progress streak.
   *
   * @param {number|string} sessionId
   * @private
   */
  async _clearRevokeSignals(sessionId) {
    try {
      await pool.query(
        `UPDATE tg_session_health
            SET consecutive_revoke_signals          = 0,
                first_revoke_signal_at              = NULL,
                consecutive_external_revoke_signals = 0,
                updated_at                          = NOW()
          WHERE session_id = $1
            AND (consecutive_revoke_signals > 0
                 OR consecutive_external_revoke_signals > 0)`,
        [sessionId]
      );
    } catch { /* tg_session_health optional */ }
  }

  /**
   * Anti-revoke Phase 4: same N-strike rule, but for the
   * GetAuthorizations probe ("we're not in the active-sessions list
   * any more"). Two consecutive missing-current responses required
   * before flipping the row.
   *
   * @param {number|string} sessionId
   * @returns {Promise<{revoked:boolean, streak:number}>}
   * @private
   */
  async _recordExternalRevokeSignal(sessionId) {
    const cfg = require('../config/telegram');
    if (!cfg.ANTI_REVOKE_PHASE_4_ENABLED) {
      await this._markSessionAuthRevoked(sessionId, new Error('AUTH_KEY_REMOVED_BY_USER'));
      return { revoked: true, streak: 1 };
    }
    let streak = 1;
    try {
      const upd = await pool.query(
        `INSERT INTO tg_session_health
           (session_id, consecutive_external_revoke_signals, updated_at)
         VALUES ($1, 1, NOW())
         ON CONFLICT (session_id) DO UPDATE SET
           consecutive_external_revoke_signals = tg_session_health.consecutive_external_revoke_signals + 1,
           updated_at                          = NOW()
         RETURNING consecutive_external_revoke_signals`,
        [sessionId]
      );
      streak = (upd.rows[0] && upd.rows[0].consecutive_external_revoke_signals) || 1;
    } catch {
      await this._markSessionAuthRevoked(sessionId, new Error('AUTH_KEY_REMOVED_BY_USER'));
      return { revoked: true, streak: 1 };
    }
    const threshold = Math.max(1, cfg.ANTI_REVOKE_PHASE_4_CONSECUTIVE_EXTERNAL_REVOKE_THRESHOLD || 2);
    if (streak >= threshold) {
      await this._markSessionAuthRevoked(sessionId, new Error('AUTH_KEY_REMOVED_BY_USER'));
      return { revoked: true, streak };
    }
    try {
      const sessionAlertService = require('./sessionAlertService');
      await sessionAlertService.alertStrike(sessionId, {
        code: 'AUTH_KEY_REMOVED_BY_USER',
        streak,
        threshold,
        kind: 'external',
      }).catch(() => {});
    } catch { /* best-effort */ }
    logger.info(
      `[anti-revoke phase4] session ${sessionId} external-strike ${streak}/${threshold}; ` +
        `not yet flipped to 'revoked'.`
    );
    return { revoked: false, streak };
  }

  /**
   * Anti-revoke Phase 4: snapshot the encrypted session string +
   * api_id/api_hash from the live session row to the off-DB backups
   * directory. Called on session creation, every successful login, and
   * lazily by the heartbeat once a week so an operator-error DELETE
   * never wipes the only copy of the auth_key.
   *
   * Backup format mirrors the on-disk session JSON:
   *   {
   *     session: <encrypted gramjs string>,   // unchanged
   *     apiId,
   *     apiHash,
   *     phone,
   *     savedAt: ISO8601,
   *     reason,                               // 'created' | 'login' | 'periodic' | 'manual'
   *   }
   *
   * Dedupe key is sha256(encryptedSession). Identical bodies on
   * subsequent calls return immediately without writing or inserting.
   *
   * @param {number|string} sessionId
   * @param {string} reason - one of 'created' | 'login' | 'periodic' | 'manual'
   * @returns {Promise<{written:boolean, backupId?:number, deduped?:boolean}>}
   * @private
   */
  async _writeSessionBackup(sessionId, reason = 'manual') {
    const cfg = require('../config/telegram');
    if (!cfg.ANTI_REVOKE_PHASE_4_ENABLED) return { written: false };
    const crypto = require('crypto');
    try {
      const r = await pool.query(
        `SELECT user_id, phone, session_file_path, api_id, api_hash
           FROM sessions WHERE id = $1`,
        [sessionId]
      );
      const row = r.rows[0];
      if (!row || !row.session_file_path) return { written: false };
      const fullPath = path.join(uploadDir, row.session_file_path);
      if (!await fs.pathExists(fullPath)) return { written: false };
      const data = JSON.parse(await fs.readFile(fullPath, 'utf8'));
      if (!data.session) return { written: false };
      const sha = crypto
        .createHash('sha256')
        .update(typeof data.session === 'string' ? data.session : JSON.stringify(data.session))
        .digest('hex');

      // Dedupe — if we've already saved this exact ciphertext for this
      // session, just bump retain_until on the existing row and return.
      const retentionDays = Math.max(
        1,
        cfg.ANTI_REVOKE_PHASE_4_BACKUP_RETENTION_DAYS || 90
      );
      const dup = await pool.query(
        `UPDATE session_backups
            SET retain_until = NOW() + ($3::int || ' days')::interval
          WHERE session_id = $1 AND content_sha256 = $2
          RETURNING id`,
        [sessionId, sha, retentionDays]
      );
      if (dup.rows[0]) {
        return { written: false, deduped: true, backupId: dup.rows[0].id };
      }

      const userId = row.user_id;
      const tsSlug = new Date().toISOString().replace(/[:.]/g, '-');
      const relativePath = path.posix.join(
        'backups',
        String(userId || 'system'),
        String(sessionId),
        `${sha.slice(0, 16)}-${tsSlug}.enc`
      );
      const absPath = path.join(uploadDir, relativePath);
      await fs.ensureDir(path.dirname(absPath));
      const payload = JSON.stringify({
        session: data.session,
        apiId: row.api_id,
        apiHash: row.api_hash,
        phone: row.phone,
        savedAt: new Date().toISOString(),
        reason,
      });
      await fs.writeFile(absPath, payload, 'utf8');
      const ins = await pool.query(
        `INSERT INTO session_backups
           (session_id, user_id, phone, api_id, api_hash, content_sha256,
            backup_path, backup_bytes, reason, retain_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 NOW() + ($10::int || ' days')::interval)
         ON CONFLICT (session_id, content_sha256) DO UPDATE SET
           retain_until = EXCLUDED.retain_until
         RETURNING id`,
        [
          sessionId,
          userId || null,
          row.phone || null,
          row.api_id || null,
          row.api_hash || null,
          sha,
          relativePath,
          Buffer.byteLength(payload, 'utf8'),
          reason,
          retentionDays,
        ]
      );
      return { written: true, backupId: ins.rows[0].id };
    } catch (err) {
      logger.warn(`_writeSessionBackup failed for ${sessionId}: ${err.message}`);
      return { written: false };
    }
  }

  /**
   * Anti-revoke Phase 4: attempt to bring a session row that was
   * marked status='revoked' back to life by re-loading the encrypted
   * session file + running getMe. If Telegram still accepts the
   * auth_key (false-positive revocation), the row flips back to
   * status='active' / is_logged_in=TRUE and the heartbeat resumes. If
   * Telegram really has killed the key, the function returns
   * `{ recovered: false, reason: <code> }` and leaves the row
   * untouched.
   *
   * Fallback chain when the on-disk session file is missing or
   * unparseable: try the most recent session_backups row for the same
   * session_id (newest first) until one succeeds.
   *
   * @param {number|string} sessionId
   * @param {number|string} userId  - for ownership check
   * @returns {Promise<{recovered:boolean, status?:string, accountInfo?:object, reason?:string}>}
   */
  async recoverSession(sessionId, userId) {
    const cfg = require('../config/telegram');
    if (!cfg.ANTI_REVOKE_PHASE_4_ENABLED) {
      throw new AppError(
        'Session recovery is disabled (ANTI_REVOKE_PHASE_4_ENABLED=false)',
        503,
        'PHASE_4_DISABLED'
      );
    }
    const r = await pool.query(
      `SELECT id, user_id, phone, session_file_path, api_id, api_hash, status, is_logged_in
         FROM sessions
        WHERE id = $1 AND user_id = $2 AND platform = 'telegram'`,
      [sessionId, userId]
    );
    const session = r.rows[0];
    if (!session) {
      throw new AppError(`Session not found: ${sessionId}`, 404, 'SESSION_NOT_FOUND');
    }
    // Try the on-disk live file first, then walk the backup ledger.
    const candidates = [];
    if (session.session_file_path) {
      candidates.push({
        kind: 'live',
        absPath: path.join(uploadDir, session.session_file_path),
        apiId: session.api_id,
        apiHash: session.api_hash,
      });
    }
    const bk = await pool.query(
      `SELECT backup_path, api_id, api_hash
         FROM session_backups
        WHERE session_id = $1
        ORDER BY created_at DESC
        LIMIT 5`,
      [sessionId]
    );
    for (const row of bk.rows) {
      candidates.push({
        kind: 'backup',
        absPath: path.join(uploadDir, row.backup_path),
        apiId: row.api_id || session.api_id,
        apiHash: row.api_hash || session.api_hash,
      });
    }

    let lastError = null;
    for (const cand of candidates) {
      try {
        if (!await fs.pathExists(cand.absPath)) continue;
        const data = JSON.parse(await fs.readFile(cand.absPath, 'utf8'));
        if (!data.session) continue;
        // Tear down any half-dead client first so we get a clean slot.
        await tgService.disconnectSession(String(sessionId)).catch(() => {});
        await tgService.createSession(
          String(sessionId),
          data.session,
          cand.apiId,
          cand.apiHash,
          {}
        );
        const me = await tgService.getMe(String(sessionId));
        // Flip the row back to active + clear the strike counters so
        // the heartbeat doesn't immediately re-revoke us.
        await pool.query(
          `UPDATE sessions
              SET is_logged_in = TRUE,
                  status       = 'active',
                  last_active  = NOW(),
                  last_heartbeat = NOW()
            WHERE id = $1`,
          [sessionId]
        );
        await pool.query(
          `UPDATE tg_session_health
              SET consecutive_revoke_signals          = 0,
                  first_revoke_signal_at              = NULL,
                  consecutive_external_revoke_signals = 0,
                  last_recovered_at                   = NOW(),
                  updated_at                          = NOW()
            WHERE session_id = $1`,
          [sessionId]
        ).catch(() => {});
        // If we recovered from a backup, persist the still-working
        // copy back into the live slot so subsequent restores skip
        // the backup-walk path.
        if (cand.kind === 'backup' && session.session_file_path) {
          try {
            const livePath = path.join(uploadDir, session.session_file_path);
            await fs.ensureDir(path.dirname(livePath));
            await fs.writeFile(livePath, JSON.stringify(data), 'utf8');
          } catch (writeErr) {
            logger.debug(`recoverSession: live-file rewrite failed: ${writeErr.message}`);
          }
        }
        // Re-harden — confirm the auth + push the TTL back out.
        try { await tgService.hardenSessionAgainstRevocation(String(sessionId)); } catch {}
        try {
          const sessionAlertService = require('./sessionAlertService');
          await sessionAlertService.alertRecovered(sessionId, cand.kind).catch(() => {});
        } catch { /* best-effort */ }
        logger.info(
          `Session ${sessionId} recovered via ${cand.kind} (${path.basename(cand.absPath)})`
        );
        return {
          recovered: true,
          status: 'active',
          accountInfo: me ? {
            telegramId: me.id,
            username: me.username,
            firstName: me.firstName,
            lastName: me.lastName,
            phone: me.phone,
          } : null,
        };
      } catch (err) {
        lastError = err;
        logger.debug(
          `Recovery attempt failed for ${sessionId} via ${cand.kind} ${cand.absPath}: ${err.message}`
        );
        // Permanent auth errors mean THIS particular session string is
        // dead — but a later backup might still work, so keep walking.
        continue;
      }
    }
    return {
      recovered: false,
      reason: (lastError && (lastError.errorMessage || lastError.message)) || 'no_valid_backup',
    };
  }
}

module.exports = new SessionService();
