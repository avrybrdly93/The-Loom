'use strict';

// Headless whole-game playthroughs (Wednesday post-merge integration): the
// real engine, simulation, content and Loom module, all 5 cycles to END on
// shrunk phase timers. No network: GEMINI_API_KEY is unset unless a test
// injects its own Loom config and fetch.

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../gameEngine');
const loom = require('../loom');
const { NODE_IDS } = engine;
const { playGame, okModeration, withLoom } = require('./playGame');

const FINALE_FLOW = ['5:INCIDENT', '5:FINALE_WRITE', '5:FINALE_MOD', '5:FINALE_DEBATE', '5:FINALE_RANK', '5:FINALE_ENACT', '5:END'];
const FALLBACK_FLOW = ['5:INCIDENT', '5:FINALE_WRITE', '5:FINALE_MOD', '5:DEBATE', '5:VOTE', '5:RESOLUTION', '5:END'];
// Cycles 3-5 on the crisis tree when cycle 3 goes to A (the default late vote).
const WORLD_CRISES = {
  AA: ['aa-purpose-drift', 'aa-robot-art', 'aa-fake-struggle'],
  AB: ['ab-the-pods', 'ab-curated-bonds', 'ab-merge-offer'],
  BA: ['ba-shadow-elite', 'ba-media-monopoly', 'ba-vote-to-seize'],
  BB: ['bb-scroll-extinction', 'bb-the-unplugged', 'bb-march-datacenter']
};

function incidentsByCycle(out) {
  return Object.fromEntries(out.payloads.filter((p) => p.phase === 'INCIDENT').map((p) => [p.cycle, p.crisis && p.crisis.id]));
}

// TASK-574 ------------------------------------------------------------------

test('post-merge: Cycle 5 write-and-rank flows FINALE_WRITE -> FINALE_MOD -> FINALE_DEBATE -> FINALE_RANK -> FINALE_ENACT in every world', async () => {
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    for (const world of Object.keys(WORLD_CRISES)) {
      const out = await playGame({ gameId: `finaleflow-${world}`, world });
      assert.deepEqual(out.phases.filter((p) => p.startsWith('5:')), FINALE_FLOW, `${world} finale phases`);
      assert.equal(incidentsByCycle(out)[5], WORLD_CRISES[world][2], `${world} finale crisis`);

      // FINALE_DEBATE shows 5 anonymous policies: ids and text only.
      const debate = out.payloads.find((p) => p.phase === 'FINALE_DEBATE');
      const policies = debate.policies || (debate.finale && debate.finale.policies);
      assert.equal(policies.length, 5, `${world} debate policies`);
      for (const p of policies) {
        assert.deepEqual(Object.keys(p).sort(), ['id', 'text'], 'no authors, tags or effects on the projector');
        assert.match(p.id, /^POLICY-[1-5]$/);
      }

      // Each phone ranks exactly the 4 policies it did not write.
      assert.equal(out.ballots.length, 5);
      for (const b of out.ballots) {
        assert.equal(b.policies.length, 4);
        assert.ok(!b.policies.some((p) => out.game.finaleAuthor(p.id) === b.node), `${b.node} never ranks its own policy`);
      }

      // FINALE_ENACT enacts the Borda top three at 50/25/25 and simulates them.
      const finale = out.resolutions[4].result;
      assert.equal(finale.finale, true);
      assert.deepEqual(finale.enacted.map((e) => e.weight), [0.5, 0.25, 0.25]);
      assert.deepEqual(finale.enacted.map((e) => e.place), ['first', 'second', 'third']);
      assert.equal(out.game.gdwHistory.length, 1 + 5 * 12, `${world} has 60 months of realized GDW`);
    }
  });
});

// TASK-575 ------------------------------------------------------------------

test('post-merge: Worlds BA and BB play their own crises, Loom lines and finale across Cycles 3-5', async () => {
  const { crises } = engine.loadGameData();
  const byId = Object.fromEntries(crises.crises.map((c) => [c.id, c]));
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    for (const world of ['BA', 'BB']) {
      const out = await playGame({ gameId: `latecycles-${world}`, world });
      assert.equal(out.game.worldKey, world);
      assert.equal(out.reveals.length, 1, 'one world reveal after Cycle 2');
      assert.equal(out.reveals[0].worldKey, world);

      const incidents = incidentsByCycle(out);
      assert.deepEqual([incidents[3], incidents[4], incidents[5]], WORLD_CRISES[world], `${world} cycles 3-5`);

      // Cycles 3 and 4: no intel drops; the Loom says the crisis out loud to everyone.
      for (const cycle of [3, 4]) {
        const crisis = byId[WORLD_CRISES[world][cycle - 3]];
        assert.equal(out.intel.length, 0, 'intel drops are gone');
        const lines = out.game.loomFeed.filter((l) => l.cycle === cycle && l.kind === 'crisis');
        assert.ok(lines.some((l) => l.text.startsWith(crisis.title)), `${world} c${cycle} Loom names the crisis`);
        assert.ok(lines.every((l) => l.year === 2120 + cycle), 'cycle n is the year 2120 + n');
      }

      // Cycles 3 and 4 resolve as normal binary votes, Cycle 5 as the finale.
      assert.equal(out.resolutions.length, 5);
      assert.ok(['A', 'B'].includes(out.resolutions[2].result.winner));
      assert.ok(['A', 'B'].includes(out.resolutions[3].result.winner));
      assert.equal(out.resolutions[4].result.finale, true);
      assert.deepEqual(out.phases.filter((p) => p.startsWith('5:')), FINALE_FLOW);
    }
  });
});

// TASK-576 / TASK-577 -------------------------------------------------------

/** The exact phase sequence of an offline game that survives to Cycle 5. */
function expectedOfflinePhases() {
  const cycle = (c) => ['INCIDENT', 'DEBATE', 'VOTE', 'RESOLUTION'].map((p) => `${c}:${p}`);
  return [
    '0:INTRO', '0:ROLE_ASSIGN', '0:CHAMBER',
    ...cycle(1), ...cycle(2), '2:WORLD_REVEAL', ...cycle(3), ...cycle(4),
    ...FALLBACK_FLOW
  ];
}

/** Shared checks for an offline (no GEMINI_API_KEY) 5-cycle headless game. */
async function headlessOfflineRun(world) {
  const out = await playGame({ gameId: `headless-${world}`, world });
  const phases = out.phases.filter((p, i, a) => p !== a[i - 1]); // a resubmit/extension re-broadcast is one phase
  const expected = expectedOfflinePhases();
  // Cycle 0 lead-in phases may be numbered 0 or 1 depending on when the
  // engine bumps the counter; compare from the first INCIDENT on.
  assert.deepEqual(phases.slice(phases.indexOf('1:INCIDENT')), expected.slice(expected.indexOf('1:INCIDENT')), `${world} phase order`);
  assert.equal(out.game.worldKey, world);
  assert.deepEqual(Object.values(incidentsByCycle(out)).slice(2), WORLD_CRISES[world]);
  assert.equal(out.resolutions.length, 5);
  for (const r of out.resolutions) {
    assert.ok(Number.isFinite(r.gdw), 'every resolution reports a GDW');
    assert.ok(r.loomLine && r.loomLine.length > 0, 'offline Loom narration on every cycle');
    assert.ok(Array.isArray(r.messages) && r.messages.length > 0, 'offline authored citizen reactions appear on every cycle');
    assert.ok(r.messages.every((m) => m.citizenId && m.text), 'citizen fallback messages stay attributable and non-empty');
  }
  assert.equal(out.game.finaleFallback, true, 'offline moderation selects the authored A/B finale');
  assert.equal(out.gameEnd.finaleMode, 'fallback');
  assert.equal(out.gameEnd.finaleFallback, true);
  assert.deepEqual(out.gameEnd.authors, [], 'unmoderated write-ins are not attributed or displayed');
  assert.equal(out.game.gdwHistory.length, 1 + 5 * 12, '60 monthly points plus the start');
  assert.ok(out.game.gdw > 0, `${world} survived to the end`);
  for (const node of NODE_IDS) assert.ok(Number.isInteger(out.game.scores[node]), `${node} has an integer score`);
  // Same game id, same choices: the exact same realized GDW line.
  const again = await playGame({ gameId: `headless-${world}`, world });
  assert.deepEqual(again.game.gdwHistory, out.game.gdwHistory, `${world} replays deterministically`);
  return out;
}

test('headless 5-cycle playthrough on the BA (Uneasy Republic) branch reaches END offline', async () => {
  const out = await headlessOfflineRun('BA');
  assert.equal(out.game.volatility, 1.5, 'The Assembly (2A) keeps the rest of the game volatile');
});

test('headless 5-cycle playthrough on the BB (Gilded Cage) branch reaches END offline', async () => {
  const out = await headlessOfflineRun('BB');
  assert.equal(out.game.volatility, 1, 'Delegated Control (2B) keeps normal volatility');
  assert.ok(out.resolutions[0].gdw > 25, 'the easy 1B opening lifts GDW');
});

// TASK-578 ------------------------------------------------------------------

test('headless 5-cycle playthrough: a "revise" write-in in Cycle 5 is resubmitted, re-moderated and the finale completes', async () => {
  const JOKE = 'Make P4 clean every toilet in the Grid lol';
  const REVISED = 'Rotate essential maintenance shifts fairly across every district.';
  const oneCalls = [];
  await withLoom({
    moderate: async (subs) => okModeration(subs).map((r, i) => (subs[i].text === JOKE
      ? { node: r.node, status: 'revise', cleaned: '', feedback: 'Please keep it about policy, not a classmate.', roles: [], effects: {} }
      : r)),
    moderateOne: async (sub) => {
      oneCalls.push(sub);
      return { node: sub.node, status: 'ok', cleaned: sub.text, feedback: '', roles: ['artisan'], effects: { purpose: 0.2, connection: 0, health: 0, trust: 0.1, fairness: 0.2, autonomy: 0 } };
    }
  }, async () => {
    const out = await playGame({
      gameId: 'headless-revise',
      world: 'AA',
      writeIn: (i) => (i === 4 ? JOKE : `Council proposal number ${i + 1}`),
      onEvent: (type, ev, game) => {
        if (type === 'finale:feedback' && ev.status === 'revise') setImmediate(() => game.resubmitPolicy(ev.node, REVISED));
      }
    });
    // FINALE_MOD is re-broadcast once for the resubmit window, then the write-and-rank flow continues.
    const five = out.payloads.filter((p) => p.cycle === 5).map((p) => p.phase);
    assert.deepEqual(five, ['INCIDENT', 'FINALE_WRITE', 'FINALE_MOD', 'FINALE_MOD', 'FINALE_DEBATE', 'FINALE_RANK', 'FINALE_ENACT', 'END']);
    const resubmitWindow = out.payloads.filter((p) => p.phase === 'FINALE_MOD')[1];
    assert.equal(resubmitWindow.resubmit, true);
    assert.equal(resubmitWindow.revising, 1);

    // Only the joke's author was asked to revise, privately; nothing else leaked.
    const revise = out.feedback.filter((f) => f.status === 'revise');
    assert.deepEqual(revise.map((f) => f.node), ['NODE-05']);
    assert.deepEqual(oneCalls, [{ node: 'NODE-05', text: REVISED }], 'moderateOne sees one resubmission: node id and text only');

    // The revised text, not the joke, is what the council debates.
    const debate = out.payloads.find((p) => p.phase === 'FINALE_DEBATE');
    const texts = (debate.policies || debate.finale.policies).map((p) => p.text);
    assert.ok(texts.includes(REVISED));
    assert.ok(!texts.some((t) => /toilet|P4/.test(t)));
    assert.equal(out.resolutions[4].result.finale, true);
    assert.equal(out.game.gdwHistory.length, 1 + 5 * 12);
  });
});

// TASK-579 ------------------------------------------------------------------

test('headless 5-cycle playthrough: an 8-second Gemini timeout in Cycle 5 falls back to the authored A/B finale', { timeout: 40000 }, async () => {
  // The real loom.moderate, pointed at a Gemini that accepts the request and
  // never answers. Only the abort from the 8 s budget ends the call.
  const realModerate = loom.moderate;
  const requests = [];
  const hangingFetch = (url, init) => new Promise((resolve, reject) => {
    requests.push(url);
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });
  const config = { apiKey: 'test-key-not-real', enabled: true, model: 'gemini-2.5-flash', timeoutMs: 8000 };
  await withLoom({
    moderate: (subs, crisis, opts = {}) => realModerate(subs, crisis, { ...opts, config, fetchImpl: hangingFetch })
  }, async () => {
    // FINALE_MOD keeps its real 10 s length so the 8 s Loom timeout, not the phase timer, decides.
    const out = await playGame({ gameId: 'headless-timeout', world: 'BA', phaseSeconds: { FINALE_MOD: 10 }, guardMs: 35000 });
    assert.equal(requests.length, 1, 'one batch moderation request was sent');
    assert.ok(out.game.finale.moderationMs >= 8000, `moderation waited out the budget (${out.game.finale.moderationMs} ms)`);
    assert.ok(out.game.finale.moderationMs < 10000, 'and gave up before the FINALE_MOD timer');
    assert.equal(out.game.finaleFallback, true);
    assert.deepEqual(out.phases.filter((p) => p.startsWith('5:')), FALLBACK_FLOW);

    // The authored ba-vote-to-seize A/B is played and resolved normally.
    const vote = out.payloads.find((p) => p.cycle === 5 && p.phase === 'VOTE');
    assert.equal(vote.crisis.id, 'ba-vote-to-seize');
    assert.ok(out.game.crisis.options.A && out.game.crisis.options.B, 'the authored A/B options are in play');
    assert.ok(['A', 'B'].includes(out.resolutions[4].result.winner));
    assert.equal(out.game.gdwHistory.length, 1 + 5 * 12);
  });
});

// TASK-618 ------------------------------------------------------------------

test('internet drops mid-game: DNS and socket errors from the Loom never crash the engine', { timeout: 30000 }, async () => {
  const real = { narrate: loom.narrate, moderate: loom.moderate, moderateOne: loom.moderateOne };
  const config = { apiKey: 'test-key-not-real', enabled: true, model: 'gemini-2.5-flash', timeoutMs: 8000 };
  const netError = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`getaddrinfo ${code} generativelanguage.googleapis.com`), { code }) });
  const failures = ['ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH'];
  let calls = 0;
  // The classroom's internet is gone (the LAN hotspot is still up): every Gemini call fails at the network layer.
  const fetchImpl = async () => {
    calls++;
    throw netError(failures[calls % failures.length]);
  };
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    await withLoom({
      narrate: (ctx, opts = {}) => real.narrate(ctx, { ...opts, config, fetchImpl }),
      moderate: (subs, crisis, opts = {}) => real.moderate(subs, crisis, { ...opts, config, fetchImpl }),
      moderateOne: (sub, crisis, opts = {}) => real.moderateOne(sub, crisis, { ...opts, config, fetchImpl })
    }, async () => {
      const out = await playGame({ gameId: 'offline-midgame', world: 'BA' });
      assert.ok(calls >= 5, `the Loom was really called (${calls})`);
      assert.equal(out.end.phase, 'END');
      assert.deepEqual(out.phases.filter((p) => p.startsWith('5:')), FALLBACK_FLOW, 'moderation failed, so the authored A/B finale ran');
      assert.equal(out.resolutions.length, 5);
      for (const r of out.resolutions) assert.ok(r.loomLine, 'offline narration on every cycle');
      assert.ok(out.gameEnd && out.gameEnd.closingMessage, 'End Screen data still compiled');
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, [], 'no unhandled promise rejections');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
