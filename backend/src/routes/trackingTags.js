const express = require('express');
const router = express.Router();
const trackingTagController = require('../controllers/trackingTagController');
const { authenticate } = require('../middleware/auth');
const { attachTrackingMember, requireTrackingPermission } = require('../middleware/trackingAuth');
const { validate, schemas } = require('../middleware/validator');

router.use(authenticate);
router.use(attachTrackingMember);

router.get('/', requireTrackingPermission('view'), trackingTagController.listTags);
router.post('/', requireTrackingPermission('edit'), validate(schemas.trackingTagCreate), trackingTagController.createTag);
router.put('/:id', requireTrackingPermission('edit'), validate(schemas.trackingTagUpdate), trackingTagController.updateTag);
router.delete('/:id', requireTrackingPermission('delete'), trackingTagController.deleteTag);

module.exports = router;
