const telegramService = require('./telegramService');
const sessionService = require('./sessionService');
const listService = require('./listService');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { FIRST_NAMES, LAST_NAMES, BIOS } = require('../data/randomNamePool');
const { getAvatars, resolveAvatarPath, AVATAR_IDS } = require('../data/randomAvatars');

/**
 * Wrap a per-session Telegram call so a permanent auth error is recorded
 * against the session row before the error is propagated to the caller's
 * own error-collection logic. The session-level catch in the bulk update
 * loops still runs as usual — this just makes sure the DB / Sessions UI
 * reflects the revocation immediately for any failed call.
 *
 * @param {number|string} sessionId
 * @param {string} source        Subsystem tag for the revocation log.
 * @param {() => Promise<*>} fn  The underlying telegramService.* call.
 */
async function callWithRevocationTracking(sessionId, source, fn) {
  try {
    return await fn();
  } catch (err) {
    // Best-effort, fire-and-forget — the caller's catch block records
    // the original error against the per-session result.
    sessionService.maybeFlagRevoked(sessionId, err, source).catch(() => {});
    throw err;
  }
}

/**
 * Pick a random element from an array. Returns null if the array is empty.
 * Pure helper so the profile-list cycling logic is easy to test.
 */
function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a short random alphanumeric suffix used to keep usernames
 * unique when the same profile-list row gets reused for multiple
 * sessions (per the operator's requirement: "for username in case of
 * repeat some more random words should be added").
 *
 * Output is lowercase letters + digits, prefixed with an underscore so
 * it can be safely concatenated to a real username. Telegram usernames
 * are capped at 32 chars, so the suffix is intentionally short.
 */
function randomUsernameSuffix() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '_';
  for (let i = 0; i < 4; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/**
 * Build the per-session assignment list when applying a profile list to
 * a set of sessions. Pure function so the cycling/uniqueness logic is
 * unit-testable without any DB access.
 *
 *   - Names + bios cycle: if the list has fewer rows than sessions, we
 *     reuse rows in order. Repeats are allowed.
 *   - Usernames cycle but get a unique random suffix on every repeat AND
 *     a different suffix per session-using-the-same-row, so no two
 *     sessions ever try to claim the same handle.
 *   - Avatars are sampled at random from the bundled catalog regardless
 *     of what the list says (the "PFP idea" text is intentionally
 *     ignored — operators paste English descriptions there, not URLs).
 *
 * @param {Array<{firstName?:string, lastName?:string, username?:string, bio?:string}>} profileItems
 * @param {Array<number|string>} sessionIds
 * @param {Array<string>} avatarIds         Pool of avatar IDs to draw from.
 * @param {object} [opts]
 * @param {boolean} [opts.updateUsernames=true]
 * @param {boolean} [opts.updatePhotos=true]
 * @param {boolean} [opts.updateBios=true]
 * @returns {Array<{sessionId:number|string, firstName?:string, lastName?:string, username?:string, bio?:string, avatarId?:string, sourceIndex:number, repeated:boolean}>}
 */
function buildProfileListAssignments(profileItems, sessionIds, avatarIds, opts = {}) {
  const updateUsernames = opts.updateUsernames !== false;
  const updatePhotos = opts.updatePhotos !== false;
  const updateBios = opts.updateBios !== false;

  if (!Array.isArray(profileItems) || profileItems.length === 0) {
    throw new AppError('Profile list is empty', 400, 'EMPTY_PROFILE_LIST');
  }
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new AppError('No sessions selected', 400, 'NO_SESSIONS');
  }

  // Track how many times each username has been used so the suffix
  // changes deterministically on every repeat (operator can re-run the
  // job and still get unique handles).
  const usernameUseCount = new Map();
  const claimedUsernames = new Set();

  const assignments = [];
  for (let i = 0; i < sessionIds.length; i++) {
    const sourceIndex = i % profileItems.length;
    const repeated = i >= profileItems.length;
    const src = profileItems[sourceIndex];

    const assignment = {
      sessionId: sessionIds[i],
      sourceIndex,
      repeated,
    };

    if (src.firstName) assignment.firstName = src.firstName;
    if (src.lastName) assignment.lastName = src.lastName;

    if (updateBios && src.bio) {
      assignment.bio = src.bio;
    }

    if (updateUsernames && src.username) {
      let candidate;
      const baseUses = usernameUseCount.get(src.username) || 0;
      if (baseUses === 0 && !claimedUsernames.has(src.username.toLowerCase())) {
        candidate = src.username;
      } else {
        // Repeat: add a random suffix until we get something unused.
        for (let tries = 0; tries < 8; tries++) {
          const candidateAttempt = `${src.username}${randomUsernameSuffix()}`.slice(0, 32);
          if (!claimedUsernames.has(candidateAttempt.toLowerCase())) {
            candidate = candidateAttempt;
            break;
          }
        }
        if (!candidate) {
          // Extremely unlikely after 8 attempts; let the runtime
          // collision detection (USERNAME_OCCUPIED) handle it.
          candidate = `${src.username}${randomUsernameSuffix()}`.slice(0, 32);
        }
      }
      usernameUseCount.set(src.username, baseUses + 1);
      claimedUsernames.add(candidate.toLowerCase());
      assignment.username = candidate;
    }

    if (updatePhotos && Array.isArray(avatarIds) && avatarIds.length > 0) {
      assignment.avatarId = pickRandom(avatarIds);
    }

    assignments.push(assignment);
  }

  return assignments;
}

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
            await callWithRevocationTracking(session.id, 'accountSettings.bulkName', () =>
              telegramService.updateProfile(
                String(session.id),
                updateFlags.firstName ? (firstName || '') : undefined,
                updateFlags.lastName ? (lastName || '') : ''
              )
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
            await callWithRevocationTracking(session.id, 'accountSettings.bulkUsername', () =>
              telegramService.updateUsername(String(session.id), username)
            );
            sessionResult.updatedFields.push('username');
          } catch (err) {
            sessionResult.errors.push(`Username update failed: ${err.message}`);
          }
        }

        // Update bio
        if (updateFlags.bio && bio !== undefined) {
          try {
            await callWithRevocationTracking(session.id, 'accountSettings.bulkBio', () =>
              telegramService.updateProfile(
                String(session.id),
                undefined,
                '',
                updateFlags.bio ? bio : ''
              )
            );
            sessionResult.updatedFields.push('bio');
          } catch (err) {
            sessionResult.errors.push(`Bio update failed: ${err.message}`);
          }
        }

        // Update profile photo
        if (updateFlags.profilePhoto && profilePhotoPath) {
          try {
            await callWithRevocationTracking(session.id, 'accountSettings.bulkPhoto', () =>
              telegramService.updateProfilePhoto(String(session.id), profilePhotoPath)
            );
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
   * Return the pools the Randomize Mode samples from.
   *
   * The frontend reads this once when the page mounts and does all the
   * sampling client-side, so the user can preview, edit, and re-roll without
   * round-trips. The backend only ever sees the final per-session
   * assignments via {@link applyRandomizedAssignments}.
   *
   * @returns {{ firstNames: string[], lastNames: string[], bios: string[], avatars: Array<{id:string,fileName:string}> }}
   */
  getRandomizePools() {
    return {
      firstNames: FIRST_NAMES.slice(),
      lastNames: LAST_NAMES.slice(),
      bios: BIOS.slice(),
      avatars: getAvatars().map(({ id, fileName }) => ({ id, fileName })),
    };
  }

  /**
   * Resolve a bundled avatar ID to an on-disk JPG path.
   *
   * @param {string} id
   * @returns {string|null}
   */
  getAvatarFilePath(id) {
    return resolveAvatarPath(id);
  }

  /**
   * Apply per-session randomized assignments. Each entry may carry its own
   * `firstName`, `lastName`, `username`, `bio`, and/or `avatarId` (the ID of
   * a bundled avatar from {@link getRandomizePools}). Any field omitted on
   * a given entry is left untouched on that session.
   *
   * @param {object} params
   * @param {Array<{sessionId:number, firstName?:string, lastName?:string, username?:string, bio?:string, avatarId?:string}>} params.assignments
   * @param {number} userId
   */
  async applyRandomizedAssignments({ assignments }, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }
    if (!Array.isArray(assignments) || assignments.length === 0) {
      throw new AppError('At least one assignment is required', 400, 'NO_ASSIGNMENTS');
    }

    const sessionIds = assignments
      .map((a) => Number(a.sessionId))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (sessionIds.length === 0) {
      throw new AppError('No valid session IDs in assignments', 400, 'NO_VALID_SESSIONS');
    }

    const sessionRecords = await pool.query(
      `SELECT id, phone, status FROM sessions WHERE id = ANY($1::int[]) AND user_id = $2`,
      [sessionIds, userId]
    );

    const ownedById = new Map(sessionRecords.rows.map((r) => [r.id, r]));
    if (ownedById.size === 0) {
      throw new AppError('No valid sessions found', 404, 'NO_VALID_SESSIONS');
    }

    logger.info(`Starting randomized account-settings update for ${ownedById.size} sessions`, {
      userId,
      sessionCount: ownedById.size,
    });

    const results = [];
    for (const a of assignments) {
      const id = Number(a.sessionId);
      const owned = ownedById.get(id);
      const sessionResult = {
        sessionId: id,
        phone: owned ? owned.phone : null,
        success: false,
        errors: [],
        updatedFields: [],
      };

      if (!owned) {
        sessionResult.errors.push('Session not found or not owned by user');
        results.push(sessionResult);
        continue;
      }

      try {
        const wantsFirst = typeof a.firstName === 'string' && a.firstName.length > 0;
        const wantsLast = typeof a.lastName === 'string';
        if (wantsFirst || wantsLast) {
          try {
            await callWithRevocationTracking(id, 'accountSettings.randomizeName', () =>
              telegramService.updateProfile(
                String(id),
                wantsFirst ? a.firstName : undefined,
                wantsLast ? a.lastName : ''
              )
            );
            if (wantsFirst) sessionResult.updatedFields.push('firstName');
            if (wantsLast) sessionResult.updatedFields.push('lastName');
          } catch (err) {
            sessionResult.errors.push(`Name update failed: ${err.message}`);
          }
        }

        if (typeof a.username === 'string' && a.username.length > 0) {
          try {
            await callWithRevocationTracking(id, 'accountSettings.randomizeUsername', () =>
              telegramService.updateUsername(String(id), a.username)
            );
            sessionResult.updatedFields.push('username');
          } catch (err) {
            sessionResult.errors.push(`Username update failed: ${err.message}`);
          }
        }

        if (typeof a.bio === 'string') {
          try {
            await callWithRevocationTracking(id, 'accountSettings.randomizeBio', () =>
              telegramService.updateProfile(String(id), undefined, '', a.bio)
            );
            sessionResult.updatedFields.push('bio');
          } catch (err) {
            sessionResult.errors.push(`Bio update failed: ${err.message}`);
          }
        }

        if (typeof a.avatarId === 'string' && a.avatarId.length > 0) {
          const avatarPath = resolveAvatarPath(a.avatarId);
          if (!avatarPath) {
            sessionResult.errors.push(`Unknown avatar id: ${a.avatarId}`);
          } else {
            try {
              await callWithRevocationTracking(id, 'accountSettings.randomizePhoto', () =>
                telegramService.updateProfilePhoto(String(id), avatarPath)
              );
              sessionResult.updatedFields.push('profilePhoto');
            } catch (err) {
              sessionResult.errors.push(`Profile photo update failed: ${err.message}`);
            }
          }
        }

        sessionResult.success = sessionResult.updatedFields.length > 0;
      } catch (err) {
        sessionResult.errors.push(`Session error: ${err.message}`);
      }

      results.push(sessionResult);
    }

    const successCount = results.filter((r) => r.success).length;
    await pool.query(
      `INSERT INTO activity_logs (user_id, action, details, created_at)
       VALUES ($1, 'randomize_account_settings', $2, NOW())`,
      [
        userId,
        JSON.stringify({
          sessionCount: assignments.length,
          successCount,
        }),
      ]
    );

    logger.info(
      `Randomized account-settings update completed: ${successCount}/${assignments.length} succeeded`,
      { userId }
    );

    return {
      total: assignments.length,
      success: successCount,
      failed: assignments.length - successCount,
      results,
    };
  }

  /**
   * Build the preview assignments for "Apply Profile List" without
   * touching Telegram. The frontend calls this to render the preview
   * table; the operator can re-roll the avatar selection by re-calling
   * this endpoint until they're happy, then apply.
   *
   * @param {object} params
   * @param {number|string} params.listId
   * @param {Array<number|string>} params.sessionIds
   * @param {boolean} [params.updateUsernames]
   * @param {boolean} [params.updatePhotos]
   * @param {boolean} [params.updateBios]
   * @param {number|string} userId
   * @returns {Promise<{ list: object, assignments: Array, listSize: number, sessionCount: number, repeatsRequired: boolean }>}
   */
  async previewProfileListAssignments({ listId, sessionIds, updateUsernames, updatePhotos, updateBios }, userId) {
    if (!userId) throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    const { list, items } = await listService.loadProfileListItems(userId, listId);

    const cleanIds = Array.isArray(sessionIds)
      ? sessionIds.map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    if (cleanIds.length === 0) {
      throw new AppError('No sessions selected', 400, 'NO_SESSIONS');
    }

    // Verify ownership of every requested session.
    const ownedResult = await pool.query(
      `SELECT id FROM sessions WHERE id = ANY($1::int[]) AND user_id = $2`,
      [cleanIds, userId]
    );
    const ownedIds = ownedResult.rows.map((r) => Number(r.id));
    if (ownedIds.length === 0) {
      throw new AppError('No valid sessions found', 404, 'NO_VALID_SESSIONS');
    }

    const assignments = buildProfileListAssignments(
      items,
      ownedIds,
      AVATAR_IDS.slice(),
      { updateUsernames, updatePhotos, updateBios }
    );

    return {
      list,
      assignments,
      listSize: items.length,
      sessionCount: ownedIds.length,
      repeatsRequired: ownedIds.length > items.length,
    };
  }

  /**
   * Apply a profile list across multiple sessions. Internally builds the
   * per-session assignments (cycling names + bios, suffixing duplicate
   * usernames with a random tail, randomising avatars) and delegates to
   * {@link applyRandomizedAssignments} so revocation tracking + activity
   * logging are inherited unchanged.
   *
   * @param {object} params
   * @param {number|string} params.listId
   * @param {Array<number|string>} params.sessionIds
   * @param {boolean} [params.updateUsernames]
   * @param {boolean} [params.updatePhotos]
   * @param {boolean} [params.updateBios]
   * @param {Array<object>} [params.assignments]   Optional explicit assignments (e.g. from a preview the operator already re-rolled).
   * @param {number|string} userId
   */
  async applyProfileListToSessions(params, userId) {
    if (!userId) throw new AppError('User ID is required', 400, 'MISSING_USER_ID');

    let assignmentsArr;
    if (Array.isArray(params.assignments) && params.assignments.length > 0) {
      // Use what the operator previewed verbatim. We still pass them
      // through `applyRandomizedAssignments` for ownership + DB writes.
      assignmentsArr = params.assignments;
    } else {
      const preview = await this.previewProfileListAssignments(params, userId);
      assignmentsArr = preview.assignments;
    }

    if (!Array.isArray(assignmentsArr) || assignmentsArr.length === 0) {
      throw new AppError('No assignments produced', 400, 'NO_ASSIGNMENTS');
    }

    logger.info(
      `Applying profile list ${params.listId} to ${assignmentsArr.length} sessions`,
      { userId }
    );

    return this.applyRandomizedAssignments({ assignments: assignmentsArr }, userId);
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

// Internal helpers exposed for unit/smoke tests.
module.exports.__internal = {
  buildProfileListAssignments,
  randomUsernameSuffix,
  pickRandom,
};
