const { Server } = require('socket.io');
const gameHandler = require('./gameHandler');
const matchmakingHandler = require('./matchmakingHandler');
const aiHandler = require('./aiHandler');
const roomHandler = require('./roomHandler');
const User = require('../models/User');
const Game = require('../models/Game');
const redis = require('../services/redisClient');
const mongoose = require('mongoose');

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
        },
        // Ping tuning for mobile stability
        pingInterval: 25000, // 25s ping interval
        pingTimeout: 60000,  // 60s timeout - slow networks için
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

    // Track online users as Maps of Sets to handle multiple tabs
    const onlineUsers = new Map(); // Map<userId, Set<socketId>>

    // Connection handler
    io.on('connection', (socket) => {
        const userId = socket.userId;
        const authType = socket.isClerkUser ? 'Clerk' : 'Legacy';

        console.log(`✅ User connected: ${userId} (${authType})`);

        // Track online user
        if (!onlineUsers.has(userId)) {
            onlineUsers.set(userId, new Set());
        }
        onlineUsers.get(userId).add(socket.id);
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
        gameHandler(io, socket, onlineUsers);

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
                    // Check if this is the last socket for this user in this room
                    const userSockets = onlineUsers.get(userId) || new Set();
                    let hasOtherSocketsInRoom = false;
                    for (const sId of userSockets) {
                        if (sId !== socket.id) {
                            const otherSocket = io.sockets.sockets.get(sId);
                            if (otherSocket && otherSocket.rooms.has(room)) {
                                hasOtherSocketsInRoom = true;
                                break;
                            }
                        }
                    }

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
                                        console.log(`[Socket] User ${userId} disconnected from game ${room}, starting 20s grace period`);
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
            console.log(`❌ User disconnected: ${userId} (${authType})`);

            // Remove from online users
            if (onlineUsers.has(userId)) {
                onlineUsers.get(userId).delete(socket.id);
                if (onlineUsers.get(userId).size === 0) {
                    onlineUsers.delete(userId);
                }
            }
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
