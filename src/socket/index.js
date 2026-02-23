const { Server } = require('socket.io');
const gameHandler = require('./gameHandler');
const matchmakingHandler = require('./matchmakingHandler');
const aiHandler = require('./aiHandler');
const roomHandler = require('./roomHandler');
const User = require('../models/User');
const Game = require('../models/Game');
const redis = require('../services/redisClient');

const mongoose = require('mongoose');

const logger = require('../utils/logger');

const { createAdapter } = require('@socket.io/redis-adapter');

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
        logger.info('🧹 Cleared stale online users from Redis');
    } catch (err) {
        logger.warn('⚠️ Could not clear Redis on startup:', err.message);
    }
}

// Run cleanup on module load
clearOnlineUsersOnStartup();

function setupSocket(server) {
    const pubClient = redis.createClient();
    const subClient = pubClient.duplicate();

    const io = new Server(server, {
        cors: {
            origin: '*', // Development için tüm origin'lere izin ver
            methods: ['GET', 'POST']
        },
        // WS-02: WebSocket-only mode — polling/upgrade path disabled, mobile (WS-01) ile tam uyum
        transports: ['websocket'],
        allowUpgrades: false,
        // WS-03: Compression kapalı — düşük kaynaklı instance'larda (Render free tier) CPU spike/jitter azaltır
        perMessageDeflate: false,
        // Ping tuning for mobile stability
        pingInterval: 25000, // 25s ping interval
        pingTimeout: 60000,  // 60s timeout - slow networks için
        adapter: createAdapter(pubClient, subClient)
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
                    logger.debug(`🔐 [Socket] Clerk user authenticated: ${result.userId}`);

                    // Update user's online status in database
                    try {
                        await User.findOneAndUpdate(
                            { clerkId: result.userId },
                            { isOnline: true, lastSeen: new Date() }
                        );
                    } catch (err) {
                        logger.warn('⚠️ [Socket] Could not update user status:', err.message);
                    }

                    return next();
                } else {
                    logger.warn(`⚠️ [Socket] Clerk token invalid: ${result.error}`);
                    // Fall through to legacy auth
                }
            } catch (err) {
                logger.warn(`⚠️ [Socket] Clerk token verification error: ${err.message}`);
                // Fall through to legacy auth
            }
        }

        // Legacy authentication (for backward compatibility)
        if (userId) {
            socket.userId = userId;
            socket.isClerkUser = false;
            logger.debug(`🔓 [Socket] Legacy user connected: ${userId}`);
            return next();
        }

        // No authentication provided
        return next(new Error('Authentication error: userId or token required'));
    });



    // Connection handler
    io.on('connection', (socket) => {
        const userId = socket.userId;
        const authType = socket.isClerkUser ? 'Clerk' : 'Legacy';

        // Join a personal room to allow cross-node targeted messages
        socket.join(userId);

        logger.info(`✅ User connected: ${userId} (${authType}) | Socket: ${socket.id}`);

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
                    logger.warn('⚠️ [Socket] Could not update user status:', err.message);
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

        // Handle disconnecting (before rooms are left)
        socket.on('disconnecting', async () => {
            // socket.rooms is a Set containing socket.id and joined rooms
            for (const room of socket.rooms) {
                if (room !== socket.id) {
                    // It's likely a game room or other room.
                    // Check if this is the last socket for this user in this room across instances
                    const socketsInRoom = await io.in(room).fetchSockets();
                    const hasOtherSocketsInRoom = socketsInRoom.some(s => s.userId === userId && s.id !== socket.id);

                    if (!hasOtherSocketsInRoom) {
                        // This user is fully disconnecting from this room
                        if (mongoose.Types.ObjectId.isValid(room)) {
                            try {
                                const game = await Game.findById(room);
                                if (game && game.status === 'ongoing') {
                                    const isPlayer = game.whitePlayer.toString() === userId || game.blackPlayer.toString() === userId;
                                    if (isPlayer) {
                                        const deadline = Date.now() + 20000; // 20 seconds grace period
                                        game.disconnectedPlayerId = userId;
                                        game.disconnectDeadlineAt = deadline;
                                        await game.save();

                                        socket.to(room).emit('opponent_disconnected', {
                                            playerId: userId,
                                            reconnectDeadlineAt: deadline
                                        });
                                        logger.info(`[Socket] User ${userId} disconnected from game ${room}, starting 20s grace period | Socket: ${socket.id}`);
                                        continue;
                                    }
                                }
                            } catch (err) {
                                console.error('Error handling player disconnect from game:', err);
                            }
                        }
                    }

                    // Fallback or non-game room emit
                    socket.to(room).emit('opponent_disconnected', { playerId: userId });
                }
            }
        });

        // Disconnect
        socket.on('disconnect', async () => {
            logger.info(`❌ User disconnected: ${userId} (${authType}) | Socket: ${socket.id}`);

            broadcastOnlineCount();

            // Update database for Clerk users
            if (socket.isClerkUser) {
                try {
                    // Check if they still have other active connections
                    const userSockets = await io.in(userId).fetchSockets();
                    if (userSockets.length === 0) {
                        await User.findOneAndUpdate(
                            { clerkId: userId },
                            { isOnline: false, lastSeen: new Date() }
                        );
                    }
                } catch (err) {
                    logger.warn('⚠️ [Socket] Could not update user status:', err.message);
                }
            }
        });
    });

    // Broadcast online count to all clients
    async function broadcastOnlineCount() {
        try {
            // Because each user joins a room named exactly their `userId`
            // and we're looking for unique users, we might need an adapter supported 
            // way. For now, since `onlineUsers` is local, we'll use `io.sockets.sockets.size`
            // Wait, fetchSockets fetches all sockets across the cluster
            const sockets = await io.fetchSockets();
            const uniqueUsers = new Set(sockets.map(s => s.userId));
            io.emit('online_count', { count: uniqueUsers.size });
        } catch (e) {
            console.error(e);
        }
    }

    return io;
}

module.exports = setupSocket;
