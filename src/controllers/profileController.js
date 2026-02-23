const User = require('../models/User');
const Game = require('../models/Game');
const { Chess } = require('chess.js');
const { getAuth } = require('../middleware/clerkAuth');

/**
 * GET /api/profile/overview
 * Returns combined stats + recent games for the authenticated user.
 * Accepts query params ?page=1&limit=10
 * Response contract: ProfileOverviewResponse (v1)
 */
const getProfileOverview = async (req, res) => {
    try {
        const auth = getAuth(req);
        const clerkId = auth?.userId;

        if (!clerkId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Pagination query params
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limitQuery = parseInt(req.query.limit) || 10;
        const limit = Math.max(1, Math.min(50, limitQuery)); // clamp to 50
        const skip = (page - 1) * limit;

        // ── User lookup ──
        const user = await User.findOne({ clerkId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // ── Stats ──
        const wins = user.wins || 0;
        const losses = user.losses || 0;
        const draws = user.draws || 0;
        const totalGames = wins + losses + draws;
        const winRate = totalGames === 0 ? 0 : Math.round((wins / totalGames) * 100);

        const stats = {
            totalGames,
            wins,
            losses,
            draws,
            winRate,
            elo: user.elo || 1200,
            memberSince: user.createdAt ? user.createdAt.toISOString() : null,
        };

        const query = {
            $or: [{ whitePlayer: clerkId }, { blackPlayer: clerkId }],
            status: 'completed',
            result: { $ne: 'aborted' }, // exclude aborted games
        };

        // ── Recent games query ──
        // whitePlayer/blackPlayer store Clerk ID strings
        
        const [totalRecentGames, games] = await Promise.all([
            Game.countDocuments(query),
            Game.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        // ── Opponent enrichment (manual User lookup) ──
        const opponentClerkIds = new Set();
        for (const g of games) {
            const oppId = g.whitePlayer === clerkId ? g.blackPlayer : g.whitePlayer;
            if (oppId) opponentClerkIds.add(oppId);
        }

        const opponentUsers = opponentClerkIds.size > 0
            ? await User.find(
                { clerkId: { $in: [...opponentClerkIds] } },
                'clerkId firstName lastName username imageUrl'
            ).lean()
            : [];

        const opponentMap = {};
        for (const u of opponentUsers) {
            opponentMap[u.clerkId] = u;
        }

        // ── Build recentGames ──
        const recentGames = games.map((game) => {
            const isWhite = game.whitePlayer === clerkId;
            const userColor = isWhite ? 'white' : 'black';
            const opponentClerkId = isWhite ? game.blackPlayer : game.whitePlayer;
            const opponent = opponentMap[opponentClerkId];

            // result conversion: game.result (white|black|draw) → user perspective (win|loss|draw)
            let result;
            if (game.result === 'draw') {
                result = 'draw';
            } else if (game.result === userColor) {
                result = 'win';
            } else {
                result = 'loss';
            }

            // opponentName with fallback chain
            let opponentName = 'Misafir';
            if (opponent) {
                opponentName = opponent.username
                    || (opponent.firstName && opponent.lastName
                        ? `${opponent.firstName} ${opponent.lastName}`
                        : opponent.firstName || opponent.lastName)
                    || 'Anonymous';
            } else if (opponentClerkId && opponentClerkId.startsWith('guest_')) {
                opponentName = 'Misafir';
            }

            // tempoCategory
            let tempoCategory = 'rapid'; // default
            const timeMinutes = game.timeControl?.time;
            if (timeMinutes != null) {
                if (timeMinutes <= 2) tempoCategory = 'bullet';
                else if (timeMinutes <= 5) tempoCategory = 'blitz';
                else if (timeMinutes <= 15) tempoCategory = 'rapid';
                else tempoCategory = 'classical';
            }

            // moveCount: prefer clock.moveCount, fallback PGN parse, fallback 0
            let moveCount = 0;
            if (game.clock?.moveCount != null) {
                moveCount = game.clock.moveCount;
            } else if (game.pgn) {
                try {
                    const chess = new Chess();
                    chess.loadPgn(game.pgn);
                    moveCount = chess.history().length;
                } catch {
                    moveCount = 0;
                }
            }

            return {
                id: game._id.toString(),
                opponentName,
                opponentImageUrl: opponent?.imageUrl || null,
                result,
                resultReason: game.resultReason || null,
                tempo: game.timeControl?.label || null,
                tempoCategory,
                moveCount,
                playedAt: game.createdAt ? game.createdAt.toISOString() : null,
                userColor,
            };
        });

        // Pagination metadata
        const totalPages = Math.ceil(totalRecentGames / limit);
        const pagination = {
            page,
            limit,
            totalRecentGames,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
        };

        // ── Response ──
        res.json({ stats, recentGames, pagination });
    } catch (error) {
        console.error('❌ [Profile] Overview error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = {
    getProfileOverview,
};
