const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { clerkAuthMiddleware, authRequired, getAuth } = require('../middleware/clerkAuth');

// Apply Clerk middleware to all auth routes
router.use(clerkAuthMiddleware);

/**
 * POST /api/auth/sync
 * Sync Clerk user with MongoDB
 * Called after successful Clerk authentication
 */
router.post('/sync', authRequired, async (req, res) => {
    try {
        const auth = getAuth(req);
        const userId = auth?.userId;

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Get user data from request body (sent from client after Clerk auth)
        const { email, firstName, lastName, imageUrl, username } = req.body;

        // Find or create user
        let user = await User.findOne({ clerkId: userId });

        if (!user && email) {
            // Fallback: Check if user exists with same email (orphaned record or pre-clerk user)
            user = await User.findOne({ email });

            if (user) {
                console.log('🔗 [Auth] Found existing user by email. Updating Clerk ID:', user.email);
                user.clerkId = userId; // Link existing user to new Clerk ID
            }
        }

        if (user) {
            // Update existing user
            user.email = email || user.email;
            user.firstName = firstName || user.firstName;
            user.lastName = lastName || user.lastName;
            user.imageUrl = imageUrl || user.imageUrl;

            // Only update username if provided and different
            if (username && username !== user.username) {
                // Check username availability
                const existingUsername = await User.findOne({
                    username,
                    clerkId: { $ne: userId } // Exclude self from check
                });

                if (!existingUsername) {
                    user.username = username;
                }
            }

            user.lastSeen = new Date();
            user.isOnline = true;
            await user.save();

            console.log('✅ [Auth] User synced:', user.clerkId);
        } else {
            // Create new user
            try {
                user = await User.create({
                    clerkId: userId,
                    email: email || `${userId}@clerk.user`, // Fallback email
                    firstName,
                    lastName,
                    imageUrl,
                    username: username || null,
                    lastSeen: new Date(),
                    isOnline: true,
                });
                console.log('🆕 [Auth] New user created:', user.clerkId);
            } catch (createError) {
                // Final safety net for race conditions or other constraints
                if (createError.code === 11000) {
                    console.warn('⚠️ [Auth] Duplicate key error during creation, attempting recovery...');
                    // Try to fetch again in case it was created just now by webhook
                    user = await User.findOne({ $or: [{ clerkId: userId }, { email }] });
                    if (user) {
                        res.json({
                            success: true,
                            user: {
                                id: user._id,
                                clerkId: user.clerkId,
                                email: user.email,
                                username: user.username,
                                displayName: user.displayName,
                                imageUrl: user.imageUrl,
                                elo: user.elo,
                                wins: user.wins,
                                losses: user.losses,
                                draws: user.draws,
                            },
                        });
                        return;
                    }
                }
                throw createError;
            }
        }

        res.json({
            success: true,
            user: {
                id: user._id,
                clerkId: user.clerkId,
                email: user.email,
                username: user.username,
                displayName: user.displayName,
                imageUrl: user.imageUrl,
                elo: user.elo,
                wins: user.wins,
                losses: user.losses,
                draws: user.draws,
            },
        });
    } catch (error) {
        console.error('❌ [Auth] Sync error:', error);
        res.status(500).json({ error: 'Failed to sync user' });
    }
});

/**
 * GET /api/auth/me
 * Get current authenticated user's profile
 */
router.get('/me', authRequired, async (req, res) => {
    try {
        const auth = getAuth(req);
        const userId = auth?.userId;

        const user = await User.findOne({ clerkId: userId });

        if (!user) {
            return res.status(404).json({ error: 'User not found. Please sync first.' });
        }

        res.json({
            id: user._id,
            clerkId: user.clerkId,
            email: user.email,
            username: user.username,
            displayName: user.displayName,
            imageUrl: user.imageUrl,
            elo: user.elo,
            wins: user.wins,
            losses: user.losses,
            draws: user.draws,
            createdAt: user.createdAt,
        });
    } catch (error) {
        console.error('❌ [Auth] Get user error:', error);
        res.status(500).json({ error: 'Failed to get user' });
    }
});

/**
 * POST /api/auth/logout
 * Mark user as offline
 */
router.post('/logout', async (req, res) => {
    try {
        const auth = getAuth(req);
        const userId = auth?.userId;

        if (userId) {
            await User.findOneAndUpdate(
                { clerkId: userId },
                { isOnline: false, lastSeen: new Date() }
            );
            console.log('👋 [Auth] User logged out:', userId);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('❌ [Auth] Logout error:', error);
        res.status(500).json({ error: 'Failed to logout' });
    }
});

module.exports = router;
