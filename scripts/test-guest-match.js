const { io } = require('socket.io-client');

const socket = io('http://localhost:3001', {
    auth: { userId: 'guest_' + Math.random().toString(36).substring(2, 11) }
});

socket.on('connect', () => {
    console.log('Guest connected');
    socket.emit('user_online');
    socket.emit('start_matchmaking', { tempo: 'bullet', timeControl: '1+0' });
});

socket.on('match_found', (data) => {
    console.log('--- MATCH FOUND ---');
    console.log('White Player:', data.whitePlayer);
    console.log('Black Player:', data.blackPlayer);
    setTimeout(() => {
        socket.emit('join_game', { gameId: data.gameId });
    }, 500);
});

socket.on('game_state', (data) => {
    console.log('--- GAME STATE ---');
    console.log('White Player State:', data.game.whitePlayer);
    console.log('Black Player State:', data.game.blackPlayer);
    process.exit(0);
});
