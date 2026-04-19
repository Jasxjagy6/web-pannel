/**
 * ListService - Manages contact lists for import, export, merge,
 * deduplication, and manual editing.
 *
 * Supports CSV, JSON, and TXT file imports with flexible header detection,
 * batch database operations using transactions, deduplication by telegram_id,
 * and multiple export formats.
 */

const fs = require('fs-extra');
const path = require('path');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const { applyPagination, applySorting, buildPagination } = require('../utils/pagination');

/**
 * Maximum number of items allowed per list.
 */
const MAX_ITEMS_PER_LIST = 10000;

/**
 * Valid list types.
 */
const VALID_LIST_TYPES = ['users', 'groups', 'channels', 'scraped', 'manual', 'imported', 'merged'];

/**
 * Valid export formats.
 */
const VALID_EXPORT_FORMATS = ['csv', 'json', 'txt'];

/**
 * Valid CSV header mappings: maps common header variants to canonical field names.
 */
const HEADER_MAPPINGS = {
  // Telegram ID variants
  user_id: 'telegram_id',
  id: 'telegram_id',
  telegram_id: 'telegram_id',
  tg_id: 'telegram_id',
  uid: 'telegram_id',

  // Username variants
  username: 'username',
  user_name: 'username',
  uname: 'username',
  handle: 'username',
  '@username': 'username',

  // First name variants
  first_name: 'first_name',
  firstname: 'first_name',
  fname: 'first_name',
  name: 'first_name',

  // Last name variants
  last_name: 'last_name',
  lastname: 'last_name',
  lname: 'last_name',
  surname: 'last_name',

  // Phone variants
  phone: 'phone',
  phone_number: 'phone',
  mobile: 'phone',
  tel: 'phone',
};

/**
 * CSV content-type for exports.
 */
const CSV_MIME_TYPE = 'text/csv';

/**
 * JSON content-type for exports.
 */
const JSON_MIME_TYPE = 'application/json';

/**
 * Plain text content-type for exports.
 */
const TXT_MIME_TYPE = 'text/plain';

// =========================================================================
// Parsing Helpers
// =========================================================================

/**
 * Parse the header row of a CSV file and map each column to a canonical field name.
 *
 * @param {string[]} headers - Raw header strings from the first CSV row
 * @returns {Map<number, string>} Map of column index to canonical field name
 * @private
 */
function parseCsvHeaders(headers) {
  const mapping = new Map();

  headers.forEach((rawHeader, index) => {
    const normalized = rawHeader.trim().toLowerCase().replace(/["'\s]/g, '');
    const canonical = HEADER_MAPPINGS[normalized];

    if (canonical) {
      mapping.set(index, canonical);
    }
  });

  return mapping;
}

/**
 * Parse a CSV file string into an array of user objects.
 *
 * @param {string} content - The raw CSV content
 * @returns {Array<{ telegram_id?: string, username?: string|null, first_name?: string|null, last_name?: string|null, phone?: string|null }>}
 * @private
 */
function parseCsvContent(content) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    return [];
  }

  // Parse the header row
  const headerLine = lines[0];
  const rawHeaders = splitCsvLine(headerLine);
  const headerMap = parseCsvHeaders(rawHeaders);

  if (headerMap.size === 0) {
    throw new AppError(
      'Could not recognize any valid headers in CSV file. Supported headers: user_id/id/telegram_id, username, first_name/name, last_name, phone',
      400,
      'INVALID_CSV_HEADERS'
    );
  }

  // Check that telegram_id or equivalent was found
  const hasIdColumn = [...headerMap.values()].includes('telegram_id');
  if (!hasIdColumn) {
    throw new AppError(
      'CSV file must contain a column for user ID (user_id, id, or telegram_id)',
      400,
      'MISSING_ID_COLUMN'
    );
  }

  const entries = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    const entry = {};

    headerMap.forEach((fieldName, colIndex) => {
      const value = values[colIndex] ? values[colIndex].trim() : null;
      if (value && value.length > 0) {
        entry[fieldName] = value;
      }
    });

    if (entry.telegram_id) {
      // Normalize: strip @ from username, clean phone
      if (entry.username) {
        entry.username = entry.username.replace(/^@/, '');
      }
      if (entry.phone) {
        entry.phone = entry.phone.replace(/[^\d+]/g, '');
      }
      entries.push({
        telegram_id: entry.telegram_id,
        username: entry.username || null,
        first_name: entry.first_name || null,
        last_name: entry.last_name || null,
        phone: entry.phone || null,
      });
    }
  }

  return entries;
}

/**
 * Split a single CSV line into fields, handling quoted values and escaped quotes.
 *
 * @param {string} line - A single CSV line
 * @returns {string[]} Array of field values
 * @private
 */
function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        // Check for escaped quote ("")
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }

  fields.push(current);
  return fields;
}

/**
 * Parse a JSON file string into an array of user objects.
 *
 * Accepts an array of objects, or a single object, or an object with a
 * "users" / "contacts" / "data" array property.
 *
 * @param {string} content - The raw JSON content
 * @returns {Array<{ telegram_id?: string, username?: string|null, first_name?: string|null, last_name?: string|null, phone?: string|null }>}
 * @private
 */
function parseJsonContent(content) {
  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch (parseError) {
    throw new AppError(
      `Invalid JSON file: ${parseError.message}`,
      400,
      'INVALID_JSON_FORMAT'
    );
  }

  // Normalize to array
  let items;

  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === 'object') {
    // Try common wrapper keys
    const wrapperKeys = ['users', 'contacts', 'data', 'items', 'members', 'entries'];
    items = null;

    for (const key of wrapperKeys) {
      if (Array.isArray(parsed[key])) {
        items = parsed[key];
        break;
      }
    }

    if (!items) {
      // Treat the single object as a one-element array
      items = [parsed];
    }
  } else {
    throw new AppError(
      'JSON file must contain an array or an object with a users/contacts/data array',
      400,
      'INVALID_JSON_STRUCTURE'
    );
  }

  const entries = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    // Map various field names to canonical names
    const telegramId = String(
      item.telegram_id || item.user_id || item.id || item.tg_id || item.uid || ''
    ).trim();

    if (!telegramId) continue;

    const username = item.username || item.user_name || item.uname || item.handle || null;
    const firstName = item.first_name || item.firstname || item.fname || item.name || null;
    const lastName = item.last_name || item.lastname || item.lname || item.surname || null;
    const phone = item.phone || item.phone_number || item.mobile || item.tel || null;

    entries.push({
      telegram_id: telegramId,
      username: username ? String(username).replace(/^@/, '').trim() : null,
      first_name: firstName ? String(firstName).trim() : null,
      last_name: lastName ? String(lastName).trim() : null,
      phone: phone ? String(phone).replace(/[^\d+]/g, '').trim() : null,
    });
  }

  return entries;
}

/**
 * Parse a TXT file string into an array of user objects.
 *
 * Each line can be:
 *   - @username (starts with @)
 *   - A numeric ID (all digits, possibly with leading +)
 *   - A phone number (starts with +)
 *
 * @param {string} content - The raw TXT content
 * @returns {Array<{ telegram_id?: string, username?: string|null, first_name?: null, last_name?: null, phone?: string|null }>}
 * @private
 */
function parseTxtContent(content) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const entries = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (trimmed.startsWith('@')) {
      // Username entry
      const username = trimmed.substring(1).trim();
      if (username.length > 0) {
        entries.push({
          telegram_id: null, // No numeric ID available
          username,
          first_name: null,
          last_name: null,
          phone: null,
        });
      }
    } else if (/^\+\d+$/.test(trimmed)) {
      // Phone number entry
      entries.push({
        telegram_id: null,
        username: null,
        first_name: null,
        last_name: null,
        phone: trimmed,
      });
    } else if (/^\d+$/.test(trimmed)) {
      // Numeric ID entry
      entries.push({
        telegram_id: trimmed,
        username: null,
        first_name: null,
        last_name: null,
        phone: null,
      });
    }
    // Lines that don't match any pattern are silently skipped
  }

  return entries;
}

/**
 * Escape a value for safe CSV output.
 *
 * @param {*} value - The value to escape
 * @returns {string} CSV-safe string
 * @private
 */
function csvEscape(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Validate that a list belongs to the specified user.
 *
 * @param {number|string} listId - List database ID
 * @param {number|string} userId - Owner user ID
 * @returns {Promise<object>} List row from the database
 * @throws {AppError} If list not found or not owned by user
 * @private
 */
async function validateListOwnership(listId, userId) {
  const result = await pool.query(
    'SELECT id, user_id, name, type, items_count, source, created_at FROM lists WHERE id = $1 AND user_id = $2',
    [listId, userId]
  );

  if (result.rows.length === 0) {
    throw new AppError(
      `List not found or access denied: ${listId}`,
      404,
      'LIST_NOT_FOUND'
    );
  }

  return result.rows[0];
}

/**
 * Validate that all given list IDs belong to the specified user.
 *
 * @param {Array<number|string>} listIds - Array of list IDs
 * @param {number|string} userId - Owner user ID
 * @returns {Promise<Array<object>>} Array of list rows
 * @throws {AppError} If any list is not found or not owned by user
 * @private
 */
async function validateMultipleListOwnership(listIds, userId) {
  if (!listIds || listIds.length === 0) {
    throw new AppError('At least one list ID is required', 400, 'NO_LIST_IDS');
  }

  const result = await pool.query(
    'SELECT id, user_id, name, type, items_count, source, created_at FROM lists WHERE id = ANY($1::int[]) AND user_id = $2',
    [listIds.map((id) => parseInt(id, 10)), userId]
  );

  if (result.rows.length !== listIds.length) {
    const foundIds = new Set(result.rows.map((r) => r.id));
    const missing = listIds.filter((id) => !foundIds.has(parseInt(id, 10)));
    throw new AppError(
      `List(s) not found or access denied: ${missing.join(', ')}`,
      404,
      'LIST_NOT_FOUND'
    );
  }

  return result.rows;
}

/**
 * Insert list items into the database in batches using a transaction.
 * Deduplicates by telegram_id within the target list.
 *
 * @param {object} client - Database client with active transaction
 * @param {number} listId - Target list ID
 * @param {Array<object>} items - Array of item objects to insert
 * @returns {Promise<number>} Number of items inserted
 * @private
 */
async function insertListItemsBatch(client, listId, items) {
  if (items.length === 0) return 0;

  const BATCH_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    const placeholders = [];
    const values = [];
    let paramIndex = 1;

    for (const item of batch) {
      placeholders.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, NOW())`
      );

      const telegramId = item.telegram_id ? parseInt(item.telegram_id, 10) : null;
      values.push(
        listId,
        telegramId,
        item.username || null,
        item.first_name || null,
        item.last_name || null,
        item.phone || null
      );
      paramIndex += 6;
    }

    const insertQuery = `
      INSERT INTO list_items (list_id, telegram_id, username, first_name, last_name, phone, added_at)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT DO NOTHING
    `;

    const insertResult = await client.query(insertQuery, values);
    inserted += insertResult.rowCount;
  }

  return inserted;
}

// =========================================================================
// ListService Class
// =========================================================================

class ListService {
  // =========================================================================
  // Import Operations
  // =========================================================================

  /**
   * Import a contact list from an uploaded file (CSV, JSON, or TXT).
   *
   * Parses the file, validates entries, and inserts them into a new list
   * within a database transaction. Duplicates are removed by telegram_id.
   *
   * @param {number|string} userId - The user who owns the new list
   * @param {object} file - Multer file object with path, originalname, mimetype
   * @param {string} listName - Name for the new list
   * @param {string} type - List type: 'users', 'groups', 'channels'
   * @returns {Promise<{
   *   listId: number,
   *   listName: string,
   *   totalImported: number,
   *   totalDuplicate: number,
   *   totalParsed: number
   * }>}
   */
  async importList(userId, file, listName, type = 'users') {
    if (!listName || listName.trim().length === 0) {
      throw new AppError('List name is required', 400, 'MISSING_LIST_NAME');
    }

    if (!file || !file.path) {
      throw new AppError('File is required for import', 400, 'MISSING_FILE');
    }

    const validTypes = ['users', 'groups', 'channels'];
    const listType = validTypes.includes(type) ? type : 'users';

    logger.info(`Importing list "${listName}" for user ${userId} from ${file.originalname}`, {
      userId,
      fileName: file.originalname,
      type: listType,
    });

    // Read file content
    let content;
    try {
      content = await fs.readFile(file.path, 'utf8');
    } catch (readError) {
      throw new AppError(
        `Failed to read uploaded file: ${readError.message}`,
        500,
        'FILE_READ_ERROR'
      );
    }

    // Parse based on file extension or MIME type
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeType = (file.mimetype || '').toLowerCase();
    let entries = [];

    try {
      if (ext === '.csv' || mimeType === 'text/csv') {
        entries = parseCsvContent(content);
      } else if (ext === '.json' || mimeType === 'application/json') {
        entries = parseJsonContent(content);
      } else if (ext === '.txt' || mimeType === 'text/plain') {
        entries = parseTxtContent(content);
      } else {
        // Attempt to auto-detect format
        const trimmed = content.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          entries = parseJsonContent(content);
        } else if (trimmed.includes(',')) {
          entries = parseCsvContent(content);
        } else {
          entries = parseTxtContent(content);
        }
      }
    } catch (parseError) {
      // If this is an AppError, re-throw it
      if (parseError instanceof AppError) throw parseError;
      throw new AppError(
        `Failed to parse file: ${parseError.message}`,
        400,
        'PARSE_ERROR'
      );
    }

    if (entries.length === 0) {
      // Clean up the temp file
      await fs.unlink(file.path).catch(() => {});
      throw new AppError(
        'No valid entries found in the uploaded file',
        400,
        'NO_VALID_ENTRIES'
      );
    }

    // Limit to MAX_ITEMS_PER_LIST
    const totalParsed = entries.length;
    if (entries.length > MAX_ITEMS_PER_LIST) {
      logger.warn(`Truncating import from ${entries.length} to ${MAX_ITEMS_PER_LIST} items`, {
        userId,
        listName,
      });
      entries = entries.slice(0, MAX_ITEMS_PER_LIST);
    }

    // Deduplicate by telegram_id (only for entries that have telegram_id)
    const seenIds = new Set();
    const deduplicatedEntries = [];
    let duplicateCount = 0;

    for (const entry of entries) {
      if (entry.telegram_id) {
        if (seenIds.has(entry.telegram_id)) {
          duplicateCount++;
          continue;
        }
        seenIds.add(entry.telegram_id);
      }
      deduplicatedEntries.push(entry);
    }

    // Insert into database using a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create the list
      const listResult = await client.query(
        `INSERT INTO lists (user_id, name, type, items_count, source, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id`,
        [userId, listName.trim(), listType, deduplicatedEntries.length, `import_${ext.replace('.', '')}`]
      );

      const listId = listResult.rows[0].id;

      // Insert items
      const insertedCount = await insertListItemsBatch(client, listId, deduplicatedEntries);

      // Update item count to reflect actual inserted rows
      await client.query(
        'UPDATE lists SET items_count = $1 WHERE id = $2',
        [insertedCount, listId]
      );

      await client.query('COMMIT');

      logger.info(`List "${listName}" imported with ${insertedCount} items for user ${userId}`, {
        listId,
        userId,
      });

      return {
        listId,
        listName: listName.trim(),
        totalImported: insertedCount,
        totalDuplicate: duplicateCount,
        totalParsed,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to import list "${listName}" for user ${userId}`, {
        error: error.message,
      });
      throw new AppError(
        `Failed to import list: ${error.message}`,
        500,
        'IMPORT_FAILED'
      );
    } finally {
      client.release();
      // Clean up the uploaded file
      await fs.unlink(file.path).catch(() => {});
    }
  }

  /**
   * Create a new list from the results of a completed scraping job.
   *
   * Copies scraped_users entries from a scrape job to a new list.
   *
   * @param {number|string} userId - The user who owns the new list
   * @param {number|string} scrapeJobId - The scraping job ID to copy from
   * @param {string} listName - Name for the new list
   * @returns {Promise<{
   *   listId: number,
   *   listName: string,
   *   totalItems: number,
   *   source: string
   * }>}
   */
  async createListFromScrape(userId, scrapeJobId, listName) {
    if (!listName || listName.trim().length === 0) {
      throw new AppError('List name is required', 400, 'MISSING_LIST_NAME');
    }

    if (!scrapeJobId) {
      throw new AppError('Scrape job ID is required', 400, 'MISSING_SCRAPE_JOB_ID');
    }

    logger.info(`Creating list from scrape job ${scrapeJobId} for user ${userId}`, {
      userId,
      scrapeJobId,
      listName,
    });

    // Verify that the scrape job belongs to the user
    // For multi-session jobs, check via the primary session_id
    const jobCheck = await pool.query(
      `SELECT sj.id, sj.target_title, sj.target_id, sj.status, sj.session_id, s.user_id
       FROM scraping_jobs sj
       LEFT JOIN sessions s ON sj.session_id = s.id
       WHERE sj.id = $1 AND (s.user_id = $2 OR sj.session_id IS NULL)`,
      [scrapeJobId, userId]
    );

    if (jobCheck.rows.length === 0) {
      throw new AppError(
        `Scraping job not found or access denied: ${scrapeJobId}`,
        404,
        'SCRAPE_JOB_NOT_FOUND'
      );
    }

    // If session_id exists, verify ownership through it
    const job = jobCheck.rows[0];
    if (job.session_id && job.user_id !== userId) {
      throw new AppError(
        `Scraping job not found or access denied: ${scrapeJobId}`,
        404,
        'SCRAPE_JOB_NOT_FOUND'
      );
    }

    // Count scraped users
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM scraped_users WHERE job_id = $1',
      [scrapeJobId]
    );
    const itemCount = parseInt(countResult.rows[0].total, 10);

    if (itemCount === 0) {
      throw new AppError(
        'No scraped users found for this job',
        400,
        'NO_SCRAPE_DATA'
      );
    }

    if (itemCount > MAX_ITEMS_PER_LIST) {
      throw new AppError(
        `Too many items (${itemCount}). Maximum allowed per list is ${MAX_ITEMS_PER_LIST}`,
        400,
        'LIST_TOO_LARGE'
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create the list
      const listResult = await client.query(
        `INSERT INTO lists (user_id, name, type, items_count, source, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id`,
        [userId, listName.trim(), 'scraped', itemCount, `job_${scrapeJobId}`]
      );

      const listId = listResult.rows[0].id;

      // Copy users from scraped_users to list_items
      await client.query(
        `INSERT INTO list_items (list_id, telegram_id, username, first_name, last_name, phone, added_at)
         SELECT $1, telegram_id, username, first_name, last_name, phone, NOW()
         FROM scraped_users
         WHERE job_id = $2`,
        [listId, scrapeJobId]
      );

      await client.query('COMMIT');

      logger.info(`Created list "${listName}" with ${itemCount} users from job ${scrapeJobId}`, {
        listId,
        userId,
      });

      return {
        listId,
        listName: listName.trim(),
        totalItems: itemCount,
        source: `job_${scrapeJobId}`,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to create list from job ${scrapeJobId}`, {
        error: error.message,
      });
      throw new AppError(
        `Failed to create list from scrape job: ${error.message}`,
        500,
        'CREATE_LIST_FROM_SCRAPE_FAILED'
      );
    } finally {
      client.release();
    }
  }

  // =========================================================================
  // Merge Operations
  // =========================================================================

  /**
   * Merge multiple lists into a single new list, deduplicating by telegram_id.
   *
   * All source lists must belong to the requesting user. Items from earlier
   * lists in the array take priority when duplicates are found.
   *
   * @param {number|string} userId - The user who owns the source lists
   * @param {Array<number|string>} listIds - IDs of the lists to merge
   * @param {string} newListName - Name for the merged list
   * @returns {Promise<{
   *   listId: number,
   *   listName: string,
   *   totalItems: number,
   *   totalDuplicates: number,
   *   sourceListCount: number
   * }>}
   */
  async mergeLists(userId, listIds, newListName) {
    if (!newListName || newListName.trim().length === 0) {
      throw new AppError('New list name is required', 400, 'MISSING_LIST_NAME');
    }

    if (!listIds || listIds.length < 2) {
      throw new AppError('At least two list IDs are required for merging', 400, 'INSUFFICIENT_LISTS');
    }

    logger.info(`Merging ${listIds.length} lists for user ${userId}`, {
      userId,
      listIds,
      newListName,
    });

    // Validate ownership of all source lists
    const sourceLists = await validateMultipleListOwnership(listIds, userId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Fetch all items from all source lists, ordered by list position
      // (items from earlier lists in the array take priority)
      const allItems = [];

      for (let i = 0; i < sourceLists.length; i++) {
        const listId = sourceLists[i].id;
        const itemsResult = await client.query(
          `SELECT telegram_id, username, first_name, last_name, phone
           FROM list_items
           WHERE list_id = $1
           ORDER BY id ASC`,
          [listId]
        );

        for (const row of itemsResult.rows) {
          allItems.push({
            telegram_id: row.telegram_id ? String(row.telegram_id) : null,
            username: row.username || null,
            first_name: row.first_name || null,
            last_name: row.last_name || null,
            phone: row.phone || null,
          });
        }
      }

      // Deduplicate by telegram_id (entries with telegram_id)
      const seenIds = new Set();
      const uniqueItems = [];
      let duplicateCount = 0;

      for (const item of allItems) {
        if (item.telegram_id) {
          if (seenIds.has(item.telegram_id)) {
            duplicateCount++;
            continue;
          }
          seenIds.add(item.telegram_id);
        }
        uniqueItems.push(item);
      }

      // Cap at maximum
      const finalItems = uniqueItems.slice(0, MAX_ITEMS_PER_LIST);
      const truncated = uniqueItems.length - finalItems.length;
      if (truncated > 0) {
        duplicateCount += truncated;
      }

      // Create the merged list
      const listResult = await client.query(
        `INSERT INTO lists (user_id, name, type, items_count, source, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id`,
        [
          userId,
          newListName.trim(),
          'merged',
          finalItems.length,
          `merge_${sourceLists.map((l) => l.id).join('_')}`,
        ]
      );

      const newListId = listResult.rows[0].id;

      // Insert the merged, deduplicated items
      await insertListItemsBatch(client, newListId, finalItems);

      await client.query('COMMIT');

      logger.info(`Merged ${sourceLists.length} lists into "${newListName}" with ${finalItems.length} items`, {
        newListId,
        userId,
      });

      return {
        listId: newListId,
        listName: newListName.trim(),
        totalItems: finalItems.length,
        totalDuplicates: duplicateCount,
        sourceListCount: sourceLists.length,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to merge lists for user ${userId}`, {
        error: error.message,
      });
      throw new AppError(
        `Failed to merge lists: ${error.message}`,
        500,
        'MERGE_FAILED'
      );
    } finally {
      client.release();
    }
  }

  // =========================================================================
  // Deduplicate Operations
  // =========================================================================

  /**
   * Remove duplicate entries from a list based on telegram_id.
   *
   * Keeps the oldest entry (lowest id) when duplicates are found.
   *
   * @param {number|string} userId - The user who owns the list
   * @param {number|string} listId - The list to deduplicate
   * @returns {Promise<{
   *   listId: number,
   *   totalBefore: number,
   *   totalAfter: number,
   *   duplicatesRemoved: number
   * }>}
   */
  async deduplicateList(userId, listId) {
    logger.info(`Deduplicating list ${listId} for user ${userId}`, { userId, listId });

    // Validate ownership
    const list = await validateListOwnership(listId, userId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Count before
      const beforeResult = await client.query(
        'SELECT COUNT(*) as total FROM list_items WHERE list_id = $1',
        [listId]
      );
      const totalBefore = parseInt(beforeResult.rows[0].total, 10);

      if (totalBefore === 0) {
        await client.query('COMMIT');
        return {
          listId: Number(listId),
          totalBefore: 0,
          totalAfter: 0,
          duplicatesRemoved: 0,
        };
      }

      // Delete duplicates: keep the row with the lowest id for each telegram_id
      // Only consider entries that have a telegram_id
      const deleteResult = await client.query(
        `DELETE FROM list_items
         WHERE list_id = $1
           AND telegram_id IS NOT NULL
           AND id NOT IN (
             SELECT MIN(id)
             FROM list_items
             WHERE list_id = $1 AND telegram_id IS NOT NULL
             GROUP BY telegram_id
           )`,
        [listId]
      );

      const duplicatesRemoved = deleteResult.rowCount;

      // Count after
      const afterResult = await client.query(
        'SELECT COUNT(*) as total FROM list_items WHERE list_id = $1',
        [listId]
      );
      const totalAfter = parseInt(afterResult.rows[0].total, 10);

      // Update the list's item count
      await client.query(
        'UPDATE lists SET items_count = $1 WHERE id = $2',
        [totalAfter, listId]
      );

      await client.query('COMMIT');

      logger.info(`Deduplicated list ${listId}: removed ${duplicatesRemoved} duplicates`, {
        listId,
        userId,
        totalBefore,
        totalAfter,
      });

      return {
        listId: Number(listId),
        totalBefore,
        totalAfter,
        duplicatesRemoved,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to deduplicate list ${listId}`, {
        error: error.message,
      });
      throw new AppError(
        `Failed to deduplicate list: ${error.message}`,
        500,
        'DEDUPLICATE_FAILED'
      );
    } finally {
      client.release();
    }
  }

  // =========================================================================
  // Export Operations
  // =========================================================================

  /**
   * Export a list in the specified format.
   *
   * @param {number|string} userId - The user who owns the list
   * @param {number|string} listId - The list to export
   * @param {string} format - Export format: 'csv', 'json', or 'txt'
   * @returns {Promise<{
   *   content: string,
   *   filename: string,
   *   mimeType: string,
   *   totalItems: number
   * }>}
   */
  async exportList(userId, listId, format = 'csv') {
    const exportFormat = (format || 'csv').toLowerCase();

    if (!VALID_EXPORT_FORMATS.includes(exportFormat)) {
      throw new AppError(
        `Invalid export format: ${format}. Supported: ${VALID_EXPORT_FORMATS.join(', ')}`,
        400,
        'INVALID_EXPORT_FORMAT'
      );
    }

    logger.info(`Exporting list ${listId} as ${exportFormat} for user ${userId}`, {
      userId,
      listId,
      format: exportFormat,
    });

    // Validate ownership
    const list = await validateListOwnership(listId, userId);

    // Fetch all items
    const itemsResult = await pool.query(
      `SELECT telegram_id, username, first_name, last_name, phone
       FROM list_items
       WHERE list_id = $1
       ORDER BY id ASC`,
      [listId]
    );

    const items = itemsResult.rows;
    const listName = list.name || `list_${listId}`;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    let content;
    let filename;
    let mimeType;

    switch (exportFormat) {
      case 'csv': {
        const headers = ['user_id', 'username', 'first_name', 'last_name', 'phone'];
        const csvRows = [headers.join(',')];

        for (const item of items) {
          const row = [
            csvEscape(item.telegram_id),
            csvEscape(item.username),
            csvEscape(item.first_name),
            csvEscape(item.last_name),
            csvEscape(item.phone),
          ];
          csvRows.push(row.join(','));
        }

        content = csvRows.join('\r\n');
        filename = `${listName}_${timestamp}.csv`;
        mimeType = CSV_MIME_TYPE;
        break;
      }

      case 'json': {
        const jsonArray = items.map((item) => ({
          user_id: item.telegram_id ? String(item.telegram_id) : null,
          username: item.username || null,
          first_name: item.first_name || null,
          last_name: item.last_name || null,
          phone: item.phone || null,
        }));

        content = JSON.stringify(jsonArray, null, 2);
        filename = `${listName}_${timestamp}.json`;
        mimeType = JSON_MIME_TYPE;
        break;
      }

      case 'txt': {
        const lines = items.map((item) => {
          if (item.username) return `@${item.username}`;
          if (item.phone) return item.phone;
          if (item.telegram_id) return String(item.telegram_id);
          return '';
        }).filter((line) => line.length > 0);

        content = lines.join('\n');
        filename = `${listName}_${timestamp}.txt`;
        mimeType = TXT_MIME_TYPE;
        break;
      }
    }

    return {
      content,
      filename,
      mimeType,
      totalItems: items.length,
    };
  }

  // =========================================================================
  // Statistics
  // =========================================================================

  /**
   * Get statistics for a specific list.
   *
   * Includes total count, unique users (by telegram_id), username coverage,
   * phone coverage, and source breakdown.
   *
   * @param {number|string} userId - The user who owns the list
   * @param {number|string} listId - The list ID
   * @returns {Promise<{
   *   listId: number,
   *   listName: string,
   *   listType: string,
   *   totalItems: number,
   *   uniqueUsers: number,
   *   withUsername: number,
   *   withPhone: number,
   *   withFirstName: number,
   *   usernamePercentage: number,
   *   phonePercentage: number,
   *   source: string|null,
   *   createdAt: string
   * }>}
   */
  async getListStats(userId, listId) {
    logger.info(`Getting stats for list ${listId} for user ${userId}`, { userId, listId });

    // Validate ownership
    const list = await validateListOwnership(listId, userId);

    // Get stats
    const statsResult = await pool.query(
      `SELECT
         COUNT(*) as total_items,
         COUNT(*) FILTER (WHERE telegram_id IS NOT NULL) as unique_users,
         COUNT(*) FILTER (WHERE username IS NOT NULL AND username != '') as with_username,
         COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone != '') as with_phone,
         COUNT(*) FILTER (WHERE first_name IS NOT NULL AND first_name != '') as with_first_name
       FROM list_items
       WHERE list_id = $1`,
      [listId]
    );

    const row = statsResult.rows[0];
    const totalItems = parseInt(row.total_items, 10);
    const uniqueUsers = parseInt(row.unique_users, 10);
    const withUsername = parseInt(row.with_username, 10);
    const withPhone = parseInt(row.with_phone, 10);
    const withFirstName = parseInt(row.with_first_name, 10);

    return {
      listId: Number(listId),
      listName: list.name,
      listType: list.type,
      totalItems,
      uniqueUsers,
      withUsername,
      withPhone,
      withFirstName,
      usernamePercentage: totalItems > 0 ? Math.round((withUsername / totalItems) * 10000) / 100 : 0,
      phonePercentage: totalItems > 0 ? Math.round((withPhone / totalItems) * 10000) / 100 : 0,
      source: list.source,
      createdAt: list.created_at,
    };
  }

  // =========================================================================
  // List CRUD
  // =========================================================================

  /**
   * List all contact lists for a user with pagination and sorting.
   *
   * @param {number|string} userId - The requesting user ID
   * @param {object} params - Query parameters
   * @param {number} params.page - Page number (1-based, default: 1)
   * @param {number} params.limit - Items per page (default: 20, max: 100)
   * @param {string} params.sort - Sort field (default: 'created_at')
   * @param {string} params.order - Sort order: ASC or DESC (default: 'DESC')
   * @returns {Promise<{
   *   lists: Array<{ id: number, name: string, type: string, itemsCount: number, source: string|null, createdAt: string }>,
   *   pagination: object
   * }>}
   */
  async listLists(userId, { page = 1, limit = 20, sort = 'created_at', order = 'DESC' } = {}) {
    logger.info(`Listing lists for user ${userId}`, { page, limit, sort, order });

    const validSortFields = ['created_at', 'name', 'items_count', 'id', 'type'];
    const { field: sortField, order: sortOrder } = applySorting(sort, order, validSortFields);
    const { offset, limit: pageSize } = applyPagination(null, page, limit);

    // Get total count
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM lists WHERE user_id = $1',
      [userId]
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated results with actual item counts from list_items
    const listsResult = await pool.query(
      `SELECT l.id, l.name, l.type, l.items_count, l.source, l.created_at,
              COUNT(li.id) as actual_count
       FROM lists l
       LEFT JOIN list_items li ON l.id = li.list_id
       WHERE l.user_id = $1
       GROUP BY l.id
       ORDER BY l.${sortField} ${sortOrder}
       LIMIT $2 OFFSET $3`,
      [userId, pageSize, offset]
    );

    const lists = listsResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      itemsCount: parseInt(row.actual_count, 10),
      source: row.source,
      createdAt: row.created_at,
    }));

    const pagination = buildPagination(page, limit, total);

    return { lists, pagination };
  }

  /**
   * Get detailed information about a list including paginated items.
   *
   * @param {number|string} userId - The requesting user ID
   * @param {number|string} listId - The list ID
   * @param {object} params - Pagination parameters
   * @param {number} params.page - Page number (default: 1)
   * @param {number} params.limit - Items per page (default: 20)
   * @returns {Promise<{
   *   list: { id: number, name: string, type: string, itemsCount: number, source: string|null, createdAt: string },
   *   items: Array<object>,
   *   pagination: object
   * }>}
   */
  async getListDetails(userId, listId, { page = 1, limit = 20 } = {}) {
    logger.info(`Getting list details ${listId} for user ${userId}`, { userId, listId });

    // Validate ownership
    const list = await validateListOwnership(listId, userId);

    // Get paginated items
    const itemsResult = await this.getListItems(userId, listId, { page, limit });

    return {
      list: {
        id: list.id,
        name: list.name,
        type: list.type,
        itemsCount: list.items_count,
        source: list.source,
        createdAt: list.created_at,
      },
      items: itemsResult.items,
      pagination: itemsResult.pagination,
    };
  }

  /**
   * Get paginated list items with optional search.
   *
   * @param {number|string} userId - The requesting user ID
   * @param {number|string} listId - The list ID
   * @param {object} params - Query parameters
   * @param {number} params.page - Page number (default: 1)
   * @param {number} params.limit - Items per page (default: 20)
   * @param {string} params.search - Optional search term (matches username, first_name, last_name, phone)
   * @returns {Promise<{
   *   items: Array<{ id: number, telegramId: string|null, username: string|null, firstName: string|null, lastName: string|null, phone: string|null, addedAt: string }>,
   *   pagination: object
   * }>}
   */
  async getListItems(userId, listId, { page = 1, limit = 20, search } = {}) {
    logger.info(`Getting list items for list ${listId}`, { userId, listId, page, limit, search });

    // Validate ownership
    await validateListOwnership(listId, userId);

    const { offset, limit: pageSize } = applyPagination(null, page, limit);

    const conditions = ['list_id = $1'];
    const values = [listId];
    let paramIndex = 2;

    if (search && search.trim().length > 0) {
      const searchPattern = `%${search.trim().toLowerCase()}%`;
      conditions.push(
        `(LOWER(username) LIKE $${paramIndex} OR LOWER(first_name) LIKE $${paramIndex} OR LOWER(last_name) LIKE $${paramIndex} OR phone LIKE $${paramIndex})`
      );
      values.push(searchPattern);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM list_items WHERE ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated items
    const itemsResult = await pool.query(
      `SELECT id, telegram_id, username, first_name, last_name, phone, added_at
       FROM list_items
       WHERE ${whereClause}
       ORDER BY id ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, pageSize, offset]
    );

    const items = itemsResult.rows.map((row) => ({
      id: row.id,
      telegramId: row.telegram_id ? String(row.telegram_id) : null,
      username: row.username || null,
      firstName: row.first_name || null,
      lastName: row.last_name || null,
      phone: row.phone || null,
      addedAt: row.added_at,
    }));

    const pagination = buildPagination(page, limit, total);

    return { items, pagination };
  }

  /**
   * Update a list's name.
   *
   * @param {number|string} userId - The user who owns the list
   * @param {number|string} listId - The list ID
   * @param {string} newName - The new name for the list
   * @returns {Promise<{ success: boolean, listId: number, name: string }>}
   */
  async updateList(userId, listId, newName) {
    if (!newName || newName.trim().length === 0) {
      throw new AppError('New list name is required', 400, 'MISSING_LIST_NAME');
    }

    logger.info(`Updating list ${listId} name for user ${userId}`, { userId, listId });

    // Validate ownership
    await validateListOwnership(listId, userId);

    const result = await pool.query(
      'UPDATE lists SET name = $1 WHERE id = $2 RETURNING id, name',
      [newName.trim(), listId]
    );

    if (result.rows.length === 0) {
      throw new AppError(
        `List not found: ${listId}`,
        404,
        'LIST_NOT_FOUND'
      );
    }

    logger.info(`List ${listId} renamed to "${newName.trim()}" for user ${userId}`);

    return {
      success: true,
      listId: Number(listId),
      name: result.rows[0].name,
    };
  }

  /**
   * Delete a list and all of its items.
   *
   * Uses a transaction to ensure both the list record and its items
   * are deleted atomically.
   *
   * @param {number|string} userId - The user who owns the list
   * @param {number|string} listId - The list ID to delete
   * @returns {Promise<{ success: boolean, listId: number, deletedItems: number }>}
   */
  async deleteList(userId, listId) {
    logger.info(`Deleting list ${listId} for user ${userId}`, { userId, listId });

    // Validate ownership
    const list = await validateListOwnership(listId, userId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Count items before deletion
      const countResult = await client.query(
        'SELECT COUNT(*) as total FROM list_items WHERE list_id = $1',
        [listId]
      );
      const deletedItems = parseInt(countResult.rows[0].total, 10);

      // Delete items first (foreign key)
      await client.query('DELETE FROM list_items WHERE list_id = $1', [listId]);

      // Delete the list
      await client.query('DELETE FROM lists WHERE id = $1', [listId]);

      await client.query('COMMIT');

      logger.info(`Deleted list ${listId} ("${list.name}") with ${deletedItems} items for user ${userId}`, {
        listId,
        userId,
      });

      return {
        success: true,
        listId: Number(listId),
        deletedItems,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to delete list ${listId}`, { error: error.message });
      throw new AppError(
        `Failed to delete list: ${error.message}`,
        500,
        'DELETE_LIST_FAILED'
      );
    } finally {
      client.release();
    }
  }

  // =========================================================================
  // Item Management
  // =========================================================================

  /**
   * Manually add items to an existing list.
   *
   * Each item should have at least one of: telegram_id, username, or phone.
   * Duplicates by telegram_id are silently skipped.
   *
   * @param {number|string} userId - The user who owns the list
   * @param {number|string} listId - The target list ID
   * @param {Array<{ telegram_id?: string, username?: string, first_name?: string, last_name?: string, phone?: string }>} items - Items to add
   * @returns {Promise<{
   *   success: boolean,
   *   listId: number,
   *   totalSubmitted: number,
   *   totalAdded: number,
   *   totalDuplicates: number,
   *   totalInvalid: number
   * }>}
   */
  async addItemsToList(userId, listId, items) {
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new AppError('At least one item is required', 400, 'NO_ITEMS');
    }

    logger.info(`Adding ${items.length} items to list ${listId} for user ${userId}`, {
      userId,
      listId,
    });

    // Validate ownership
    const list = await validateListOwnership(listId, userId);

    // Validate and normalize items
    const validItems = [];
    let invalidCount = 0;

    for (const item of items) {
      if (!item || typeof item !== 'object') {
        invalidCount++;
        continue;
      }

      // Must have at least one identifier
      const telegramId = item.telegram_id ? String(item.telegram_id).trim() : null;
      const username = item.username ? String(item.username).replace(/^@/, '').trim() : null;
      const firstName = item.first_name ? String(item.first_name).trim() : null;
      const lastName = item.last_name ? String(item.last_name).trim() : null;
      const phone = item.phone ? String(item.phone).replace(/[^\d+]/g, '').trim() : null;

      if (!telegramId && !username && !phone) {
        invalidCount++;
        continue;
      }

      validItems.push({
        telegram_id: telegramId,
        username,
        first_name: firstName,
        last_name: lastName,
        phone,
      });
    }

    if (validItems.length === 0) {
      throw new AppError(
        'No valid items found. Each item must have at least one of: telegram_id, username, or phone',
        400,
        'NO_VALID_ITEMS'
      );
    }

    // Check current item count against limit
    const currentCountResult = await pool.query(
      'SELECT COUNT(*) as total FROM list_items WHERE list_id = $1',
      [listId]
    );
    const currentCount = parseInt(currentCountResult.rows[0].total, 10);

    if (currentCount + validItems.length > MAX_ITEMS_PER_LIST) {
      throw new AppError(
        `Adding these items would exceed the maximum of ${MAX_ITEMS_PER_LIST} items per list`,
        400,
        'LIST_CAPACITY_EXCEEDED'
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const insertedCount = await insertListItemsBatch(client, listId, validItems);

      // Update the item count
      const newCountResult = await client.query(
        'SELECT COUNT(*) as total FROM list_items WHERE list_id = $1',
        [listId]
      );
      const newCount = parseInt(newCountResult.rows[0].total, 10);

      await client.query(
        'UPDATE lists SET items_count = $1 WHERE id = $2',
        [newCount, listId]
      );

      await client.query('COMMIT');

      const duplicatesSkipped = validItems.length - insertedCount;

      logger.info(`Added ${insertedCount} items to list ${listId} for user ${userId}`, {
        listId,
        userId,
        added: insertedCount,
        duplicates: duplicatesSkipped,
        invalid: invalidCount,
      });

      return {
        success: true,
        listId: Number(listId),
        totalSubmitted: items.length,
        totalAdded: insertedCount,
        totalDuplicates: duplicatesSkipped,
        totalInvalid: invalidCount,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to add items to list ${listId}`, {
        error: error.message,
      });
      throw new AppError(
        `Failed to add items to list: ${error.message}`,
        500,
        'ADD_ITEMS_FAILED'
      );
    } finally {
      client.release();
    }
  }

  /**
   * Remove specific items from a list by their item IDs.
   *
   * @param {number|string} userId - The user who owns the list
   * @param {number|string} listId - The list ID
   * @param {Array<number|string>} itemIds - IDs of the items to remove
   * @returns {Promise<{
   *   success: boolean,
   *   listId: number,
   *   removedCount: number,
   *   remainingCount: number
   * }>}
   */
  async removeItems(userId, listId, itemIds) {
    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
      throw new AppError('At least one item ID is required', 400, 'NO_ITEM_IDS');
    }

    logger.info(`Removing ${itemIds.length} items from list ${listId} for user ${userId}`, {
      userId,
      listId,
    });

    // Validate ownership
    await validateListOwnership(listId, userId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Only delete items that belong to this list
      const numericIds = itemIds.map((id) => parseInt(id, 10));
      const deleteResult = await client.query(
        'DELETE FROM list_items WHERE list_id = $1 AND id = ANY($2::int[])',
        [listId, numericIds]
      );

      const removedCount = deleteResult.rowCount;

      // Update item count
      const countResult = await client.query(
        'SELECT COUNT(*) as total FROM list_items WHERE list_id = $1',
        [listId]
      );
      const remainingCount = parseInt(countResult.rows[0].total, 10);

      await client.query(
        'UPDATE lists SET items_count = $1 WHERE id = $2',
        [remainingCount, listId]
      );

      await client.query('COMMIT');

      logger.info(`Removed ${removedCount} items from list ${listId} for user ${userId}`, {
        listId,
        userId,
        removedCount,
        remainingCount,
      });

      return {
        success: true,
        listId: Number(listId),
        removedCount,
        remainingCount,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to remove items from list ${listId}`, {
        error: error.message,
      });
      throw new AppError(
        `Failed to remove items: ${error.message}`,
        500,
        'REMOVE_ITEMS_FAILED'
      );
    } finally {
      client.release();
    }
  }
}

module.exports = new ListService();
