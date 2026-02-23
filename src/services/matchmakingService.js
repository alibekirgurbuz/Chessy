const redis = require('./redisClient');
const Game = require('../models/Game');

class MatchmakingService {
    constructor() {
        this.SEARCH_PREFIX = `${redis.appPrefix}matchmaking:searching:`;
        this.ONLINE_USERS = `${redis.appPrefix}online:users`;
        this.USER_QUEUE_KEY = `${redis.appPrefix}matchmaking:user_queue:`; // Stores which queue a user is currently in
    }

    // Generate queue key based on parameters
    getQueueKey(userType, tempo, timeControl) {
        return `${redis.appPrefix}matchmaking:queue:${userType}:${tempo}:${timeControl}`;
    }

    // Kuyruğa ekle
    async joinQueue(userId, { userType, tempo, timeControl }) {
        // Kullanıcının zaten bir kuyrukta olup olmadığını kontrol et
        const existingQueue = await redis.get(`${this.USER_QUEUE_KEY}${userId}`);
        if (existingQueue) {
            return { alreadySearching: true };
        }

        const queueKey = this.getQueueKey(userType, tempo, timeControl);

        // Kuyruğa ekle
        await redis.lpush(queueKey, userId);

        // Kullanıcının hangi kuyrukta olduğunu ve arama durumunu kaydet
        await redis.set(`${this.USER_QUEUE_KEY}${userId}`, queueKey, 'EX', 300); // 5 dakika timeout
        await redis.set(`${this.SEARCH_PREFIX}${userId}`, 'true', 'EX', 300);

        console.log(`User ${userId} joined queue: ${queueKey}`);
        return { success: true, queueKey };
    }

    // Kuyruktan çıkar
    async leaveQueue(userId) {
        // Kullanıcının hangi kuyrukta olduğunu bul
        const queueKey = await redis.get(`${this.USER_QUEUE_KEY}${userId}`);

        if (queueKey) {
            await redis.lrem(queueKey, 1, userId);
            await redis.del(`${this.USER_QUEUE_KEY}${userId}`);
            await redis.del(`${this.SEARCH_PREFIX}${userId}`);
            console.log(`User ${userId} left queue: ${queueKey}`);
            return { success: true };
        }

        // Fallback cleanup if queue key is missing but search flag exists
        await redis.del(`${this.SEARCH_PREFIX}${userId}`);
        return { success: false, message: 'User was not in a known queue' };
    }

    // Eşleşme bul
    async findMatch(userId, timeControl) {
        // Kullanıcının hangi kuyrukta olduğunu bul
        const queueKey = await redis.get(`${this.USER_QUEUE_KEY}${userId}`);

        if (!queueKey) {
            return null;
        }

        // Distributed lock to prevent race conditions during matching
        const lockKey = `${queueKey}:lock`;
        const lock = await redis.set(lockKey, 'locked', 'NX', 'PX', 2000);
        if (!lock) return null;

        try {
            // Kuyruktan ilk 2 oyuncuyu al
            const queueLength = await redis.llen(queueKey);

            if (queueLength < 2) {
                return null; // Yeterli oyuncu yok
            }

            // İki oyuncu çek
            const player1 = await redis.rpop(queueKey);
            const player2 = await redis.rpop(queueKey);

            if (!player1 || !player2 || player1 === player2) {
                // Tekrar kuyruğa koy
                if (player1) await redis.lpush(queueKey, player1);
                if (player2) await redis.lpush(queueKey, player2);
                return null;
            }

            // ... rest of the logic ...
            // (I will keep the rest as is but I need to make sure I don't break the return)

            // Arama durumlarını temizle
            await redis.del(`${this.SEARCH_PREFIX}${player1}`);
            await redis.del(`${this.SEARCH_PREFIX}${player2}`);
            await redis.del(`${this.USER_QUEUE_KEY}${player1}`);
            await redis.del(`${this.USER_QUEUE_KEY}${player2}`);

            // Rastgele renk ata
            const [whitePlayerId, blackPlayerId] = Math.random() > 0.5
                ? [player1, player2]
                : [player2, player1];

            // Calculate base time and increment in milliseconds
            const baseTime = timeControl.time * 60 * 1000;
            const increment = timeControl.increment * 1000;

            // Yeni oyun oluştur with clock
            const game = new Game({
                whitePlayer: whitePlayerId,
                blackPlayer: blackPlayerId,
                pgn: '',
                status: 'ongoing',
                timeControl: {
                    time: timeControl.time,
                    increment: timeControl.increment,
                    label: `${timeControl.time}+${timeControl.increment}`
                },
                clock: {
                    whiteTime: baseTime,
                    blackTime: baseTime,
                    activeColor: null,
                    lastMoveAt: null,
                    firstMoveDeadline: Date.now() + 30000,
                    moveCount: 0,
                    baseTime: baseTime,
                    increment: increment
                }
            });

            await game.save();

            return {
                game: {
                    _id: game._id,
                    whitePlayer: { _id: whitePlayerId, username: whitePlayerId },
                    blackPlayer: { _id: blackPlayerId, username: blackPlayerId },
                    pgn: game.pgn,
                    status: game.status,
                    timeControl: game.timeControl,
                    clock: game.clock
                },
                players: [player1, player2]
            };
        } finally {
            await redis.del(lockKey);
        }
    }

    // Online kullanıcı ekle
    async setUserOnline(userId) {
        await redis.sadd(this.ONLINE_USERS, userId);
    }

    // Online kullanıcı çıkar
    async setUserOffline(userId) {
        await redis.srem(this.ONLINE_USERS, userId);
        await this.leaveQueue(userId); // Kuyruktan da çıkar
    }

    // Online kullanıcı sayısı
    async getOnlineCount() {
        return await redis.scard(this.ONLINE_USERS);
    }

    // Tüm kuyrukları temizle (Server start'ta)
    async clearAllQueues() {
        // Queue key'lerini bul ve sil
        const keys = await redis.keys(`${redis.appPrefix}matchmaking:queue:*`);
        if (keys.length > 0) {
            await redis.del(...keys);
        }

        // User queue mappingleri sil
        const mappingKeys = await redis.keys(`${redis.appPrefix}matchmaking:user_queue:*`);
        if (mappingKeys.length > 0) {
            await redis.del(...mappingKeys);
        }

        console.log(`🧹 Cleared ${keys.length} queues and ${mappingKeys.length} user mappings`);
    }
}

module.exports = new MatchmakingService();
