const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/userCredentialsController');
const { authenticate } = require('../middleware/auth');

// All routes need an auth token but we deliberately do NOT apply
// `requireApproved` here: a user must be able to configure their
// Telegram API credentials before the rest of the panel is unlocked.
router.use(authenticate);

router.get('/',         ctrl.list);
router.post('/',        ctrl.create);
router.get('/:id',      ctrl.get);
router.put('/:id',      ctrl.update);
router.delete('/:id',   ctrl.remove);

module.exports = router;
