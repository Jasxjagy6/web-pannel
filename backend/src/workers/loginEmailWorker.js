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

    const { rows: jobMeta } = await pool.query(
      `SELECT user_id FROM login_email_jobs WHERE id = $1`,
      [jobId]
    );
    const userId = jobMeta[0].user_id;

    const { rows: allGmailAccounts } = await pool.query(
      `SELECT id, email, access_token, refresh_token FROM gmail_accounts WHERE user_id = $1 ORDER BY id ASC`,
      [userId]
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

      await this.processItem(item, allGmailAccounts);

      const { rows: updatedItem } = await pool.query(
        `SELECT status FROM login_email_job_items WHERE id = $1`,
        [item.id]
      );
      if (updatedItem[0].status === 'completed') {
        succeeded++;

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

  _isGramJsBug(err) {
    if (!err) return false;
    const msg = err.message || '';
    return msg === 'entities is not iterable' ||
      msg.includes('Could not find a matching Constructor ID');
  }

  _safeInvoke(client, request) {
    return new Promise((resolve, reject) => {
      client.invoke(request)
        .then(resolve)
        .catch((err) => {
          if (this._isGramJsBug(err)) {
            logger.warn(`Caught gram.js bug (${err.message}) — treating as success`);
            resolve(null);
          } else {
            reject(err);
          }
        });
    });
  }

  _buildGmailClient(account) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID || 'dummy',
      process.env.GOOGLE_CLIENT_SECRET || 'dummy'
    );
    oauth2Client.setCredentials({
      access_token: account.access_token,
      refresh_token: account.refresh_token,
    });
    return google.gmail({ version: 'v1', auth: oauth2Client });
  }

  async processItem(item, allGmailAccounts) {
    let client = null;

    try {
      await pool.query(`UPDATE login_email_job_items SET status = 'requesting_code', started_at = NOW() WHERE id = $1`, [item.id]);

      // Build ordered list: assigned account first, then the rest
      const assigned = allGmailAccounts.find(a => a.id === item.gmail_account_id);
      const ordered = assigned
        ? [assigned, ...allGmailAccounts.filter(a => a.id !== assigned.id)]
        : allGmailAccounts;

      if (ordered.length === 0) {
        throw new Error('No Gmail accounts connected. Connect at least one first.');
      }

      logger.info(`Item ${item.id}: connecting to session ${item.session_id}`);
      await tgService._ensureConnected(item.session_id);

      const entry = tgService.clients.get(String(item.session_id));
      if (!entry || !entry.client) {
        throw new Error('Could not connect to Telegram session');
      }
      client = entry.client;

      // Verify the session is actually authenticated.
      // gram.js sometimes throws TypeNotFoundError on the first getMe() call
      // after a long idle period (stale background updates), so retry a few times.
      let me;
      const MAX_ME_RETRIES = 3;
      for (let attempt = 1; attempt <= MAX_ME_RETRIES; attempt++) {
        try {
          me = await client.getMe();
          logger.info(`Item ${item.id}: session authenticated as ${me?.phone || me?.username || me?.id}`);
          break;
        } catch (meErr) {
          if (this._isGramJsBug(meErr) && attempt < MAX_ME_RETRIES) {
            logger.warn(`Item ${item.id}: getMe() hit gram.js bug (attempt ${attempt}/${MAX_ME_RETRIES}), retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
          } else if (this._isGramJsBug(meErr) && attempt === MAX_ME_RETRIES) {
            logger.warn(`Item ${item.id}: getMe() hit gram.js bug on all attempts — session is connected, proceeding`);
            me = null;
            break;
          } else {
            throw new Error(`Session is not authenticated: ${meErr.message}`);
          }
        }
      }

      // Try each Gmail account. On EMAIL_NOT_ALLOWED, rotate to the next one.
      let lastEmailError = null;
      for (let gIdx = 0; gIdx < ordered.length; gIdx++) {
        const gmailAccount = ordered[gIdx];
        const targetEmail = gmailAccount.email;

        if (gIdx > 0) {
          logger.info(`Item ${item.id}: rotating to next Gmail account: ${targetEmail} (${gIdx + 1}/${ordered.length})`);
          await new Promise(r => setTimeout(r, 5000));
        }

        const gmail = this._buildGmailClient(gmailAccount);

        try {
          logger.info(`Item ${item.id}: sending verify code to ${targetEmail}`);
          await this._safeInvoke(client,
            new Api.account.SendVerifyEmailCode({
              purpose: new Api.EmailVerifyPurposeLoginChange(),
              email: targetEmail,
            })
          );
          logger.info(`Item ${item.id}: verify code request sent to ${targetEmail}`);

          await pool.query(`UPDATE login_email_job_items SET status = 'waiting_for_email' WHERE id = $1`, [item.id]);

          const sentAt = Date.now();
          const code = await this.waitForEmail(gmail, targetEmail, sentAt);

          if (!code) {
            throw new Error(`Timeout waiting for OTP email at ${targetEmail}. Check that the Gmail account receives Telegram emails.`);
          }

          logger.info(`Item ${item.id}: got OTP code, verifying with email ${targetEmail}`);
          await pool.query(`UPDATE login_email_job_items SET status = 'verifying' WHERE id = $1`, [item.id]);

          await this._safeInvoke(client,
            new Api.account.VerifyEmail({
              purpose: new Api.EmailVerifyPurposeLoginChange(),
              verification: new Api.EmailVerificationCode({ code }),
            })
          );

          // Success — update the item with the email that actually worked
          await pool.query(
            `UPDATE login_email_job_items SET status = 'completed', email = $2, gmail_account_id = $3, finished_at = NOW() WHERE id = $1`,
            [item.id, targetEmail, gmailAccount.id]
          );
          logger.info(`Item ${item.id}: login email set to ${targetEmail} successfully`);
          return;

        } catch (err) {
          const errCode = (err && (err.errorMessage || err.code)) || 'ERROR';
          const msg = err.message || 'Unknown error';

          if (errCode === 'EMAIL_NOT_ALLOWED') {
            lastEmailError = `EMAIL_NOT_ALLOWED for ${targetEmail}`;
            logger.warn(`Item ${item.id}: ${lastEmailError} — trying next Gmail account`);
            continue;
          }

          // Non-email-rotation error — fail immediately
          throw err;
        }
      }

      // All Gmail accounts exhausted with EMAIL_NOT_ALLOWED
      throw new Error(
        `All ${ordered.length} Gmail account(s) rejected by Telegram (EMAIL_NOT_ALLOWED). Tried: ${ordered.map(a => a.email).join(', ')}. ${lastEmailError || ''}`
      );

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
