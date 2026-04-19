const express = require('express');
const router = express.Router();
const groupController = require('../controllers/groupController');
const { authenticate } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validator');

router.use(authenticate);

// POST /api/groups/add-members
router.post('/add-members', validate(schemas.addMembersToGroup), groupController.addMembers);

// POST /api/groups/join
router.post('/join', validate(schemas.joinLeaveChannels), groupController.joinChannels);

// POST /api/groups/leave
router.post('/leave', validate(schemas.joinLeaveChannels), groupController.leaveChannels);

// POST /api/groups/configure
router.post('/configure', groupController.configureGroup);

// POST /api/groups/create
router.post('/create', groupController.createGroup);

// GET /api/groups/list
router.get('/list', groupController.listGroups);

// GET /api/groups/operations
router.get('/operations', groupController.listOperations);

// GET /api/groups/operations/:id
router.get('/operations/:id', groupController.getOperation);

// POST /api/groups/operations/:id/cancel
router.post('/operations/:id/cancel', groupController.cancelOperation);

// GET /api/groups/:id/info
router.get('/:id/info', groupController.getGroupInfo);

// DELETE /api/groups/:id/remove-member
router.delete('/:id/remove-member', groupController.removeMember);

module.exports = router;
