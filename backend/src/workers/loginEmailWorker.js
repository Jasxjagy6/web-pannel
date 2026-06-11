const { pool } = require('../config/database');
const { Api } = require('telegram');
const tgService = require('../services/telegramService');
const logger = require('../utils/logger');
const { google } = require('googleapis');

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

      // Get Gmail Account tokens
      const { rows: gmailRows } = await pool.query(
        `SELECT access_token, refresh_token FROM gmail_accounts WHERE id = $1`,
        [item.gmail_account_id]
      );

      if (gmailRows.length === 0) {
        throw new Error('Gmail account not found in database');
      }

      const { access_token, refresh_token } = gmailRows[0];
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID || 'dummy',
        process.env.GOOGLE_CLIENT_SECRET || 'dummy'
      );
      oauth2Client.setCredentials({
        access_token,
        refresh_token
      });

      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

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
      const code = await this.waitForEmail(gmail);

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

  async waitForEmail(gmail) {
    let foundCode = null;
    const startTime = Date.now();
    const timeoutMs = 60 * 1000 * 2; // 2 minutes timeout

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Query unread messages from Telegram
        const res = await gmail.users.messages.list({
          userId: 'me',
          q: 'from:Telegram is:unread',
          maxResults: 5
        });

        const messages = res.data.messages || [];

        for (const message of messages) {
          const msgDetails = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full'
          });

          const snippet = msgDetails.data.snippet || '';
          
          // Telegram code is usually 5-6 digits
          const match = snippet.match(/\b(\d{5,6})\b/);
          if (match) {
            foundCode = match[1];

            // Mark as read
            await gmail.users.messages.modify({
              userId: 'me',
              id: message.id,
              requestBody: {
                removeLabelIds: ['UNREAD']
              }
            });

            break;
          }
        }

        if (foundCode) break;

      } catch (err) {
        logger.error(`Error polling Gmail: ${err.message}`);
      }

      // Wait 5 seconds before next poll
      await new Promise(r => setTimeout(r, 5000));
    }

    return foundCode;
  }
}

module.exports = new LoginEmailWorker();
