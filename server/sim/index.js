'use strict';

// Societelos simulation: canonical interface for the game engine.
// Pure functions, no I/O. The caller loads data/sim.json and passes it in
// (via a state from createInitialState, or opts.config).

/**
 * @typedef {{ purpose: number, connection: number, health: number, trust: number, fairness: number, autonomy: number }} Effects
 *   Effect vector, each trait in [-1, 1].
 *
 * @typedef {object} Forecast  The Loom's 500-run fan chart.
 * @property {number} runs        number of forecast runs
 * @property {number[]} median    median GDW per month (index 0 = start, 12 = end of cycle)
 * @property {number[]} p5        5th percentile GDW per month
 * @property {number[]} p95       95th percentile GDW per month
 * @property {number} pCollapse   share of runs ending at GDW 0
 * @property {number} pUnrest     share of runs ending below constants.unrestGdw (15)
 *
 * @typedef {object} Realized  What actually happens (base parameters, seed = hash(gameId, cycle)).
 * @property {number} seed
 * @property {number[]} gdw                    GDW per month (13 values)
 * @property {number} finalGdw
 * @property {boolean} collapsed               true when W <= 0.20 at month 12 (GDW clamped to 0)
 * @property {Object<string, number>[]} districts  per month: { D1: wellbeing W, ... D5 } for the map
 * @property {{ month, district, trait, amount }[]} shocks  shocks that fired
 *
 * @typedef {object} SimSummary  Facts passed to loom.narrate().
 * @property {number} startGdw
 * @property {number} realizedDelta
 * @property {number} medianDelta
 * @property {number} pCollapse
 * @property {number} pUnrest
 * @property {{ district, cohort, trait, change }[]} topMoves  3 biggest trait moves
 * @property {object[]} shocks
 *
 * @typedef {object} SimResult
 * @property {Forecast} forecast
 * @property {Realized} realized
 * @property {object} finalState   next cycle's starting sim state
 * @property {SimSummary} summary
 */

const { createInitialState, cloneState, computeGDW, computeDistrictWellbeing, getCitizenMood } = require('./state');
const { runSingleSimulation, needsSnapshot, getTopology } = require('./step');
const { hashSeed } = require('./prng');

/** Linear-interpolated percentile of a sorted numeric array (p in [0, 1]). */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Resolve the sim state from what the engine passes in. */
function resolveState(state, opts) {
  if (state && state.traits) return state;
  if (state && state.simState && state.simState.traits) return state.simState;
  const config = opts.config || (state && state.config);
  if (!config) throw new Error('simulate: no sim state or config provided');
  return createInitialState(config);
}

/** The 3 biggest trait moves between two states: { district, cohort, trait, change }. */
function topMoves(before, after, count = 3) {
  const K = before.traitNames.length;
  const moves = [];
  before.cohorts.forEach((c, i) => {
    before.traitNames.forEach((t, k) => {
      moves.push({ district: c.district, cohort: c.cohort, trait: t, change: after.traits[i * K + k] - before.traits[i * K + k] });
    });
  });
  moves.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return moves.slice(0, count).map((m) => ({ ...m, change: Math.round(m.change * 1000) / 1000 }));
}

/**
 * Stable engine-facing simulation boundary. A replacement model may change
 * its population size or internal state, but keep this call and result shape
 * so `server/gameEngine.js` can keep treating `simState` as opaque.
 *
 * Inputs:
 * - `state`: the model state, or the engine adapter `{ gdw, simState }` where
 *   `simState` is the value returned by `createInitialState(config)`.
 * - `effects`: a trait-to-number map (missing traits mean zero).
 * - `opts`: `runs` (forecast count, default 500), `seed` (32-bit deterministic
 *   seed), `volatility` (noise/shock multiplier), and optional `config`/`mode`.
 *
 * Result contract:
 * - `forecast`: `{ runs, median, p5, p95, pCollapse, pUnrest }`.
 * - `realized`: `{ seed, gdw, finalGdw, collapsed, districts, needs, shocks }`.
 *   `gdw` is the monthly trajectory; `finalGdw` is the closing score.
 * - `finalState`: next-cycle model state, stored and passed back as `simState`.
 * - `summary`: `{ startGdw, realizedDelta, medianDelta, pCollapse, pUnrest,
 *   topMoves, shocks }`, consumed by narration and the public resolution.
 *
 * @param {object} state model state or `{ gdw, simState }` engine adapter
 * @param {Effects} effects trait effects for the enacted policy
 * @param {{ runs?: number, seed?: number, volatility?: number, config?: object, mode?: 'stub' }} [opts]
 * @returns {{ forecast: object, realized: object, finalState: object|null, summary: object }}
 */
function simulate(state, effects, opts = {}) {
  // Stub mode, or a caller that has no sim state or config yet (the engine
  // before it is wired to data/sim.json): flat-line stub, never a crash.
  const hasState = !!(state && (state.traits || (state.simState && state.simState.traits) || state.config)) || !!opts.config;
  if (opts.mode === 'stub' || !hasState) return simulateStub(state, opts);
  const start = resolveState(state, opts);
  const c = start.config.constants;
  const runs = Number.isInteger(opts.runs) ? opts.runs : c.forecastRuns;
  const seed = opts.seed >>> 0;
  const volatility = typeof opts.volatility === 'number' ? opts.volatility : 1;
  const months = c.monthsPerCycle;
  const K = start.traitNames.length;
  const effectVector = new Float64Array(K);
  if (effects) {
    for (let k = 0; k < K; k++) {
      const v = effects[start.traitNames[k]];
      effectVector[k] = typeof v === 'number' ? v : 0;
    }
  }

  // Forecast fan.
  const byMonth = Array.from({ length: months + 1 }, () => new Float64Array(runs));
  let collapses = 0;
  let unrest = 0;
  const prefixHash = hashSeed(`${seed}:forecast:`);
  for (let r = 0; r < runs; r++) {
    const runSeed = hashSeed(r, prefixHash);
    const run = runSingleSimulation(start, effects, runSeed, true, { volatility, effectVector });
    for (let m = 0; m <= months; m++) byMonth[m][r] = run.gdw[m];
    const end = run.gdw[months];
    if (end <= 0) collapses++;
    if (end < c.unrestGdw) unrest++;
  }
  const median = [];
  const p5 = [];
  const p95 = [];
  for (let m = 0; m <= months; m++) {
    const sorted = byMonth[m].sort();
    median.push(percentile(sorted, 0.5));
    p5.push(percentile(sorted, 0.05));
    p95.push(percentile(sorted, 0.95));
  }
  const forecast = {
    runs,
    median,
    p5,
    p95,
    pCollapse: runs ? collapses / runs : 0,
    pUnrest: runs ? unrest / runs : 0
  };

  // What actually happens.
  const realizedRun = runSingleSimulation(start, effects, seed, false, { volatility, effectVector });
  const startGdw = computeGDW(start);
  const finalGdw = realizedRun.gdw[months];
  // Collapse: region wellbeing W <= floorWellbeing (0.20) at month 12, which
  // computeGDW already clamps to GDW 0.
  const collapsed = finalGdw <= 0;
  const realized = {
    seed,
    gdw: realizedRun.gdw,
    finalGdw,
    collapsed,
    districts: realizedRun.districts,
    needs: realizedRun.needs,
    shocks: realizedRun.shocks
  };

  const summary = {
    startGdw,
    realizedDelta: finalGdw - startGdw,
    medianDelta: runs ? median[months] - startGdw : 0,
    pCollapse: forecast.pCollapse,
    pUnrest: forecast.pUnrest,
    topMoves: topMoves(start, realizedRun.finalState),
    shocks: realizedRun.shocks
  };

  return { forecast, realized, finalState: realizedRun.finalState, summary };
}

/**
 * Monday stub mode (opts.mode = 'stub'): same return shape, flat line at the
 * current GDW + 5. Lets the engine and UI run before the model is tuned.
 */
/**
 * Fast forecast median for tie-breakers: the median end-of-cycle GDW over
 * `runs` forecast runs (default 200), seeded exactly like simulate()'s
 * forecast fan, without the realized run, district snapshots or percentile
 * fan. Same state, effects and seed give the same number as
 * simulate(...).forecast.median at month 12.
 * @param {object} state  sim state, or { simState } as the engine passes it
 * @param {object} effects  { trait: -1..1 } (missing traits are 0)
 * @param {number} seed
 * @param {{ runs?: number, volatility?: number, config?: object }} [opts]
 * @returns {number}
 */
function getForecastMedian(state, effects, seed, opts = {}) {
  const start = resolveState(state, opts);
  const runs = Number.isInteger(opts.runs) && opts.runs > 0 ? opts.runs : 200;
  const volatility = typeof opts.volatility === 'number' ? opts.volatility : 1;
  const K = start.traitNames.length;
  const effectVector = new Float64Array(K);
  if (effects) for (let k = 0; k < K; k++) { const v = effects[start.traitNames[k]]; effectVector[k] = typeof v === 'number' ? v : 0; }
  const ends = new Float64Array(runs);
  const prefixHash = hashSeed(`${seed >>> 0}:forecast:`);
  for (let r = 0; r < runs; r++) {
    const run = runSingleSimulation(start, effects, hashSeed(r, prefixHash), true, { volatility, effectVector });
    ends[r] = run.gdw[run.gdw.length - 1];
  }
  return percentile(ends.sort(), 0.5);
}

/**
 * End Screen closing message: the citizen whose cohort's wellbeing changed
 * most (by absolute size) between the start of the game and the end, with
 * one of their authored lines for how it went (good: up 2+ points, bad: down
 * 2+ points, otherwise mixed). Pure: citizens are passed in.
 * @param {object} startState  sim state before Cycle 1
 * @param {object} endState    sim state after the last cycle
 * @param {{ id, district, cohort, lines?: { good, mixed, bad } }[]} citizens
 * @returns {{ citizenId, district, cohort, wellbeingStart, wellbeingEnd, change, band, text } | null}
 *   wellbeing in points (W x 100), change rounded to 0.1
 */
function closingCitizen(startState, endState, citizens = []) {
  if (!startState || !endState) return null;
  let best = null;
  for (const c of citizens) {
    if (!c || !c.id) continue;
    const before = getCitizenMood(startState, c);
    const after = getCitizenMood(endState, c);
    if (!before || !after) continue;
    const change = (after.wellbeing - before.wellbeing) * 100;
    // Ties keep the first citizen in data order (deterministic).
    if (!best || Math.abs(change) > Math.abs(best.change) + 1e-9) best = { c, before, after, change };
  }
  if (!best) return null;
  const band = best.change >= 2 ? 'good' : best.change <= -2 ? 'bad' : 'mixed';
  const lines = (best.c.lines && best.c.lines[band]) || [];
  return {
    citizenId: best.c.id,
    district: best.c.district,
    cohort: best.c.cohort,
    wellbeingStart: Math.round(best.before.wellbeing * 1000) / 10,
    wellbeingEnd: Math.round(best.after.wellbeing * 1000) / 10,
    change: Math.round(best.change * 10) / 10,
    band,
    text: lines[0] || ''
  };
}

function simulateStub(state, opts = {}) {
  const sim = state && state.traits ? state : state && state.simState;
  const startGdw = sim ? computeGDW(sim) : (state && typeof state.gdw === 'number' ? state.gdw : 25);
  const endGdw = Math.min(100, Math.max(0, startGdw + 5));
  const months = (sim && sim.config.constants.monthsPerCycle) || 12;
  const line = Array.from({ length: months + 1 }, (_, m) => (m === 0 ? startGdw : endGdw));
  return {
    forecast: { runs: opts.runs || 0, median: line.slice(), p5: line.slice(), p95: line.slice(), pCollapse: 0, pUnrest: endGdw < 15 ? 1 : 0 },
    realized: { seed: opts.seed >>> 0, gdw: line.slice(), finalGdw: endGdw, collapsed: endGdw <= 0, districts: [], shocks: [] },
    finalState: sim ? cloneState(sim) : null,
    summary: { startGdw, realizedDelta: endGdw - startGdw, medianDelta: endGdw - startGdw, pCollapse: 0, pUnrest: 0, topMoves: [], shocks: [], stub: true }
  };
}

/**
 * Each citizen's mood after a cycle and what changed for their cohort:
 * [{ id, mood (GDW-scaled, 0-100), moodChange, topChange: { trait, change } }].
 * `before` and `after` are sim states (e.g. the cycle's start and finalState).
 */
function citizenMoods(before, after, citizens = []) {
  if (!before || !after) return [];
  return citizens.map((c) => {
    const was = getCitizenMood(before, c);
    const now = getCitizenMood(after, c);
    if (!was || !now) return { id: c.id };
    let top = null;
    for (const t of Object.keys(now.traits)) {
      const change = now.traits[t] - was.traits[t];
      if (!top || Math.abs(change) > Math.abs(top.change)) top = { trait: t, change };
    }
    const r1 = (v) => Math.round(v * 10) / 10;
    return { id: c.id, mood: r1(now.gdw), moodChange: r1(now.gdw - was.gdw), topChange: top && { trait: top.trait, change: Math.round(top.change * 1000) / 1000 } };
  });
}

function currentNeeds(state) {
  if (!state) return null;
  return needsSnapshot(state, getTopology(state).popWeight);
}

module.exports = { currentNeeds, simulate, getForecastMedian, closingCitizen, simulateStub, createInitialState, cloneState, computeGDW, computeDistrictWellbeing, getCitizenMood, citizenMoods, percentile };
