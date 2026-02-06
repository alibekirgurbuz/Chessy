const { v4: uuidv4 } = require('uuid');
const Game = require('../models/Game');
const { Chess } = require('chess.js');
const ClockManager = require('../services/ClockManager');

// In-memory room storage for waiting rooms
const waitingRooms = new Map();

/**
 * Room Handler - Manages private game rooms for friend invites
 */
function roomHandler(io, socket) {
    const userId = socket.userId;

    /**
     * Create a new private room
     * @param {Object} data - { timeControl: "3+0", tempo: "blitz" }
     */
    socket.on('create_room', async (data) => {
        try {
            console.log('🏠 ========== CREATE ROOM ==========');
            console.log('   👤 Creator:', userId);
            console.log('   📦 Data:', JSON.stringify(data, null, 2));

            const { timeControl, tempo } = data;

            if (!timeControl) {
                socket.emit('room_error', { message: 'Zaman kontrolü gerekli' });
                return;
            }

            // Parse time control (e.g., "3+0" -> { time: 3, increment: 0 })
            const [timeMinutes, incrementSeconds] = timeControl.split('+').map(Number);

            // Generate unique room ID
            const roomId = uuidv4();

            // Create room data
            const roomData = {
                roomId,
                creatorId: userId,
                creatorSocketId: socket.id,
                timeControl: {
                    time: timeMinutes,
                    increment: incrementSeconds,
                    label: timeControl
                },
                tempo: tempo || 'custom',
                status: 'waiting',
                createdAt: Date.now(),
                players: [userId]
            };

            // Store in waiting rooms
            waitingRooms.set(roomId, roomData);

            // Join socket room
            socket.join(`room:${roomId}`);

            // Generate invite link
            const inviteLink = `/join/${roomId}`;

            console.log('   🔗 Room created:', roomId);
            console.log('   📩 Invite link:', inviteLink);
            console.log('====================================');

            // Emit success with room info
            socket.emit('room_created', {
                roomId,
                inviteLink,
                timeControl: roomData.timeControl,
                status: 'waiting'
            });

        } catch (error) {
            console.error('❌ [RoomHandler] Create room error:', error);
            socket.emit('room_error', { message: 'Oda oluşturma hatası' });
        }
    });

    /**
     * Join an existing room
     * @param {Object} data - { roomId: "uuid" }
     */
    socket.on('join_room', async (data) => {
        try {
            console.log('🚪 ========== JOIN ROOM ==========');
            console.log('   👤 User:', userId);
            console.log('   📦 Data:', JSON.stringify(data, null, 2));

            const { roomId } = data;

            if (!roomId) {
                socket.emit('room_error', { message: 'Oda ID gerekli' });
                return;
            }

            // Check if room exists
            const room = waitingRooms.get(roomId);

            if (!room) {
                console.log('   ❌ Room not found:', roomId);
                socket.emit('room_error', { message: 'Oda bulunamadı veya süresi doldu' });
                return;
            }

            // Check if room is full
            if (room.players.length >= 2) {
                console.log('   ❌ Room is full');
                socket.emit('room_error', { message: 'Oda dolu' });
                return;
            }

            // Check if user is already in room (creator trying to join)
            if (room.players.includes(userId)) {
                console.log('   ⚠️ User already in room');
                socket.emit('room_joined', {
                    roomId,
                    status: room.status,
                    players: room.players.length
                });
                return;
            }

            // Add player to room
            room.players.push(userId);
            room.status = 'starting';
            room.joinerSocketId = socket.id;
            room.joinerId = userId;

            // Join socket room
            socket.join(`room:${roomId}`);

            console.log('   ✅ Player joined, starting game...');

            // Create game in database - ensure proper number parsing
            const timeMinutes = parseInt(room.timeControl.time, 10) || 3;
            const incrementSeconds = parseInt(room.timeControl.increment, 10) || 0;
            const timeMs = timeMinutes * 60 * 1000;
            const incrementMs = incrementSeconds * 1000;

            console.log('   ⏱️ Time config:', { timeMinutes, incrementSeconds, timeMs, incrementMs });

            // Randomly assign colors
            const isCreatorWhite = Math.random() < 0.5;
            const whitePlayer = isCreatorWhite ? room.creatorId : userId;
            const blackPlayer = isCreatorWhite ? userId : room.creatorId;

            // Initialize clock - ClockManager expects { time: minutes, increment: seconds }
            const clockManager = new ClockManager({ time: timeMinutes, increment: incrementSeconds });
            const clockState = clockManager.toJSON();

            console.log('   ⏱️ Clock state:', clockState);

            const game = new Game({
                whitePlayer,
                blackPlayer,
                roomId,
                isPrivate: true,
                roomStatus: 'playing',
                status: 'ongoing',
                timeControl: {
                    time: timeMinutes,
                    increment: incrementSeconds,
                    label: room.timeControl.label || `${timeMinutes}+${incrementSeconds}`
                },
                clock: clockState
            });

            await game.save();

            // Update room with game info
            room.gameId = game._id.toString();
            room.status = 'playing';

            console.log('   🎮 Game created:', game._id);
            console.log('   ⚪ White:', whitePlayer);
            console.log('   ⚫ Black:', blackPlayer);

            // Prepare match data
            const matchData = {
                gameId: game._id.toString(),
                roomId,
                whitePlayer: { _id: whitePlayer, username: `Player_${whitePlayer.slice(-6)}` },
                blackPlayer: { _id: blackPlayer, username: `Player_${blackPlayer.slice(-6)}` },
                timeControl: room.timeControl,
                clock: clockManager.getState()
            };

            // Notify creator
            io.to(room.creatorSocketId).emit('room_game_start', {
                ...matchData,
                yourColor: isCreatorWhite ? 'white' : 'black'
            });

            // Notify joiner
            socket.emit('room_game_start', {
                ...matchData,
                yourColor: isCreatorWhite ? 'black' : 'white'
            });

            // Remove from waiting rooms (game is now active)
            waitingRooms.delete(roomId);

            console.log('   ✅ Game started!');
            console.log('==================================');

        } catch (error) {
            console.error('❌ [RoomHandler] Join room error:', error);
            socket.emit('room_error', { message: 'Odaya katılma hatası' });
        }
    });

    /**
     * Leave/Cancel a room
     */
    socket.on('leave_room', async (data) => {
        try {
            const { roomId } = data;
            console.log('🚶 ========== LEAVE ROOM ==========');
            console.log('   👤 User:', userId);
            console.log('   🏠 Room:', roomId);

            const room = waitingRooms.get(roomId);

            if (room) {
                // If creator leaves waiting room, delete it
                if (room.creatorId === userId && room.status === 'waiting') {
                    waitingRooms.delete(roomId);
                    console.log('   ✅ Room deleted (creator left)');
                }
            }

            socket.leave(`room:${roomId}`);
            socket.emit('room_left', { roomId });
            console.log('==================================');

        } catch (error) {
            console.error('❌ [RoomHandler] Leave room error:', error);
        }
    });

    /**
     * Get room info
     */
    socket.on('get_room_info', async (data) => {
        try {
            const { roomId } = data;
            const room = waitingRooms.get(roomId);

            if (!room) {
                // Check if game exists in DB
                const game = await Game.findOne({ roomId });
                if (game) {
                    socket.emit('room_info', {
                        roomId,
                        status: game.status === 'ongoing' ? 'playing' : 'completed',
                        gameId: game._id.toString()
                    });
                } else {
                    socket.emit('room_error', { message: 'Oda bulunamadı' });
                }
                return;
            }

            socket.emit('room_info', {
                roomId,
                status: room.status,
                timeControl: room.timeControl,
                players: room.players.length
            });

        } catch (error) {
            console.error('❌ [RoomHandler] Get room info error:', error);
        }
    });

    // Handle disconnect - cleanup waiting rooms
    socket.on('disconnect', () => {
        // Find and clean up any waiting rooms created by this user
        for (const [roomId, room] of waitingRooms.entries()) {
            if (room.creatorSocketId === socket.id && room.status === 'waiting') {
                waitingRooms.delete(roomId);
                console.log(`🧹 [RoomHandler] Cleaned up room ${roomId} (creator disconnected)`);
            }
        }
    });
}

// Room cleanup interval (every 10 minutes, clean rooms older than 1 hour)
setInterval(() => {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    let cleaned = 0;

    for (const [roomId, room] of waitingRooms.entries()) {
        if (room.createdAt < oneHourAgo) {
            waitingRooms.delete(roomId);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`🧹 [RoomHandler] Cleaned ${cleaned} expired rooms`);
    }
}, 10 * 60 * 1000); // Every 10 minutes

module.exports = roomHandler;
