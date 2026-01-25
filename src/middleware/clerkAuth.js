const { clerkMiddleware, requireAuth, getAuth } = require('@clerk/express');

// Middleware that requires authentication - use with clerkMiddleware first
const clerkAuthMiddleware = clerkMiddleware();

// Middleware that requires authenticated user
const authRequired = requireAuth();

// Custom middleware to verify Clerk JWT manually (for sockets)
// Custom middleware to verify Clerk JWT manually (for sockets)
const verifyClerkToken = async (token) => {
    try {
        if (!token) {
            return { success: false, error: 'No token provided' };
        }

        // Import verifyToken directly from @clerk/backend
        // This is safer as SDK structures change
        const { verifyToken } = require('@clerk/backend');

        const verifiedToken = await verifyToken(token, {
            secretKey: process.env.CLERK_SECRET_KEY,
        });

        return {
            success: true,
            userId: verifiedToken.sub,
            sessionId: verifiedToken.sid,
        };
    } catch (error) {
        // If module not found, try falling back to simple decode (dev only) or fail gracefully
        if (error.code === 'MODULE_NOT_FOUND') {
            console.warn('⚠️ @clerk/backend not found for token verification');
        } else {
            console.error('❌ Clerk token verification failed:', error.message);
        }
        return { success: false, error: error.message };
    }
};

// Extract user ID from either Clerk or legacy format
const extractUserId = (auth, legacyUserId) => {
    // Prefer Clerk user ID if authenticated
    if (auth?.userId) {
        return { userId: auth.userId, isClerkUser: true };
    }

    // Fall back to legacy user ID (for backward compatibility)
    if (legacyUserId) {
        return { userId: legacyUserId, isClerkUser: false };
    }

    return null;
};

module.exports = {
    clerkAuthMiddleware,
    authRequired,
    verifyClerkToken,
    extractUserId,
    getAuth,
};
