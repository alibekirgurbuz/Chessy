const PremoveManager = require('../src/services/PremoveManager');

// Fresh PremoveManager for each test — we need to reset singleton state
beforeEach(() => {
    // Clear internal state via clearAll for any leftover games
    PremoveManager._store.clear();
    PremoveManager._locks.clear();
});

describe('PremoveManager', () => {
    const gameId = 'game_test_001';

    // ——— Test 1: Set and get premove ———
    test('setPremove stores and getPremove retrieves', () => {
        PremoveManager.setPremove(gameId, 'black', { from: 'd7', to: 'd5' });

        const premove = PremoveManager.getPremove(gameId, 'black');
        expect(premove).toEqual({ from: 'd7', to: 'd5', promotion: undefined });

        // White should have no premove
        expect(PremoveManager.getPremove(gameId, 'white')).toBeNull();
    });

    // ——— Test 2: Overwrite premove → last one wins ———
    test('setPremove overwrites existing premove for same color', () => {
        PremoveManager.setPremove(gameId, 'black', { from: 'd7', to: 'd5' });
        PremoveManager.setPremove(gameId, 'black', { from: 'e7', to: 'e5' });

        const premove = PremoveManager.getPremove(gameId, 'black');
        expect(premove).toEqual({ from: 'e7', to: 'e5', promotion: undefined });
    });

    // ——— Test 3: clearPremove clears specific color ———
    test('clearPremove removes premove for specific color', () => {
        PremoveManager.setPremove(gameId, 'white', { from: 'e2', to: 'e4' });
        PremoveManager.setPremove(gameId, 'black', { from: 'd7', to: 'd5' });

        PremoveManager.clearPremove(gameId, 'white', 'cancelled');

        expect(PremoveManager.getPremove(gameId, 'white')).toBeNull();
        expect(PremoveManager.getPremove(gameId, 'black')).toEqual({ from: 'd7', to: 'd5', promotion: undefined });
    });

    // ——— Test 4: clearAll removes everything for a game ———
    test('clearAll removes all premoves and store entry', () => {
        PremoveManager.setPremove(gameId, 'white', { from: 'e2', to: 'e4' });
        PremoveManager.setPremove(gameId, 'black', { from: 'd7', to: 'd5' });

        PremoveManager.clearAll(gameId, 'game_over');

        expect(PremoveManager.getPremove(gameId, 'white')).toBeNull();
        expect(PremoveManager.getPremove(gameId, 'black')).toBeNull();
        expect(PremoveManager._store.has(gameId)).toBe(false);
    });

    // ——— Test 5: getPremove returns null for unknown game ———
    test('getPremove returns null for non-existent game', () => {
        expect(PremoveManager.getPremove('unknown_game', 'white')).toBeNull();
    });

    // ——— Test 6: withLock serializes concurrent access ———
    test('withLock serializes concurrent operations', async () => {
        const order = [];

        const op1 = PremoveManager.withLock(gameId, async () => {
            await new Promise(r => setTimeout(r, 50));
            order.push('op1');
        });

        const op2 = PremoveManager.withLock(gameId, async () => {
            order.push('op2');
        });

        await Promise.all([op1, op2]);

        // op1 started first, op2 must wait
        expect(order).toEqual(['op1', 'op2']);
    });

    // ——— Test 7: withLock does NOT block different games ———
    test('withLock allows parallel access to different games', async () => {
        const order = [];

        const op1 = PremoveManager.withLock('game_a', async () => {
            await new Promise(r => setTimeout(r, 50));
            order.push('game_a');
        });

        const op2 = PremoveManager.withLock('game_b', async () => {
            order.push('game_b');
        });

        await Promise.all([op1, op2]);

        // game_b should complete before game_a since it doesn't wait
        expect(order).toEqual(['game_b', 'game_a']);
    });

    // ——— Test 8: promotion field preserved ———
    test('setPremove preserves promotion field', () => {
        PremoveManager.setPremove(gameId, 'white', { from: 'e7', to: 'e8', promotion: 'q' });

        const premove = PremoveManager.getPremove(gameId, 'white');
        expect(premove).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
    });

    // ——— Test 9: withLock error handling — lock released on error ———
    test('withLock releases lock even when fn throws', async () => {
        try {
            await PremoveManager.withLock(gameId, async () => {
                throw new Error('test error');
            });
        } catch (e) {
            // Expected
        }

        // Should be able to acquire lock again
        let called = false;
        await PremoveManager.withLock(gameId, async () => {
            called = true;
        });
        expect(called).toBe(true);
    });
});
