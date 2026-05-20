/**
 * REST controller for the Reddit cookie-scraper feature.
 *
 * Routes (mounted under /api/reddit):
 *   GET    /accounts                       list  operator's Reddit accounts
 *   POST   /accounts                       add   a new account
 *   GET    /accounts/:id                   show  a single account
 *   PATCH  /accounts/:id                   edit  password / TOTP / label / notes / proxy
 *   DELETE /accounts/:id                   delete an account (and its cookies / jobs)
 *   POST   /accounts/:id/scrape            enqueue a fresh scrape job
 *   GET    /accounts/:id/jobs              list job history for an account
 *   GET    /accounts/:id/cookies/latest    convenience — cookies for the latest succeeded job
 *   GET    /jobs/:jobId                    inspect a single job
 *   GET    /jobs/:jobId/cookies            list captured cookies for a job (decrypted)
 *   GET    /jobs/:jobId/export/:format     download cookies in any supported export format
 *   GET    /formats                        list the export formats this server supports
 */

'use strict';

const svc = require('../services/redditCookieScrapeService');
const fmt = require('../services/redditCookieFormatService');
const queue = require('../queues/redditScrapeQueue');
const pool = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');

function _id(req, key = 'id') {
  const n = parseInt(req.params[key], 10);
  if (!Number.isFinite(n)) throw new AppError(`invalid ${key}`, 400, 'VALIDATION_ERROR');
  return n;
}

function _clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || null;
}

const controller = {
  listFormats: asyncHandler(async (_req, res) => {
    res.json({ success: true, data: { formats: fmt.SUPPORTED } });
  }),

  listAccounts: asyncHandler(async (req, res) => {
    const rows = await svc.listAccounts(req.user.id);
    res.json({ success: true, data: { accounts: rows } });
  }),

  getAccount: asyncHandler(async (req, res) => {
    const row = await svc.getAccount(req.user.id, _id(req));
    if (!row) throw new AppError('account not found', 404, 'NOT_FOUND');
    res.json({ success: true, data: { account: row } });
  }),

  createAccount: asyncHandler(async (req, res) => {
    const { username, password, totpSecret, label, notes, proxyId } = req.body || {};
    if (!username || !password) throw new AppError('username and password required', 400, 'VALIDATION_ERROR');
    try {
      const row = await svc.createAccount(req.user.id, {
        username, password, totpSecret, label, notes, proxyId,
      });
      res.status(201).json({ success: true, data: { account: row } });
    } catch (err) {
      if (err.code === 'duplicate_account') {
        throw new AppError(err.message, 409, 'DUPLICATE');
      }
      throw new AppError(err.message || 'invalid account input', 400, 'VALIDATION_ERROR');
    }
  }),

  updateAccount: asyncHandler(async (req, res) => {
    const row = await svc.updateAccount(req.user.id, _id(req), req.body || {});
    res.json({ success: true, data: { account: row } });
  }),

  deleteAccount: asyncHandler(async (req, res) => {
    await svc.deleteAccount(req.user.id, _id(req));
    res.json({ success: true });
  }),

  scrapeAccount: asyncHandler(async (req, res) => {
    const accountId = _id(req);
    const account = await svc.getAccount(req.user.id, accountId);
    if (!account) throw new AppError('account not found', 404, 'NOT_FOUND');
    const clientIp = _clientIp(req);
    const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 512);
    const jobId = await svc.createJobRow(req.user.id, accountId, { clientIp, userAgent });
    try {
      const q = await queue.addJob({ jobId, userId: req.user.id, accountId });
      await pool.query(
        `UPDATE reddit_scrape_jobs SET queue_job_id = $2 WHERE id = $1`,
        [jobId, String(q.id)]
      );
    } catch (err) {
      // queue down — fall back to synchronous execution so the operator
      // never sees a phantom "queued forever" row.
      await pool.query(
        `UPDATE reddit_scrape_jobs SET queue_job_id = $2 WHERE id = $1`,
        [jobId, null]
      );
      // eslint-disable-next-line global-require
      const logger = require('../utils/logger');
      logger.warn(`Reddit queue addJob failed (${err.message}); falling back to inline execution`);
      svc.executeJob(jobId).catch((e) => logger.error(`inline scrape failed: ${e.message}`));
    }
    res.status(202).json({ success: true, data: { jobId } });
  }),

  listJobs: asyncHandler(async (req, res) => {
    const rows = await svc.listJobs(req.user.id, _id(req), { limit: req.query.limit });
    res.json({ success: true, data: { jobs: rows } });
  }),

  getJob: asyncHandler(async (req, res) => {
    const job = await svc.getJob(req.user.id, _id(req, 'jobId'));
    if (!job) throw new AppError('job not found', 404, 'NOT_FOUND');
    res.json({ success: true, data: { job } });
  }),

  listJobCookies: asyncHandler(async (req, res) => {
    const out = await svc.listCookies(req.user.id, _id(req, 'jobId'));
    if (!out) throw new AppError('job not found', 404, 'NOT_FOUND');
    res.json({ success: true, data: out });
  }),

  exportJob: asyncHandler(async (req, res) => {
    const format = String(req.params.format || 'json').toLowerCase();
    if (!fmt.SUPPORTED.includes(format)) {
      throw new AppError(`unsupported format: ${format}`, 400, 'VALIDATION_ERROR');
    }
    const out = await svc.listCookies(req.user.id, _id(req, 'jobId'));
    if (!out) throw new AppError('job not found', 404, 'NOT_FOUND');
    const account = await svc.getAccount(req.user.id, out.job.account_id);
    const exp = fmt.exportCookies(format, out.cookies, {
      account: { id: account?.id, username: account?.username, label: account?.label },
      job: {
        id: out.job.id,
        status: out.job.status,
        cookies_count: out.job.cookies_count,
        created_at: out.job.created_at,
        completed_at: out.job.completed_at,
        user_agent: out.job.user_agent,
        oauth_token_present: out.job.oauth_token_present,
      },
      profile: out.job.meta_snapshot?.me_endpoint || null,
    });
    res.setHeader('Content-Type', exp.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${exp.filename}"`);
    res.send(exp.body);
  }),

  latestCookies: asyncHandler(async (req, res) => {
    const accountId = _id(req);
    const account = await svc.getAccount(req.user.id, accountId);
    if (!account) throw new AppError('account not found', 404, 'NOT_FOUND');
    if (!account.last_job_id) {
      res.json({ success: true, data: { job: null, cookies: [] } });
      return;
    }
    const out = await svc.listCookies(req.user.id, account.last_job_id);
    res.json({ success: true, data: out || { job: null, cookies: [] } });
  }),
};

module.exports = controller;
