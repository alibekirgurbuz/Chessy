#!/usr/bin/env node
/**
 * Backfill User Stats from Game Collection
 *
 * Recalculates User.wins/losses/draws from completed Game records.
 * Safe to run multiple times — it always resets counters first.
 *
 * Usage:
 *   cd apps/backend
 *   node scripts/backfill-stats.js
 *
 * Requirements:
 *   - .env must contain MONGODB_URI
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Game = require('../src/models/Game');

async function backfillStats() {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
        console.error('❌ MONGODB_URI not set in .env');
        process.exit(1);
    }

    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // 1. Reset all user counters to 0
    const resetResult = await User.updateMany({}, {
        $set: { wins: 0, losses: 0, draws: 0 }
    });
    console.log(`🔄 Reset ${resetResult.modifiedCount} users' stats to 0`);

    // 2. Aggregate completed games (excluding aborted)
    const completedGames = await Game.find({
        status: 'completed',
        result: { $in: ['white', 'black', 'draw'] },
    }, 'whitePlayer blackPlayer result').lean();

    console.log(`📊 Found ${completedGames.length} completed games to process`);

    let applied = 0;
    for (const game of completedGames) {
        const { whitePlayer, blackPlayer, result } = game;

        if (result === 'white') {
            await User.updateOne({ clerkId: whitePlayer }, { $inc: { wins: 1 } });
            await User.updateOne({ clerkId: blackPlayer }, { $inc: { losses: 1 } });
        } else if (result === 'black') {
            await User.updateOne({ clerkId: blackPlayer }, { $inc: { wins: 1 } });
            await User.updateOne({ clerkId: whitePlayer }, { $inc: { losses: 1 } });
        } else if (result === 'draw') {
            await User.updateOne({ clerkId: whitePlayer }, { $inc: { draws: 1 } });
            await User.updateOne({ clerkId: blackPlayer }, { $inc: { draws: 1 } });
        }

        applied++;

        // Mark statsApplied on the game (if flag exists)
        await Game.updateOne({ _id: game._id }, { $set: { statsApplied: true } });
    }

    console.log(`✅ Applied stats for ${applied} games`);

    // 3. Show summary
    const users = await User.find({}, 'clerkId username wins losses draws').lean();
    console.log('\n📋 Updated User Stats:');
    console.log('─'.repeat(60));
    for (const u of users) {
        const total = (u.wins || 0) + (u.losses || 0) + (u.draws || 0);
        console.log(`  ${u.username || u.clerkId}: W${u.wins || 0} / L${u.losses || 0} / D${u.draws || 0} (total: ${total})`);
    }

    await mongoose.disconnect();
    console.log('\n✅ Done. Database connection closed.');
}

backfillStats().catch((err) => {
    console.error('❌ Backfill failed:', err);
    process.exit(1);
});
