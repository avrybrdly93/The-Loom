'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const loom = require('../loom');

const OFFLINE = { enabled: false, apiKey: '', model: 'gemini-2.5-flash', timeoutMs: 8000 };
const citizens = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'citizens.json'), 'utf8'));

test('loom.narrate returns valid fallback JSON when the API key is missing', async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    for (const delta of [-8, 0, 8]) {
      const out = await loom.narrate({ winningOption: { name: 'The Charter' }, simSummary: { realizedDelta: delta }, citizens });
      // Round-trips through JSON and matches the narration schema.
      const parsed = JSON.parse(JSON.stringify(out));
      assert.equal(typeof parsed.loomLine, 'string');
      assert.ok(parsed.loomLine.length > 0 && parsed.loomLine.length <= 200);
      assert.ok(Array.isArray(parsed.messages) && parsed.messages.length > 0);
      for (const m of parsed.messages) {
        assert.ok(citizens.some((c) => c.id === m.citizenId), `unknown citizen ${m.citizenId}`);
        assert.ok(typeof m.text === 'string' && m.text.length <= 140);
      }
      assert.equal(parsed.fallback, true);
    }
  } finally {
    if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
  }
  // Explicit offline config behaves the same.
  const out = await loom.narrate({ winningOption: { name: 'X' } }, { config: OFFLINE });
  assert.equal(out.fallback, true);
});

test('loom.moderate returns valid fallback JSON when the API key is missing', async () => {
  const submissions = [
    { node: 'NODE-01', text: '  Every district elects a repair council.  ' },
    { node: 'NODE-02', text: 'x'.repeat(400) },
    { node: 'NODE-05', text: 'Open the datacenter doors on weekends.' }
  ];
  const out = await loom.moderate(submissions, { title: 'March on the Datacenter' }, { config: OFFLINE });
  const parsed = JSON.parse(JSON.stringify(out));
  assert.equal(parsed.length, submissions.length);
  const TRAITS = ['purpose', 'connection', 'health', 'trust', 'fairness', 'autonomy'];
  parsed.forEach((r, i) => {
    assert.equal(r.node, submissions[i].node);
    assert.ok(['ok', 'revise', 'reject'].includes(r.status));
    assert.ok(typeof r.cleaned === 'string' && r.cleaned.length > 0 && r.cleaned.length <= 140);
    assert.equal(typeof r.feedback, 'string');
    assert.ok(Array.isArray(r.roles));
    assert.deepEqual(Object.keys(r.effects).sort(), [...TRAITS].sort());
    for (const t of TRAITS) assert.ok(r.effects[t] >= -1 && r.effects[t] <= 1);
    assert.equal(r.fallback, true);
  });
  assert.equal(parsed[0].cleaned, 'Every district elects a repair council.');
});

test('loom never mutates the game state or scores it is given', async () => {
  const deepFreeze = (o) => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.values(o).forEach(deepFreeze);
    }
    return o;
  };
  const game = deepFreeze({
    scores: { 'NODE-01': 2, 'NODE-02': 0 },
    gdw: 31,
    crisis: { title: 'Purpose Drift', incident: 'Posts about feeling useless are spiking.' },
    winningOption: { name: 'The Guilds', text: 'Fund voluntary guilds.', roles: ['artisan'], effects: { purpose: 0.6 } },
    simSummary: { realizedDelta: 4, topMoves: [] },
    citizens
  });
  const submissions = deepFreeze([{ node: 'NODE-01', text: 'Plant a forest.' }]);
  const before = JSON.stringify({ game, submissions });

  // Online path with a mocked Gemini reply, and the offline path.
  const reply = (obj) => async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }) });
  const online = { enabled: true, apiKey: 'test', model: 'gemini-2.5-flash', timeoutMs: 1000 };
  await loom.narrate(game, { config: online, fetchImpl: reply({ loomLine: 'Noted.', messages: [{ citizenId: 'mara', text: 'Hi.' }] }) });
  await loom.narrate(game, { config: OFFLINE });
  await loom.moderate(submissions, game.crisis, {
    config: online,
    fetchImpl: reply([{ node: 'NODE-01', status: 'ok', cleaned: 'Plant a forest.', feedback: '', roles: ['ghost'], effects: { purpose: 0.4 } }])
  });
  await loom.moderate(submissions, game.crisis, { config: OFFLINE });

  assert.equal(JSON.stringify({ game, submissions }), before);
  // The module exposes no way to set scores or GDW (moderateAndScorePolicies is
  // the prototype's alias for moderate(); it returns effect vectors, not scores).
  const LEGACY = ['moderateAndScorePolicies'];
  for (const name of Object.keys(loom)) {
    if (!LEGACY.includes(name)) assert.ok(!/score|gdw|setState/i.test(name), `unexpected export ${name}`);
  }
});

test('every Gemini request sets API-level blocks for classroom safety categories', async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = JSON.parse(init.body);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ok: true, line: 'I am online.' }) }] } }] }) };
  };
  const out = await loom.testConnection({ config: ONLINE, fetchImpl });
  assert.equal(out.ok, true);
  assert.deepEqual(request.safetySettings, [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_LOW_AND_ABOVE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_LOW_AND_ABOVE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_LOW_AND_ABOVE' }
  ]);
});

test('narrateFallback prefers the option\'s authored loomLines for the outcome band', () => {
  const option = { name: 'X', loomLine: 'single line', loomLines: { good: 'good line', mixed: 'mixed line', bad: 'bad line' } };
  assert.equal(loom.narrateFallback({ winningOption: option, simSummary: { realizedDelta: 8 } }).loomLine, 'good line');
  assert.equal(loom.narrateFallback({ winningOption: option, simSummary: { realizedDelta: 0 } }).loomLine, 'mixed line');
  assert.equal(loom.narrateFallback({ winningOption: option, simSummary: { realizedDelta: -8 } }).loomLine, 'bad line');
  assert.equal(loom.narrateFallback({ winningOption: { name: 'Y', loomLine: 'single line' }, simSummary: { realizedDelta: 8 } }).loomLine, 'single line');
});

test('narrate accepts { crisis, winningPolicy, summary, citizens } as well as the engine shape', async () => {
  const policy = { name: 'P', loomLines: { good: 'good line', mixed: 'mixed line', bad: 'bad line' } };
  const a = await loom.narrate({ crisis: { title: 'T' }, winningPolicy: policy, summary: { realizedDelta: -9 }, citizens }, { config: OFFLINE });
  const b = await loom.narrate({ crisis: { title: 'T' }, winningOption: policy, simSummary: { realizedDelta: -9 }, citizens }, { config: OFFLINE });
  assert.equal(a.loomLine, 'bad line');
  assert.deepEqual(a, b);
});

test('rankCitizensByShift puts citizens of the most-moved district and cohort first', () => {
  const summary = { topMoves: [
    { district: 'D4', cohort: 'elders', trait: 'trust', change: -0.2 },
    { district: 'D2', cohort: 'youth', trait: 'connection', change: 0.1 }
  ] };
  const ranked = loom.rankCitizensByShift(citizens, summary);
  assert.equal(ranked.length, citizens.length);
  assert.equal(ranked[0].id, 'ruth', 'D4 elder');
  assert.equal(ranked[1].id, 'kai', 'D2 youth');
});

test('offline narration puts citizens from top-move and shock districts ahead of unaffected districts', async () => {
  const summary = {
    realizedDelta: -4,
    topMoves: [{ district: 'D4', cohort: 'elders', trait: 'trust', change: -0.2 }],
    shocks: [{ month: 5, district: 'D2', trait: 'health', amount: 0.05 }]
  };
  const out = await loom.narrate({ winningOption: { name: 'P' }, simSummary: summary, citizens }, { config: OFFLINE });
  const affected = out.messages.slice(0, 3).map((message) => message.citizenId);
  assert.ok(affected.includes('ruth'), 'the D4 elder in topMoves is prioritized');
  assert.ok(affected.includes('kai') || affected.includes('ezra'), 'a citizen from the D2 shock district is prioritized');
  assert.ok(affected.every((id) => ['ruth', 'tomas', 'kai', 'ezra'].includes(id)), 'the first messages come from affected districts');
});

test('narrate prompt names the most affected citizens and asks for 6-10 in character', async () => {
  let prompt = '';
  const fetchImpl = async (url, init) => {
    prompt = JSON.parse(init.body).contents[0].parts[0].text;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ loomLine: 'ok', messages: [{ citizenId: 'ruth', text: 'hi' }] }) }] } }] }) };
  };
  const out = await loom.narrate(
    { crisis: { title: 'T' }, winningOption: { name: 'P' }, simSummary: { topMoves: [{ district: 'D4', cohort: 'elders', trait: 'trust', change: -0.2 }] }, citizens },
    { config: { ...OFFLINE, enabled: true, apiKey: 'test' }, fetchImpl }
  );
  assert.equal(out.loomLine, 'ok');
  assert.match(prompt, /Most affected first: ruth \(Sector V Commons elders\)/);
  assert.match(prompt, /Pick 6-10 different citizens/);
});

test('offline narration names the most affected district and the realized shock', async () => {
  const summary = {
    realizedDelta: -4,
    topMoves: [{ district: 'D4', cohort: 'elders', trait: 'trust', change: -0.2 }],
    shocks: [{ month: 5, district: 'D2', trait: 'health', amount: 0.05 }]
  };
  const out = await loom.narrate({ winningOption: { name: 'P', loomLine: 'Done.' }, simSummary: summary, citizens }, { config: OFFLINE });
  assert.equal(out.loomLine, 'Done. Sector V Commons moved most. A shock hit Capitol in month 5.');
  // Facts are dropped (shock first) rather than overflowing 200 characters.
  const long = 'x'.repeat(160);
  assert.equal(loom.withSimFacts(long, summary), `${long} Sector V Commons moved most.`);
  assert.equal(loom.withSimFacts('y'.repeat(199), summary), 'y'.repeat(199));
});

test('offline narration carries the changing district and trait into citizen messages across all five cycles', async () => {
  const traits = ['purpose', 'connection', 'health', 'trust', 'fairness'];
  const districtNames = {
    D1: 'Aurelia', D2: 'Capitol', D3: 'Obsidian-Chasm',
    D4: 'Sector V Commons', D5: 'Twilight Promenade'
  };
  for (let cycle = 0; cycle < 5; cycle++) {
    const target = citizens[cycle];
    const trait = traits[cycle];
    const summary = {
      realizedDelta: cycle % 2 ? -4 : 4,
      topMoves: [{ district: target.district, cohort: target.cohort, trait, change: cycle % 2 ? -0.12 : 0.12 }]
    };
    const out = await loom.narrate({ winningOption: { name: `Cycle ${cycle + 1}` }, simSummary: summary, citizens }, { config: OFFLINE });
    const message = out.messages.find((item) => item.citizenId === target.id);
    assert.ok(message, `cycle ${cycle + 1} includes an affected citizen`);
    assert.match(message.text, new RegExp(`${trait} (?:rose|fell) in ${districtNames[target.district]}`, 'i'), `cycle ${cycle + 1} explains the leading trait and district`);
    assert.ok(message.text.length <= 140, `cycle ${cycle + 1} stays within the phone-feed limit`);
  }
});

test('narrate sends each citizen\'s simulated mood and top trait change to Gemini', async () => {
  let prompt = '';
  const fetchImpl = async (url, init) => {
    prompt = JSON.parse(init.body).contents[0].parts[0].text;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ loomLine: 'ok', messages: [] }) }] } }] }) };
  };
  const withMood = citizens.map((c, i) => ({ ...c, mood: 20 + i, moodChange: -1.5, topChange: { trait: 'trust', change: -0.04 } }));
  await loom.narrate({ crisis: { title: 'T' }, winningOption: { name: 'P' }, simSummary: {}, citizens: withMood }, { config: { ...OFFLINE, enabled: true, apiKey: 'k' }, fetchImpl });
  assert.match(prompt, /"id":"mara"[^}]*"mood":20,"moodChange":-1\.5,"topChange":\{"trait":"trust","change":-0\.04\}/);
});

test('loom.narrate times out cleanly at 8,000 ms and returns fallback citizen messages', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false;
  // A network that never answers until the request is aborted.
  const hangingFetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    let settled = false;
    const pending = loom.narrate(
      { winningOption: { name: 'P' }, simSummary: { realizedDelta: 5 }, citizens },
      { config: { ...OFFLINE, enabled: true, apiKey: 'k' }, fetchImpl: hangingFetch }
    ).then((r) => { settled = true; return r; });
    await Promise.resolve();
    t.mock.timers.tick(7999);
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'still waiting just before 8 s');
    assert.equal(aborted, false);
    t.mock.timers.tick(1);
    const out = await pending;
    assert.equal(aborted, true, 'request aborted at 8 s');
    assert.equal(out.fallback, true);
    assert.ok(out.loomLine.length > 0);
    assert.ok(out.messages.length > 0 && out.messages.every((m) => citizens.some((c) => c.id === m.citizenId)));
  } finally {
    console.warn = warn;
  }
});

/** A fetch stub returning `payload` as Gemini's JSON text. */
const geminiReturns = (payload) => async () => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] })
});
const ONLINE = { ...OFFLINE, enabled: true, apiKey: 'k' };

test('loom.narrate strips emoji the model outputs despite instructions', async () => {
  const out = await loom.narrate(
    { winningOption: { name: 'P' }, simSummary: {}, citizens },
    { config: ONLINE, fetchImpl: geminiReturns({ loomLine: 'The council has chosen \u{1F916} wisely.', messages: [{ citizenId: 'kai', text: 'best day ever \u{1F389}\u{1F389} \u{1F44D}\u{1F3FD}' }, { citizenId: 'ruth', text: '\u{1F600}' }] }) }
  );
  assert.equal(out.loomLine, 'The council has chosen wisely.');
  assert.deepEqual(out.messages, [{ citizenId: 'kai', text: 'best day ever' }], 'emoji-only message dropped');
  assert.ok(!/\p{Extended_Pictographic}/u.test(JSON.stringify(out)));
});

test('loom.narrate truncates a 250-character citizen message to 140 characters cleanly', async () => {
  const words = 'The grid hums again and the kids are back at the river and nobody quite knows who to thank for it. ';
  const long = words.repeat(3).slice(0, 250);
  assert.equal(long.length, 250);
  const out = await loom.narrate(
    { winningOption: { name: 'P' }, simSummary: {}, citizens },
    { config: ONLINE, fetchImpl: geminiReturns({ loomLine: 'x'.repeat(260), messages: [{ citizenId: 'mara', text: long }] }) }
  );
  const text = out.messages[0].text;
  assert.ok(text.length <= 140, `length ${text.length}`);
  assert.ok(text.endsWith('…'), 'ends with an ellipsis');
  assert.ok(long.startsWith(text.slice(0, -1)), 'a prefix of the original');
  assert.ok(/\w…$/.test(text), 'cut at a word boundary, no dangling space or punctuation');
  assert.ok(out.loomLine.length <= 200);
});

test('narrate fallback never repeats a citizen in the same resolution feed', async () => {
  const doubled = [...citizens, ...citizens.map((c) => ({ ...c }))];
  const out = await loom.narrate({ winningOption: { name: 'P' }, simSummary: { realizedDelta: 4, topMoves: [{ district: 'D5', cohort: 'youth', trait: 'autonomy', change: 0.3 }] }, citizens: doubled }, { config: OFFLINE });
  const ids = out.messages.map((m) => m.citizenId);
  assert.equal(new Set(ids).size, ids.length, `duplicates in ${ids}`);
  assert.equal(ids.length, 6);
  assert.equal(ids[0], 'sol', 'most affected citizen (D5 youth) speaks first');
  // Authored reactions fallback is de-duplicated too.
  const reactions = [{ citizenId: 'kai', text: 'a' }, { citizenId: 'kai', text: 'b' }, { citizenId: 'lin', text: 'c' }];
  const out2 = await loom.narrate({ winningOption: { name: 'P', reactions }, simSummary: {} }, { config: OFFLINE });
  assert.deepEqual(out2.messages.map((m) => m.citizenId), ['kai', 'lin']);
});

// ---------------------------------------------------------------------------
// Finale moderation (Stream 4, TASK-536+)
// ---------------------------------------------------------------------------

/** A fetch stub that records each request body and answers with `respond(body)`. */
function recordingFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, prompt: body.contents[0].parts[0].text });
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(respond(body)) }] } }] }) };
  };
  return { calls, fetchImpl };
}
const FINALE_CRISIS = {
  id: 'bb-march-datacenter', title: 'March on the Datacenter', mode: 'writein',
  incident: 'Over 100,000 citizens converge outside the central Loom server monolith.',
  options: {
    A: { name: 'Open the Server Gates', text: 'Grant citizen representatives direct executive keys to The Loom.', roles: ['ghost', 'artisan'], effects: { purpose: 0.4, connection: 0.3, health: -0.5, trust: 0.2, fairness: 0.5, autonomy: 0.6 } },
    B: { name: 'Acoustic Lockdown', text: 'Disperse the crowd with non-lethal sensory barriers.', roles: ['assimilator', 'lotus'], effects: { purpose: -0.5, connection: -0.4, health: 0.4, trust: -0.6, fairness: -0.6, autonomy: -0.7 } }
  }
};
const FIVE = ['Every district elects a repair council.', 'A luxury dividend for all.', 'Neural links for every adult.', 'Shut the servers one day a week.', 'Keep things as they are.']
  .map((text, i) => ({ node: `NODE-0${i + 1}`, text }));
const okFor = (list) => list.map((s, i) => ({ node: s.node, status: 'ok', cleaned: `Cleaned ${i + 1}`, feedback: '', roles: ['artisan'], effects: { purpose: 0.1 * i, connection: 0, health: 0, trust: 0, fairness: 0, autonomy: 0 } }));

test('loom.moderate sends all 5 write-ins and the Cycle 5 crisis in one batch call, results mapped by node', async () => {
  const { calls, fetchImpl } = recordingFetch((body) => okFor(JSON.parse(body.contents[0].parts[0].text.split('\n\n').pop())).reverse());
  const out = await loom.moderate(FIVE, FINALE_CRISIS, { config: ONLINE, fetchImpl });
  assert.equal(calls.length, 1, 'one Gemini call for the whole council');
  assert.match(calls[0].prompt, /March on the Datacenter/);
  assert.match(calls[0].prompt, /100,000 citizens/);
  for (const s of FIVE) assert.ok(calls[0].prompt.includes(s.text), `prompt carries ${s.node}`);
  assert.deepEqual(out.map((r) => r.node), FIVE.map((s) => s.node), 'same order as submitted, even if Gemini reorders');
  assert.deepEqual(out.map((r) => r.cleaned), ['Cleaned 1', 'Cleaned 2', 'Cleaned 3', 'Cleaned 4', 'Cleaned 5']);
  assert.ok(out.every((r) => !r.fallback));
});

test('loom.moderate embeds few-shot calibration: authored policies with exact effect vectors and role tags', async () => {
  const { calls, fetchImpl } = recordingFetch((body) => okFor(JSON.parse(body.contents[0].parts[0].text.split('\n\n').pop())));
  await loom.moderate(FIVE, FINALE_CRISIS, { config: ONLINE, fetchImpl });
  const prompt = calls[0].prompt;
  assert.match(prompt, /Calibration examples/);
  const examples = loom.calibrationExamples(FINALE_CRISIS);
  assert.ok(prompt.includes(JSON.stringify(examples)), 'examples sent verbatim');
  // The crisis's own A/B first, exactly as authored...
  assert.deepEqual(examples[0], { policy: FINALE_CRISIS.options.A.text, roles: ['ghost', 'artisan'], effects: FINALE_CRISIS.options.A.effects });
  assert.deepEqual(examples[1].effects, FINALE_CRISIS.options.B.effects);
  // ...then Fixed Crisis 1's options from data/crises.json as anchors.
  const data = require('../../data/crises.json');
  const fixed1 = data.crises.find((c) => c.world === 'fixed' && c.cycle === 1);
  assert.deepEqual(examples[2].effects, loom.cleanEffects(fixed1.options.A.effects));
  assert.equal(examples.length, 4);
  // The submissions come last, after the calibration block.
  assert.ok(prompt.indexOf('Calibration examples') < prompt.indexOf(FIVE[0].text));
});

test('loom.moderate requests temperature 0.2 and a JSON responseSchema of { node, status, cleaned, feedback, roles, effects }', async () => {
  const { calls, fetchImpl } = recordingFetch((body) => okFor(JSON.parse(body.contents[0].parts[0].text.split('\n\n').pop())));
  await loom.moderate(FIVE, FINALE_CRISIS, { config: ONLINE, fetchImpl });
  const cfg = calls[0].body.generationConfig;
  assert.equal(cfg.temperature, 0.2);
  assert.equal(cfg.responseMimeType, 'application/json');
  assert.equal(cfg.responseSchema.type, 'ARRAY');
  const item = cfg.responseSchema.items;
  assert.deepEqual([...item.required].sort(), ['cleaned', 'effects', 'feedback', 'node', 'roles', 'status']);
  assert.deepEqual(item.properties.status.enum, ['ok', 'revise', 'reject']);
  assert.deepEqual(item.properties.roles.items.enum, ['artisan', 'lotus', 'assimilator', 'ghost']);
  assert.deepEqual([...item.properties.effects.required].sort(), ['autonomy', 'connection', 'fairness', 'health', 'purpose', 'trust']);
  assert.ok(calls[0].url.endsWith(':generateContent'));
});

test('moderation rules: ok rewrites (140), revise for crude/off-topic/personal attacks with kind feedback (200, no lecturing), reject for unsafe or a failed revision', async () => {
  const sp = loom.SYSTEM_PROMPT;
  assert.match(sp, /status "ok": rewrite it as one clear, neutral policy sentence \(max 140 characters\) that preserves the author's intent/);
  assert.match(sp, /status "revise": it is crude, off-topic, a joke, or a personal attack/);
  assert.match(sp, /kind, specific private feedback \(max 200 characters\)/);
  assert.match(sp, /Do not lecture/);
  assert.match(sp, /status "reject": the content is unsafe .*or it is a second attempt that still fails after feedback/);
  // The system prompt rides on every moderation request.
  const { calls, fetchImpl } = recordingFetch((body) => okFor(JSON.parse(body.contents[0].parts[0].text.split('\n\n').pop())));
  await loom.moderate(FIVE, FINALE_CRISIS, { config: ONLINE, fetchImpl });
  assert.equal(calls[0].body.systemInstruction.parts[0].text, sp);
  assert.doesNotMatch(calls[0].prompt, /second attempts/);
});

test('loom.moderateOne marks the call as a revision: ok or reject only, a second "revise" becomes "reject"', async () => {
  const { calls, fetchImpl } = recordingFetch((body) => [{ node: 'NODE-05', status: 'revise', cleaned: 'x', feedback: 'try again', roles: [], effects: {} }]);
  const out = await loom.moderateOne({ node: 'NODE-05', text: 'still a joke about Sam' }, FINALE_CRISIS, { config: ONLINE, fetchImpl });
  assert.match(calls[0].prompt, /revised second attempts .*Never "revise" again/);
  assert.equal(out.status, 'reject');
  assert.equal(out.node, 'NODE-05');
  const ok = await loom.moderateOne({ node: 'NODE-05', text: 'Every district elects a council.' }, FINALE_CRISIS, { config: ONLINE, fetchImpl: recordingFetch(() => [{ node: 'NODE-05', status: 'ok', cleaned: 'Every district elects a council.', feedback: '', roles: ['artisan'], effects: { purpose: 0.3 } }]).fetchImpl });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.effects.purpose, 0.3);
});

test('moderate locally flags profanity and slurs before Gemini, including when the API is offline', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Gemini should not receive filtered text'); };
  const firstAttempt = await loom.moderate([{ node: 'NODE-01', text: 'This is stupid.' }], FINALE_CRISIS, { config: ONLINE, fetchImpl });
  assert.equal(calls, 0, 'unsafe text is filtered before contacting Gemini');
  assert.equal(firstAttempt[0].status, 'revise');
  assert.equal(firstAttempt[0].cleaned, '');
  assert.match(firstAttempt[0].feedback, /school-appropriate/);

  const offline = await loom.moderate([{ node: 'NODE-02', text: 'That was a damn bad policy.' }], FINALE_CRISIS, { config: OFFLINE, fetchImpl });
  assert.equal(calls, 0);
  assert.equal(offline[0].status, 'revise');
  assert.equal(offline[0].fallback, true);

  const revision = await loom.moderateOne({ node: 'NODE-03', text: 'This is still shit.' }, FINALE_CRISIS, { config: ONLINE, fetchImpl });
  assert.equal(calls, 0);
  assert.equal(revision.status, 'reject');
  assert.equal(revision.cleaned, '');
});

test('loom.moderate runs every Gemini result through sanitizeModerationResult (emoji, lengths, roles, traits)', async () => {
  const messy = (list) => list.map((s) => ({ node: s.node, status: 'ok', cleaned: `Free \u{1F355} pizza ${'for all '.repeat(40)}`, feedback: '', roles: ['catalyst', 'ghost', 'artisan', 'lotus'], effects: { purpose: 3, trust: -2, health: 'lots' } }));
  const out = await loom.moderate(FIVE, FINALE_CRISIS, { config: ONLINE, fetchImpl: recordingFetch((body) => messy(JSON.parse(body.contents[0].parts[0].text.split('\n\n').pop()))).fetchImpl });
  for (const r of out) {
    assert.ok(r.cleaned.length <= 140 && !/\p{Extended_Pictographic}/u.test(r.cleaned));
    assert.deepEqual(r.roles, ['ghost', 'artisan']);
    assert.deepEqual(r.effects, { purpose: 1, connection: 0, health: 0, trust: -1, fairness: 0, autonomy: 0 });
  }
});

test('loom.getPlaceholderPolicy(node): the standard protocol text, no roles, zero effects', () => {
  const p = loom.getPlaceholderPolicy('NODE-03');
  assert.equal(p.node, 'NODE-03');
  assert.equal(p.cleaned, 'Maintain current regional administrative protocols without structural changes.');
  assert.deepEqual(p.roles, []);
  assert.deepEqual(p.effects, { purpose: 0, connection: 0, health: 0, trust: 0, fairness: 0, autonomy: 0 });
  assert.equal(p.status, 'reject');
  assert.equal(loom.getPlaceholderPolicy('Sam').node, null, 'never echoes a name');
  assert.notEqual(loom.getPlaceholderPolicy('NODE-01').effects, loom.getPlaceholderPolicy('NODE-02').effects, 'fresh objects');
});

test('loom.moderateOne falls back to a deterministic local heuristic when Gemini times out on a resubmit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hanging = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const warn = console.warn;
  console.warn = () => {};
  const resubmit = (text) => {
    const p = loom.moderateOne({ node: 'NODE-05', text }, FINALE_CRISIS, { config: ONLINE, fetchImpl: hanging, playerNames: ['Sam Lee'] });
    return Promise.resolve().then(() => t.mock.timers.tick(8000)).then(() => p);
  };
  try {
    const ok = await resubmit('every district elects a repair council that controls its own grid');
    assert.equal(ok.status, 'ok');
    assert.equal(ok.heuristic, true);
    assert.equal(ok.cleaned, 'Every district elects a repair council that controls its own grid.');
    assert.deepEqual(ok.roles, ['artisan']);
    assert.ok(ok.effects.purpose > 0 && Object.values(ok.effects).every((v) => v >= -1 && v <= 1));
    // Deterministic: the same revision always scores the same.
    assert.deepEqual(await resubmit('every district elects a repair council that controls its own grid'), ok);
    // Unsafe, naming a player, or not a policy: rejected (the engine then shows the placeholder).
    for (const bad of ['Sam Lee should run everything', 'kill the owners', 'lol ok']) {
      const r = await resubmit(bad);
      assert.equal(r.status, 'reject', bad);
      assert.equal(r.cleaned, '');
    }
  } finally {
    console.warn = warn;
  }
});

test('offline Loom line names the shock: "A Coastal Storm hit Aurelia in month 3."', () => {
  const line = loom.withSimFacts('The council has chosen.', { topMoves: [], shocks: [{ month: 3, district: 'D1', trait: 'health', amount: 0.04, name: 'Coastal Storm' }] });
  assert.equal(line, 'The council has chosen. A Coastal Storm hit Aurelia in month 3.');
});

test('loom.narrate for the Cycle 5 finale gets the 50/25/25 package and asks for one commentary on it', async () => {
  let prompt = '';
  const fetchImpl = async (url, init) => {
    prompt = JSON.parse(init.body).contents[0].parts[0].text;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ loomLine: 'Three policies, one region.', messages: [] }) }] } }] }) };
  };
  const enacted = [
    { text: 'Shut the servers one day a week.', weight: 0.25, place: 'third', author: 'NODE-02' },
    { text: 'Every district elects a repair council.', weight: 0.5, place: 'first', node: 'NODE-04' },
    { text: 'A luxury dividend for all.', weight: 0.25, place: 'second' }
  ];
  const out = await loom.narrate({ crisis: { title: 'March on the Datacenter' }, winningOption: { name: 'The Council Package', text: 'x' }, simSummary: { realizedDelta: 4 }, citizens, enacted }, { config: ONLINE, fetchImpl });
  assert.equal(out.loomLine, 'Three policies, one region.');
  assert.match(prompt, /weighted package was enacted together \(50 \/ 25 \/ 25\)/);
  assert.ok(prompt.indexOf('- 50% (1st): Every district elects a repair council.') < prompt.indexOf('- 25% (2nd): A luxury dividend for all.'));
  assert.match(prompt, /- 25% \(3rd\): Shut the servers one day a week\./);
  assert.match(prompt, /comment on the package as a whole/);
  assert.doesNotMatch(prompt, /NODE-0|Policy enacted:/, 'no authors, no single-policy line');
});

test('sanitizeModerationResult clamps { purpose: 2.5, trust: -9.0 } to { purpose: 1.0, trust: -1.0 } and zero-fills the rest', () => {
  const r = loom.sanitizeModerationResult({ node: 'NODE-02', status: 'ok', cleaned: 'A policy.', feedback: '', roles: [], effects: { purpose: 2.5, trust: -9.0 } });
  assert.deepEqual(r.effects, { purpose: 1.0, connection: 0, health: 0, trust: -1.0, fairness: 0, autonomy: 0 });
  // Non-numeric, NaN and Infinity also become safe numbers in range.
  const odd = loom.sanitizeModerationResult({ effects: { health: 'high', fairness: NaN, autonomy: Infinity, connection: -0.35 } }).effects;
  assert.deepEqual(odd, { purpose: 0, connection: -0.35, health: 0, trust: 0, fairness: 0, autonomy: 0 });
  assert.deepEqual(loom.sanitizeModerationResult(null).effects, { purpose: 0, connection: 0, health: 0, trust: 0, fairness: 0, autonomy: 0 });
});

test('sanitizeModerationResult drops invalid role tags like "catalyst" or "hacker" and keeps at most 2 valid tags', () => {
  const tags = (roles) => loom.sanitizeModerationResult({ roles }).roles;
  assert.deepEqual(tags(['catalyst', 'hacker', 'ghost']), ['ghost']);
  assert.deepEqual(tags(['artisan', 'lotus', 'assimilator', 'ghost']), ['artisan', 'lotus']);
  assert.deepEqual(tags(['catalyst', 'hacker']), []);
  assert.deepEqual(tags(['ARTISAN', 'Lotus ', 7, null]), [], 'exact tags only');
  assert.deepEqual(tags('artisan'), [], 'not an array');
});

test('sanitizeModerationResult truncates 300-character strings to 140 (cleaned) and 200 (feedback)', () => {
  const words = 'Every district elects a council that repairs its own grid '.repeat(6).slice(0, 300);
  const solid = 'x'.repeat(300);
  assert.equal(words.length, 300);
  const r = loom.sanitizeModerationResult({ cleaned: words, feedback: words });
  assert.ok(r.cleaned.length <= 140 && r.cleaned.length > 100, `cleaned ${r.cleaned.length}`);
  assert.ok(r.feedback.length <= 200 && r.feedback.length > 150, `feedback ${r.feedback.length}`);
  assert.ok(words.startsWith(r.cleaned.replace(/…$/, '')), 'a clean prefix, cut at a word');
  const s = loom.sanitizeModerationResult({ cleaned: solid, feedback: solid });
  assert.equal(s.cleaned.length, 140);
  assert.equal(s.feedback.length, 200);
  // Emoji are stripped before measuring.
  assert.equal(loom.sanitizeModerationResult({ cleaned: `Free parks \u{1F333}\u{1F333} for all.` }).cleaned, 'Free parks for all.');
});

test('loom.moderate falls back cleanly after the 8,000 ms timeout, and the engine then switches to the authored A/B finale', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false;
  const hanging = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const warn = console.warn;
  console.warn = () => {};
  let out;
  try {
    let settled = false;
    const pending = loom.moderate(FIVE, FINALE_CRISIS, { config: ONLINE, fetchImpl: hanging }).then((r) => { settled = true; return r; });
    await Promise.resolve();
    t.mock.timers.tick(7999);
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'still waiting just before 8 s');
    t.mock.timers.tick(1);
    out = await pending;
  } finally {
    console.warn = warn;
  }
  assert.equal(aborted, true, 'request aborted at 8 s');
  assert.equal(out.length, 5, 'resolves (never rejects), one result per write-in');
  assert.ok(out.every((r) => r.fallback === true && r.status === 'ok' && r.roles.length === 0));
  assert.ok(out.every((r) => Object.values(r.effects).every((v) => v === 0)), 'zero effects: never scored');
  // The engine reads an all-fallback batch as "Gemini unavailable" and plays the authored A/B.
  t.mock.timers.reset();
  const engine = require('../gameEngine');
  const game = new engine.GameState({ roomCode: 'TOUT' });
  const log = console.log;
  console.log = () => {};
  try {
    engine.NODE_IDS.forEach((n, i) => game.addPlayer(`s${i}`, `P${i}`));
    game.assignRoles(game.data.roles);
    game.worldKey = 'BB';
    game.voteHistory = { 1: 'B', 2: 'B', 3: 'A', 4: 'A' };
    game.cycle = 5;
    game.startIncidentPhase();
    game.startFinaleWritePhase();
    game.phase = engine.PHASES.FINALE_MOD;
    game.onFinaleModeration(out);
    assert.equal(game.finaleFallback, true);
    assert.equal(game.phase, 'DEBATE');
    assert.equal(game.publicOptions().A.name, 'Open the Server Gates');
  } finally {
    game.stop();
    console.log = log;
  }
});

test('callGemini retries once on 429/503 inside the 8 s budget, then gives up', async () => {
  const reply = (status, payload, headers = {}) => ({ ok: status === 200, status, headers: { get: (k) => headers[k.toLowerCase()] }, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }) });
  // 503 then success: one retry, same request.
  let n = 0;
  const flaky = async () => (++n === 1 ? reply(503) : reply(200, { loomLine: 'Recovered.', messages: [] }));
  const out = await loom.narrate({ winningOption: { name: 'P' }, simSummary: {}, citizens }, { config: ONLINE, fetchImpl: flaky });
  assert.equal(n, 2);
  assert.equal(out.loomLine, 'Recovered.');
  assert.ok(!out.fallback);
  // 429 twice: exactly one retry, then the offline fallback.
  n = 0;
  const limited = async () => { n++; return reply(429, null, { 'retry-after': '0.1' }); };
  const warn = console.warn; console.warn = () => {};
  try {
    const fb = await loom.narrate({ winningOption: { name: 'P' }, simSummary: {}, citizens }, { config: ONLINE, fetchImpl: limited });
    assert.equal(n, 2, 'one retry only');
    assert.equal(fb.fallback, true);
    // Other errors (e.g. 400) are not retried.
    n = 0;
    await loom.narrate({ winningOption: { name: 'P' }, simSummary: {}, citizens }, { config: ONLINE, fetchImpl: async () => { n++; return reply(400); } });
    assert.equal(n, 1);
    // Not enough budget left for a real second attempt: no retry.
    n = 0;
    await loom.narrate({ winningOption: { name: 'P' }, simSummary: {}, citizens }, { config: { ...ONLINE, timeoutMs: 2000 }, fetchImpl: async () => { n++; return reply(503); } });
    assert.equal(n, 1);
  } finally { console.warn = warn; }
});

test('Loom uses fast network failures immediately but still aborts a hanging request at 8 seconds', async (t) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const started = Date.now();
    let calls = 0;
    const unreachable = await loom.narrate(
      { winningOption: { name: 'P' }, simSummary: {}, citizens },
      { config: ONLINE, fetchImpl: async () => { calls++; throw new TypeError('fetch failed'); } }
    );
    const elapsedMs = Date.now() - started;
    assert.equal(calls, 1, 'do not retry an immediate network failure');
    assert.ok(elapsedMs < 100, `immediate fetch rejection took ${elapsedMs} ms`);
    assert.equal(unreachable.fallback, true);

    t.mock.timers.enable({ apis: ['setTimeout'] });
    let settled = false;
    let aborted = false;
    const hanging = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
    const pending = loom.narrate(
      { winningOption: { name: 'P' }, simSummary: {}, citizens },
      { config: { ...ONLINE, timeoutMs: 8000 }, fetchImpl: hanging }
    ).then((out) => { settled = true; return out; });
    await Promise.resolve();
    t.mock.timers.tick(7999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'a hanging request is still pending before its deadline');
    t.mock.timers.tick(1);
    const timedOut = await pending;
    assert.equal(aborted, true, 'the request aborts at 8,000 ms');
    assert.equal(timedOut.fallback, true);
  } finally {
    console.warn = warn;
  }
});

test('every Gemini call logs latency and token usage, never student write-ins in privacy mode', async () => {
  const lines = [];
  const logger = (l) => lines.push(l);
  const withUsage = async (url, init) => ({ ok: true, status: 200, json: async () => ({
    usageMetadata: { promptTokenCount: 812, candidatesTokenCount: 96, totalTokenCount: 908 },
    candidates: [{ content: { parts: [{ text: JSON.stringify(okFor(JSON.parse(JSON.parse(init.body).contents[0].parts[0].text.split('\n\n').pop()))) }] } }]
  }) });
  const secret = [{ node: 'NODE-01', text: 'My secret plan about the harbour' }];
  await loom.moderate(secret, FINALE_CRISIS, { config: ONLINE, fetchImpl: withUsage, logger, env: { LOOM_DEBUG_PROMPTS: 'true' } });
  assert.equal(lines.length, 1, 'privacy mode (default): metrics only');
  assert.match(lines[0], /^\[loom\] moderate gemini-2\.5-flash \d+ ms HTTP 200 tokens 812 in \/ 96 out \/ 908 total$/);
  assert.ok(!lines.join('\n').includes('secret plan'));
  // Privacy off + debug: the prompt may be logged (for a teacher debugging locally).
  lines.length = 0;
  await loom.moderate(secret, FINALE_CRISIS, { config: ONLINE, fetchImpl: withUsage, logger, env: { LOOM_DEBUG_PROMPTS: 'true', LOOM_PRIVACY: 'false' } });
  assert.ok(lines[1].includes('secret plan'));
  // Failures log the latency and reason; LOOM_LOG=off is silent.
  lines.length = 0;
  const warn = console.warn; console.warn = () => {};
  try {
    await loom.narrate({ winningOption: { name: 'P' }, simSummary: {}, citizens }, { config: ONLINE, logger, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({}) }) });
    assert.match(lines[0], /^\[loom\] narrate gemini-2\.5-flash \d+ ms HTTP 400 FAILED: Gemini HTTP 400$/);
    lines.length = 0;
    await loom.moderate(secret, FINALE_CRISIS, { config: ONLINE, fetchImpl: withUsage, logger, env: { LOOM_LOG: 'off' } });
    assert.equal(lines.length, 0);
  } finally { console.warn = warn; }
});

test('loom.narrate fallback works for the Cycle 5 finale when the winning option is a 50/25/25 package', async () => {
  const enacted = [
    { text: 'Every district elects a repair council.', weight: 0.5, place: 'first' },
    { text: 'A luxury dividend for all.', weight: 0.25, place: 'second' },
    { text: 'Shut the servers one day a week.', weight: 0.25, place: 'third' }
  ];
  const pkg = { name: 'The Council Package', text: enacted.map((e) => `${e.weight * 100}%: ${e.text}`).join(' | '), summary: 'Three council-written policies enacted together at 50/25/25.' };
  const lines = new Set();
  for (const delta of [-9, 0, 9]) {
    const out = await loom.narrate({ crisis: { title: 'March on the Datacenter' }, winningOption: pkg, simSummary: { realizedDelta: delta, shocks: [{ month: 4, district: 'D2', name: 'Cooling Grid Outage' }] }, citizens, enacted }, { config: OFFLINE });
    assert.equal(out.fallback, true);
    assert.ok(out.loomLine.length > 0 && out.loomLine.length <= 200, out.loomLine);
    assert.match(out.loomLine, /three/i, 'speaks about the package');
    assert.ok(out.messages.length > 0 && out.messages.every((m) => m.text.length <= 140 && citizens.some((c) => c.id === m.citizenId)));
    lines.add(out.loomLine);
  }
  assert.equal(lines.size, 3, 'a different line for good, mixed and bad outcomes');
  // Engine-shaped context through narrateFallback directly as well.
  assert.match(loom.narrateFallback({ winningOption: pkg, simSummary: { realizedDelta: 5 }, enacted }).loomLine, /three/i);
});
