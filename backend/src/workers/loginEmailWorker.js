const { pool } = require('../config/database');
const { Api } = require('telegram');
const tgService = require('../services/telegramService');
const logger = require('../utils/logger');
const { google } = require('googleapis');

class LoginEmailWorker {
  async processJob(jobId) {
    logger.info(`Starting login email job ${jobId}`);

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

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isLastItem = i === items.length - 1;

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
      if (updatedItem[0].status === 'completed') {
        succeeded++;
        
        // Add 5-minute delay after successful completion (except for last item)
        // This prevents Telegram rate-limiting when setting same email to multiple sessions
        if (!isLastItem) {
          logger.info(`Item ${item.id} completed successfully. Waiting 5 minutes before processing next item to avoid Telegram rate-limiting...`);
          await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
          logger.info(`5-minute delay completed. Proceeding to next item.`);
        }
      } else {
        failed++;
      }
    }

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

  _safeInvoke(client, request) {
    return new Promise((resolve, reject) => {
      client.invoke(request)
        .then(resolve)
        .catch((err) => {
          if (err && err.message === 'entities is not iterable') {
            logger.warn('Caught gram.js entities bug — code was likely sent successfully');
            resolve(null);
          } else {
            reject(err);
          }
        });
    });
  }

  async processItem(item) {
    try {
      await pool.query(`UPDATE login_email_job_items SET status = 'requesting_code', started_at = NOW() WHERE id = $1`, [item.id]);

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
      oauth2Client.setCredentials({ access_token, refresh_token });
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      logger.info(`Item ${item.id}: connecting to session ${item.session_id}`);
      await tgService._ensureConnected(item.session_id);

      const entry = tgService.clients.get(String(item.session_id));
      if (!entry || !entry.client) {
        throw new Error('Could not connect to Telegram session');
      }
      const client = entry.client;

      // Verify the session is actually authenticated
      let me;
      try {
        me = await client.getMe();
        logger.info(`Item ${item.id}: session authenticated as ${me?.phone || me?.username || me?.id}`);
      } catch (meErr) {
        throw new Error(`Session is not authenticated: ${meErr.message}`);
      }

      // Send verification code using LoginChange (works for accounts with or without existing email)
      // Wrap in _safeInvoke to handle gram.js "entities is not iterable" bug on background updates
      logger.info(`Item ${item.id}: sending verify code to ${item.email}`);
      await this._safeInvoke(client,
        new Api.account.SendVerifyEmailCode({
          purpose: new Api.EmailVerifyPurposeLoginChange(),
          email: item.email,
        })
      );
      logger.info(`Item ${item.id}: verify code request sent`);

      await pool.query(`UPDATE login_email_job_items SET status = 'waiting_for_email' WHERE id = $1`, [item.id]);

      const sentAt = Date.now();
      const code = await this.waitForEmail(gmail, item.email, sentAt);

      if (!code) {
        throw new Error('Timeout waiting for email or no OTP code found. Check that the Gmail account receives Telegram emails.');
      }

      logger.info(`Item ${item.id}: got OTP code, verifying`);
      await pool.query(`UPDATE login_email_job_items SET status = 'verifying' WHERE id = $1`, [item.id]);

      await this._safeInvoke(client,
        new Api.account.VerifyEmail({
          purpose: new Api.EmailVerifyPurposeLoginChange(),
          verification: new Api.EmailVerificationCode({ code }),
        })
      );

      await pool.query(`UPDATE login_email_job_items SET status = 'completed', finished_at = NOW() WHERE id = $1`, [item.id]);
      logger.info(`Item ${item.id}: login email set successfully`);

    } catch (err) {
      const errCode = (err && (err.errorMessage || err.code)) || 'ERROR';
      const msg = err.message || 'Unknown error';
      const stack = err.stack || '';
      logger.error(`Login Email item ${item.id} failed: [${errCode}] ${msg}\n${stack}`);
      await pool.query(
        `UPDATE login_email_job_items SET status = 'failed', error_code = $2, error_message = $3, finished_at = NOW() WHERE id = $1`,
        [item.id, String(errCode).slice(0, 100), msg.slice(0, 500)]
      );
    }
  }

  async waitForEmail(gmail, targetEmail, sentAt) {
    let foundCode = null;
    const startTime = Date.now();
    const timeoutMs = 60 * 1000 * 3;

    logger.info(`Polling Gmail for OTP from Telegram (timeout: 3 min, only emails after ${new Date(sentAt).toISOString()})`);

    while (Date.now() - startTime < timeoutMs) {
      try {
        const res = await gmail.users.messages.list({
          userId: 'me',
          q: 'from:Telegram newer_than:10m',
          maxResults: 10
        });

        const messages = res.data.messages || [];

        for (const message of messages) {
          const msgDetails = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full'
          });

          const emailDate = parseInt(msgDetails.data.internalDate || '0', 10);
          if (emailDate < sentAt - 5000) {
            continue;
          }

          const snippet = msgDetails.data.snippet || '';
          const match = snippet.match(/\b(\d{5,6})\b/);
          if (match) {
            foundCode = match[1];
            logger.info(`Found OTP code in email: ${foundCode} (email date: ${new Date(emailDate).toISOString()})`);

            try {
              await gmail.users.messages.modify({
                userId: 'me',
                id: message.id,
                requestBody: { removeLabelIds: ['UNREAD'] }
              });
            } catch (_) { /* readonly scope can't modify — ignore */ }
            break;
          }
        }

        if (foundCode) break;

      } catch (err) {
        logger.error(`Error polling Gmail: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 5000));
    }

    if (!foundCode) {
      logger.warn('Gmail polling timed out — no OTP code found');
    }

    return foundCode;
  }
}

module.exports = new LoginEmailWorker();
