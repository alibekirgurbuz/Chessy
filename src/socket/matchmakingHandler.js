const matchmakingService = require('../services/matchmakingService');

function matchmakingHandler(io, socket) {

    // Kullanıcı online oldu
    socket.on('user_online', async () => {
        try {
            await matchmakingService.setUserOnline(socket.userId);

            // Socket'i kendi odasına ekle (matchmaking bildirimleri için)
            socket.join(socket.userId);

            // Online sayısını tüm kullanıcılara yayınla
            const onlineCount = await matchmakingService.getOnlineCount();
            io.emit('online_count', { count: onlineCount });

            console.log(`User ${socket.userId} is now online. Total online: ${onlineCount}`);
        } catch (error) {
            console.error('user_online error:', error);
            socket.emit('error', { message: error.message });
        }
    });

    // Matchmaking'e başla
    socket.on('start_matchmaking', async (data) => {
        try {
            const { tempo, timeControl } = data || {};

            if (!tempo || !timeControl) {
                return socket.emit('error', { message: 'Missing tempo or timeControl parameters' });
            }

            const userType = socket.isClerkUser ? 'registered' : 'guest';

            const result = await matchmakingService.joinQueue(socket.userId, {
                userType,
                tempo,
                timeControl
            });

            if (result.alreadySearching) {
                return socket.emit('error', { message: 'Already searching for a match' });
            }

            socket.emit('matchmaking_started', {
                searching: true,
                queue: result.queueKey
            });
            console.log(`User ${socket.userId} (${userType}) started matchmaking for ${tempo} ${timeControl}`);

            // Parse timeControl string (e.g., "3+0" -> { time: 3, increment: 0 })
            const [timeMinutes, incrementSeconds] = timeControl.split('+').map(Number);

            // Eşleşme bulmaya çalış - pass parsed timeControl
            const match = await matchmakingService.findMatch(socket.userId, {
                time: timeMinutes,
                increment: incrementSeconds
            });

            if (match) {
                console.log(`Match found! Game ID: ${match.game._id}`);

                // Fetch user details
                const User = require('../models/User');
                const playersData = await User.find({
                    clerkId: { $in: match.players }
                });

                // Create a map for quick lookup
                const playerMap = {};
                playersData.forEach(p => {
                    playerMap[p.clerkId] = p;
                });

                // Her iki oyuncuya da oyun bilgisi gönder
                match.players.forEach(playerId => {
                    const yourColor = playerId === match.game.whitePlayer._id.toString() ? 'white' : 'black';

                    // Update player names in the game object for the emission
                    const whitePlayerId = match.game.whitePlayer._id.toString();
                    const blackPlayerId = match.game.blackPlayer._id.toString();

                    const whiteUser = playerMap[whitePlayerId];
                    const blackUser = playerMap[blackPlayerId];

                    const whiteUsername = whiteUser ? (whiteUser.username || whiteUser.firstName || 'Anonymous') : whitePlayerId;
                    const blackUsername = blackUser ? (blackUser.username || blackUser.firstName || 'Anonymous') : blackPlayerId;

                    io.to(playerId).emit('match_found', {
                        gameId: match.game._id,
                        whitePlayer: { _id: whitePlayerId, username: whiteUsername },
                        blackPlayer: { _id: blackPlayerId, username: blackUsername },
                        yourColor: yourColor,
                        timeControl: match.game.timeControl,
                        clock: match.game.clock
                    });
                });
            }

        } catch (error) {
            console.error('start_matchmaking error:', error);
            socket.emit('error', { message: error.message });
        }
    });

    // Matchmaking'den çık
    socket.on('cancel_matchmaking', async () => {
        try {
            await matchmakingService.leaveQueue(socket.userId);
            socket.emit('matchmaking_cancelled');
            console.log(`User ${socket.userId} cancelled matchmaking`);
        } catch (error) {
            console.error('cancel_matchmaking error:', error);
            socket.emit('error', { message: error.message });
        }
    });

    // Disconnect - kullanıcıyı offline yap
    socket.on('disconnect', async () => {
        try {
            await matchmakingService.setUserOffline(socket.userId);
            const onlineCount = await matchmakingService.getOnlineCount();
            io.emit('online_count', { count: onlineCount });
        } catch (error) {
            console.error('disconnect cleanup error:', error);
        }
    });
}

module.exports = matchmakingHandler;
