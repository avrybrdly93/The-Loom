'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { simulate, createInitialState } = require('../index');
const simConfig = require('../../../data/sim.json');

const EFFECTS = { purpose: 0.3, connection: -0.2, health: 0.1, trust: -0.4, fairness: 0.5, autonomy: 0.2 };

test('simulate preserves the documented engine-facing input and output boundary', () => {
  const modelState = createInitialState(simConfig);
  const result = simulate({ gdw: 25, simState: modelState }, EFFECTS, { runs: 1, seed: 42 });
  assert.deepEqual(Object.keys(result).sort(), ['finalState', 'forecast', 'realized', 'summary']);
  for (const key of ['runs', 'median', 'p5', 'p95', 'pCollapse', 'pUnrest']) assert.ok(key in result.forecast, `forecast.${key}`);
  for (const key of ['seed', 'gdw', 'finalGdw', 'collapsed', 'districts', 'needs', 'shocks']) assert.ok(key in result.realized, `realized.${key}`);
  for (const key of ['startGdw', 'realizedDelta', 'medianDelta', 'pCollapse', 'pUnrest', 'topMoves', 'shocks']) assert.ok(key in result.summary, `summary.${key}`);
  assert.ok(result.finalState, 'the engine can store this opaque value for the next cycle');
});

test('500 forecast runs + 1 realized run execute in < 50 ms', async () => {
  const state = createInitialState(simConfig);
  simulate(state, EFFECTS, { runs: 500, seed: 1 }); // warm up the JIT and topology cache
  // Best of up to 15 runs spaced 100 ms apart: other test files run in
  // parallel processes, so a single run can lose the CPU for a moment.
  let best = Infinity;
  for (let i = 0; i < 15 && best >= 50; i++) {
    if (i) await new Promise((r) => setTimeout(r, 100));
    const t0 = process.hrtime.bigint();
    simulate(state, EFFECTS, { runs: 500, seed: 100 + i });
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  assert.ok(best < 50, `best run: ${best.toFixed(1)} ms`);
});

test('forecast percentiles are ordered p5 <= median <= p95 for every month 1-12', () => {
  const state = createInitialState(simConfig);
  for (const [effects, volatility] of [[EFFECTS, 1], [{ purpose: -0.9, connection: -0.9, health: -0.9, trust: -0.9, fairness: -0.9, autonomy: -0.9 }, 1.5]]) {
    const { forecast } = simulate(state, effects, { runs: 500, seed: 7, volatility });
    assert.equal(forecast.median.length, 13);
    for (let t = 1; t <= 12; t++) {
      assert.ok(forecast.p5[t] <= forecast.median[t] && forecast.median[t] <= forecast.p95[t], `month ${t}: ${forecast.p5[t]} / ${forecast.median[t]} / ${forecast.p95[t]}`);
    }
  }
});

test('simulate() is bit-for-bit reproducible for the same state, effects and seed', () => {
  const state = createInitialState(simConfig);
  const a = simulate(state, EFFECTS, { runs: 500, seed: 424242 });
  const b = simulate(state, EFFECTS, { runs: 500, seed: 424242 });
  const plain = (r) => JSON.parse(JSON.stringify({ forecast: r.forecast, realized: { ...r.realized, gdw: Array.from(r.realized.gdw) } }));
  assert.deepEqual(plain(a), plain(b));
  // Exact float equality, not just JSON-rounded.
  for (let m = 0; m < 13; m++) {
    assert.ok(Object.is(a.forecast.median[m], b.forecast.median[m]));
    assert.ok(Object.is(a.realized.gdw[m], b.realized.gdw[m]));
  }
  assert.deepEqual(Array.from(a.finalState.traits), Array.from(b.finalState.traits));
  // A different seed gives a different realized run.
  const c = simulate(state, EFFECTS, { runs: 500, seed: 424243 });
  assert.notDeepEqual(Array.from(a.realized.gdw), Array.from(c.realized.gdw));
});

test('summary.topMoves lists exactly the 3 largest-magnitude (district, cohort, trait) changes', () => {
  const state = createInitialState(simConfig);
  const r = simulate(state, EFFECTS, { runs: 50, seed: 99 });
  const K = state.traitNames.length;
  const all = [];
  state.cohorts.forEach((c, i) => state.traitNames.forEach((t, k) => {
    all.push({ district: c.district, cohort: c.cohort, trait: t, change: r.finalState.traits[i * K + k] - state.traits[i * K + k] });
  }));
  all.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  const { topMoves } = r.summary;
  assert.equal(topMoves.length, 3);
  topMoves.forEach((m, j) => {
    assert.equal(m.district, all[j].district);
    assert.equal(m.cohort, all[j].cohort);
    assert.equal(m.trait, all[j].trait);
    assert.ok(Math.abs(m.change - all[j].change) < 0.0006, 'rounded to 3 decimals');
  });
  // Ordered by magnitude, and nothing outside the top 3 is bigger.
  assert.ok(Math.abs(topMoves[0].change) >= Math.abs(topMoves[1].change) && Math.abs(topMoves[1].change) >= Math.abs(topMoves[2].change));
  assert.ok(Math.abs(all[3].change) <= Math.abs(topMoves[2].change) + 0.0006);
});

test('hedonic drift slowly erodes GDW under a zero-effect policy', () => {
  const state = createInitialState(simConfig);
  const zero = { purpose: 0, connection: 0, health: 0, trust: 0, fairness: 0, autonomy: 0 };
  const { forecast } = simulate(state, zero, { runs: 500, seed: 31 });
  const start = forecast.median[0];
  const end = forecast.median[12];
  assert.ok(end < start, `median falls: ${start.toFixed(2)} -> ${end.toFixed(2)}`);
  assert.ok(start - end > 1 && start - end < 5, `slow erosion, not a crash (${(start - end).toFixed(2)} points)`);
  // The decline is steady: each quarter's median is below the previous one.
  for (const m of [3, 6, 9, 12]) assert.ok(forecast.median[m] < forecast.median[m - 3], `month ${m}`);
  // With drift switched off the line holds (noise and shocks aside).
  const noDrift = { ...simConfig, constants: { ...simConfig.constants, hedonicDrift: 0, shockChance: 0 } };
  const flat = simulate(createInitialState(noDrift), zero, { runs: 500, seed: 31 }).forecast.median;
  assert.ok(Math.abs(flat[12] - flat[0]) < 0.5, `no drift: ${flat[0].toFixed(2)} -> ${flat[12].toFixed(2)}`);
});

test('near 5% GDW, P(collapse) equals the fraction of forecast runs ending at 0%', () => {
  const { runSingleSimulation } = require('../step');
  const { hashSeed } = require('../prng');
  const { computeGDW } = require('../state');
  const state = createInitialState(simConfig);
  // Find the uniform trait level whose wellness reads GDW 5% (the model is non-linear).
  let lo = 0; let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    state.traits.fill(mid);
    if (computeGDW(state) > 5) hi = mid; else lo = mid;
  }
  state.traits.fill((lo + hi) / 2);
  assert.ok(Math.abs(computeGDW(state) - 5) < 1e-6);
  const effects = { purpose: -0.1, connection: -0.05, health: 0, trust: 0, fairness: 0, autonomy: 0 };
  const runs = 500;
  const seed = 2026;
  const { forecast } = simulate(state, effects, { runs, seed });
  // Replay every forecast run with the documented seed scheme and count collapses.
  let collapsed = 0;
  let unrest = 0;
  for (let r = 0; r < runs; r++) {
    const run = runSingleSimulation(state, effects, hashSeed(`${seed}:forecast:${r}`), true);
    if (run.gdw[12] <= 0) collapsed++;
    if (run.gdw[12] < simConfig.constants.unrestGdw) unrest++;
  }
  assert.ok(collapsed > 0 && collapsed < runs, `a real mix of outcomes (${collapsed}/${runs})`);
  assert.equal(forecast.pCollapse, collapsed / runs);
  assert.equal(forecast.pUnrest, unrest / runs);
});

test('realized run clamps GDW at 0% and records collapsed: true when W <= 0.20 at month 12', () => {
  const { computeRegionWellbeing } = require('../state');
  const state = createInitialState(simConfig);
  state.traits.fill(0.22); // GDW 2.5%: a harsh policy pushes W under the 0.20 floor
  const harsh = { purpose: -1, connection: -1, health: -1, trust: -1, fairness: -1, autonomy: -1 };
  const r = simulate(state, harsh, { runs: 20, seed: 5 });
  assert.ok(computeRegionWellbeing(r.finalState) <= 0.20, 'W fell to the floor');
  assert.equal(r.realized.finalGdw, 0, 'clamped, never negative');
  assert.ok(Array.from(r.realized.gdw).every((g) => g >= 0));
  assert.equal(r.realized.collapsed, true);
  // A healthy run is not collapsed.
  const ok = simulate(createInitialState(simConfig), EFFECTS, { runs: 20, seed: 5 });
  assert.equal(ok.realized.collapsed, false);
});

test('simulate() forecasts a single write-in policy (sparse, unscaled effects) for the Borda tie-breaker', () => {
  const start = createInitialState(simConfig);
  // A moderated write-in typically moves 2-3 traits and leaves the rest out.
  const writeIn = { purpose: 0.4, autonomy: 0.3 };
  const r = simulate({ gdw: 25, simState: start }, writeIn, { runs: 200, seed: 99 });
  const end = r.forecast.median[r.forecast.median.length - 1];
  assert.ok(Number.isFinite(end) && end > 25, `a purpose/autonomy write-in lifts the median (${end.toFixed(1)})`);
  assert.equal(r.forecast.runs, 200);
  // Same seed, same median: the tie-breaker is deterministic.
  assert.equal(simulate({ gdw: 25, simState: start }, writeIn, { runs: 200, seed: 99 }).forecast.median[12], r.forecast.median[12]);
  // Two different write-ins are distinguishable, so a Borda tie can be broken.
  const other = simulate({ gdw: 25, simState: start }, { trust: -0.4, fairness: -0.3 }, { runs: 200, seed: 99 });
  assert.ok(other.forecast.median[12] < end - 1);
  // An empty (placeholder) vector is a valid input too.
  assert.ok(Number.isFinite(simulate(start, {}, { runs: 50, seed: 1 }).forecast.median[12]));
});

test('getForecastMedian(state, effects, seed) matches simulate()\'s month-12 median, with no extra work', () => {
  const { getForecastMedian } = require('../index');
  const start = createInitialState(simConfig);
  const effects = { purpose: 0.4, autonomy: 0.3, trust: -0.1 };
  for (const [seed, vol] of [[99, 1], [12345, 1.5]]) {
    const full = simulate({ gdw: 25, simState: start }, effects, { runs: 200, seed, volatility: vol }).forecast.median[12];
    assert.equal(getForecastMedian({ gdw: 25, simState: start }, effects, seed, { volatility: vol }), full, `seed ${seed}`);
  }
});

test('closingCitizen picks the citizen whose cohort changed most over the game, with their own line', () => {
  const { closingCitizen } = require('../index');
  const citizens = require('../../../data/citizens.json');
  const start = createInitialState(simConfig);
  // Four cycles that favour fairness hard: D4's former workers gain most.
  let end = start;
  for (let i = 0; i < 4; i++) end = simulate(end, { fairness: 0.9, purpose: 0.3 }, { runs: 20, seed: i }).finalState;
  const pick = closingCitizen(start, end, citizens);
  const changes = citizens.map((c) => {
    const { getCitizenMood } = require('../index');
    return { id: c.id, d: Math.abs(getCitizenMood(end, c).wellbeing - getCitizenMood(start, c).wellbeing) };
  });
  const max = Math.max(...changes.map((x) => x.d));
  assert.equal(pick.citizenId, changes.find((x) => x.d === max).id);
  assert.equal(pick.band, pick.change >= 2 ? 'good' : pick.change <= -2 ? 'bad' : 'mixed');
  const c = citizens.find((x) => x.id === pick.citizenId);
  assert.equal(pick.text, c.lines[pick.band][0]);
  assert.ok(Math.abs(pick.wellbeingEnd - pick.wellbeingStart - pick.change) < 0.11);
  assert.equal(closingCitizen(null, end, citizens), null);
  assert.equal(closingCitizen(start, end, []), null);
});
