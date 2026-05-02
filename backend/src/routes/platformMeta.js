const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../utils/errorHandler');

/**
 * Per-platform meta routes (§3.4 / §6.2 of INSTAGRAM_PANEL_ARCHITECTURE.md).
 *
 * Mounted at:
 *   /api/telegram/meta/*    parsePlatform('telegram')
 *   /api/instagram/meta/*   parsePlatform('instagram')
 *
 * Used by the frontend to:
 *   - render only the features the current platform supports,
 *   - know whether the user has an active subscription on that platform.
 */

/**
 * GET /capabilities
 *
 * Returns the provider.capabilities map. The frontend calls this once per
 * platform on mount and caches the result; pages and the sidebar use it to
 * hide non-supported actions instead of rendering broken buttons.
 */
router.get(
  '/capabilities',
  authenticate,
  asyncHandler(async (req, res) => {
    const provider = req.provider;
    res.json({
      success: true,
      platform: provider.platform,
      capabilities: provider.capabilities,
    });
  })
);

module.exports = router;
