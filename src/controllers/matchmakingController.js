const matchmakingService = require('../services/matchmakingService');

// Kuyruk durumu
exports.getQueueStatus = async (req, res) => {
    try {
        const status = await matchmakingService.getQueueStatus();
        res.json(status);
    } catch (error) {
        console.error('getQueueStatus error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Online kullanıcılar
exports.getOnlineUsers = async (req, res) => {
    try {
        const count = await matchmakingService.getOnlineCount();
        res.json({ onlineUsers: count });
    } catch (error) {
        console.error('getOnlineUsers error:', error);
        res.status(500).json({ error: error.message });
    }
};
