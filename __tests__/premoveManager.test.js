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
        expect(premove).toMatchObject({ from: 'd7', to: 'd5' });
        expect(premove.setAt).toEqual(expect.any(Number));

        // White should have no premove
        expect(PremoveManager.getPremove(gameId, 'white')).toBeNull();
    });

    // ——— Test 2: Overwrite premove → last one wins ———
    test('setPremove overwrites existing premove for same color', () => {
        PremoveManager.setPremove(gameId, 'black', { from: 'd7', to: 'd5', sourceMoveNo: 1 });
        PremoveManager.setPremove(gameId, 'black', { from: 'e7', to: 'e5', sourceMoveNo: 3 });

        const premove = PremoveManager.getPremove(gameId, 'black');
        expect(premove).toMatchObject({ from: 'e7', to: 'e5' });
        expect(premove.sourceMoveNo).toBe(3);
    });

    // ——— Test 3: clearPremove clears specific color ———
    test('clearPremove removes premove for specific color', () => {
        PremoveManager.setPremove(gameId, 'white', { from: 'e2', to: 'e4' });
        PremoveManager.setPremove(gameId, 'black', { from: 'd7', to: 'd5' });

        PremoveManager.clearPremove(gameId, 'white', 'cancelled');

        expect(PremoveManager.getPremove(gameId, 'white')).toBeNull();
        expect(PremoveManager.getPremove(gameId, 'black')).toMatchObject({ from: 'd7', to: 'd5' });
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
        expect(premove).toMatchObject({ from: 'e7', to: 'e8', promotion: 'q' });
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

    // ——— Test 10: enriched payload — setAt and sourceMoveNo stored ———
    test('setPremove stores setAt and sourceMoveNo', () => {
        const setAt = Date.now();
        PremoveManager.setPremove(gameId, 'white', {
            from: 'e2', to: 'e4', setAt, sourceMoveNo: 0
        });

        const premove = PremoveManager.getPremove(gameId, 'white');
        expect(premove.setAt).toBe(setAt);
        expect(premove.sourceMoveNo).toBe(0);
    });

    // ——— Test 11: overwrite preserves latest sourceMoveNo ———
    test('overwrite keeps latest enriched fields', () => {
        PremoveManager.setPremove(gameId, 'black', {
            from: 'd7', to: 'd5', setAt: 1000, sourceMoveNo: 1
        });
        PremoveManager.setPremove(gameId, 'black', {
            from: 'c7', to: 'c5', setAt: 2000, sourceMoveNo: 3
        });

        const premove = PremoveManager.getPremove(gameId, 'black');
        expect(premove).toMatchObject({ from: 'c7', to: 'c5' });
        expect(premove.setAt).toBe(2000);
        expect(premove.sourceMoveNo).toBe(3);
    });

    // ——— Test 12: hasPremove convenience ———
    test('hasPremove returns correct boolean', () => {
        expect(PremoveManager.hasPremove(gameId, 'white')).toBe(false);

        PremoveManager.setPremove(gameId, 'white', { from: 'e2', to: 'e4' });
        expect(PremoveManager.hasPremove(gameId, 'white')).toBe(true);
        expect(PremoveManager.hasPremove(gameId, 'black')).toBe(false);

        PremoveManager.clearPremove(gameId, 'white', 'test');
        expect(PremoveManager.hasPremove(gameId, 'white')).toBe(false);
    });

    // ——— Test 13: rehydrate from DB-shaped object ———
    test('rehydrate populates in-memory store from DB object', () => {
        const dbPremoves = {
            white: { from: 'e2', to: 'e4', promotion: null, setAt: 1234, sourceMoveNo: 0 },
            black: { from: 'd7', to: 'd5', promotion: null, setAt: 5678, sourceMoveNo: 1 }
        };

        PremoveManager.rehydrate(gameId, dbPremoves);

        const white = PremoveManager.getPremove(gameId, 'white');
        expect(white).toMatchObject({ from: 'e2', to: 'e4' });
        expect(white.setAt).toBe(1234);
        expect(white.sourceMoveNo).toBe(0);

        const black = PremoveManager.getPremove(gameId, 'black');
        expect(black).toMatchObject({ from: 'd7', to: 'd5' });
        expect(black.setAt).toBe(5678);
        expect(black.sourceMoveNo).toBe(1);
    });

    // ——— Test 14: rehydrate skips null/empty entries ———
    test('rehydrate skips entries with null from/to', () => {
        const dbPremoves = {
            white: { from: null, to: null, promotion: null },
            black: { from: 'e7', to: 'e5', promotion: null }
        };

        PremoveManager.rehydrate(gameId, dbPremoves);

        expect(PremoveManager.getPremove(gameId, 'white')).toBeNull();
        expect(PremoveManager.getPremove(gameId, 'black')).toMatchObject({ from: 'e7', to: 'e5' });
    });

    // ——— Test 15: rehydrate with null queuedPremoves is a no-op ———
    test('rehydrate with null does nothing', () => {
        PremoveManager.rehydrate(gameId, null);
        expect(PremoveManager._store.has(gameId)).toBe(false);
    });

    // ——— Test 16: race — set + clear under same lock serializes correctly ———
    test('set then clear under lock: clear wins', async () => {
        const results = [];

        const op1 = PremoveManager.withLock(gameId, async () => {
            PremoveManager.setPremove(gameId, 'white', { from: 'e2', to: 'e4' });
            results.push('set');
        });

        const op2 = PremoveManager.withLock(gameId, async () => {
            PremoveManager.clearPremove(gameId, 'white', 'cancelled');
            results.push('clear');
        });

        await Promise.all([op1, op2]);

        expect(results).toEqual(['set', 'clear']);
        expect(PremoveManager.getPremove(gameId, 'white')).toBeNull();
    });

    // ——— Test 17: parallel games isolation ———
    test('premoves in different games do not interfere', () => {
        const gameA = 'game_a';
        const gameB = 'game_b';

        PremoveManager.setPremove(gameA, 'white', { from: 'e2', to: 'e4' });
        PremoveManager.setPremove(gameB, 'white', { from: 'd2', to: 'd4' });

        expect(PremoveManager.getPremove(gameA, 'white')).toMatchObject({ from: 'e2', to: 'e4' });
        expect(PremoveManager.getPremove(gameB, 'white')).toMatchObject({ from: 'd2', to: 'd4' });

        PremoveManager.clearAll(gameA, 'game_over');
        expect(PremoveManager.getPremove(gameA, 'white')).toBeNull();
        expect(PremoveManager.getPremove(gameB, 'white')).toMatchObject({ from: 'd2', to: 'd4' });
    });

    // ——— Test 18: clearAll on game over clears both colors ———
    test('clearAll clears both colors and removes store entry', () => {
        PremoveManager.setPremove(gameId, 'white', { from: 'e2', to: 'e4' });
        PremoveManager.setPremove(gameId, 'black', { from: 'd7', to: 'd5' });

        expect(PremoveManager.hasPremove(gameId, 'white')).toBe(true);
        expect(PremoveManager.hasPremove(gameId, 'black')).toBe(true);

        PremoveManager.clearAll(gameId, 'game_over');

        expect(PremoveManager.hasPremove(gameId, 'white')).toBe(false);
        expect(PremoveManager.hasPremove(gameId, 'black')).toBe(false);
        expect(PremoveManager._store.has(gameId)).toBe(false);
        expect(PremoveManager._locks.has(gameId)).toBe(false);
    });
});
