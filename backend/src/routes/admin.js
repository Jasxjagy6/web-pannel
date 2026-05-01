const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/adminController');
const { authenticate, requireAdmin } = require('../middleware/auth');

router.use(authenticate);
router.use(requireAdmin);

router.get('/stats', ctrl.systemStats);
router.get('/actions', ctrl.recentActions);

router.get('/users', ctrl.listUsers);
router.get('/users/:id', ctrl.getUser);
router.delete('/users/:id', ctrl.deleteUser);
router.post('/users/:id/approve', ctrl.approveUser);
router.post('/users/:id/ban', ctrl.banUser);
router.post('/users/:id/unban', ctrl.unbanUser);
router.put('/users/:id/subscription', ctrl.setSubscription);

module.exports = router;
