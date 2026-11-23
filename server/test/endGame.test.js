'use strict';

// Thursday End Screen data: the END compiler and the game:end payload.

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../gameEngine');
const { NODE_IDS } = engine;
const { playGame, okModeration, withLoom } = require('./playGame');

// TASK-601 ------------------------------------------------------------------

test('END compiles the End Screen data once, after Cycle 5, and emits game:end', async () => {
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    const out = await playGame({ gameId: 'enddata-01', world: 'BB' });
    const end = out.gameEnd;
    assert.ok(end, 'game:end emitted');
    assert.equal(out.game.endData, end, 'stored on the game for late or reconnecting hosts');
    assert.equal(end.gameId, 'enddata-01');
    assert.equal(end.cyclesPlayed, 5);
    assert.equal(end.finalGdw, out.game.gdw);
    assert.equal(end.shutdown, false);
    assert.equal(end.grade, engine.gradeFor(end.finalGdw));
    assert.equal(end.gradeText, engine.GRADE_TEXT[end.grade]);
    assert.equal(end.worldKey, 'BB');
    assert.equal(end.worldName, 'The Gilded Cage');
    assert.deepEqual(Object.keys(end.scores), NODE_IDS);
    for (const node of NODE_IDS) assert.equal(end.scores[node], out.game.scores[node]);
    assert.ok(end.closingMessage && end.closingMessage.text, 'closing citizen line');
  });
});

test('END data is compiled early when realized GDW hits 0, and resetGame clears it', async () => {
  const game = new engine.GameState({ roomCode: 'ENDX' });
  const log = console.log;
  console.log = () => {};
  try {
    NODE_IDS.forEach((n, i) => game.addPlayer(`s${i}`, `P${i}`));
    game.cycle = 2;
    game.worldKey = null;
    game.gdw = 0;
    game.ending = 'shutdown';
    let emitted = null;
    game.on('game:end', (d) => { emitted = d; });
    game.startEndPhase();
    assert.equal(game.phase, 'END');
    assert.equal(emitted.shutdown, true);
    assert.equal(emitted.cyclesPlayed, 2);
    assert.equal(emitted.finalGdw, 0);
    assert.equal(emitted.grade, 'SHUTDOWN');
    assert.equal(emitted.gradeText, 'The Loom has shut down');
    assert.equal(emitted.worldKey, null);
    game.resetGame();
    assert.equal(game.endData, null);
  } finally {
    game.clearPhaseTimer();
    console.log = log;
  }
});

// TASK-602 ------------------------------------------------------------------

test('gradeFor maps final GDW to SHUTDOWN / Fragile / Stable / Thriving', () => {
  assert.equal(engine.gradeFor(0), 'SHUTDOWN');
  assert.equal(engine.gradeFor(12.3), 'Fragile');
  assert.equal(engine.gradeFor(47), 'Stable');
  assert.equal(engine.gradeFor(81.4), 'Thriving');
  assert.equal(engine.gradeFor(NaN), 'SHUTDOWN', 'a broken number never reads as a success');
});

// TASK-603 ------------------------------------------------------------------

test('game:end gdwHistory holds the starting 25 plus all 60 realized months, with cycle markers', async () => {
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    const out = await playGame({ gameId: 'enddata-history', world: 'AA' });
    const { gdwHistory, cycleMarkers } = out.gameEnd;
    assert.equal(gdwHistory.length, 61);
    assert.equal(gdwHistory[0], out.game.startGdw);
    assert.equal(gdwHistory[60], out.gameEnd.finalGdw);
    assert.deepEqual(cycleMarkers.map((m) => m.cycle), [1, 2, 3, 4, 5]);
    assert.deepEqual(cycleMarkers.map((m) => m.index), [12, 24, 36, 48, 60]);
    // Each marker's GDW is the realized GDW the resolution showed for that cycle.
    assert.deepEqual(cycleMarkers.map((m) => m.gdw), out.resolutions.map((r) => r.gdw));
    assert.notEqual(gdwHistory, out.game.gdwHistory, 'a copy, not the live array');
  });
});

test('on a shutdown, gdwHistory stops at the month GDW hit 0', () => {
  const game = new engine.GameState({ roomCode: 'ENDH' });
  game.gdwHistory = [25, ...Array.from({ length: 12 }, (_, i) => 24 - i), 9, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  game.cycleMarkers = [{ cycle: 1, index: 12, gdw: 13 }, { cycle: 2, index: 24, gdw: 0 }];
  const { gdwHistory, cycleMarkers } = game.endGdwHistory();
  assert.equal(gdwHistory.length, 16, 'start + 12 months + 3 months to the shutdown');
  assert.equal(gdwHistory.at(-1), 0);
  assert.deepEqual(cycleMarkers, [{ cycle: 1, index: 12, gdw: 13 }, { cycle: 2, index: 15, gdw: 0 }]);
});

// TASK-604 ------------------------------------------------------------------

test('game:end roles reveal maps NODE-01..05 to name, character and per-cycle scores', async () => {
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    const out = await playGame({ gameId: 'enddata-roles', world: 'AB' });
    const { roles, scores } = out.gameEnd;
    assert.deepEqual(roles.map((r) => r.node), NODE_IDS);
    assert.deepEqual(roles.map((r) => r.name), ['P0', 'P1', 'P2', 'P3', 'P4']);
    assert.deepEqual(roles.map((r) => r.role.key).sort(), ['humanist', 'optimist', 'pragmatist', 'radical', 'traditionalist']);
    for (const r of roles) {
      assert.equal(r.role.key, out.roles[r.node], `${r.node} reveals the role it was dealt`);
      assert.ok(r.role.name && r.role.portrait && r.role.motto, 'character name, portrait and motto');
      assert.deepEqual(r.perCycle.map((c) => c.cycle), [1, 2, 3, 4, 5]);
      for (const c of r.perCycle) assert.ok(c.points >= 0 && c.points <= 100, 'each round is worth 0-100');
      const sum = r.perCycle.reduce((t, c) => t + c.points, 0);
      assert.equal(sum, r.total, `${r.node} breakdown adds up`);
      assert.equal(r.total, scores[r.node]);
    }
  });
});

// TASK-605 ------------------------------------------------------------------

test('game:end authors reveal maps POLICY-1..5 to author, Borda points, placement and tags', async () => {
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    const out = await playGame({ gameId: 'enddata-authors', world: 'BA' });
    const { authors } = out.gameEnd;
    assert.deepEqual(authors.map((a) => a.id), ['POLICY-1', 'POLICY-2', 'POLICY-3', 'POLICY-4', 'POLICY-5']);
    assert.deepEqual(authors.map((a) => a.node).sort(), NODE_IDS, 'one policy per node');
    assert.deepEqual(authors.map((a) => a.place).sort(), [1, 2, 3, 4, 5]);
    assert.equal(authors.reduce((t, a) => t + a.points, 0), 50, '5 ballots x (4+3+2+1)');
    const finale = out.resolutions[4].result;
    for (const a of authors) {
      assert.equal(a.node, out.game.finaleAuthor(a.id));
      assert.equal(a.name, out.game.players[a.node].name);
      const row = finale.tally.find((t) => t.id === a.id);
      assert.equal(a.points, row.points);
      const enacted = finale.enacted.find((e) => e.id === a.id);
      assert.equal(a.weight, enacted ? enacted.weight : 0);
      assert.ok(a.roles.length <= 2);
    }
    // Places follow the public tally order.
    assert.deepEqual(finale.tally.map((t) => authors.find((a) => a.id === t.id).place), [1, 2, 3, 4, 5]);
  });
});

test('a new game never reveals the previous game\'s finale authors', async () => {
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    const out = await playGame({ gameId: 'enddata-stale', world: 'AA' });
    assert.equal(out.gameEnd.authors.length, 5);
    const log = console.log;
    console.log = () => {};
    out.game.resetGame();
    console.log = log;
    out.game.clearPhaseTimer();
    assert.equal(out.game.finale, null);
    assert.deepEqual(out.game.endAuthors(), []);
  });
});

// TASK-606 ------------------------------------------------------------------

test('game:end winner is every top-scoring node, or null when the Loom shut down', async () => {
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    const out = await playGame({ gameId: 'enddata-winner', world: 'AA' });
    const { winner, scores, sharedWin } = out.gameEnd;
    const top = Math.max(...Object.values(scores));
    assert.deepEqual(winner, NODE_IDS.filter((n) => scores[n] === top));
    assert.equal(sharedWin, winner.length > 1);
  });
  assert.deepEqual(engine.determineWinners({ 'NODE-01': 3, 'NODE-02': 5, 'NODE-03': 1 }, 40), ['NODE-02']);
  assert.equal(engine.determineWinners({ 'NODE-01': 3, 'NODE-02': 5 }, 0), null, 'shutdown: nobody wins');
});

// TASK-607 ------------------------------------------------------------------

test('game:end carries the game id seed and the per-cycle realized-run seeds', async () => {
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    const out = await playGame({ gameId: 'enddata-seed', world: 'BB' });
    assert.equal(out.gameEnd.seed, 'enddata-seed');
    assert.deepEqual(out.gameEnd.cycleSeeds, [1, 2, 3, 4, 5].map((c) => engine.hashSeed('enddata-seed', c)));
    for (const s of out.gameEnd.cycleSeeds) assert.ok(Number.isInteger(s) && s >= 0 && s < 2 ** 32);
  });
});

// TASK-620 ------------------------------------------------------------------

/** A seated game at END-time with hand-set scores and final GDW. */
function finishedGame(scores, gdw, ending = null) {
  const log = console.log;
  console.log = () => {};
  const game = new engine.GameState({ roomCode: 'WIN' });
  NODE_IDS.forEach((n, i) => game.addPlayer(`s${i}`, `P${i}`));
  console.log = log;
  game.cycle = 5;
  game.scores = { ...scores };
  game.gdw = gdw;
  game.ending = ending;
  return game.compileEndData();
}

test('game:end winner: a single top scorer wins alone', () => {
  const end = finishedGame({ 'NODE-01': 2, 'NODE-02': 6, 'NODE-03': 3, 'NODE-04': 1, 'NODE-05': 0 }, 44.2);
  assert.deepEqual(end.winner, ['NODE-02']);
  assert.equal(end.sharedWin, false);
  assert.equal(end.shutdown, false);
});

test('game:end winner: a 2-way tie on the top score is a shared win', () => {
  const end = finishedGame({ 'NODE-01': 5, 'NODE-02': 3, 'NODE-03': 5, 'NODE-04': 1, 'NODE-05': 4 }, 61);
  assert.deepEqual(end.winner, ['NODE-01', 'NODE-03']);
  assert.equal(end.sharedWin, true);
});

test('game:end winner: GDW 0% shutdown means nobody wins, whatever the scores', () => {
  const end = finishedGame({ 'NODE-01': 9, 'NODE-02': 3, 'NODE-03': 1, 'NODE-04': 1, 'NODE-05': 0 }, 0, 'shutdown');
  assert.equal(end.winner, null);
  assert.equal(end.sharedWin, false);
  assert.equal(end.shutdown, true);
  assert.equal(end.grade, 'SHUTDOWN');
});

// TASK-621 ------------------------------------------------------------------

test('game:end grade at the boundary values 0, 1, 34, 35, 59, 60, 100', () => {
  const cases = [[0, 'SHUTDOWN'], [1, 'Fragile'], [34, 'Fragile'], [35, 'Stable'], [59, 'Stable'], [60, 'Thriving'], [100, 'Thriving']];
  for (const [gdw, grade] of cases) {
    assert.equal(engine.gradeFor(gdw), grade, `gradeFor(${gdw})`);
    const end = finishedGame({ 'NODE-01': 1 }, gdw, gdw === 0 ? 'shutdown' : null);
    assert.equal(end.grade, grade, `game:end grade at GDW ${gdw}`);
    assert.equal(end.gradeText, engine.GRADE_TEXT[grade]);
  }
  // One-decimal GDW between the integer bands.
  assert.equal(engine.gradeFor(0.1), 'Fragile');
  assert.equal(engine.gradeFor(34.9), 'Fragile');
  assert.equal(engine.gradeFor(59.9), 'Stable');
});

// TASK-623 ------------------------------------------------------------------

test('host:playAgain clears scores, Overrides, votes and End Screen data and resets GDW to 25', async () => {
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    // Play a full game, then mark an Override spent and a vote cast so there is something to clear.
    const out = await playGame({ gameId: 'play-again', world: 'AA' });
    const { game } = out;
    game.overridesUsed['NODE-01'] = true;
    game.votes = { 'NODE-01': { choice: 'A', override: true } };
    assert.ok(out.gameEnd, 'a finished game');
    assert.notEqual(game.gdw, game.startGdw);

    const log = console.log;
    console.log = () => {};
    let result;
    try {
      result = game.playAgain({ keepPlayers: true });
    } finally {
      game.clearPhaseTimer();
      console.log = log;
    }
    assert.equal(result.ok, true);
    assert.equal(game.phase, 'LOBBY');
    assert.equal(game.gdw, game.startGdw);
    assert.deepEqual(game.gdwHistory, []);
    assert.deepEqual(game.votes, {});
    for (const node of NODE_IDS) {
      assert.equal(game.scores[node], 0, `${node} score`);
      assert.equal(game.overridesUsed[node], false, `${node} Override back`);
      assert.equal(game.overrideAvailable(node), true);
    }
    assert.deepEqual(game.scoreLedger, []);
    assert.equal(game.endData, null);
    assert.equal(game.finale, null);
    assert.equal(game.worldKey, null);
    assert.equal(game.cycle, 0);
    assert.notEqual(game.gameId, 'play-again', 'fresh seeds');
  });
});

// TASK-626 ------------------------------------------------------------------

test('replaying a fixed seed with identical votes gives identical final scores, GDW and End Screen', async () => {
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    const runs = [];
    for (let i = 0; i < 2; i++) runs.push(await playGame({ gameId: 'replay-seed-626', world: 'BA' }));
    const [a, b] = runs.map((r) => r.gameEnd);
    assert.equal(a.finalGdw, b.finalGdw);
    assert.deepEqual(a.gdwHistory, b.gdwHistory);
    assert.deepEqual(a.scores, b.scores);
    assert.deepEqual(a.winner, b.winner);
    assert.deepEqual(a.roles.map((r) => [r.node, r.role.key, r.total]), b.roles.map((r) => [r.node, r.role.key, r.total]));
    assert.deepEqual(a.authors, b.authors);
    assert.deepEqual(a.closingMessage, b.closingMessage);
    // A different seed with the same votes plays out differently.
    const other = await playGame({ gameId: 'replay-seed-other', world: 'BA' });
    assert.notDeepEqual(other.gameEnd.gdwHistory, a.gdwHistory);
  });
});

// TASK-637 ------------------------------------------------------------------

test('game:end authors reveal says when Cycle 5 fell back to the authored A/B finale', async () => {
  // Offline (no key, no mock): moderation is unavailable, so the finale falls back.
  const fallback = await playGame({ gameId: 'authors-fallback', world: 'BB' });
  assert.equal(fallback.gameEnd.finaleMode, 'fallback');
  assert.equal(fallback.gameEnd.finaleFallback, true);
  assert.deepEqual(fallback.gameEnd.authors, [], 'no unmoderated write-ins are revealed');

  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    const writein = await playGame({ gameId: 'authors-writein', world: 'BB' });
    assert.equal(writein.gameEnd.finaleMode, 'writein');
    assert.equal(writein.gameEnd.finaleFallback, false);
    assert.equal(writein.gameEnd.authors.length, 5);
    assert.ok(writein.gameEnd.authors.every((a) => a.fallback === false));
  });

  // A shutdown before Cycle 5: no finale at all.
  const game = new engine.GameState({ roomCode: 'NOFIN' });
  game.cycle = 3;
  game.gdw = 0;
  game.ending = 'shutdown';
  const end = game.compileEndData();
  assert.equal(end.finaleMode, 'none');
  assert.equal(end.finaleFallback, false);
  assert.deepEqual(end.authors, []);
});

// TASK-638 ------------------------------------------------------------------

test('closingMessage always has a citizen name, district and text, even offline or after an early shutdown', async () => {
  const check = (c, label) => {
    assert.ok(c, `${label}: closingMessage present`);
    for (const k of ['name', 'district', 'text']) assert.ok(typeof c[k] === 'string' && c[k].length > 0, `${label}: ${k}`);
  };
  // Offline full game (no key): the simulation's pick.
  const offline = await playGame({ gameId: 'closing-offline', world: 'AA' });
  check(offline.gameEnd.closingMessage, 'offline game');

  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    // Shutdown in Cycle 2 with no simulation state at all.
    const early = new engine.GameState({ roomCode: 'CLS1' });
    early.cycle = 2;
    early.gdw = 0;
    early.ending = 'shutdown';
    early.startEndPhase();
    check(early.endData.closingMessage, 'early shutdown');
    assert.equal(early.endData.closingMessage.band, 'bad');
    early.clearPhaseTimer();

    // Citizen data missing entirely: the built-in voice.
    const bare = new engine.GameState({ roomCode: 'CLS2' });
    bare.data = { ...bare.data, citizens: [] };
    bare.cycle = 5;
    bare.gdw = 48;
    bare.startEndPhase();
    check(bare.endData.closingMessage, 'no citizen data');
    assert.equal(bare.endData.closingMessage.band, 'good');
    bare.clearPhaseTimer();
  } finally {
    console.log = log;
    console.error = err;
  }
});

// TASK-648 ------------------------------------------------------------------

/** Play a game whose Cycle 3 uses severe negative effects and collapses to GDW 0. */
async function collapseInCycle3(gameId) {
  const sim = require('../sim');
  const realSimulate = sim.simulate;
  let collapse = false;
  sim.simulate = (state, effects, options) => {
    if (!collapse) return realSimulate(state, effects, options);
    const forcedState = { ...state, simState: sim.cloneState(state.simState) };
    forcedState.simState.traits.fill(0.4); // low, but nonzero, Cycle 3 starting wellbeing
    const negativeEffects = Object.fromEntries(forcedState.simState.traitNames.map((trait) => [trait, -1]));
    const result = realSimulate(forcedState, negativeEffects, { ...options, runs: 1 });
    if (result.realized.finalGdw !== 0) throw new Error('severe negative Cycle 3 effects did not collapse the region');
    return result;
  };
  try {
    return await playGame({
      gameId,
      world: 'AB',
      onEvent: (type, ev) => { if (type === 'phase' && ev.phase === 'VOTE') collapse = ev.cycle === 3; }
    });
  } finally {
    sim.simulate = realSimulate;
  }
}

test('Shutdown Ending: severe negative Cycle 3 effects collapse the region and RESOLUTION goes straight to END', async () => {
  const out = await collapseInCycle3('shutdown-648');
  const after = out.phases.slice(out.phases.indexOf('3:RESOLUTION'));
  assert.deepEqual(after, ['3:RESOLUTION', '3:END'], 'no Cycle 4, no finale');
  assert.equal(out.resolutions.length, 3);
  assert.equal(out.resolutions[2].gdw, 0);
  assert.equal(out.resolutions[2].realized.collapsed, true);
  assert.ok(out.resolutions[2].realized.gdw.findIndex((gdw, month) => month > 0 && gdw === 0) > 0, 'the realized trajectory reaches zero during Cycle 3');
  const end = out.gameEnd;
  assert.equal(end.shutdown, true);
  assert.equal(end.grade, 'SHUTDOWN');
  assert.equal(end.winner, null, 'everyone loses');
  assert.equal(end.cyclesPlayed, 3);
  assert.equal(end.finaleMode, 'none');
  assert.equal(end.gdwHistory.at(-1), 0);
  assert.ok(end.gdwHistory.length < 37, 'the line stops at the shutdown month');
});

// TASK-649 ------------------------------------------------------------------


// TASK-650 ------------------------------------------------------------------

test('game:end Borda points match an independent recount of the ballots', async () => {
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    for (const world of ['AA', 'BB']) {
      const out = await playGame({ gameId: `borda-650-${world}`, world });
      // Phones ranked their ballots in the order dealt: recount 4/3/2/1 by hand.
      const points = {};
      for (const b of out.ballots) b.policies.forEach((p, i) => { points[p.id] = (points[p.id] || 0) + [4, 3, 2, 1][i]; });
      const { authors, roles } = out.gameEnd;
      for (const a of authors) assert.equal(a.points, points[a.id] || 0, `${world} ${a.id} Borda points`);
      const first = authors.find((a) => a.place === 1);
      assert.equal(first.weight, 0.5);
      assert.ok(authors.every((a) => a.place === 1 || a.points <= first.points), 'first place has the most points');
      // Cycle 5 scores the enacted package like any round: 0-100 per member.
      for (const r of roles) {
        const c5 = r.perCycle.find((c) => c.cycle === 5);
        assert.ok(c5.points >= 0 && c5.points <= 100, `${world} ${r.node} cycle 5 points in 0..100`);
      }
    }
  });
});
