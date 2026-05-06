/**
 * Shared helper that expands `req.body.sessionListId` (or
 * `req.body.session_list_id`) to that list's active member session
 * IDs, returning the explicit `sessionIds` array if no list was
 * supplied.
 *
 * Used by every controller that today accepts a `sessionIds` array so
 * the new "Organise > Session List" feature works uniformly across
 * messaging, scrape, privacy, groups, change-2FA, get-OTP, OTP relay,
 * anti-detect, and account-settings.
 */

const sessionListService = require('../services/sessionListService');

/**
 * @param {object} req      Express request (carries req.user.id, req.platform).
 * @param {number[]} fallbackSessionIds  The explicit sessionIds parsed
 *   from the request body.
 * @param {object} [opts]
 * @param {boolean} [opts.includeAll=false] Pass true to include
 *   sessions whose state is `dead` (e.g. for read-only export flows).
 * @returns {Promise<number[]>}
 */
async function resolveSessionIdsFromRequest(req, fallbackSessionIds = [], opts = {}) {
  const body = req && req.body ? req.body : {};
  const listId = body.sessionListId ?? body.session_list_id;
  if (listId != null && listId !== '') {
    return sessionListService.resolveSessionIds({
      userId: req.user && req.user.id,
      platform: req.platform,
      sessionIds: [],
      sessionListId: listId,
      includeAll: !!opts.includeAll,
    });
  }
  if (!Array.isArray(fallbackSessionIds)) return [];
  return fallbackSessionIds
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
}

module.exports = {
  resolveSessionIdsFromRequest,
};
