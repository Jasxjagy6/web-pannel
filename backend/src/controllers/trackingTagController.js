const trackingTagService = require('../services/trackingTagService');
const reportService = require('../services/reportService');
const { asyncHandler } = require('../utils/errorHandler');

const trackingTagController = {
  listTags: asyncHandler(async (req, res) => {
    const tags = await trackingTagService.listAllTags();
    return res.status(200).json({ success: true, data: tags });
  }),

  createTag: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const tag = await trackingTagService.createTag(userId, req.body);

    await reportService.logActivity(userId, 'tracking_tag_created', 'tracking_tag', tag.id, { name: tag.name });

    return res.status(201).json({ success: true, data: tag });
  }),

  updateTag: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const tag = await trackingTagService.updateTag(req.params.id, req.body);

    await reportService.logActivity(userId, 'tracking_tag_updated', 'tracking_tag', tag.id, {});

    return res.status(200).json({ success: true, data: tag });
  }),

  deleteTag: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const tagId = req.params.id;
    const result = await trackingTagService.deleteTag(tagId);

    await reportService.logActivity(userId, 'tracking_tag_deleted', 'tracking_tag', tagId, {});

    return res.status(200).json({ success: true, data: result });
  }),
};

module.exports = trackingTagController;
