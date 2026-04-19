const { pool } = require('../config/database');
const telegramService = require('./telegramService');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');

/**
 * Default delay in milliseconds between bulk 2FA operations.
 */
const DEFAULT_BULK_DELAY_MS = 2000;

/**
 * Utility to sleep for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate that the given session belongs to the specified user.
 * Throws AppError if the session does not exist or does not belong to the user.
 * @param {string} sessionId
 * @param {number|string} userId
 */
async function validateSessionOwnership(sessionId, userId) {
  const result = await pool.query(
    'SELECT id, user_id, status, is_logged_in, is_2fa_enabled FROM sessions WHERE id = $1 AND user_id = $2',
    [sessionId, userId]
  );

  if (result.rows.length === 0) {
    throw new AppError('Session not found or access denied', 404, 'SESSION_NOT_FOUND');
  }

  const row = result.rows[0];

  if (!row.is_logged_in) {
    throw new AppError('Session is not logged in', 400, 'SESSION_NOT_LOGGED_IN');
  }

  return row;
}

/**
 * Parse the 2FA password request result into a structured object.
 * @param {object} passwordRequest - Raw result from Api.account.GetPassword
 * @returns {{ enabled: boolean, hint: string|null, emailRecovery: string|null }}
 */
function parse2FAStatus(passwordRequest) {
  const enabled = !!(passwordRequest && passwordRequest.currentAlgo);

  let hint = null;
  let emailRecovery = null;

  if (passwordRequest) {
    hint = passwordRequest.hint || null;

    if (passwordRequest.emailUnconfirmedPattern) {
      emailRecovery = passwordRequest.emailUnconfirmedPattern;
    }
  }

  return {
    enabled,
    hint,
    emailRecovery,
  };
}

class TwoFAService {
  // =========================================================================
  // Check 2FA Status
  // =========================================================================

  /**
   * Check whether 2FA is enabled for a given session.
   *
   * Queries the Telegram API for current password settings and updates
   * the database record to reflect the latest status.
   *
   * @param {string} sessionId - Active session identifier
   * @param {number|string} userId - User who owns the session
   * @returns {Promise<{
   *   enabled: boolean,
   *   hint: string|null,
   *   emailRecovery: string|null,
   *   updatedAt: string
   * }>}
   */
  async check2FAStatus(sessionId, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    const session = await validateSessionOwnership(sessionId, userId);

    const tgService = telegramService;

    try {
      await tgService._ensureConnected(sessionId);

      const client = tgService.clients.get(sessionId).client;

      const passwordRequest = await tgService._withFloodRetry(sessionId, async () => {
        const { Api } = require('telegram/tl');
        return await client.invoke(new Api.account.GetPassword());
      });

      const status = parse2FAStatus(passwordRequest);

      // Update the database record with the current 2FA status
      await pool.query(
        'UPDATE sessions SET is_2fa_enabled = $1, last_active = NOW() WHERE id = $2',
        [status.enabled, sessionId]
      );

      logger.info(`2FA status checked for session ${sessionId}: ${status.enabled ? 'enabled' : 'disabled'}`, {
        userId,
      });

      return {
        ...status,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Failed to check 2FA status for session ${sessionId}`, {
        userId, error: error.message,
      });

      if (error instanceof AppError) throw error;

      throw new AppError(
        `Failed to check 2FA status: ${error.message}`,
        error.statusCode || 500,
        error.code || 'CHECK_2FA_FAILED'
      );
    }
  }

  // =========================================================================
  // Set 2FA
  // =========================================================================

  /**
   * Enable 2FA (Cloud Password) on a session account.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string} password - New 2FA password (min 1 char)
   * @param {string} hint - Password hint (optional)
   * @param {string} email - Recovery email (optional)
   * @param {number|string} userId - User who owns the session
   * @returns {Promise<{ success: boolean, enabled: boolean, sessionId: string }>}
   */
  async set2FA(sessionId, password, hint, email, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!password || typeof password !== 'string' || password.length === 0) {
      throw new AppError('Password is required to enable 2FA', 400, 'MISSING_PASSWORD');
    }

    await validateSessionOwnership(sessionId, userId);

    const tgService = telegramService;

    try {
      await tgService.enable2FA(sessionId, password, hint || '', email || '');

      // Update the database record
      await pool.query(
        `UPDATE sessions SET
          is_2fa_enabled = true,
          last_active = NOW()
         WHERE id = $1`,
        [sessionId]
      );

      logger.info(`2FA enabled for session ${sessionId} by user ${userId}`, {
        sessionId,
        hasHint: !!hint,
        hasEmail: !!email,
      });

      return {
        success: true,
        enabled: true,
        sessionId,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Failed to enable 2FA for session ${sessionId}`, {
        userId, error: error.message,
      });

      if (error instanceof AppError) throw error;

      const errorMsg = error.message || '';

      // Map known Telegram errors
      if (errorMsg.includes('EMAIL_UNCONFIRMED')) {
        throw new AppError(
          'The recovery email has not been confirmed. Please check your email and verify the address.',
          400,
          'EMAIL_UNCONFIRMED'
        );
      }

      if (errorMsg.includes('PASSWORD_HASH_INVALID')) {
        throw new AppError(
          'The password hash is invalid. Please try again.',
          400,
          'PASSWORD_HASH_INVALID'
        );
      }

      throw new AppError(
        `Failed to enable 2FA: ${error.message}`,
        error.statusCode || 500,
        error.code || 'ENABLE_2FA_FAILED'
      );
    }
  }

  // =========================================================================
  // Verify 2FA
  // =========================================================================

  /**
   * Verify a 2FA password during login for a session.
   *
   * @param {string} sessionId - Session identifier from the login attempt
   * @param {string} password - The 2FA password to verify
   * @param {number|string} userId - User who owns the session
   * @returns {Promise<{
   *   success: boolean,
   *   sessionId: string,
   *   sessionData: string,
   *   me: object
   * }>}
   */
  async verify2FA(sessionId, password, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!password || typeof password !== 'string' || password.length === 0) {
      throw new AppError('Password is required for 2FA verification', 400, 'MISSING_PASSWORD');
    }

    // For 2FA verification during login, we check the session exists for the user
    // (the session may not be logged in yet, so we skip the is_logged_in check)
    const sessionResult = await pool.query(
      'SELECT id, user_id, status FROM sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId]
    );

    if (sessionResult.rows.length === 0) {
      throw new AppError('Session not found or access denied', 404, 'SESSION_NOT_FOUND');
    }

    const tgService = telegramService;

    try {
      const result = await tgService.handle2FA(sessionId, password);

      // Update login status in the database
      await pool.query(
        `UPDATE sessions SET
          is_logged_in = true,
          is_2fa_enabled = true,
          status = 'active',
          last_active = NOW()
         WHERE id = $1`,
        [sessionId]
      );

      logger.info(`2FA verification successful for session ${sessionId}`, {
        userId,
      });

      return {
        success: true,
        sessionId: result.sessionId,
        sessionData: result.sessionData,
        me: result.me,
        verifiedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`2FA verification failed for session ${sessionId}`, {
        userId, error: error.message,
      });

      if (error instanceof AppError) throw error;

      const errorMsg = error.message || '';

      if (errorMsg.includes('PASSWORD_HASH_INVALID')) {
        throw new AppError(
          'The 2FA password is incorrect. Please try again.',
          400,
          'PASSWORD_HASH_INVALID'
        );
      }

      if (errorMsg.includes('SESSION_REVOKED') || errorMsg.includes('SESSION_EXPIRED')) {
        throw new AppError(
          'The session has been revoked or expired. Please create a new session.',
          401,
          'SESSION_INVALID'
        );
      }

      if (errorMsg.includes('FLOOD_WAIT')) {
        const match = errorMsg.match(/(\d+)/);
        const seconds = match ? parseInt(match[1], 10) : 30;
        throw new AppError(
          `Too many login attempts. Please wait ${seconds} seconds before trying again.`,
          429,
          'FLOOD_WAIT'
        );
      }

      throw new AppError(
        `2FA verification failed: ${error.message}`,
        error.statusCode || 500,
        error.code || 'VERIFY_2FA_FAILED'
      );
    }
  }

  // =========================================================================
  // Disable 2FA
  // =========================================================================

  /**
   * Disable 2FA on a session account.
   *
   * Requires the current 2FA password to confirm identity.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string} currentPassword - Current 2FA password for verification
   * @param {number|string} userId - User who owns the session
   * @returns {Promise<{ success: boolean, enabled: boolean, sessionId: string }>}
   */
  async disable2FA(sessionId, currentPassword, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!currentPassword || typeof currentPassword !== 'string' || currentPassword.length === 0) {
      throw new AppError('Current password is required to disable 2FA', 400, 'MISSING_PASSWORD');
    }

    await validateSessionOwnership(sessionId, userId);

    const tgService = telegramService;

    try {
      await tgService.disable2FA(sessionId, currentPassword);

      // Update the database record
      await pool.query(
        `UPDATE sessions SET
          is_2fa_enabled = false,
          last_active = NOW()
         WHERE id = $1`,
        [sessionId]
      );

      logger.info(`2FA disabled for session ${sessionId} by user ${userId}`, {
        sessionId,
      });

      return {
        success: true,
        enabled: false,
        sessionId,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Failed to disable 2FA for session ${sessionId}`, {
        userId, error: error.message,
      });

      if (error instanceof AppError) throw error;

      const errorMsg = error.message || '';

      if (errorMsg.includes('PASSWORD_HASH_INVALID')) {
        throw new AppError(
          'The current 2FA password is incorrect. Cannot disable 2FA.',
          400,
          'PASSWORD_HASH_INVALID'
        );
      }

      throw new AppError(
        `Failed to disable 2FA: ${error.message}`,
        error.statusCode || 500,
        error.code || 'DISABLE_2FA_FAILED'
      );
    }
  }

  // =========================================================================
  // Change 2FA Password
  // =========================================================================

  /**
   * Change the 2FA password on a session account.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string} oldPass - Current 2FA password
   * @param {string} newPass - New 2FA password
   * @param {number|string} userId - User who owns the session
   * @returns {Promise<{ success: boolean, sessionId: string }>}
   */
  async change2FA(sessionId, oldPass, newPass, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!oldPass || typeof oldPass !== 'string' || oldPass.length === 0) {
      throw new AppError('Current password is required', 400, 'MISSING_OLD_PASSWORD');
    }

    if (!newPass || typeof newPass !== 'string' || newPass.length === 0) {
      throw new AppError('New password is required', 400, 'MISSING_NEW_PASSWORD');
    }

    await validateSessionOwnership(sessionId, userId);

    const tgService = telegramService;

    try {
      await tgService.change2FA(sessionId, oldPass, newPass);

      // Update the database record
      await pool.query(
        'UPDATE sessions SET last_active = NOW() WHERE id = $1',
        [sessionId]
      );

      logger.info(`2FA password changed for session ${sessionId} by user ${userId}`, {
        sessionId,
      });

      return {
        success: true,
        sessionId,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Failed to change 2FA password for session ${sessionId}`, {
        userId, error: error.message,
      });

      if (error instanceof AppError) throw error;

      const errorMsg = error.message || '';

      if (errorMsg.includes('PASSWORD_HASH_INVALID')) {
        throw new AppError(
          'The current 2FA password is incorrect. Cannot change password.',
          400,
          'PASSWORD_HASH_INVALID'
        );
      }

      throw new AppError(
        `Failed to change 2FA password: ${error.message}`,
        error.statusCode || 500,
        error.code || 'CHANGE_2FA_FAILED'
      );
    }
  }

  // =========================================================================
  // Bulk Check 2FA Status
  // =========================================================================

  /**
   * Check 2FA status across multiple sessions belonging to the user.
   *
   * Processes each session sequentially and returns a consolidated report.
   *
   * @param {Array<string|number>} sessionIds - Array of session database IDs
   * @param {number|string} userId - User who owns the sessions
   * @returns {Promise<{
   *   total: number,
   *   checked: number,
   *   failed: number,
   *   results: Array<{
   *     sessionId: string|number,
   *     enabled: boolean,
   *     hint: string|null,
   *     emailRecovery: string|null,
   *     success: boolean,
   *     error?: string
   *   }>
   * }>}
   */
  async bulkCheck2FA(sessionIds, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('No session IDs provided for bulk 2FA check', 400, 'NO_SESSION_IDS');
    }

    logger.info(`Bulk 2FA status check started for ${sessionIds.length} sessions`, { userId });

    // Fetch all sessions in a single query, verifying ownership
    const fetchResult = await pool.query(
      'SELECT id, user_id, is_logged_in FROM sessions WHERE id = ANY($1::int[]) AND user_id = $2',
      [sessionIds.map(Number), userId]
    );

    const ownedSessions = fetchResult.rows;
    const missingSessions = sessionIds.filter(
      (id) => !ownedSessions.find((s) => s.id === Number(id))
    );

    const results = [];

    // Add entries for sessions that were not found or not owned
    for (const missingId of missingSessions) {
      results.push({
        sessionId: String(missingId),
        enabled: false,
        hint: null,
        emailRecovery: null,
        success: false,
        error: 'Session not found or access denied',
      });
    }

    const tgService = telegramService;
    let checkedCount = 0;
    let failedCount = 0;

    for (const session of ownedSessions) {
      if (!session.is_logged_in) {
        results.push({
          sessionId: String(session.id),
          enabled: false,
          hint: null,
          emailRecovery: null,
          success: false,
          error: 'Session is not logged in',
        });
        failedCount++;
        continue;
      }

      try {
        await tgService._ensureConnected(String(session.id));

        const client = tgService.clients.get(String(session.id)).client;

        const passwordRequest = await tgService._withFloodRetry(String(session.id), async () => {
          const { Api } = require('telegram/tl');
          return await client.invoke(new Api.account.GetPassword());
        });

        const status = parse2FAStatus(passwordRequest);

        // Update DB record
        await pool.query(
          'UPDATE sessions SET is_2fa_enabled = $1, last_active = NOW() WHERE id = $2',
          [status.enabled, session.id]
        );

        results.push({
          sessionId: String(session.id),
          enabled: status.enabled,
          hint: status.hint,
          emailRecovery: status.emailRecovery,
          success: true,
        });

        checkedCount++;
      } catch (error) {
        logger.error(`Bulk check failed for session ${session.id}`, {
          userId, error: error.message,
        });

        results.push({
          sessionId: String(session.id),
          enabled: false,
          hint: null,
          emailRecovery: null,
          success: false,
          error: error.message || 'Failed to check 2FA status',
        });

        failedCount++;
      }

      // Delay between sessions to avoid flood
      if (checkedCount + failedCount < ownedSessions.length) {
        await sleep(DEFAULT_BULK_DELAY_MS);
      }
    }

    logger.info(`Bulk 2FA status check complete: ${checkedCount} checked, ${failedCount} failed`, {
      userId,
    });

    return {
      total: sessionIds.length,
      checked: checkedCount,
      failed: failedCount,
      results,
    };
  }

  // =========================================================================
  // Bulk Enable 2FA
  // =========================================================================

  /**
   * Enable 2FA on multiple sessions sequentially.
   *
   * Each session is processed one at a time with a delay between operations
   * to avoid triggering Telegram rate limits.
   *
   * @param {Array<string|number>} sessionIds - Array of session database IDs
   * @param {string} password - 2FA password to set
   * @param {string} hint - Password hint (optional)
   * @param {string} email - Recovery email (optional)
   * @param {number|string} userId - User who owns the sessions
   * @returns {Promise<{
   *   total: number,
   *   successful: number,
   *   failed: number,
   *   results: Array<{
   *     sessionId: string|number,
   *     success: boolean,
   *     error?: string
   *   }>
   * }>}
   */
  async bulkEnable2FA(sessionIds, password, hint, email, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!password || typeof password !== 'string' || password.length === 0) {
      throw new AppError('Password is required to enable 2FA', 400, 'MISSING_PASSWORD');
    }

    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('No session IDs provided for bulk 2FA enable', 400, 'NO_SESSION_IDS');
    }

    logger.info(`Bulk 2FA enable started for ${sessionIds.length} sessions`, {
      userId,
      hasHint: !!hint,
      hasEmail: !!email,
    });

    // Fetch all sessions in a single query, verifying ownership
    const fetchResult = await pool.query(
      'SELECT id, user_id, is_logged_in FROM sessions WHERE id = ANY($1::int[]) AND user_id = $2',
      [sessionIds.map(Number), userId]
    );

    const ownedSessions = fetchResult.rows;
    const missingSessions = sessionIds.filter(
      (id) => !ownedSessions.find((s) => s.id === Number(id))
    );

    const results = [];

    // Add entries for sessions that were not found or not owned
    for (const missingId of missingSessions) {
      results.push({
        sessionId: String(missingId),
        success: false,
        error: 'Session not found or access denied',
      });
    }

    const tgService = telegramService;
    let successCount = 0;
    let failedCount = 0;

    for (const session of ownedSessions) {
      if (!session.is_logged_in) {
        results.push({
          sessionId: String(session.id),
          success: false,
          error: 'Session is not logged in',
        });
        failedCount++;
        continue;
      }

      try {
        await tgService.enable2FA(String(session.id), password, hint || '', email || '');

        // Update the database record
        await pool.query(
          'UPDATE sessions SET is_2fa_enabled = true, last_active = NOW() WHERE id = $1',
          [session.id]
        );

        results.push({
          sessionId: String(session.id),
          success: true,
        });

        successCount++;

        logger.info(`Bulk 2FA enabled for session ${session.id}`, { userId });
      } catch (error) {
        logger.error(`Bulk 2FA enable failed for session ${session.id}`, {
          userId, error: error.message,
        });

        const errorMsg = error.message || '';

        let userError = errorMsg;
        if (errorMsg.includes('EMAIL_UNCONFIRMED')) {
          userError = 'Recovery email not confirmed';
        } else if (errorMsg.includes('PASSWORD_HASH_INVALID')) {
          userError = 'Password hash invalid';
        } else if (errorMsg.includes('FLOOD_WAIT')) {
          const match = errorMsg.match(/(\d+)/);
          const seconds = match ? parseInt(match[1], 10) : 30;
          userError = `Rate limited. Wait ${seconds} seconds`;
        }

        results.push({
          sessionId: String(session.id),
          success: false,
          error: userError,
        });

        failedCount++;
      }

      // Delay between sessions to avoid flood
      if (successCount + failedCount < ownedSessions.length) {
        await sleep(DEFAULT_BULK_DELAY_MS);
      }
    }

    logger.info(`Bulk 2FA enable complete: ${successCount} success, ${failedCount} failed`, {
      userId,
    });

    return {
      total: sessionIds.length,
      successful: successCount,
      failed: failedCount,
      results,
    };
  }

  // =========================================================================
  // Get 2FA Statistics
  // =========================================================================

  /**
   * Get comprehensive 2FA statistics for all sessions belonging to a user.
   *
   * Returns counts of sessions with/without 2FA, and recent 2FA changes.
   *
   * @param {number|string} userId - User who owns the sessions
   * @returns {Promise<{
   *   totalSessions: number,
   *   with2FA: number,
   *   without2FA: number,
   *   percentage2FA: number,
   *   loggedInWith2FA: number,
   *   loggedInWithout2FA: number,
   *   recentChanges: Array<{
   *     sessionId: number,
   *     action: string,
   *     changedAt: string
   *   }>
   * }>}
   */
  async get2FAStats(userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    // Overall counts
    const totalResult = await pool.query(
      'SELECT COUNT(*) as total FROM sessions WHERE user_id = $1',
      [userId]
    );
    const totalSessions = parseInt(totalResult.rows[0].total, 10);

    // 2FA breakdown
    const faBreakdown = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE is_2fa_enabled = true) as with_2fa,
         COUNT(*) FILTER (WHERE is_2fa_enabled = false) as without_2fa,
         COUNT(*) FILTER (WHERE is_2fa_enabled = true AND is_logged_in = true) as logged_in_with_2fa,
         COUNT(*) FILTER (WHERE is_2fa_enabled = false AND is_logged_in = true) as logged_in_without_2fa
       FROM sessions
       WHERE user_id = $1`,
      [userId]
    );

    const faRow = faBreakdown.rows[0];
    const with2FA = parseInt(faRow.with_2fa, 10);
    const without2FA = parseInt(faRow.without_2fa, 10);
    const loggedInWith2FA = parseInt(faRow.logged_in_with_2fa, 10);
    const loggedInWithout2FA = parseInt(faRow.logged_in_without_2fa, 10);

    const percentage2FA = totalSessions > 0 ? Math.round((with2FA / totalSessions) * 100) : 0;

    // Recent 2FA changes - sessions that were recently updated
    const recentChanges = await pool.query(
      `SELECT id as session_id,
              CASE
                WHEN is_2fa_enabled = true THEN '2FA enabled'
                ELSE '2FA disabled'
              END as action,
              last_active as changed_at
       FROM sessions
       WHERE user_id = $1 AND last_active IS NOT NULL
       ORDER BY last_active DESC
       LIMIT 20`,
      [userId]
    );

    const changesList = recentChanges.rows.map((row) => ({
      sessionId: row.session_id,
      action: row.action,
      changedAt: row.changed_at,
    }));

    logger.info(`2FA stats fetched for user ${userId}`, {
      totalSessions, with2FA, without2FA, percentage2FA,
    });

    return {
      totalSessions,
      with2FA,
      without2FA,
      percentage2FA,
      loggedInWith2FA,
      loggedInWithout2FA,
      recentChanges: changesList,
    };
  }
}

module.exports = new TwoFAService();
