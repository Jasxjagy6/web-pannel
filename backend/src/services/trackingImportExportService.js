const fs = require('fs');
const csvParser = require('csv-parser');
const { stringify } = require('csv-stringify/sync');
const ExcelJS = require('exceljs');
const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');
const trackingAccountService = require('../services/trackingAccountService');
const trackingPurchaseService = require('../services/trackingPurchaseService');
const trackingTagService = require('../services/trackingTagService');

// Canonical column set used for both import and export. Header names are
// the on-the-wire (CSV/XLSX) column names; camelCase is the internal key.
const COLUMNS = [
  { header: 'internal_code', key: 'internalCode', importable: false },
  { header: 'phone_number', key: 'phoneNumber' },
  { header: 'country', key: 'country' },
  { header: 'country_code', key: 'countryCode' },
  { header: 'telegram_user_id', key: 'telegramUserId', type: 'int' },
  { header: 'username', key: 'username' },
  { header: 'display_name', key: 'displayName' },
  { header: 'bio', key: 'bio' },
  { header: 'is_premium', key: 'isPremium', type: 'bool' },
  { header: 'is_verified', key: 'isVerified', type: 'bool' },
  { header: 'is_scam', key: 'isScam', type: 'bool' },
  { header: 'is_fake', key: 'isFake', type: 'bool' },
  { header: 'status', key: 'status' },
  { header: 'purchase_price', key: 'purchasePrice', type: 'float', permission: 'earnings' },
  { header: 'supplier_name', key: 'supplierName', permission: 'earnings' },
  { header: 'sale_price', key: 'salePrice', type: 'float', permission: 'sales' },
  { header: 'sold_at', key: 'soldAt', importable: false, permission: 'sales' },
  { header: 'created_at', key: 'createdAt', importable: false },
  { header: 'tags', key: 'tags' },
];

const TRUE_STRINGS = new Set(['true', '1', 'yes', 'y']);

function coerce(value, type) {
  if (value === undefined || value === null || value === '') return undefined;
  if (type === 'bool') return TRUE_STRINGS.has(String(value).trim().toLowerCase());
  if (type === 'int') return parseInt(value, 10);
  if (type === 'float') return parseFloat(value);
  return String(value).trim();
}

async function parseCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

function parseJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new AppError('JSON import must be an array of account objects', 400, 'INVALID_IMPORT_FORMAT');
  }
  return parsed;
}

async function parseXlsx(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];
  const headerRow = worksheet.getRow(1).values; // 1-indexed, index 0 is empty
  const headers = headerRow.slice(1).map((h) => String(h || '').trim());
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = row.values.slice(1);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] !== undefined && values[i] !== null ? String(values[i]) : ''; });
    rows.push(obj);
  });
  return rows;
}

function mapImportRow(raw) {
  const mapped = {};
  for (const col of COLUMNS) {
    if (col.importable === false) continue;
    const value = raw[col.header] ?? raw[col.key];
    const coerced = coerce(value, col.type);
    if (coerced !== undefined) mapped[col.key] = coerced;
  }
  return mapped;
}

const trackingImportExportService = {
  /**
   * Imports accounts from an uploaded CSV/JSON/XLSX file. Each row is
   * created independently (no all-or-nothing transaction) so a single
   * malformed row doesn't roll back an otherwise-good batch of 1000+ rows
   * — failures are collected and returned alongside the successes.
   */
  async importAccounts(userId, file, format) {
    let rawRows;
    if (format === 'json') rawRows = parseJson(file.path);
    else if (format === 'xlsx') rawRows = await parseXlsx(file.path);
    else rawRows = await parseCsv(file.path);

    let imported = 0;
    const errors = [];

    for (let i = 0; i < rawRows.length; i++) {
      const rowNumber = i + 2; // account for the header row in CSV/XLSX
      try {
        const mapped = mapImportRow(rawRows[i]);
        if (mapped.status && !trackingAccountService.VALID_STATUSES.includes(mapped.status)) {
          throw new Error(`Invalid status "${mapped.status}"`);
        }
        const tagNames = (rawRows[i].tags || '')
          .split(/[;,]/)
          .map((t) => t.trim())
          .filter(Boolean);
        const { purchasePrice, supplierName, ...accountFields } = mapped;

        const account = await trackingAccountService.createAccount(userId, accountFields);

        if (purchasePrice !== undefined || supplierName !== undefined) {
          await trackingPurchaseService.upsert(account.id, { purchasePrice, supplierName });
        }
        if (tagNames.length > 0) {
          const tagIds = [];
          for (const name of tagNames) {
            const tag = await trackingTagService.createTag(userId, { name });
            tagIds.push(tag.id);
          }
          await trackingTagService.addTagsToAccount(account.id, userId, tagIds);
        }
        imported++;
      } catch (err) {
        errors.push({ row: rowNumber, error: err.message || 'Unknown error' });
      }
    }

    return { imported, total: rawRows.length, errors };
  },

  /**
   * Exports accounts matching `filters` (no pagination cap — this is a
   * full-result export, unlike the list page). Columns gated by
   * `permission: 'sales'|'earnings'` are stripped when the requester
   * lacks that permission, even if they explicitly asked to export them.
   */
  async exportAccounts(filters, format, permissions = {}) {
    const columns = COLUMNS.filter((c) => !c.permission || permissions[c.permission] === true);
    const { where, params } = trackingAccountService.buildFilters(filters);

    const { rows } = await pool.query(
      `SELECT a.*, pi.supplier_name,
              COALESCE(
                (SELECT string_agg(t.name, ';') FROM tracking_account_tags tt
                   JOIN tracking_tags t ON t.id = tt.tag_id WHERE tt.account_id = a.id),
                ''
              ) AS tags
         FROM tracking_accounts a
         LEFT JOIN tracking_account_purchase_info pi ON pi.account_id = a.id
        WHERE ${where.join(' AND ')}
        ORDER BY a.created_at DESC`,
      params
    );

    const records = rows.map((row) => {
      const record = {};
      for (const col of columns) {
        if (col.key === 'tags') { record.tags = row.tags; continue; }
        const snake = col.header;
        record[col.header] = row[snake] !== undefined ? row[snake] : null;
      }
      return record;
    });

    const headers = columns.map((c) => c.header);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (format === 'json') {
      return {
        content: JSON.stringify(records, null, 2),
        filename: `tracking-accounts-${timestamp}.json`,
        mimeType: 'application/json',
        totalItems: records.length,
      };
    }

    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Accounts');
      sheet.columns = headers.map((h) => ({ header: h, key: h }));
      records.forEach((r) => sheet.addRow(r));
      const buffer = await workbook.xlsx.writeBuffer();
      return {
        content: buffer,
        filename: `tracking-accounts-${timestamp}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        totalItems: records.length,
      };
    }

    // Default: CSV
    const csv = stringify(records, { header: true, columns: headers });
    return {
      content: csv,
      filename: `tracking-accounts-${timestamp}.csv`,
      mimeType: 'text/csv',
      totalItems: records.length,
    };
  },

  getTemplate() {
    const headers = COLUMNS.filter((c) => c.importable !== false).map((c) => c.header);
    const example = {
      phone_number: '+15550001111', country: 'United States', country_code: 'US',
      telegram_user_id: '123456789', username: 'exampleuser', display_name: 'Example User',
      bio: '', is_premium: 'true', is_verified: 'false', is_scam: 'false', is_fake: 'false',
      status: 'available', purchase_price: '5.00', supplier_name: 'Acme Supplier',
      sale_price: '', tags: 'Fresh;Personal',
    };
    return stringify([example], { header: true, columns: headers });
  },
};

module.exports = trackingImportExportService;
