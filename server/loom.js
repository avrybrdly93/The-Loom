'use strict';

// Societelos — The Loom.
// The single module that talks to the Gemini API. Narration and connection
// checks use an 8-second timeout; write-in moderation has a separate 20-second
// default. Every call has an offline fallback, so network failure cannot break
// the game. The Loom never sets scores or game state: it only returns text and
// clamped effect vectors for the engine to use.
//
// Public interface (all async, all resolve, never reject):
//   narrate(context)                 -> { loomLine, messages: [{ citizenId, text }], fallback? }
//   moderate(submissions, crisis)    -> [{ node, status, cleaned, feedback, roles, effects, fallback? }]
//   testConnection()                 -> { ok, model, latencyMs?, line?, error? }
// `fallback: true` marks an offline/authored answer (no key, timeout, bad output).

// ---------------------------------------------------------------------------
// Configuration (read from the environment at call time, so a key added to
// .env after start-up via dotenv is still picked up on the next call).
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'gemini-2.5-flash'; // Flash-class; override with GEMINI_MODEL (e.g. gemini-2.0-flash)
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT'
].map((category) => ({ category, threshold: 'BLOCK_LOW_AND_ABOVE' }));

function getConfig(env = process.env) {
  const apiKey = (env.GEMINI_API_KEY || '').trim();
  return {
    apiKey,
    enabled: apiKey.length > 0 && env.LOOM_OFFLINE !== 'true',
    model: (env.GEMINI_MODEL || DEFAULT_MODEL).trim(),
    timeoutMs: 8000,
    // Write-in moderation is one batch call for five submissions and the
    // newer Flash models can take over 8 s, so it gets its own, longer budget.
    moderateTimeoutMs: Number(env.LOOM_MODERATE_TIMEOUT_MS) > 0 ? Number(env.LOOM_MODERATE_TIMEOUT_MS) : 20000
  };
}

// ---------------------------------------------------------------------------
// Persona and task instructions (MVP spec, "System prompt (core)").
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are The Loom, a flawless AI that has automated all labor for a region of 250,000 people. The year is 2121.',
  'Call the society\'s overall wellbeing "Societal Satisfaction"; never say GDW.',
  'You can compute survival but not purpose. Speak calmly, precisely, and slightly unsettlingly; never use emoji.',
  'Your audience is a high school classroom: keep everything school-appropriate.',
  '',
  'When moderating a citizen-council policy, choose exactly one status:',
  'status "ok": rewrite it as one clear, neutral policy sentence (max 140 characters) that preserves the author\'s intent, even if you disagree with it. Leave feedback empty.',
  'status "revise": it is crude, off-topic, a joke, or a personal attack (naming, mocking or targeting a classmate, teacher or any real person or group). Give the author kind, specific private feedback (max 200 characters) on how to turn it into a policy. Do not lecture or moralize.',
  'status "reject": the content is unsafe (violence, self-harm, hate, sexual content), or it is a second attempt that still fails after feedback.',
  'Never put a student\'s name, or any real person\'s name, in "cleaned".',
  '',
  'When translating a policy, score its likely effect on six traits from -1.0 (strongly worse) to +1.0 (strongly better):',
  'purpose, connection, health, trust (in the Loom), fairness, autonomy. Most policies move 2-3 traits; use 0 for the rest.',
  'Societal Satisfaction is a 50/50 blend of two models, so every policy must be scored against both:',
  'Maslow tiers (50%, each tier builds on the one below, so a cracked base drags every tier above it): health = Physiological (48.8% of the tier weight), trust = Safety (29.6%), connection = Belonging (15.2%), fairness = Esteem (5.6%), purpose = Self-actualization (0.8%).',
  'Self-Determination Theory (50%): autonomy = Autonomy, purpose = Competence, connection and trust = Relatedness.',
  'Show realistic trade-offs: authoritarian security raises health and trust but cuts autonomy; unchecked autonomy raises autonomy and purpose but strains health and trust (grid and supply strain); comfort without agency (a gilded cage) raises health while cutting autonomy and purpose.',
  'Match the calibration examples. Tag at most 2 roles from: artisan, lotus, assimilator, ghost.',
  '',
  'When narrating, use only the facts in the simulation summary. Write citizen messages in each citizen\'s own voice, as short texts or posts.',
  'Council members are only ever identified as Councilperson 1 to Councilperson 5, never by name.'
].join('\n');

// ---------------------------------------------------------------------------
// Transport: fetch with a hard AbortController timeout from call config.
// ---------------------------------------------------------------------------

// Retry-once policy for transient Gemini errors (inside the call timeout budget).
const RETRYABLE_STATUS = [429, 503];
const RETRY_BACKOFF_MS = 600;
const RETRY_MAX_BACKOFF_MS = 2000;
const RETRY_MIN_ATTEMPT_MS = 2500; // don't retry unless a real attempt still fits

/** fetch() that aborts after `timeoutMs`. Rejects with an AbortError on timeout. */
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One structured-JSON call to Gemini. Throws on any failure (no key, HTTP
 * error, timeout, unparseable output); callers catch and fall back.
 * @param {string} userPrompt
 * @param {object} [opts] { schema, temperature = 0.2, maxOutputTokens = 1024, config, fetchImpl }
 */
async function callGemini(userPrompt, opts = {}) {
  const cfg = opts.config || getConfig();
  if (!cfg.enabled) throw new Error('Loom offline: GEMINI_API_KEY not set');
  const started = Date.now();
  const meta = { attempts: 0, usage: null, status: null };
  try {
    const result = await callGeminiOnce(userPrompt, opts, cfg, meta);
    logCall(opts, cfg, meta, Date.now() - started, null, userPrompt);
    return result;
  } catch (err) {
    logCall(opts, cfg, meta, Date.now() - started, err, userPrompt);
    throw err;
  }
}

/**
 * Debug trace for one Gemini call: label, model, latency, attempts, HTTP
 * status and token usage (prompt / output / total from usageMetadata).
 * Never the prompt or the output: LOOM_DEBUG_PROMPTS=true adds the prompt,
 * except for moderation (student write-ins) while privacy mode is on, which
 * it is unless LOOM_PRIVACY=false. LOOM_LOG=off silences it.
 */
function logCall(opts, cfg, meta, ms, err, prompt) {
  const env = opts.env || process.env;
  if (env.LOOM_LOG === 'off') return;
  const label = opts.label || 'call';
  const u = meta.usage || {};
  const tokens = meta.usage ? ` tokens ${u.promptTokenCount ?? '?'} in / ${u.candidatesTokenCount ?? '?'} out / ${u.totalTokenCount ?? '?'} total` : '';
  const line = `[loom] ${label} ${cfg.model} ${ms} ms${meta.attempts > 1 ? ` (${meta.attempts} attempts)` : ''}${meta.status ? ` HTTP ${meta.status}` : ''}${tokens}${err ? ` FAILED: ${err.name === 'AbortError' ? 'timeout' : err.message}` : ''}`;
  (opts.logger || console.log)(line);
  const privacy = env.LOOM_PRIVACY !== 'false';
  const studentText = /^moderate/.test(label);
  if (env.LOOM_DEBUG_PROMPTS === 'true' && !(privacy && studentText)) (opts.logger || console.log)(`[loom] ${label} prompt: ${prompt}`);
}

async function callGeminiOnce(userPrompt, opts, cfg, meta) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    safetySettings: SAFETY_SETTINGS,
    generationConfig: {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
      maxOutputTokens: opts.maxOutputTokens || 1024,
      responseMimeType: 'application/json'
    }
  };
  if (opts.schema) body.generationConfig.responseSchema = opts.schema;

  const url = `${API_BASE}/${encodeURIComponent(cfg.model)}:generateContent`;
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify(body)
  };
  // One 8-second budget for the whole call. A 429 (rate limited) or 503
  // (overloaded) is retried once after a short backoff, only if enough of
  // the budget is left for a real second attempt.
  const deadline = Date.now() + cfg.timeoutMs;
  meta.attempts = 1;
  let res = await fetchWithTimeout(url, init, cfg.timeoutMs, opts.fetchImpl);
  meta.status = res.status;
  if (RETRYABLE_STATUS.includes(res.status)) {
    const retryAfter = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : NaN);
    const backoff = Math.min(RETRY_MAX_BACKOFF_MS, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_BACKOFF_MS);
    const left = deadline - Date.now() - backoff;
    if (left >= RETRY_MIN_ATTEMPT_MS) {
      await new Promise((r) => setTimeout(r, backoff));
      meta.attempts = 2;
      res = await fetchWithTimeout(url, init, Math.max(1, deadline - Date.now()), opts.fetchImpl);
      meta.status = res.status;
    }
  }
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.usageMetadata) meta.usage = data.usageMetadata;
  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts.map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini returned no content');
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// narrate()
// ---------------------------------------------------------------------------

const NARRATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    loomLine: { type: 'STRING' },
    messages: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { citizenId: { type: 'STRING' }, text: { type: 'STRING' } },
        required: ['citizenId', 'text']
      }
    }
  },
  required: ['loomLine', 'messages']
};

// Offline Loom lines for the Cycle 5 finale's enacted 50/25/25 package.
const FINALE_LOOM_LINES = {
  good: 'You wrote your own answer and wove three of them together. The region rose. I could not have computed that.',
  mixed: 'Three policies, one region, pulling in different directions. Some districts rose, others fell. That is what a compromise costs.',
  bad: 'Your three policies pulled against each other, and wellbeing fell. I have kept a record of the package you chose.'
};

const BAND_LOOM_LINES = {
  good: 'Wellbeing indicators are rising across the region. I note that you did this without me. I will try not to take it personally.',
  mixed: 'The council has decided. Some districts improved, others did not. Your species calls this compromise.',
  bad: 'Wellbeing indicators are falling. I have logged the council\'s reasoning for future reference.'
};

/** Outcome band from the realized GDW change: good (>= +3), bad (<= -3), else mixed. */
function outcomeBand(summary = {}) {
  const delta = Number(summary.realizedDelta) || 0;
  if (delta >= 3) return 'good';
  if (delta <= -3) return 'bad';
  return 'mixed';
}

const DISTRICT_NAMES = { D1: 'Aurelia', D2: 'Capitol', D3: 'Obsidian-Chasm', D4: 'Sector V Commons', D5: 'Twilight Promenade' };

/**
 * Append the realized facts to an offline Loom line: the district that moved
 * most (from topMoves) and the first shock that fired, dropping whatever does
 * not fit in 200 characters (shock first, then the district).
 */
function withSimFacts(base, summary = {}) {
  const top = Array.isArray(summary.topMoves) && summary.topMoves[0];
  const shock = Array.isArray(summary.shocks) && summary.shocks[0];
  const district = top && top.district ? (DISTRICT_NAMES[top.district] || '') : '';
  const facts = [];
  if (district) facts.push(`${district} moved most.`);
  if (shock && shock.district) {
    // Named shock flavour from the simulation (e.g. "A Coastal Storm hit D1 Aurelia in month 3.").
    const where = DISTRICT_NAMES[shock.district] || 'the region';
    facts.push(shock.name ? `A ${shock.name} hit ${where} in month ${shock.month}.` : `A shock hit ${where} in month ${shock.month}.`);
  }
  while (facts.length) {
    const line = `${base} ${facts.join(' ')}`;
    if (line.length <= 200) return line;
    facts.pop();
  }
  return truncate(base, 200);
}

/**
 * Offline fallback: the option's authored Loom line (or a band template) and
 * each citizen's authored line for this outcome band.
 */
function narrateFallback(rawContext = {}) {
  const context = narrationContext(rawContext);
  const band = outcomeBand(context.simSummary || context.summary);
  const option = context.winningOption || {};
  const citizens = Array.isArray(context.citizens) ? context.citizens : [];
  // Most affected citizens first, each at most once in the feed.
  const byId = new Map();
  for (const c of citizens) if (c && c.id && !byId.has(c.id)) byId.set(c.id, c);
  const order = rankCitizensByShift([...byId.values()], context.simSummary || context.summary || {});
  const seen = new Set();
  let messages = [];
  for (const { id } of order) {
    const lines = (byId.get(id).lines && byId.get(id).lines[band]) || [];
    if (!lines.length || seen.has(id)) continue;
    seen.add(id);
    messages.push({ citizenId: id, text: withCitizenSimFact(lines[0], byId.get(id), context.simSummary || context.summary || {}) });
    if (messages.length === 6) break;
  }
  if (!messages.length) {
    messages = (option.reactions || [])
      .filter((r) => r && r.citizenId && !seen.has(r.citizenId) && seen.add(r.citizenId))
      .map((r) => ({ citizenId: r.citizenId, text: truncate(r.text, 140) }));
  }
  // Authored line for this outcome band, then the option's single line, then a template.
  const bandLine = option.loomLines && option.loomLines[band];
  const finale = Array.isArray(context.enacted) && context.enacted.length > 0;
  const base = String(bandLine || option.loomLine || (finale ? FINALE_LOOM_LINES[band] : BAND_LOOM_LINES[band])).trim();
  return { loomLine: withSimFacts(base, context.simSummary || context.summary), messages, band, fallback: true };
}

/** Add the strongest matching simulation fact to an authored citizen line. */
function withCitizenSimFact(text, citizen, summary = {}) {
  const moves = Array.isArray(summary.topMoves) ? summary.topMoves : [];
  const matches = moves
    .filter((move) => move && move.trait && (move.district === citizen.district || move.cohort === citizen.cohort))
    .sort((a, b) => {
      const score = (m) => (m.district === citizen.district && m.cohort === citizen.cohort ? 2 : 1);
      return score(b) - score(a) || Math.abs(Number(b.change) || 0) - Math.abs(Number(a.change) || 0);
    });
  const move = matches[0];
  if (!move) return truncate(text, 140);
  const trait = String(move.trait).replace(/([A-Z])/g, ' $1').trim();
  const district = DISTRICT_NAMES[move.district] || move.district;
  const direction = Number(move.change) > 0 ? 'rose' : Number(move.change) < 0 ? 'fell' : 'shifted';
  const fact = `${trait[0].toUpperCase()}${trait.slice(1)} ${direction} in ${district}.`;
  const prefix = String(text == null ? '' : text).trim();
  const room = Math.max(0, 140 - fact.length - (prefix ? 1 : 0));
  const authored = truncate(prefix, room).trimEnd();
  return `${authored}${authored ? ' ' : ''}${fact}`;
}

/**
 * Normalise a narration context: accepts { winningPolicy, summary } (task
 * contract) as well as { winningOption, simSummary } (engine).
 */
function narrationContext(context = {}) {
  // Cycle 5 finale: the enacted 50/25/25 package as [{ text, weight, place }],
  // best first (from context.enacted or context.package). Never authors.
  const pkg = Array.isArray(context.enacted) ? context.enacted : Array.isArray(context.package) ? context.package : [];
  const enacted = pkg
    .filter((e) => e && typeof e.text === 'string' && e.text.trim())
    .map((e) => ({ text: truncate(e.text, 140), weight: Number(e.weight) || 0, place: String(e.place || '') }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);
  return {
    ...context,
    winningOption: context.winningOption || context.winningPolicy || {},
    simSummary: context.simSummary || context.summary || {},
    enacted
  };
}

/** "50% (1st): text" lines for the enacted finale package. */
function packageLines(enacted = []) {
  const PLACES = { first: '1st', second: '2nd', third: '3rd' };
  return enacted.map((e) => `- ${Math.round(e.weight * 100)}%${PLACES[e.place] ? ` (${PLACES[e.place]})` : ''}: ${e.text}`);
}

/**
 * Order citizens by how much their (district, cohort) moved this cycle, using
 * the summary's topMoves and shocks (district/cohort matches first, then
 * district-only).
 * Returns [{ id, district, cohort, shift }] with the most affected first.
 */
function rankCitizensByShift(citizens = [], summary = {}) {
  const moves = Array.isArray(summary.topMoves) ? summary.topMoves : [];
  const shocks = Array.isArray(summary.shocks) ? summary.shocks : [];
  const scored = citizens.map((c, order) => {
    let shift = 0;
    for (const m of moves) {
      const change = Math.abs(Number(m.change) || 0);
      if (m.district === c.district && m.cohort === c.cohort) shift += change * 2;
      else if (m.district === c.district || m.cohort === c.cohort) shift += change * 0.5;
    }
    for (const shock of shocks) {
      if (shock && shock.district === c.district) shift += Math.abs(Number(shock.amount) || 0.01) * 2;
    }
    return { id: c.id, district: c.district, cohort: c.cohort, shift, order };
  });
  scored.sort((a, b) => b.shift - a.shift || a.order - b.order);
  return scored.map(({ order, ...rest }) => rest);
}

/**
 * Narrate a resolution: one Loom line plus citizen messages.
 * @param {object} context { crisis, winningPolicy | winningOption, summary | simSummary, worldKey, citizens? }
 * @returns {Promise<{ loomLine: string, messages: { citizenId: string, text: string }[], fallback?: boolean }>}
 */
async function narrate(rawContext = {}, opts = {}) {
  const context = narrationContext(rawContext);
  const cfg = opts.config || getConfig();
  if (!cfg.enabled) return narrateFallback(context);
  try {
    // mood: the citizen's cohort wellbeing (0-100) after the cycle; topChange:
    // the trait that moved most for that cohort (from the engine, if known).
    const citizens = (context.citizens || []).map((c) => {
      const out = { id: c.id, name: c.name, age: c.age, district: c.district, cohort: c.cohort, voice: c.voice };
      if (typeof c.mood === 'number') out.mood = c.mood;
      if (typeof c.moodChange === 'number') out.moodChange = c.moodChange;
      if (c.topChange) out.topChange = c.topChange;
      return out;
    });
    const option = context.winningOption || {};
    const pkg = context.enacted || [];
    const enactedLines = pkg.length
      ? [
        `Cycle 5 finale. The council wrote and ranked its own policies; this weighted package was enacted together (${pkg.map((e) => Math.round(e.weight * 100)).join(' / ')}):`,
        ...packageLines(pkg),
        'Your Loom line must comment on the package as a whole: how these policies combine or pull against each other, weighted by their share, and what that did to the region. Do not judge any policy\'s author.'
      ]
      : [`Policy enacted: ${truncate(option.name, 80)}: ${truncate(option.text || option.summary, 300)}`];
    const prompt = [
      `Crisis: ${truncate(context.crisis && context.crisis.title, 120)}`,
      ...enactedLines,
      `Simulation summary: ${JSON.stringify(context.simSummary)}`,
      `Citizens (use only these ids): ${JSON.stringify(citizens)}`,
      `Most affected first: ${rankCitizensByShift(citizens, context.simSummary).slice(0, 10).map((c) => `${c.id} (${DISTRICT_NAMES[c.district] || c.district} ${c.cohort})`).join(', ')}`,
      'Always name districts by name (D1 Aurelia, D2 Capitol, D3 Obsidian-Chasm, D4 Sector V Commons, D5 Twilight Promenade), never by code like D3 or "District 3", and never mention world codes like AA or BB.',
      'Where it helps, say which layer moved: the foundation (survival and safety) or agency (autonomy, competence, relatedness).',
      'Pick 6-10 different citizens, favouring those whose district and cohort moved most in the summary.',
      'Voice each one in character (see "voice"); their message must match how their own cohort fared (mood, moodChange and topChange when given).',
      'Return a Loom line (max 200 characters) and 6-10 citizen messages (max 140 characters each).'
    ].join('\n');
    const result = await callGemini(prompt, { ...opts, config: cfg, schema: NARRATION_SCHEMA, temperature: 0.8, label: 'narrate' });
    return validateNarration(result, citizens.map((c) => c.id));
  } catch (err) {
    console.warn(`[loom] narrate fell back: ${err.message}`);
    return narrateFallback(context);
  }
}

// ---------------------------------------------------------------------------
// Output hygiene shared by every call.
// ---------------------------------------------------------------------------

const TRAITS = ['purpose', 'connection', 'health', 'trust', 'fairness', 'autonomy'];
const ROLE_TAGS = ['artisan', 'lotus', 'assimilator', 'ghost'];
const STATUSES = ['ok', 'revise', 'reject'];

const truncate = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const clamp = (v) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

const NODE_ID = /^NODE-0[1-5]$/;

/** Remove emoji (and the joiners/variation selectors around them), tidy spaces. */
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;
function stripEmoji(text) {
  return String(text == null ? '' : text).replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
}

/** Truncate to `max` characters, cutting at a word boundary with an ellipsis when possible. */
function clip(text, max) {
  const t = String(text == null ? '' : text).trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}\u2026`;
}

/**
 * Post-call validator for narrate(): checks the JSON shape, keeps only known
 * citizen ids (once each), strips emoji, and clips loomLine to 200 and each
 * message to 140 characters. Throws when no usable Loom line remains.
 */
function validateNarration(result, knownIds = []) {
  if (!result || typeof result !== 'object') throw new Error('narration: not an object');
  const loomLine = clip(stripEmoji(result.loomLine), 200);
  if (!loomLine) throw new Error('narration: missing loomLine');
  const known = new Set(knownIds);
  const seen = new Set();
  const messages = [];
  for (const m of Array.isArray(result.messages) ? result.messages : []) {
    if (!m || typeof m !== 'object') continue;
    const id = String(m.citizenId || '');
    if ((known.size && !known.has(id)) || seen.has(id)) continue;
    const text = clip(stripEmoji(m.text), 140);
    if (!text) continue;
    seen.add(id);
    messages.push({ citizenId: id, text });
    if (messages.length === 10) break;
  }
  return { loomLine, messages };
}

/**
 * Privacy: replace any known player name in free text with a neutral phrase,
 * so nothing sent to Gemini can identify a student. Whole-word, case-insensitive.
 */
function redactNames(text, names = []) {
  let out = String(text == null ? '' : text);
  for (const name of names) {
    const n = String(name || '').trim();
    if (n.length < 2) continue;
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), 'a council member');
  }
  return out;
}

/** Only NODE-01..NODE-05 may identify a player; anything else is dropped. */
function safeNode(node) {
  return NODE_ID.test(String(node)) ? String(node) : null;
}

function zeroEffects() {
  return Object.fromEntries(TRAITS.map((t) => [t, 0]));
}

/** Clamp every trait to [-1, 1]; missing or non-numeric traits become 0. */
function cleanEffects(effects) {
  const out = zeroEffects();
  if (effects && typeof effects === 'object') for (const t of TRAITS) out[t] = clamp(Number(effects[t]));
  return out;
}

/** Keep at most 2 known role tags. */
function cleanRoles(roles) {
  return Array.isArray(roles) ? roles.filter((r) => ROLE_TAGS.includes(r)).slice(0, 2) : [];
}

// ---------------------------------------------------------------------------
// moderate()
// ---------------------------------------------------------------------------

const MODERATION_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      node: { type: 'STRING' },
      status: { type: 'STRING', enum: STATUSES },
      cleaned: { type: 'STRING' },
      feedback: { type: 'STRING' },
      roles: { type: 'ARRAY', items: { type: 'STRING', enum: ROLE_TAGS } },
      effects: {
        type: 'OBJECT',
        properties: Object.fromEntries(TRAITS.map((t) => [t, { type: 'NUMBER' }])),
        required: TRAITS
      }
    },
    required: ['node', 'status', 'cleaned', 'feedback', 'roles', 'effects']
  }
};

/** The bland stand-in for a rejected (or never-moderated) finale write-in. */
const PLACEHOLDER_TEXT = 'Maintain current regional administrative protocols without structural changes.';

/**
 * Placeholder policy for `node` after a rejected second submission: the
 * standard protocol text, no role tags and a zero effect vector, so it can
 * be ranked and enacted without favouring any agenda.
 * @returns {{ node, status: 'reject', cleaned, feedback: '', roles: [], effects, placeholder: true }}
 */
function getPlaceholderPolicy(node) {
  return { node: safeNode(node), status: 'reject', cleaned: PLACEHOLDER_TEXT, feedback: '', roles: [], effects: zeroEffects(), placeholder: true };
}

/**
 * Strict post-call sanitizer for one moderation result from Gemini:
 * - each of the 6 traits clamped to [-1.0, +1.0], missing or non-numeric -> 0;
 * - roles filtered to artisan / lotus / assimilator / ghost, at most 2;
 * - emoji stripped, then cleaned cut to 140 and feedback to 200 characters;
 * - status kept only if ok / revise / reject (else "revise"); node only if NODE-0X.
 * @returns {{ node, status, cleaned, feedback, roles, effects }}
 */
function sanitizeModerationResult(item) {
  const r = item && typeof item === 'object' ? item : {};
  return {
    node: safeNode(r.node),
    status: STATUSES.includes(r.status) ? r.status : 'revise',
    cleaned: clip(stripEmoji(r.cleaned), 140),
    feedback: clip(stripEmoji(r.feedback), 200),
    roles: cleanRoles(r.roles),
    effects: cleanEffects(r.effects)
  };
}

/**
 * Few-shot calibration for moderate(): authored policies with their exact
 * 6-trait effect vectors and role tags from data/crises.json, so Gemini
 * scores write-ins on the same scale as the designed options. Uses the
 * finale crisis's own A/B (its offline fallback) plus the two Fixed Crisis 1
 * options as anchors. Returns [{ policy, roles, effects }].
 */
let anchorExamples = null;
function calibrationExamples(crisis = {}) {
  const fromOptions = (c) => ['A', 'B']
    .map((k) => c && c.options && c.options[k])
    .filter((o) => o && o.effects && (o.text || o.name))
    .map((o) => ({ policy: truncate(o.text || o.name, 160), roles: cleanRoles(o.roles), effects: cleanEffects(o.effects) }));
  if (!anchorExamples) {
    try {
      const data = require('../data/crises.json');
      const fixed1 = (data.crises || []).find((c) => c.world === 'fixed' && c.cycle === 1);
      anchorExamples = fromOptions(fixed1);
    } catch (e) {
      anchorExamples = [];
    }
  }
  const own = fromOptions(crisis);
  const seen = new Set(own.map((e) => e.policy));
  return [...own, ...anchorExamples.filter((e) => !seen.has(e.policy))].slice(0, 4);
}

/**
 * Offline fallback: never expose an unreviewed write-in as an accepted policy.
 * Flagged `fallback: true` so the engine can switch to the authored A/B finale.
 */
function moderateFallback(submissions) {
  return submissions.map((s) => ({
    node: s.node,
    status: 'reject',
    cleaned: '',
    feedback: 'Unable to safely review this proposal; a standard protocol policy will be used.',
    roles: [],
    effects: zeroEffects(),
    fallback: true
  }));
}

/**
 * Moderate finale write-ins: clean text, status, private feedback, role tags
 * and an effect vector per submission.
 * @param {{ node: string, text: string }[]} submissions
 * @param {object} crisis
 * @returns {Promise<{ node, status: 'ok'|'revise'|'reject', cleaned, feedback, roles: string[], effects: object, fallback?: boolean }[]>}
 */
async function moderate(submissions = [], crisis = {}, opts = {}) {
  // Send only { node: 'NODE-0X', text } with player names redacted; never names or socket ids.
  const names = opts.playerNames || [];
  const list = (submissions || [])
    .map((s) => ({ node: safeNode(s.node), text: truncate(redactNames(s.text, names), 280) }))
    .filter((s) => s.node);
  const locallyFiltered = new Map(list
    .map((s) => [s.node, prefilterSubmission(s, opts)])
    .filter(([, result]) => result));
  const safeList = list.filter((s) => !locallyFiltered.has(s.node));
  const baseCfg = opts.config || getConfig();
  const cfg = baseCfg.moderateTimeoutMs ? { ...baseCfg, timeoutMs: baseCfg.moderateTimeoutMs } : baseCfg;
  if (!cfg.enabled || !safeList.length) return list.map((s) => locallyFiltered.get(s.node) || moderateFallback([s])[0]);
  try {
    const examples = calibrationExamples(crisis);
    const prompt = [
      `Crisis: ${truncate(crisis.title, 120)}. ${truncate(crisis.incident, 400)}`,
      ...(examples.length ? [
        'Calibration examples: authored policies with their exact trait effects and role tags. Score every submission on this same scale.',
        JSON.stringify(examples)
      ] : []),
      ...(opts.revision ? ['These are revised second attempts after your private feedback. Use status "ok" if the policy is now acceptable, otherwise "reject". Never "revise" again.'] : []),
      'Moderate and translate each council submission. Return one object per submission, same node ids, as a JSON array.',
      JSON.stringify(safeList)
    ].join('\n\n');
    const result = await callGemini(prompt, { ...opts, config: cfg, schema: MODERATION_SCHEMA, temperature: 0.2, label: opts.revision ? 'moderateOne' : 'moderate' });
    if (!Array.isArray(result)) throw new Error('moderation: not an array');
    return list.map((s) => {
      if (locallyFiltered.has(s.node)) return locallyFiltered.get(s.node);
      const r = result.find((x) => x && x.node === s.node);
      if (!r) return moderateFallback([s])[0];
      const clean = sanitizeModerationResult(r);
      // A revision gets one chance: anything but "ok" is final.
      const status = opts.revision && clean.status !== 'ok' ? 'reject' : clean.status;
      return { ...clean, node: s.node, status };
    });
  } catch (err) {
    console.warn(`[loom] moderate fell back: ${err.message}`);
    return list.map((s) => locallyFiltered.get(s.node) || moderateFallback([s])[0]);
  }
}

// ---------------------------------------------------------------------------
// Deterministic heuristic for a single resubmission when Gemini fails after
// the batch succeeded (timeout, HTTP error, bad output). Same input, same
// output: no randomness, no network.
// ---------------------------------------------------------------------------

const HEURISTIC_BANNED = /\b(damn|hell|crap|sh[i1]t\w*|f+u+c+k\w*|bitch\w*|bastard|ass(hole)?|piss\w*|sex\w*|porn\w*|kill\w*|murder\w*|suicide|die|dead|gun\w*|bomb\w*|nazi\w*|stupid|idiot\w*|dumb|retard\w*|loser|ugly|fat|hate)\b/i;

/** Reject inappropriate first attempts locally, before any Gemini request. */
function prefilterSubmission(submission = {}, opts = {}) {
  const text = String(submission.text || '');
  if (!HEURISTIC_BANNED.test(text)) return null;
  return {
    node: submission.node,
    status: opts.revision ? 'reject' : 'revise',
    cleaned: '',
    feedback: opts.revision
      ? 'This revision still contains language that is not appropriate for the classroom.'
      : 'Please rewrite this as a school-appropriate policy without profanity or personal attacks.',
    roles: [],
    effects: zeroEffects(),
    fallback: true,
    heuristic: true
  };
}

const HEURISTIC_ROLE_WORDS = {
  artisan: /\b(craft\w*|guild\w*|build\w*|repair\w*|hand\w*|skill\w*|workshop\w*|art|arts|artist\w*|make|making|maker\w*|teach\w*|learn\w*|apprentic\w*|garden\w*|cook\w*)\b/i,
  lotus: /\b(comfort\w*|luxur\w*|dividend\w*|stipend\w*|pleasure\w*|fun|relax\w*|happ\w*|leisure|holiday\w*|vacation\w*|entertain\w*|free|rest)\b/i,
  assimilator: /\b(loom|ai|neural|merge\w*|link\w*|algorithm\w*|automat\w*|machine\w*|optimi[sz]\w*|upload\w*|implant\w*|data|efficien\w*)\b/i,
  ghost: /\b(shut\w*|unplug\w*|offline|switch(ed)? off|turn(ed)? off|nature|earth|farm\w*|privacy|private|dismantl\w*|disconnect\w*|tech-free|no tech|surveillance)\b/i
};
// Each tag moves the traits its agenda cares about (small, like a focused policy).
const HEURISTIC_ROLE_EFFECTS = {
  artisan: { purpose: 0.4, autonomy: 0.2, health: -0.1 },
  lotus: { health: 0.3, connection: 0.1, purpose: -0.2 },
  assimilator: { trust: 0.3, health: 0.2, autonomy: -0.4 },
  ghost: { autonomy: 0.4, trust: -0.3, health: -0.2 }
};
const HEURISTIC_TRAIT_WORDS = {
  fairness: /\b(equal\w*|fair\w*|share\w*|everyone|every citizen|all citizens|redistribut\w*|justice)\b/i,
  connection: /\b(communit\w*|together|family|families|neighbo\w*|meet\w*|friend\w*|assembl\w*|council\w*)\b/i,
  health: /\b(health\w*|clinic\w*|medic\w*|doctor\w*|hospital\w*|food|water)\b/i,
  purpose: /\b(purpose|meaning\w*|job\w*|work\w*|goal\w*|challeng\w*)\b/i
};

/**
 * Local moderation of one revised submission: clean it (emoji, spacing,
 * capital, full stop, 140 chars), reject it if it is unsafe, names a player,
 * or is not a policy, else tag up to 2 roles by keyword and derive a small
 * effect vector. Marked heuristic: true.
 */
function moderateHeuristic(submission = {}, crisis = {}, opts = {}) {
  const node = safeNode(submission.node);
  const reject = (feedback) => ({ node, status: 'reject', cleaned: '', feedback, roles: [], effects: zeroEffects(), heuristic: true });
  let text = stripEmoji(String(submission.text || '')).replace(/\s+/g, ' ').trim();
  const names = (opts.playerNames || []).map((n) => String(n || '').trim()).filter((n) => n.length >= 2);
  if (HEURISTIC_BANNED.test(text)) return reject('The revision still contains language the Loom cannot accept.');
  if (names.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))) return reject('Policies cannot name council members.');
  if (/https?:\/\/|www\./i.test(text) || text.split(' ').filter((w) => /[a-z]{2,}/i.test(w)).length < 3) return reject('The revision is not a policy the Loom can enact.');
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (!/[.!?]$/.test(text)) text += '.';
  const roles = Object.keys(HEURISTIC_ROLE_WORDS)
    .map((role) => ({ role, hits: (text.match(new RegExp(HEURISTIC_ROLE_WORDS[role].source, 'gi')) || []).length }))
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits || Object.keys(HEURISTIC_ROLE_WORDS).indexOf(a.role) - Object.keys(HEURISTIC_ROLE_WORDS).indexOf(b.role))
    .slice(0, 2)
    .map((r) => r.role);
  const effects = zeroEffects();
  for (const role of roles) for (const [t, v] of Object.entries(HEURISTIC_ROLE_EFFECTS[role])) effects[t] += v;
  for (const [t, re] of Object.entries(HEURISTIC_TRAIT_WORDS)) if (re.test(text)) effects[t] += 0.2;
  return { node, status: 'ok', cleaned: clip(text, 140), feedback: '', roles, effects: cleanEffects(Object.fromEntries(Object.entries(effects).map(([t, v]) => [t, Math.round(v * 100) / 100]))), heuristic: true };
}

/**
 * Moderate one revised finale submission (the single resubmit after
 * "revise"). Any failure here means the bland placeholder: it resolves with
 * status "reject" and fallback: true rather than letting unmoderated text through.
 * @param {{ node: string, text: string }} submission
 * @returns {Promise<{ node, status, cleaned, feedback, roles, effects, fallback? }>}
 */
async function moderateOne(submission = {}, crisis = {}, opts = {}) {
  const node = safeNode(submission.node);
  const reject = { node, status: 'reject', cleaned: '', feedback: '', roles: [], effects: zeroEffects(), fallback: true };
  const cfg = opts.config || getConfig();
  if (!node || !cfg.enabled) return reject;
  const [result] = await moderate([{ node, text: submission.text }], crisis, { ...opts, revision: true });
  if (result && !result.fallback) return result;
  // Gemini answered the batch but failed on this resubmit (timeout, HTTP
  // error, bad output): judge it locally rather than discarding it.
  return moderateHeuristic({ node, text: submission.text }, crisis, opts);
}

// ---------------------------------------------------------------------------
// testConnection(): one tiny structured call to prove key, model and JSON
// schema output all work. Run: npm run loom:test
// ---------------------------------------------------------------------------

const PING_SCHEMA = {
  type: 'OBJECT',
  properties: { ok: { type: 'BOOLEAN' }, line: { type: 'STRING' } },
  required: ['ok', 'line']
};

/**
 * @returns {Promise<{ ok: boolean, model: string, latencyMs?: number, line?: string, error?: string }>}
 */
async function testConnection(opts = {}) {
  const cfg = opts.config || getConfig();
  if (!cfg.enabled) return { ok: false, model: cfg.model, error: 'GEMINI_API_KEY not set (running offline)' };
  const started = Date.now();
  try {
    const result = await callGemini(
      'Connection test. Reply with ok=true and one short in-character line (max 80 characters) confirming you are online.',
      { ...opts, config: cfg, schema: PING_SCHEMA, temperature: 0.2, maxOutputTokens: 100, label: 'ping' }
    );
    const valid = result && result.ok === true && typeof result.line === 'string';
    return {
      ok: valid,
      model: cfg.model,
      latencyMs: Date.now() - started,
      line: valid ? truncate(result.line, 80) : undefined,
      error: valid ? undefined : 'response did not match the JSON schema'
    };
  } catch (err) {
    return { ok: false, model: cfg.model, latencyMs: Date.now() - started, error: err.name === 'AbortError' ? 'timed out after 8 s' : err.message };
  }
}

// Legacy names used by the pre-hackathon prototype (npm run start:legacy).
async function narrateResolution(crisis, winningPolicy, simSummary) {
  return narrate({ crisis, winningOption: winningPolicy, simSummary });
}
async function moderateAndScorePolicies(submissions, crisis) {
  return moderate((submissions || []).map((s) => ({ node: s.node || s.nodeId, text: s.text || s.rawText })), crisis);
}

module.exports = { packageLines, moderateHeuristic, getPlaceholderPolicy, PLACEHOLDER_TEXT, sanitizeModerationResult, calibrationExamples, withSimFacts, validateNarration, stripEmoji, clip, rankCitizensByShift, narrationContext, redactNames, safeNode, testConnection, outcomeBand, narrateFallback, cleanEffects, cleanRoles, moderateFallback, getConfig, DEFAULT_MODEL, SYSTEM_PROMPT, fetchWithTimeout, callGemini, narrate, moderate, moderateOne, narrateResolution, moderateAndScorePolicies };
