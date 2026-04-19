const telegramService = require('./telegramService');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const fs = require('fs');
const path = require('path');
const os = require('os');

class AccountSettingsService {
  /**
   * Update account settings for multiple sessions.
   * 
   * @param {object} params
   * @param {number[]} params.sessionIds - Array of session IDs to update
   * @param {string} params.firstName - First name (optional, skip if empty/undefined)
   * @param {string} params.lastName - Last name (optional, skip if empty/undefined)
   * @param {string} params.username - Username (optional, skip if empty/undefined)
   * @param {string} params.bio - Bio/About (optional, skip if empty/undefined)
   * @param {string} params.profilePhotoPath - Path to profile photo (optional, skip if empty/undefined)
   * @param {object} params.updateFlags - Which fields to update {firstName, lastName, username, bio, profilePhoto}
   * @param {number} userId - User ID
   * @returns {Promise<{results: Array}>}
   */
  async updateMultipleSessions(params, userId) {
    const {
      sessionIds,
      firstName,
      lastName,
      username,
      bio,
      profilePhotoPath,
      updateFlags = {},
    } = params;

    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!sessionIds || sessionIds.length === 0) {
      throw new AppError('At least one session is required', 400, 'NO_SESSIONS');
    }

    // Check if any update flag is set
    const hasUpdates = updateFlags.firstName || updateFlags.lastName || 
                       updateFlags.username || updateFlags.bio || updateFlags.profilePhoto;
    
    if (!hasUpdates) {
      throw new AppError('At least one field must be selected for update', 400, 'NO_UPDATES_SELECTED');
    }

    // Verify session ownership
    const sessionRecords = await pool.query(
      `SELECT id, phone, status FROM sessions WHERE id = ANY($1::int[]) AND user_id = $2`,
      [sessionIds, userId]
    );

    if (sessionRecords.rows.length === 0) {
      throw new AppError('No valid sessions found', 404, 'NO_VALID_SESSIONS');
    }

    logger.info(`Starting bulk account settings update for ${sessionRecords.rows.length} sessions`, {
      userId,
      sessionCount: sessionRecords.rows.length,
      updates: updateFlags,
    });

    const results = [];

    // Process each session
    for (const session of sessionRecords.rows) {
      const sessionResult = {
        sessionId: session.id,
        phone: session.phone,
        success: false,
        errors: [],
        updatedFields: [],
      };

      try {
        // Update first name and last name
        if (updateFlags.firstName || updateFlags.lastName) {
          try {
            await telegramService.updateProfile(
              String(session.id),
              updateFlags.firstName ? (firstName || '') : undefined,
              updateFlags.lastName ? (lastName || '') : ''
            );
            if (updateFlags.firstName) sessionResult.updatedFields.push('firstName');
            if (updateFlags.lastName) sessionResult.updatedFields.push('lastName');
          } catch (err) {
            sessionResult.errors.push(`Name update failed: ${err.message}`);
          }
        }

        // Update username
        if (updateFlags.username && username) {
          try {
            await telegramService.updateUsername(String(session.id), username);
            sessionResult.updatedFields.push('username');
          } catch (err) {
            sessionResult.errors.push(`Username update failed: ${err.message}`);
          }
        }

        // Update bio
        if (updateFlags.bio && bio !== undefined) {
          try {
            await telegramService.updateProfile(
              String(session.id),
              undefined,
              '',
              updateFlags.bio ? bio : ''
            );
            sessionResult.updatedFields.push('bio');
          } catch (err) {
            sessionResult.errors.push(`Bio update failed: ${err.message}`);
          }
        }

        // Update profile photo
        if (updateFlags.profilePhoto && profilePhotoPath) {
          try {
            await telegramService.updateProfilePhoto(String(session.id), profilePhotoPath);
            sessionResult.updatedFields.push('profilePhoto');
          } catch (err) {
            sessionResult.errors.push(`Profile photo update failed: ${err.message}`);
          }
        }

        // Mark as success if at least one field was updated
        sessionResult.success = sessionResult.updatedFields.length > 0;

      } catch (err) {
        sessionResult.errors.push(`Session error: ${err.message}`);
      }

      results.push(sessionResult);
    }

    // Log activity
    const successCount = results.filter(r => r.success).length;
    await pool.query(
      `INSERT INTO activity_logs (user_id, action, details, created_at)
       VALUES ($1, 'update_account_settings', $2, NOW())`,
      [
        userId,
        JSON.stringify({
          sessionCount: sessionIds.length,
          successCount,
          updates: updateFlags,
        })
      ]
    );

    logger.info(`Bulk account settings update completed: ${successCount}/${sessionIds.length} succeeded`, {
      userId,
    });

    return {
      total: sessionIds.length,
      success: successCount,
      failed: sessionIds.length - successCount,
      results,
    };
  }

  /**
   * Save uploaded profile photo and return path.
   * 
   * @param {object} file - Uploaded file object
   * @param {number} userId - User ID
   * @returns {Promise<string>} - File path
   */
  async saveProfilePhoto(file, userId) {
    const uploadDir = path.join(os.tmpdir(), 'telegram-panel', 'uploads');
    
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const fileName = `${userId}_${Date.now()}${path.extname(file.name)}`;
    const filePath = path.join(uploadDir, fileName);

    if (file.mv) {
      await file.mv(filePath);
    } else {
      // Handle buffer
      fs.writeFileSync(filePath, file.data);
    }

    return filePath;
  }

  /**
   * Get account settings for a session.
   * 
   * @param {string} sessionId - Session ID
   * @param {number} userId - User ID
   * @returns {Promise<object>}
   */
  async getAccountSettings(sessionId, userId) {
    // Verify session ownership
    const session = await pool.query(
      `SELECT id, phone, status FROM sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId]
    );

    if (session.rows.length === 0) {
      throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    const me = await telegramService.getMe(String(sessionId));

    return {
      sessionId,
      phone: session.rows[0].phone,
      firstName: me.first_name || me.firstName,
      lastName: me.last_name || me.lastName,
      username: me.username,
      bio: me.about || me.bio,
      hasProfilePhoto: me.photo !== undefined && me.photo !== null,
    };
  }
}

module.exports = new AccountSettingsService();
