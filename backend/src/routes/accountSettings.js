const express = require('express');
const router = express.Router();
const accountSettingsController = require('../controllers/accountSettingsController');
const { authenticate, requireApproved } = require('../middleware/auth');
const fileUpload = require('../middleware/fileUpload');

// GET /api/account-settings/randomize/avatars/:id  -- PUBLIC.
// Streams a bundled avatar JPG so the Randomize Mode preview can render the
// thumbnail via a plain <img src>. The avatars are static placeholder images
// shipped with the repo (not user data), so there is no auth here.
router.get('/randomize/avatars/:id', accountSettingsController.getRandomAvatar);

// All routes BELOW require authentication.
router.use(authenticate);
router.use(requireApproved);

// POST /api/account-settings/update - Update account settings for multiple sessions
router.post('/update', accountSettingsController.updateMultipleSessions);

// POST /api/account-settings/upload-photo - Upload profile photo
router.post('/upload-photo', fileUpload, accountSettingsController.uploadProfilePhoto);

// GET  /api/account-settings/randomize/pools - Random name/bio/avatar pools
// POST /api/account-settings/randomize/apply - Apply per-session randomized assignments
// NOTE: these are registered BEFORE the `/:sessionId` catch-all below.
router.get('/randomize/pools', accountSettingsController.getRandomizePools);
router.post('/randomize/apply', accountSettingsController.applyRandomized);

// POST /api/account-settings/profile-list/preview  - Build a per-session
//   preview from an uploaded profile list (cycles names + bios, suffixes
//   duplicate usernames, picks a random avatar per session).
// POST /api/account-settings/profile-list/apply    - Apply the chosen
//   assignments via the existing Randomize Mode pipeline.
router.post('/profile-list/preview', accountSettingsController.previewProfileList);
router.post('/profile-list/apply', accountSettingsController.applyProfileList);

// POST /api/account-settings/remove-photos - Bulk-delete every profile
// photo (visible avatar + history) on the selected sessions. Destructive.
// Registered BEFORE the `/:sessionId` catch-all so the literal path wins.
router.post('/remove-photos', accountSettingsController.removeAllProfilePhotos);

// GET /api/account-settings/:sessionId - Get account settings for a session
router.get('/:sessionId', accountSettingsController.getAccountSettings);

module.exports = router;
