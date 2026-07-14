const trackingTeamService = require('../services/trackingTeamService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');

const trackingTeamController = {
  getMe: asyncHandler(async (req, res) => {
    return res.status(200).json({ success: true, data: req.trackingMember });
  }),

  listMembers: asyncHandler(async (req, res) => {
    const members = await trackingTeamService.listMembers();
    return res.status(200).json({ success: true, data: members });
  }),

  addMember: asyncHandler(async (req, res) => {
    const actorId = req.user.id;
    const { userId, role, permissions } = req.body;
    if (!userId || !role) {
      throw new AppError('userId and role are required', 400, 'MISSING_FIELDS');
    }
    const member = await trackingTeamService.addMember(actorId, { userId, role, permissions });

    await reportService.logActivity(actorId, 'tracking_team_member_added', 'tracking_team_member', member.id, {
      targetUserId: userId, role,
    });

    return res.status(201).json({ success: true, data: member });
  }),

  updateMember: asyncHandler(async (req, res) => {
    const actorId = req.user.id;
    const targetUserId = req.params.userId;
    const member = await trackingTeamService.updateMember(targetUserId, req.body);

    await reportService.logActivity(actorId, 'tracking_team_member_updated', 'tracking_team_member', member.id, {
      targetUserId,
    });

    return res.status(200).json({ success: true, data: member });
  }),

  removeMember: asyncHandler(async (req, res) => {
    const actorId = req.user.id;
    const targetUserId = req.params.userId;
    if (Number(targetUserId) === actorId) {
      throw new AppError('You cannot remove yourself from the tracking team', 400, 'CANNOT_REMOVE_SELF');
    }
    const result = await trackingTeamService.removeMember(targetUserId);

    await reportService.logActivity(actorId, 'tracking_team_member_removed', 'tracking_team_member', null, {
      targetUserId,
    });

    return res.status(200).json({ success: true, data: result });
  }),
};

module.exports = trackingTeamController;
