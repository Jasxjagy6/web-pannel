const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/instagramAccountController');
const { authenticate, requireApproved } = require('../middleware/auth');
const fileUpload = require('../middleware/fileUpload');

router.use(authenticate);
router.use(requireApproved);

router.get('/:sessionId', ctrl.get);
router.patch('/:sessionId', ctrl.update);
router.post('/:sessionId/photo', fileUpload, ctrl.uploadPhoto);

module.exports = router;
