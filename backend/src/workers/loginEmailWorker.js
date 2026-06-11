const { pool } = require('../config/database');
const { Api } = require('telegram');
const tgService = require('../services/telegramService');
const logger = require('../utils/logger');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

class LoginEmailWorker {
  async processJob(jobId) {
    logger.info(`Starting login email job ${jobId}`);

    // Update job to running
    await pool.query(
      `UPDATE login_email_jobs SET status = 'running', started_at = NOW() WHERE id = $1 AND status = 'pending'`,
      [jobId]
    );

    const { rows: items } = await pool.query(
      `SELECT * FROM login_email_job_items WHERE job_id = $1 ORDER BY id ASC`,
      [jobId]
    );

    let succeeded = 0;
    let failed = 0;

    for (const item of items) {
      // Check if job cancelled
      const { rows: jobRows } = await pool.query(
        `SELECT cancel_requested FROM login_email_jobs WHERE id = $1`,
        [jobId]
      );
      if (jobRows.length && jobRows[0].cancel_requested) {
        logger.info(`Job ${jobId} was cancelled`);
        break;
      }

      await this.processItem(item);

      const { rows: updatedItem } = await pool.query(
        `SELECT status FROM login_email_job_items WHERE id = $1`,
        [item.id]
      );
      if (updatedItem[0].status === 'completed') succeeded++;
      else failed++;
    }

    // Mark job as completed
    await pool.query(
      `UPDATE login_email_jobs 
       SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'completed' END,
           succeeded_count = $2,
           failed_count = $3,
           finished_at = NOW()
       WHERE id = $1`,
      [jobId, succeeded, failed]
    );
  }

  async processItem(item) {
    try {
      await pool.query(`UPDATE login_email_job_items SET status = 'requesting_code', started_at = NOW() WHERE id = $1`, [item.id]);

      await tgService._ensureConnected(item.session_id);
      const entry = tgService.clients.get(String(item.session_id));
      if (!entry || !entry.client) {
        throw new Error('Could not connect to Telegram session');
      }
      const client = entry.client;

      // Request email code
      await client.invoke(
        new Api.account.SendVerifyEmailCode({
          purpose: new Api.EmailVerifyPurposeLoginChange(),
          email: item.email,
        })
      );

      await pool.query(`UPDATE login_email_job_items SET status = 'waiting_for_email' WHERE id = $1`, [item.id]);

      // Wait for email
      const code = await this.waitForEmail(item.email, item.imap_password, item.imap_host, item.imap_port);

      if (!code) {
        throw new Error('Timeout waiting for email or code not found in email');
      }

      await pool.query(`UPDATE login_email_job_items SET status = 'verifying' WHERE id = $1`, [item.id]);

      // Verify code
      await client.invoke(
        new Api.account.VerifyEmail({
          purpose: new Api.EmailVerifyPurposeLoginChange(),
          verification: new Api.EmailVerificationCode({ code }),
        })
      );

      // Success
      await pool.query(`UPDATE login_email_job_items SET status = 'completed', finished_at = NOW() WHERE id = $1`, [item.id]);

    } catch (err) {
      const code = (err && (err.errorMessage || err.code)) || 'ERROR';
      const msg = err.message || 'Unknown error';
      logger.error(`Login Email item ${item.id} failed: ${msg}`);
      await pool.query(
        `UPDATE login_email_job_items SET status = 'failed', error_code = $2, error_message = $3, finished_at = NOW() WHERE id = $1`,
        [item.id, code.slice(0, 100), msg.slice(0, 500)]
      );
    }
  }

  async waitForEmail(email, password, host, port) {
    const imapClient = new ImapFlow({
      host,
      port,
      secure: port === 993,
      auth: { user: email, pass: password },
      logger: false,
    });

    await imapClient.connect();

    let foundCode = null;
    const startTime = Date.now();
    const timeoutMs = 60 * 1000 * 2; // 2 minutes timeout

    try {
      while (Date.now() - startTime < timeoutMs) {
        const lock = await imapClient.getMailboxLock('INBOX');
        try {
          // Fetch last 5 messages, unseen
          const search = await imapClient.search({ seen: false });
          if (search && search.length > 0) {
            for (const seq of search) {
              const msg = await imapClient.fetchOne(seq, { source: true });
              if (msg && msg.source) {
                const parsed = await simpleParser(msg.source);
                if (parsed.from && parsed.from.text.toLowerCase().includes('telegram')) {
                  // Extract code: usually a 5-6 digit code, or a sentence like "Here is your code: 123456"
                  const text = parsed.text || parsed.html || '';
                  const match = text.match(/\b(\d{5,6})\b/);
                  if (match) {
                    foundCode = match[1];
                    // Mark as seen
                    await imapClient.messageFlagsAdd(seq, ['\\Seen']);
                    break;
                  }
                }
              }
            }
          }
        } finally {
          lock.release();
        }

        if (foundCode) break;
        
        // Wait 5 seconds before next poll
        await new Promise(r => setTimeout(r, 5000));
      }
    } finally {
      await imapClient.logout();
    }

    return foundCode;
  }
}

module.exports = new LoginEmailWorker();
