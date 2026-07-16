const express = require('express');
const router = express.Router();
const trackingTeamController = require('../controllers/trackingTeamController');
const { authenticate } = require('../middleware/auth');
const { attachTrackingMember, requireTrackingPermission } = require('../middleware/trackingAuth');
const { validate, schemas } = require('../middleware/validator');

router.use(authenticate);
router.use(attachTrackingMember);

// No extra gate beyond attachTrackingMember — any tracking member can read
// their own role/permissions (used by the frontend to render nav/access
// state and hide actions they can't perform).
router.get('/me', trackingTeamController.getMe);

router.get('/', requireTrackingPermission('manageTeam'), trackingTeamController.listMembers);
router.post(
  '/',
  requireTrackingPermission('manageTeam'),
  validate(schemas.trackingTeamMemberAdd),
  trackingTeamController.addMember
);
router.put(
  '/:userId',
  requireTrackingPermission('manageTeam'),
  validate(schemas.trackingTeamMemberUpdate),
  trackingTeamController.updateMember
);
router.delete('/:userId', requireTrackingPermission('manageTeam'), trackingTeamController.removeMember);

module.exports = router;
