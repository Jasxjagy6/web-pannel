const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const authSessionService = require('../services/authSessionService');

/**
 * Verify the JWT, hydrate req.user from the live `users` row.
 *
 * We always re-read the database so a banned / un-approved user can't
 * keep using a JWT that was issued before the admin's action.
 *
 * Two extra revocation gates run on every authenticated request:
 *
 *   1. users.tokens_invalidated_at — set whenever ADMIN_EMAIL /
 *      ADMIN_PASSWORD rotates in backend/.env, OR when an admin force-
 *      logs-out a user from the UI. Any JWT with `iat` strictly older
 *      than this timestamp is rejected. Catches pre-existing JWTs that
 *      were issued before this PR (they have no jti).
 *
 *   2. auth_sessions.revoked_at — looked up by the JWT's `jti` claim.
 *      If the row is missing or revoked, the JWT is rejected even
 *      though it's still cryptographically valid. Used by /logout,
 *      the admin "revoke session" button, and ensureAdminUser's mass
 *      revocation on env rotation.
 */
const authenticate = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError('No token provided', 401, 'AUTH_REQUIRED');
  }
  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError('Token expired', 401, 'TOKEN_EXPIRED');
    }
    throw new AppError('Invalid token', 401, 'INVALID_TOKEN');
  }

  const result = await pool.query(
    `SELECT id, email, role, status, is_approved,
            subscription_plan, subscription_status, subscription_expires_at,
            subscription_features,
            trial_started_at, trial_expires_at, trial_used,
            tokens_invalidated_at
       FROM users
      WHERE id = $1`,
    [decoded.userId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('User not found', 401, 'USER_NOT_FOUND');
  }

  // Gate 1: blanket invalidation. Issued-at is in seconds, the column
  // is a TIMESTAMPTZ. Compare epoch seconds on both sides so the cmp
  // is timezone-safe. Also defensive against pre-v33 tokens that have
  // no iat (jwt.sign always sets iat, but be safe).
  if (row.tokens_invalidated_at && typeof decoded.iat === 'number') {
    const invalidatedAtSec = Math.floor(
      new Date(row.tokens_invalidated_at).getTime() / 1000
    );
    if (decoded.iat < invalidatedAtSec) {
      throw new AppError('Token revoked', 401, 'TOKEN_REVOKED');
    }
  }

  // Gate 2: per-session revocation. Tokens issued before v33 don't have
  // a jti — they only fall under Gate 1. After v33 every issued token
  // has a jti and MUST resolve to a non-revoked auth_sessions row.
  let authSession = null;
  if (decoded.jti) {
    authSession = await authSessionService.getActiveByJti(decoded.jti);
    if (!authSession) {
      throw new AppError('Session revoked', 401, 'TOKEN_REVOKED');
    }
    if (authSession.user_id !== row.id) {
      // jti is bound to a specific user — refuse if someone tries to
      // forge a token by mixing-and-matching claims.
      throw new AppError('Invalid token', 401, 'INVALID_TOKEN');
    }
    // Best-effort: bump last_seen_at + refresh IP/UA. Fire-and-forget
    // so a DB blip can't 500 an otherwise-valid request.
    authSessionService.touchSession(authSession.id, req).catch(() => {});
  }
  req.authSession = authSession;

  req.user = {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    isApproved: row.is_approved,
    subscriptionPlan: row.subscription_plan,
    subscriptionStatus: row.subscription_status,
    subscriptionExpiresAt: row.subscription_expires_at,
    subscriptionFeatures: row.subscription_features || {},
    trialStartedAt: row.trial_started_at,
    trialExpiresAt: row.trial_expires_at,
    trialUsed: row.trial_used,
    // Keep a snake_case mirror so subscriptionService can read it
    // without an extra DB roundtrip.
    _row: row,
  };
  next();
});

/**
 * Allow only the listed roles to proceed.
 */
const authorize = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    throw new AppError('Insufficient permissions', 403, 'FORBIDDEN');
  }
  next();
};

const requireAdmin = (req, _res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    throw new AppError('Admin access required', 403, 'ADMIN_REQUIRED');
  }
  next();
};

/**
 * Block any non-admin user that hasn't been approved by an admin yet,
 * or whose account is banned. Mounted on every "feature" route family
 * (sessions, scrape, messaging, …) so the same check exists on the
 * server even if the frontend forgets to gate the page.
 *
 * As of the OxaPay subscription rollout this check ALSO requires the
 * user to have either an active subscription or an active trial (with
 * the feature on the trial-allowed list, if `feature` is provided).
 *
 * Use:
 *   router.use(requireApproved)             // any feature
 *   router.use(requireApproved('scrape'))   // restricted feature
 */
const VALID_PLATFORMS = ['telegram', 'instagram'];

function _isPlatform(s) {
  return typeof s === 'string' && VALID_PLATFORMS.includes(s.toLowerCase());
}

async function _gate(req, _res, platform, feature) {
  if (!req.user) {
    throw new AppError('Auth required', 401, 'AUTH_REQUIRED');
  }
  if (req.user.role === 'admin') return;
  if (req.user.status === 'banned') {
    throw new AppError('Account is banned', 403, 'ACCOUNT_BANNED');
  }
  if (req.user.status !== 'approved' || !req.user.isApproved) {
    throw new AppError(
      'Account is currently disabled. Please contact support.',
      403,
      'NOT_APPROVED'
    );
  }

  // Resolve the platform for this gate. Explicit arg wins; otherwise we
  // use whatever parsePlatform / resolvePlatform set on req.platform; and
  // fall back to 'telegram' for the legacy alias and any router that
  // forgot to mount parsePlatform.
  const effectivePlatform = (platform || req.platform || 'telegram').toLowerCase();

  // Per-user Telegram API credentials gate (v8). Telegram needs the user
  // to have provisioned a Telegram API ID/Hash; Instagram authenticates
  // with the username + password the user enters at session-create time
  // and doesn't need a per-user app credential, so we skip this check on
  // the Instagram panel.
  if (effectivePlatform === 'telegram') {
    const userApiCredentials = require('../services/userApiCredentialsService');
    const hasCreds = await userApiCredentials.userHasUsable(req.user.id);
    if (!hasCreds) {
      throw new AppError(
        'Please set up your Telegram API ID and Hash in Settings before using the panel.',
        412,
        'API_CREDENTIALS_REQUIRED'
      );
    }
  }

  // Subscription / trial gate scoped to the active platform.
  const subscriptionService = require('../services/subscriptionService');
  const ent = await subscriptionService.entitlementFor(
    req.user._row || req.user,
    effectivePlatform,
    feature
  );
  if (!ent.allowed) {
    if (ent.reason === 'trial_feature_not_allowed') {
      throw new AppError(
        `This feature is not available on the ${effectivePlatform} free trial.`,
        402,
        'TRIAL_FEATURE_NOT_ALLOWED'
      );
    }
    const e = new AppError(
      `An active ${effectivePlatform} subscription is required to use this feature.`,
      402,
      'SUBSCRIPTION_REQUIRED'
    );
    e.platform = effectivePlatform;
    throw e;
  }
  req.entitlement = ent;
}

function _isExpressTriple(args) {
  // Express invokes middleware with `(req, res, next)` where `next` is
  // a function. That signature is the only reliable way to tell the
  // "act as middleware now" call apart from the "factory call with a
  // feature label" call.
  return (
    args.length === 3 &&
    typeof args[2] === 'function' &&
    args[0] && typeof args[0] === 'object' && args[0].method &&
    args[1] && typeof args[1].setHeader === 'function'
  );
}

/**
 * Subscription / approval gate.
 *
 * Signatures:
 *   router.use(requireApproved)                          // any feature, platform from req
 *   router.use(requireApproved('scrape'))                // restricted feature, platform from req
 *   router.use(requireApproved('telegram'))              // any feature on telegram
 *   router.use(requireApproved('telegram', 'scrape'))    // feature + platform
 *
 * The platform comes from req.platform (set by parsePlatform / resolvePlatform)
 * unless explicitly provided.
 */
const requireApproved = (...args) => {
  if (_isExpressTriple(args)) {
    const [req, res, next] = args;
    return _gate(req, res, null, null).then(() => next()).catch(next);
  }
  let platform = null;
  let feature = null;
  if (args.length >= 1) {
    if (_isPlatform(args[0])) {
      platform = args[0];
      if (args.length >= 2 && typeof args[1] === 'string') feature = args[1];
    } else if (typeof args[0] === 'string') {
      feature = args[0];
    }
  }
  return (req, res, next) =>
    _gate(req, res, platform, feature).then(() => next()).catch(next);
};

const optionalAuth = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      `SELECT id, email, role, status, is_approved
         FROM users WHERE id = $1`,
      [decoded.userId]
    );
    if (result.rows.length === 0) {
      req.user = null;
    } else {
      const row = result.rows[0];
      req.user = {
        id: row.id,
        email: row.email,
        role: row.role,
        status: row.status,
        isApproved: row.is_approved,
      };
    }
  } catch {
    req.user = null;
  }
  next();
});

module.exports = {
  authenticate,
  authorize,
  requireAdmin,
  requireApproved,
  optionalAuth,
};
