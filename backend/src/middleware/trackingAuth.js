const { AppError, asyncHandler } = require('../utils/errorHandler');
const trackingTeamService = require('../services/trackingTeamService');

/**
 * Gate for every Tracking route. Runs after `authenticate` (a real panel
 * login is always required first — this is a strictly additive per-module
 * layer, not a replacement for it).
 *
 * Deliberately does NOT reuse `requireApproved`: that helper also enforces
 * a per-platform Telegram-API-credentials gate and a subscription/trial
 * entitlement gate, neither of which has anything to do with a manual
 * account-inventory CRM. Only the banned/approved check is replicated here.
 */
const attachTrackingMember = asyncHandler(async (req, _res, next) => {
  if (!req.user) {
    throw new AppError('Auth required', 401, 'AUTH_REQUIRED');
  }
  if (req.user.status === 'banned') {
    throw new AppError('Account is banned', 403, 'ACCOUNT_BANNED');
  }
  if (req.user.role !== 'admin' && (req.user.status !== 'approved' || !req.user.isApproved)) {
    throw new AppError(
      'Account is currently disabled. Please contact support.',
      403,
      'NOT_APPROVED'
    );
  }

  const member = await trackingTeamService.resolveMember(req.user.id);
  if (!member) {
    throw new AppError('You do not have access to Tracking', 403, 'TRACKING_ACCESS_DENIED');
  }
  req.trackingMember = member;
  next();
});

const requireTrackingRole = (...roles) => (req, _res, next) => {
  if (!req.trackingMember || !roles.includes(req.trackingMember.role)) {
    throw new AppError('Insufficient tracking role', 403, 'TRACKING_ROLE_DENIED');
  }
  next();
};

const requireTrackingPermission = (name) => (req, _res, next) => {
  if (!req.trackingMember || req.trackingMember.permissions[name] !== true) {
    throw new AppError(
      `Tracking permission "${name}" required`,
      403,
      'TRACKING_PERMISSION_DENIED'
    );
  }
  next();
};

module.exports = {
  attachTrackingMember,
  requireTrackingRole,
  requireTrackingPermission,
};
