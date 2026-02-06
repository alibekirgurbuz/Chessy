const { Server } = require('socket.io');
const gameHandler = require('./gameHandler');
const matchmakingHandler = require('./matchmakingHandler');
const aiHandler = require('./aiHandler');
const roomHandler = require('./roomHandler');
const { verifyClerkToken } = require('../middleware/clerkAuth');
const User = require('../models/User');
const redis = require('../services/redisClient');

// Clear stale online users on server startup
async function clearOnlineUsersOnStartup() {
    try {
        await redis.del(`${redis.appPrefix}online:users`);
        await matchmakingHandler.clearAllQueues ? matchmakingHandler.clearAllQueues() : null; // Handler'da değil Service'te

        // Service direct import for cleanup
        const matchmakingService = require('../services/matchmakingService');
        await matchmakingService.clearAllQueues();

        // Clear all searching states
        const keys = await redis.keys(`${redis.appPrefix}matchmaking:searching:*`);
        if (keys.length > 0) {
            await redis.del(...keys);
        }
        console.log('🧹 Cleared stale online users from Redis');
    } catch (err) {
        console.warn('⚠️ Could not clear Redis on startup:', err.message);
    }
}

// Run cleanup on module load
clearOnlineUsersOnStartup();

function setupSocket(server) {
    const io = new Server(server, {
        cors: {
            origin: '*', // Development için tüm origin'lere izin ver
            methods: ['GET', 'POST']
        }
    });

    // Middleware: Socket authentication with Clerk JWT support
    io.use(async (socket, next) => {
        const { userId, token } = socket.handshake.auth;

        // Try Clerk JWT authentication first
        if (token) {
            try {
                const result = await verifyClerkToken(token);
                if (result.success) {
                    socket.userId = result.userId;
                    socket.isClerkUser = true;
                    socket.sessionId = result.sessionId;
                    console.log(`🔐 [Socket] Clerk user authenticated: ${result.userId}`);

                    // Update user's online status in database
                    try {
                        await User.findOneAndUpdate(
                            { clerkId: result.userId },
                            { isOnline: true, lastSeen: new Date() }
                        );
                    } catch (err) {
                        console.warn('⚠️ [Socket] Could not update user status:', err.message);
                    }

                    return next();
                } else {
                    console.warn(`⚠️ [Socket] Clerk token invalid: ${result.error}`);
                    // Fall through to legacy auth
                }
            } catch (err) {
                console.warn(`⚠️ [Socket] Clerk token verification error: ${err.message}`);
                // Fall through to legacy auth
            }
        }

        // Legacy authentication (for backward compatibility)
        if (userId) {
            socket.userId = userId;
            socket.isClerkUser = false;
            console.log(`🔓 [Socket] Legacy user connected: ${userId}`);
            return next();
        }

        // No authentication provided
        return next(new Error('Authentication error: userId or token required'));
    });

    // Track online users
    const onlineUsers = new Map(); // Map<userId, socketId>

    // Connection handler
    io.on('connection', (socket) => {
        const userId = socket.userId;
        const authType = socket.isClerkUser ? 'Clerk' : 'Legacy';

        console.log(`✅ User connected: ${userId} (${authType})`);

        // Track online user
        onlineUsers.set(userId, socket.id);
        broadcastOnlineCount();

        // Handle user_online event
        socket.on('user_online', async () => {
            if (socket.isClerkUser) {
                try {
                    await User.findOneAndUpdate(
                        { clerkId: userId },
                        { isOnline: true, lastSeen: new Date() }
                    );
                } catch (err) {
                    console.warn('⚠️ [Socket] Could not update user status:', err.message);
                }
            }
        });

        // Game events
        gameHandler(io, socket);

        // Matchmaking events
        matchmakingHandler(io, socket);

        // AI game events
        aiHandler(io, socket);

        // Room events (friend invites)
        roomHandler(io, socket);

        // Disconnect
        socket.on('disconnect', async () => {
            console.log(`❌ User disconnected: ${userId} (${authType})`);

            // Remove from online users
            onlineUsers.delete(userId);
            broadcastOnlineCount();

            // Update database for Clerk users
            if (socket.isClerkUser) {
                try {
                    await User.findOneAndUpdate(
                        { clerkId: userId },
                        { isOnline: false, lastSeen: new Date() }
                    );
                } catch (err) {
                    console.warn('⚠️ [Socket] Could not update user status:', err.message);
                }
            }
        });
    });

    // Broadcast online count to all clients
    function broadcastOnlineCount() {
        io.emit('online_count', { count: onlineUsers.size });
    }

    return io;
}

module.exports = setupSocket;
