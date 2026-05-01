const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');

/**
 * Verify the JWT, hydrate req.user from the live `users` row.
 *
 * We always re-read the database so a banned / un-approved user can't
 * keep using a JWT that was issued before the admin's action.
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
            trial_started_at, trial_expires_at, trial_used
       FROM users
      WHERE id = $1`,
    [decoded.userId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('User not found', 401, 'USER_NOT_FOUND');
  }

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
async function _gate(req, _res, feature) {
  if (!req.user) {
    throw new AppError('Auth required', 401, 'AUTH_REQUIRED');
  }
  if (req.user.role === 'admin') return;
  if (req.user.status === 'banned') {
    throw new AppError('Account is banned', 403, 'ACCOUNT_BANNED');
  }
  // Approval is now automatic on register (v8). Banned users land in
  // 'banned' above. The remaining negative case is anyone an admin
  // explicitly rolled back to 'pending' — keep that path working.
  if (req.user.status !== 'approved' || !req.user.isApproved) {
    throw new AppError(
      'Account is currently disabled. Please contact support.',
      403,
      'NOT_APPROVED'
    );
  }

  // Per-user Telegram API credentials gate (v8). The user MUST have at
  // least one usable credential before they can use any feature route,
  // including after they have an active subscription. The frontend
  // uses this to render the "Set up your API ID and Hash in Settings"
  // popup. Auth, billing, and the credentials CRUD itself are mounted
  // outside this middleware so they remain reachable.
  const userApiCredentials = require('../services/userApiCredentialsService');
  const hasCreds = await userApiCredentials.userHasUsable(req.user.id);
  if (!hasCreds) {
    throw new AppError(
      'Please set up your Telegram API ID and Hash in Settings before using the panel.',
      412,
      'API_CREDENTIALS_REQUIRED'
    );
  }

  // Subscription / trial gate.
  const subscriptionService = require('../services/subscriptionService');
  const ent = await subscriptionService.entitlementFor(req.user._row || req.user, feature);
  if (!ent.allowed) {
    if (ent.reason === 'trial_feature_not_allowed') {
      throw new AppError(
        'This feature is not available on the free trial.',
        402,
        'TRIAL_FEATURE_NOT_ALLOWED'
      );
    }
    throw new AppError(
      'An active subscription is required to use this feature.',
      402,
      'SUBSCRIPTION_REQUIRED'
    );
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

const requireApproved = (...args) => {
  if (_isExpressTriple(args)) {
    const [req, res, next] = args;
    return _gate(req, res, null).then(() => next()).catch(next);
  }
  const feature = args[0] || null;
  return (req, res, next) =>
    _gate(req, res, feature).then(() => next()).catch(next);
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
