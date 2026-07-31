const express = require('express');
const router = express.Router();
const listController = require('../controllers/listController');
const { authenticate, requireApproved } = require('../middleware/auth');
const { uploadSingle } = require('../middleware/upload');
const { validate, schemas } = require('../middleware/validator');
const usernameValidationController = require('../controllers/usernameValidationController');

router.use(authenticate);
router.use(requireApproved);

// Persisted live Telegram username-validation jobs. These routes must be
// mounted before `/:id` so the literal path is not consumed as a list id.
router.post('/username-validation/jobs', usernameValidationController.start);
router.get('/username-validation/jobs', usernameValidationController.list);
router.get('/username-validation/jobs/:jobId', usernameValidationController.get);
router.post('/username-validation/jobs/:jobId/cancel', usernameValidationController.cancel);

// Persisted sessionless link-based username filter (checks t.me web previews).
router.post('/username-validation/link-filter', usernameValidationController.linkFilter);

// POST /api/lists/import
router.post('/import', uploadSingle('file'), validate(schemas.listImport), listController.importList);

// POST /api/lists/from-scrape
router.post('/from-scrape', listController.createFromScrape);

// POST /api/lists/merge
router.post('/merge', listController.mergeLists);

// POST /api/lists/:id/deduplicate
router.post('/:id/deduplicate', listController.deduplicateList);

// POST /api/lists/normalize-all - normalize every list owned by the
// caller. Mounted before `/:id/normalize` so the `normalize-all`
// literal isn't shadowed by the param matcher.
router.post('/normalize-all', listController.normalizeAllLists);

// POST /api/lists/:id/normalize
router.post('/:id/normalize', listController.normalizeList);

// GET /api/lists - List all
router.get('/', listController.listLists);

// GET /api/lists/:id
router.get('/:id', listController.getList);

// GET /api/lists/:id/items
router.get('/:id/items', listController.getListItems);

// GET /api/lists/:id/stats
router.get('/:id/stats', listController.getListStats);

// PUT /api/lists/:id
router.put('/:id', listController.updateList);

// DELETE /api/lists/:id
router.delete('/:id', listController.deleteList);

// POST /api/lists/:id/export
router.post('/:id/export', listController.exportList);

// POST /api/lists/:id/items
router.post('/:id/items', listController.addItems);

// DELETE /api/lists/:id/items
router.delete('/:id/items', listController.removeItems);

module.exports = router;
