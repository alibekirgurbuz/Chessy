const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profileController');
const { clerkAuthMiddleware, authRequired } = require('../middleware/clerkAuth');

// Apply Clerk middleware to all profile routes
router.use(clerkAuthMiddleware);

/**
 * GET /api/profile/overview
 * Combined stats + recent games for authenticated user
 * Auth required — no userId param, uses Clerk session
 */
router.get('/overview', authRequired, profileController.getProfileOverview);

module.exports = router;
