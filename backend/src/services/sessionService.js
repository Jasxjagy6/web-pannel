const fs = require('fs-extra');
const path = require('path');
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
 */
const SUPPORTED_EXTENSIONS = ['.session', '.json', '.bin', '.txt'];

/**
 * Maximum file size for individual session uploads (100MB).
 */
const MAX_SESSION_FILE_SIZE = 100 * 1024 * 1024;

/**
 * Timeout for Telegram connection during login (30 seconds).
 */
const LOGIN_TIMEOUT_MS = 30000;

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
    const { apiId, apiHash, autoLogin = false } = options;

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

    for (const file of files) {
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
              autoLogin
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
              apiHash
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

    const duration = Date.now() - startTime;

    logger.info(`Bulk session upload complete for user ${userId}`, {
      total: files.length,
      successful: successfulCount,
      failed: failedCount,
      durationMs: duration,
    });

    return {
      total: files.length,
      successful: successfulCount,
      failed: failedCount,
      results,
      duration,
    };
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
  async _processJsonUpload(client, file, userId, apiId, apiHash, autoLogin) {
    const content = await fs.readFile(file.path, 'utf8');
    let sessionStrings = [];

    try {
      const parsed = JSON.parse(content);

      if (Array.isArray(parsed)) {
        // Array of session strings or objects
        for (const item of parsed) {
          if (typeof item === 'string') {
            sessionStrings.push(item.trim());
          } else if (item && typeof item === 'object') {
            if (item.session_string || item.sessionString || item.session) {
              sessionStrings.push(
                (item.session_string || item.sessionString || item.session).trim()
              );
            } else if (item.phone && item.data) {
              sessionStrings.push(item.data.trim());
            }
          }
        }
      } else if (typeof parsed === 'string') {
        sessionStrings.push(parsed.trim());
      } else if (parsed && typeof parsed === 'object') {
        if (parsed.sessions && Array.isArray(parsed.sessions)) {
          for (const s of parsed.sessions) {
            if (typeof s === 'string') {
              sessionStrings.push(s.trim());
            } else if (s && typeof s === 'object' && s.session_string) {
              sessionStrings.push(s.session_string.trim());
            }
          }
        } else if (parsed.session_string || parsed.sessionString || parsed.session) {
          sessionStrings.push(
            (parsed.session_string || parsed.sessionString || parsed.session).trim()
          );
        } else if (parsed.data) {
          sessionStrings.push(parsed.data.trim());
        }
      }
    } catch (parseError) {
      // If JSON parsing fails, treat the entire content as a raw session string
      const trimmed = content.trim();
      if (trimmed.length > 10) {
        sessionStrings.push(trimmed);
      } else {
        throw new AppError(
          `Invalid JSON file: ${file.originalname}. Could not extract session strings.`,
          400,
          'INVALID_JSON_SESSION'
        );
      }
    }

    // Remove empty strings and duplicates
    sessionStrings = [...new Set(sessionStrings.filter((s) => s && s.length > 10))];

    if (sessionStrings.length === 0) {
      throw new AppError(
        `No valid session strings found in JSON file: ${file.originalname}`,
        400,
        'NO_SESSION_STRINGS'
      );
    }

    const insertedIds = [];
    const sessionDir = this._getUserSessionDir(userId);
    await fs.ensureDir(sessionDir);

    for (const sessionStr of sessionStrings) {
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

      const result = await client.query(
        `INSERT INTO sessions (
          user_id, phone, session_file_path, api_id, api_hash,
          status, is_2fa_enabled, is_logged_in, account_info, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        RETURNING id`,
        [
          userId,
          null, // phone - unknown until login
          relativePath,
          apiId || null,
          apiHash || null,
          status,
          false,
          autoLogin,
          JSON.stringify({
            uploadedFrom: file.originalname,
            sessionType: 'string',
            uploadedAt: new Date().toISOString(),
          }),
        ]
      );

      const dbId = result.rows[0].id;
      insertedIds.push(dbId);

      logger.info(`Session string stored for user ${userId}`, {
        sessionId: dbId,
        file: file.originalname,
        status,
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
  async _processBinaryUpload(client, file, userId, ext, apiId, apiHash) {
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
        status, is_2fa_enabled, is_logged_in, account_info, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING id`,
      [
        userId,
        null,
        storagePath,
        apiId || null,
        apiHash || null,
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

    const result = await pool.query(
      `SELECT id, user_id, phone, session_file_path, api_id, api_hash,
              status, is_2fa_enabled, is_logged_in, account_info,
              created_at, last_active
       FROM sessions
       WHERE id = $1 AND user_id = $2`,
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
  async listSessions(userId, { page = 1, limit = 20, sort = 'created_at', order = 'DESC', filter } = {}) {
    logger.info(`Listing sessions for user ${userId}`, { page, limit, sort, order, filter });

    const { applyPagination, applySorting } = require('../utils/pagination');

    const validSortFields = ['created_at', 'last_active', 'status', 'phone', 'id'];
    const { field: sortField, order: sortOrder } = applySorting(sort, order, validSortFields);
    const { offset, limit: pageSize } = applyPagination(null, page, limit);

    const queryConditions = ['user_id = $1'];
    const queryParams = [userId];
    let paramIndex = 2;

    if (filter && filter !== 'all') {
      if (VALID_STATUSES.includes(filter)) {
        queryConditions.push(`status = $${paramIndex}`);
        queryParams.push(filter);
        paramIndex++;
      } else if (filter === 'active') {
        queryConditions.push("status IN ('active', 'uploaded') AND is_logged_in = true");
      } else if (filter === 'inactive') {
        queryConditions.push("status IN ('inactive', 'error', 'revoked', 'expired') OR is_logged_in = false");
      }
    }

    const whereClause = queryConditions.join(' AND ');

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM sessions WHERE ${whereClause}`,
      queryParams
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated results
    const sessionsResult = await pool.query(
      `SELECT id, user_id, phone, session_file_path, api_id, api_hash,
              status, is_2fa_enabled, is_logged_in, account_info,
              created_at, last_active
       FROM sessions
       WHERE ${whereClause}
       ORDER BY ${sortField} ${sortOrder}
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
      };
    });

    const { buildPagination } = require('../utils/pagination');
    const pagination = buildPagination(page, limit, total);

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

      // Fetch the session
      const sessionResult = await client.query(
        `SELECT id, user_id, session_file_path, status, is_logged_in
         FROM sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [sessionId, userId]
      );

      if (sessionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new AppError(`Session not found or access denied: ${sessionId}`, 404, 'SESSION_NOT_FOUND');
      }

      const session = sessionResult.rows[0];

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

      // Delete from database
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
    try {
      await client.query('BEGIN');

      const sessionResult = await client.query(
        `SELECT id, user_id, session_file_path, api_id, api_hash, status,
                is_logged_in, account_info
         FROM sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
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

      const accountInfo = this._parseJsonField(session.account_info);

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
      await client.query('BEGIN');
      // Re-acquire our row lock for the rest of the login flow.
      await client.query(
        `SELECT id FROM sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [sessionId, userId]
      );

      // Add timeout to prevent indefinite hanging
      const loginPromise = tgService.createSession(
        tgSessionId,
        fileData.session,
        session.api_id || undefined,
        session.api_hash || undefined,
        { proxy: assignedProxy }
      );
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Login timeout exceeded (30s)')), LOGIN_TIMEOUT_MS)
      );

      await Promise.race([loginPromise, timeoutPromise]);

      // Get account info - this MUST succeed for login to be valid
      let me;
      try {
        me = await tgService.getMe(tgSessionId);
      } catch (meError) {
        // If getMe fails, the session is NOT valid - disconnect and throw error
        await tgService.disconnectSession(tgSessionId).catch(() => {});
        await client.query('ROLLBACK');
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
          phone = $1,
          account_info = $2,
          last_active = NOW()
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
      await client.query('ROLLBACK');

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
         FROM sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
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
    const totalResult = await pool.query(
      'SELECT COUNT(*) as total FROM sessions WHERE user_id = $1',
      [userId]
    );
    const total = parseInt(totalResult.rows[0].total, 10);

    // Status breakdown
    const statusResult = await pool.query(
      `SELECT status, COUNT(*) as count
       FROM sessions
       WHERE user_id = $1
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
       WHERE user_id = $1`,
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
      const result = await pool.query(
        `SELECT id FROM sessions
         WHERE is_logged_in = TRUE AND COALESCE(keep_alive, TRUE) = TRUE
         ORDER BY id ASC`
      );
      total = result.rows.length;
      for (const row of result.rows) {
        const sessionId = row.id;
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
            continue;
          }
          // Use the lower-level loader and then reset proxy via _ensureConnected.
          await tgService._loadSessionFromDB(sessionId);
          // If a proxy is configured, replace the client with one bound to that proxy.
          if (proxyConf) {
            const sFile = await this._readSessionFile(sessionId);
            if (sFile) {
              await tgService.disconnectSession(String(sessionId)).catch(() => {});
              await tgService.createSession(
                String(sessionId),
                sFile.encryptedSession,
                sFile.apiId,
                sFile.apiHash,
                { proxy: proxyConf }
              );
            }
          }
          await pool.query(`UPDATE sessions SET last_heartbeat = NOW() WHERE id = $1`, [sessionId]);
          restored++;
        } catch (err) {
          failed++;
          logger.warn(`Failed to restore session ${sessionId}: ${err.message}`);
          // Per Upgrade 1: do NOT flip is_logged_in to false on failure;
          // the heartbeat loop will retry on the next tick.
        }
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
    try {
      const result = await pool.query(
        `SELECT id FROM sessions WHERE is_logged_in = TRUE AND COALESCE(keep_alive, TRUE) = TRUE`
      );
      for (const row of result.rows) {
        const sid = String(row.id);
        try {
          const wasActive = tgService.isSessionActive(sid);
          await tgService._ensureConnected(sid);
          if (!wasActive) revived++;
          // Lightweight ping that exercises the connection.
          try {
            await tgService.getMe(sid);
          } catch (pingErr) {
            logger.debug(`heartbeat getMe failed for ${sid}: ${pingErr.message}`);
          }
          await pool.query(`UPDATE sessions SET last_heartbeat = NOW() WHERE id = $1`, [row.id]);
          pinged++;
        } catch (err) {
          failed++;
          logger.debug(`heartbeat failed for session ${sid}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`heartbeatLoggedInSessions sweep failed: ${err.message}`);
    }
    if (pinged || revived || failed) {
      logger.debug(`Heartbeat: pinged=${pinged} revived=${revived} failed=${failed}`);
    }
    return { pinged, revived, failed };
  }
}

module.exports = new SessionService();
