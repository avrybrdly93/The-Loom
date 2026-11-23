'use strict';

// Mid-game phone reconnection over a real Socket.IO server.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.FAST_TIMERS = 'true';
process.env.FAST_TIMER_SECONDS = '0.5';
delete process.env.GEMINI_API_KEY;

const { io: ioClient } = require('socket.io-client');
const { server, io } = require('../server');
const engine = require('../gameEngine');
const socketModule = require('../socket');

const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let url;
const clients = [];
const log = console.log;

test.before(async () => {
  console.log = () => {};
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  for (const c of clients) c.close();
  for (const code of Array.from(engine.rooms.keys())) engine.closeRoom(code);
  io.close();
  await new Promise((resolve) => server.close(resolve));
  console.log = log;
});

function connect(auth) {
  const s = ioClient(url, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
  clients.push(s);
  return s;
}

/** A room with 5 seated, ready phones and the game started. */
async function startedRoom() {
  for (const code of Array.from(engine.rooms.keys())) engine.closeRoom(code);
  const host = connect({ clientType: 'host' });
  const { roomCode } = await once(host, 'host:room');
  const phones = [];
  for (let i = 0; i < 5; i++) {
    const phone = connect({ clientType: 'phone' });
    await once(phone, 'connect');
    const joined = await phone.emitWithAck('lobby:join', { name: `Student ${i + 1}`, room: roomCode });
    assert.ok(joined.ok, joined.reason);
    await phone.emitWithAck('lobby:ready', { ready: true });
    phones.push({ socket: phone, ...joined });
  }
  const started = await host.emitWithAck('host:start', {});
  assert.ok(started.ok, started.reason);
  return { host, roomCode, phones, game: engine.getRoom(roomCode) };
}

// TASK-609 ------------------------------------------------------------------

test('a phone that drops mid-game rebinds its new socket to the same NODE seat (token)', { timeout: 15000 }, async () => {
  const { roomCode, phones, game } = await startedRoom();
  const lost = phones[2];
  lost.socket.close();
  await until(() => game.players[lost.node].connected === false);

  const back = connect({ clientType: 'phone', token: lost.token });
  const resumed = await once(back, 'session:resumed');
  assert.equal(resumed.node, lost.node);
  assert.equal(resumed.roomCode, roomCode);
  assert.equal(game.players[lost.node].socketId, back.id);
  assert.equal(game.players[lost.node].connected, true);
  assert.equal(Object.keys(game.players).length, 5, 'no sixth seat');
});

test('without a token, the same name reclaims only its own offline seat', { timeout: 15000 }, async () => {
  const { roomCode, phones, game } = await startedRoom();
  const lost = phones[3];
  lost.socket.close();
  await until(() => game.players[lost.node].connected === false);

  // A live player's name cannot be used to steal their seat.
  const thief = connect({ clientType: 'phone' });
  await once(thief, 'connect');
  const stolen = await thief.emitWithAck('lobby:join', { name: 'Student 1', room: roomCode });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.reason, 'GAME_IN_PROGRESS');
  assert.notEqual(game.players['NODE-01'].socketId, thief.id);

  // The wrong saved node id with the right name is refused too.
  const wrong = await thief.emitWithAck('lobby:join', { name: 'Student 4', room: roomCode, node: 'NODE-01' });
  assert.equal(wrong.ok, false);

  // Same name (any case), no token: rebinds to NODE-04 and hands back the token.
  const back = connect({ clientType: 'phone' });
  await once(back, 'connect');
  const rejoined = await back.emitWithAck('lobby:join', { name: '  student 4 ', room: roomCode, node: lost.node });
  assert.equal(rejoined.ok, true);
  assert.equal(rejoined.resumed, true);
  assert.equal(rejoined.node, lost.node);
  assert.equal(rejoined.token, lost.token);
  assert.equal(game.players[lost.node].socketId, back.id);
  assert.equal(game.players[lost.node].connected, true);
});

// TASK-610 ------------------------------------------------------------------

const { playGame, okModeration, withLoom } = require('./playGame');

test('privateSyncFor replays role, phase, council, Loom feed, scores, Override, ballot and game:end for one node only', async () => {
  const snaps = {};
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    const out = await playGame({
      gameId: 'sync-phases',
      world: 'AA',
      onEvent: (type, ev, game) => {
        if (type !== 'phase') return;
        const key = `${ev.cycle}:${ev.phase}`;
        if (['1:VOTE', '5:FINALE_RANK', '5:END'].includes(key)) {
          setImmediate(() => { snaps[key] = game.privateSyncFor('NODE-02'); });
        }
      }
    });
    // Public replays (the council, the Loom's feed, the scoreboard) sit
    // between the phase and the node's own private state.
    const PUBLIC = new Set(['council', 'loom:history', 'scores']);
    const all = (key) => snaps[key].map(([e]) => e);
    const events = (key) => all(key).filter((e) => !PUBLIC.has(e));
    const payload = (key, name) => (snaps[key].find(([e]) => e === name) || [])[1];

    assert.deepEqual(events('1:VOTE'), ['state:sync', 'role:assigned', 'phase', 'override:status']);
    assert.ok(all('1:VOTE').includes('council') && all('1:VOTE').includes('loom:history'), 'council and Loom feed replayed');
    assert.ok(!all('1:VOTE').includes('intel:drop'), 'no intel');
    assert.ok(all('5:END').includes('scores'), 'scoreboard replayed after round 1');
    assert.equal(payload('1:VOTE', 'council').members.length, 5);
    assert.equal(payload('1:VOTE', 'state:sync').node, 'NODE-02');
    assert.equal(payload('1:VOTE', 'role:assigned').role.key, out.roles['NODE-02']);
    assert.equal(payload('1:VOTE', 'phase').phase, 'VOTE');
    assert.deepEqual(payload('1:VOTE', 'override:status'), { overrideAvailable: true });

    assert.deepEqual(events('5:FINALE_RANK'), ['state:sync', 'role:assigned', 'phase', 'finale:ballot']);
    const ballot = out.ballots.find((b) => b.node === 'NODE-02');
    assert.deepEqual(payload('5:FINALE_RANK', 'finale:ballot').policies, ballot.policies);

    assert.deepEqual(events('5:END'), ['state:sync', 'role:assigned', 'phase', 'game:end']);
    assert.equal(payload('5:END', 'game:end'), out.gameEnd);

    for (const snap of Object.values(snaps)) {
      for (const [, p] of snap) assert.ok(!('node' in p) || p.node === 'NODE-02', 'nothing addressed to another node');
    }
  });
});

test('a phone that reconnects mid-game receives state:sync, its role card and the current phase', { timeout: 15000 }, async () => {
  const { phones, game } = await startedRoom();
  await until(() => game.phase === 'CHAMBER' || game.cycle >= 1);
  const lost = phones[1];
  lost.socket.close();
  await until(() => game.players[lost.node].connected === false);

  const back = connect({ clientType: 'phone', token: lost.token });
  const got = {};
  for (const e of ['state:sync', 'role:assigned', 'phase', 'lobby:update']) back.once(e, (p) => { got[e] = p; });
  await once(back, 'session:resumed');
  await until(() => got['state:sync'] && got['role:assigned'] && got.phase && got['lobby:update']);
  assert.equal(got['state:sync'].node, lost.node);
  assert.equal(got['role:assigned'].role.key, game.roleAssignment[lost.node].key);
  assert.ok(got['role:assigned'].role.cardText, 'the full role card, as on first deal');
  assert.ok(got.phase.phase && got.phase.phase !== 'LOBBY');
  assert.equal(got['lobby:update'].players.find((p) => p.node === lost.node).connected, true);
});

// TASK-611 ------------------------------------------------------------------

test('hostSync replays the phase, GDW line and the active resolution or game:end', async () => {
  const snaps = {};
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    const out = await playGame({
      gameId: 'host-sync',
      world: 'AB',
      onEvent: (type, ev, game) => {
        if (type !== 'phase') return;
        const key = `${ev.cycle}:${ev.phase}`;
        if (['2:WORLD_REVEAL', '3:DEBATE', '5:END'].includes(key)) snaps[key] = game.hostSync();
      }
    });
    const PUBLIC = new Set(['council', 'loom:history', 'scores']);
    const events = (key) => snaps[key].map(([e]) => e).filter((e) => !PUBLIC.has(e));
    const find = (key, name) => (snaps[key].find(([e]) => e === name) || [])[1];
    assert.deepEqual(events('2:WORLD_REVEAL'), ['host:sync', 'phase', 'resolution']);
    assert.equal(find('2:WORLD_REVEAL', 'scores').rows.length, 5, 'the scoreboard comes back too');
    const sync = snaps['2:WORLD_REVEAL'][0][1];
    assert.equal(sync.worldKey, 'AB');
    assert.equal(sync.gdwHistory.length, 25, 'start + 24 months after Cycle 2');
    assert.equal(find('2:WORLD_REVEAL', 'resolution'), out.resolutions[1], 'the resolution on screen');

    assert.deepEqual(events('3:DEBATE'), ['host:sync', 'phase'], 'no stale resolution mid-cycle');
    assert.deepEqual(events('5:END'), ['host:sync', 'phase', 'game:end']);
    assert.equal(find('5:END', 'game:end'), out.gameEnd);
  });
});

test('a projector that refreshes mid-game rejoins its room and gets host:sync and the phase', { timeout: 15000 }, async () => {
  const { host, roomCode, game } = await startedRoom();
  await until(() => game.cycle >= 1);
  host.close();
  const again = connect({ clientType: 'host', roomCode });
  const got = {};
  for (const e of ['host:room', 'host:sync', 'phase']) again.once(e, (p) => { got[e] = p; });
  await until(() => got['host:room'] && got['host:sync'] && got.phase);
  assert.equal(got['host:room'].roomCode, roomCode, 'same room, not a new one');
  assert.equal(got['host:sync'].phase, game.phase);
  assert.deepEqual(got['host:sync'].gdwHistory, game.gdwHistory);
  assert.ok(got.phase.phase !== 'LOBBY');
});

test('two phones and a refreshed host reconnect during Debate and complete the cycle', { timeout: 30000 }, async () => {
  const savedFastSeconds = process.env.FAST_TIMER_SECONDS;
  process.env.FAST_TIMER_SECONDS = '2';
  let room;
  try { room = await startedRoom(); } finally {
    if (savedFastSeconds === undefined) delete process.env.FAST_TIMER_SECONDS;
    else process.env.FAST_TIMER_SECONDS = savedFastSeconds;
  }
  const { host, roomCode, phones, game } = room;
  await until(() => game.cycle === 1 && game.phase === 'DEBATE', 10000);

  const dropped = [phones[1], phones[3]];
  for (const phone of dropped) phone.socket.close();
  await until(() => dropped.every((phone) => game.players[phone.node].connected === false));

  host.close();
  const refreshedHost = connect({ clientType: 'host', roomCode });
  const hostRoom = once(refreshedHost, 'host:room');
  const hostSync = once(refreshedHost, 'host:sync');
  const hostPhase = once(refreshedHost, 'phase');
  const resolution = once(refreshedHost, 'resolution');
  assert.equal((await hostRoom).roomCode, roomCode);
  assert.equal((await hostSync).phase, 'DEBATE');
  assert.equal((await hostPhase).phase, 'DEBATE');

  const resumed = new Map();
  for (const phone of dropped) {
    const socket = connect({ clientType: 'phone', token: phone.token });
    const events = {
      resumed: once(socket, 'session:resumed'),
      sync: once(socket, 'state:sync'),
      role: once(socket, 'role:assigned'),
      phase: once(socket, 'phase')
    };
    resumed.set(phone.node, { socket, events });
  }
  for (const [node, { events }] of resumed) {
    assert.equal((await events.resumed).node, node);
    assert.equal((await events.sync).node, node);
    assert.ok((await events.role).role.key, 'the private role card is restored');
    assert.equal((await events.phase).phase, 'DEBATE');
  }

  await until(() => game.cycle === 1 && game.phase === 'VOTE', 5000);
  const voters = phones.map((phone) => resumed.get(phone.node)?.socket || phone.socket);
  const votes = await Promise.all(voters.map((socket) => socket.emitWithAck('vote:cast', { choice: 'A' })));
  assert.ok(votes.every((vote) => vote.ok), 'all five connected seats can vote');
  const completed = await resolution;
  assert.ok(completed.loomLine, 'the refreshed projector receives the cycle resolution');
  await until(() => game.phase === 'WORLD_REVEAL' || game.cycle > 1, 5000);
  assert.ok(phones.every((phone) => game.players[phone.node].connected), 'all five player seats remain connected');
});

// TASK-612 ------------------------------------------------------------------

test('host:playAgain resets the room for the next class: new game id, LOBBY, seats released', { timeout: 15000 }, async () => {
  const { host, roomCode, phones, game } = await startedRoom();
  await until(() => game.cycle >= 1);
  const firstGameId = game.gameId;
  const invalid = phones.map((p) => once(p.socket, 'session:invalid'));
  const lobby = new Promise((resolve) => host.on('phase', (p) => { if (p.phase === 'LOBBY') resolve(p); }));

  const result = await host.emitWithAck('host:playAgain', {});
  assert.equal(result.ok, true);
  assert.equal(result.keptPlayers, false);
  assert.deepEqual(result.released.sort(), ['NODE-01', 'NODE-02', 'NODE-03', 'NODE-04', 'NODE-05']);
  await lobby;
  for (const reason of await Promise.all(invalid)) assert.deepEqual(reason, { reason: 'ROOM_RESET' });
  assert.equal(engine.getRoom(roomCode), game, 'same room, same process');
  assert.notEqual(game.gameId, firstGameId);
  assert.equal(game.phase, 'LOBBY');
  assert.equal(game.cycle, 0);
  assert.equal(game.gdw, game.startGdw);
  assert.deepEqual(game.players, {});

  // The next class joins the same room code.
  const next = connect({ clientType: 'phone' });
  await once(next, 'connect');
  const joined = await next.emitWithAck('lobby:join', { name: 'Next class', room: roomCode });
  assert.equal(joined.ok, true);
  assert.equal(joined.node, 'NODE-01');
  // A released phone is no longer seated: its old events are refused.
  const stale = await phones[0].socket.emitWithAck('vote:cast', { choice: 'A' });
  assert.equal(stale.reason, 'NOT_JOINED');
});

test('host:playAgain { keepPlayers: true } keeps the same five seated for a replay', { timeout: 15000 }, async () => {
  const { host, phones, game } = await startedRoom();
  await until(() => game.cycle >= 1);
  const result = await host.emitWithAck('host:playAgain', { keepPlayers: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.released, []);
  assert.equal(game.phase, 'LOBBY');
  assert.deepEqual(Object.keys(game.players).sort(), phones.map((p) => p.node).sort());
  for (const p of Object.values(game.players)) assert.equal(p.ready, false, 'everyone readies up again');
});

// TASK-613 (socket) ---------------------------------------------------------

test('host:config over Socket.IO: ack and room broadcast in the lobby, refused mid-game', { timeout: 15000 }, async () => {
  for (const code of Array.from(engine.rooms.keys())) engine.closeRoom(code);
  const host = connect({ clientType: 'host' });
  const room = await once(host, 'host:room');
  assert.deepEqual(room.config, engine.getRoom(room.roomCode).getConfig());
  const broadcast = once(host, 'host:config');
  const res = await host.emitWithAck('host:config', { debateSeconds: 105 });
  assert.equal(res.ok, true);
  assert.equal(res.config.debateSeconds, 105);
  assert.deepEqual(await broadcast, res.config);
  assert.equal((await host.emitWithAck('host:config', { debateSeconds: 'x' })).reason, 'BAD_PAYLOAD');
});

// TASK-615 (socket) ---------------------------------------------------------

test('host:start { seed } starts the game on that seed; a malformed seed is refused', { timeout: 15000 }, async () => {
  for (const code of Array.from(engine.rooms.keys())) engine.closeRoom(code);
  const host = connect({ clientType: 'host' });
  const { roomCode } = await once(host, 'host:room');
  for (let i = 0; i < 5; i++) {
    const phone = connect({ clientType: 'phone' });
    await once(phone, 'connect');
    await phone.emitWithAck('lobby:join', { name: `Seed ${i}`, room: roomCode });
    await phone.emitWithAck('lobby:ready', { ready: true });
  }
  assert.deepEqual(await host.emitWithAck('host:start', { seed: 'no spaces allowed' }), { ok: false, reason: 'BAD_SEED' });
  assert.equal(engine.getRoom(roomCode).phase, 'LOBBY');
  assert.deepEqual(await host.emitWithAck('host:start', { seed: 'period3-tuesday' }), { ok: true, seed: 'period3-tuesday' });
  assert.equal(engine.getRoom(roomCode).gameId, 'period3-tuesday');
  assert.equal((await host.emitWithAck('host:start', { seed: 'again' })).reason, 'ALREADY_STARTED');
});

// TASK-622 ------------------------------------------------------------------

test('disconnect + reconnect during VOTE, FINALE_WRITE and FINALE_RANK restores the full private state', async () => {
  const checks = {};
  const node = 'NODE-03';
  const bounce = (game) => {
    const token = game.players[node].token;
    const before = { score: game.scores[node], override: game.overrideAvailable(node), role: game.roleAssignment[node].key };
    game.markDisconnected(node);
    assert.equal(game.players[node].connected, false);
    const seat = engine.findSession(token);
    assert.equal(seat && seat.node, node, 'token still finds the seat while offline');
    game.reconnectPlayer(node, 'socket-after-wake');
    return {
      before, sync: game.privateSyncFor(node), game, vote: game.votes[node], scoreAfter: game.scores[node],
      submission: game.finale && game.finale.submissions[node], ballot: game.finale && game.finale.ballots[node]
    };
  };
  await withLoom({ moderate: async (subs) => okModeration(subs) }, async () => {
    const roomBefore = engine.rooms.size;
    await playGame({
      gameId: 'reconnect-phases',
      world: 'BB',
      onEvent: (type, ev, game) => {
        if (type !== 'phase') return;
        // Register the room so findSession can see it during the bounce.
        engine.rooms.set(game.roomCode, game);
        if (ev.cycle === 3 && ev.phase === 'VOTE') setImmediate(() => { checks.vote = bounce(game); });
        if (ev.phase === 'FINALE_WRITE') setImmediate(() => { checks.write = bounce(game); });
        if (ev.phase === 'FINALE_RANK') setImmediate(() => { checks.rank = bounce(game); checks.rankResult = game.rankPolicies(node, game.finale.ballots[node].slice()); });
        if (ev.phase === 'END') engine.rooms.delete(game.roomCode);
      }
    });
    assert.equal(engine.rooms.size, roomBefore);
  });
  const sync = (c) => Object.fromEntries(c.sync.map(([e, p]) => [e, p]));

  // VOTE: the vote cast before the drop still stands, Override status and role return.
  const v = sync(checks.vote);
  assert.equal(v['state:sync'].phase, 'VOTE');
  assert.equal(v['state:sync'].voted, true, 'the vote cast before sleeping is kept');
  assert.ok(checks.vote.vote && ['A', 'B'].includes(checks.vote.vote.choice), 'the recorded vote itself survived');
  assert.equal(v['role:assigned'].role.key, checks.vote.before.role);
  assert.deepEqual(v['override:status'], { overrideAvailable: checks.vote.before.override });
  assert.ok(v['loom:history'].lines.length > 0, 'the Loom\'s feed is re-sent');
  assert.equal(v['scores'].rows.length, 5, 'and the public scoreboard');

  // FINALE_WRITE: the write-in survives; the phone sees it already submitted.
  const w = sync(checks.write);
  assert.equal(w['state:sync'].phase, 'FINALE_WRITE');
  assert.equal(w['state:sync'].submitted, true);
  assert.equal(checks.write.submission, 'Council proposal number 3');

  // FINALE_RANK: the same personal ballot comes back and can still be ranked.
  const r = sync(checks.rank);
  assert.equal(r['state:sync'].phase, 'FINALE_RANK');
  assert.equal(r['state:sync'].ranked, false);
  assert.deepEqual(r['finale:ballot'].policies.map((p) => p.id), checks.rank.ballot);
  assert.deepEqual(checks.rankResult, { ok: true });
  for (const c of [checks.vote, checks.write, checks.rank]) assert.equal(c.scoreAfter, c.before.score, 'score untouched');
});

// TASK-627 ------------------------------------------------------------------

test('all 5 phones reconnect at once after a sleep/wake cycle and the game carries on', { timeout: 15000 }, async () => {
  const { phones, game } = await startedRoom();
  await until(() => game.cycle >= 1);
  // Every screen locks at once (the teacher talks for a minute)...
  for (const p of phones) p.socket.close();
  await until(() => Object.values(game.players).every((pl) => !pl.connected));
  const phaseBefore = `${game.cycle}:${game.phase}`;

  // ...and every phone wakes in the same instant.
  const woken = phones.map((p) => connect({ clientType: 'phone', token: p.token }));
  const syncs = await Promise.all(woken.map((s) => once(s, 'state:sync')));
  assert.deepEqual(syncs.map((s) => s.node), phones.map((p) => p.node), 'each phone back in its own seat');
  phones.forEach((p, i) => assert.equal(game.players[p.node].socketId, woken[i].id));
  assert.equal(Object.keys(game.players).length, 5, 'no extra seats');
  assert.ok(Object.values(game.players).every((pl) => pl.connected));
  const tokens = new Set(Object.values(game.players).map((pl) => pl.token));
  assert.equal(tokens.size, 5, 'tokens unchanged and distinct');

  // The phase clock never stopped: the game moves on with everyone connected.
  await until(() => `${game.cycle}:${game.phase}` !== phaseBefore, 5000);
  const next = await once(woken[0], 'phase');
  assert.ok(next.phase);
});

// TASK-632 ------------------------------------------------------------------

test('a 6th phone gets a polite GAME IN PROGRESS / COUNCIL FULL message and the five seats are untouched', { timeout: 15000 }, async () => {
  for (const code of Array.from(engine.rooms.keys())) engine.closeRoom(code);
  const host = connect({ clientType: 'host' });
  const { roomCode } = await once(host, 'host:room');
  const game = engine.getRoom(roomCode);
  for (let i = 0; i < 5; i++) {
    const phone = connect({ clientType: 'phone' });
    await once(phone, 'connect');
    await phone.emitWithAck('lobby:join', { name: `Seat ${i}`, room: roomCode });
    await phone.emitWithAck('lobby:ready', { ready: true });
  }
  const seatsBefore = JSON.stringify(Object.values(game.players).map((p) => [p.node, p.name, p.socketId, p.token]));

  // In the lobby with five seated: COUNCIL FULL.
  const sixth = connect({ clientType: 'phone' });
  await once(sixth, 'connect');
  const full = await sixth.emitWithAck('lobby:join', { name: 'Sixth student', room: roomCode });
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'ROOM_FULL');
  assert.match(full.message, /^COUNCIL FULL\./);

  // After the start: GAME IN PROGRESS, and the sixth never joins the room channel.
  await host.emitWithAck('host:start', {});
  let leaked = 0;
  sixth.on('phase', () => leaked++);
  const late = await sixth.emitWithAck('lobby:join', { name: 'Sixth student', room: roomCode });
  assert.deepEqual(late, { ok: false, reason: 'GAME_IN_PROGRESS', message: socketModule.JOIN_REFUSALS.GAME_IN_PROGRESS, canSpectate: true });
  assert.match(late.message, /^GAME IN PROGRESS\./);
  await until(() => game.cycle >= 1, 5000);
  assert.equal(leaked, 0, 'no phase events reach the refused phone');
  assert.equal(JSON.stringify(Object.values(game.players).map((p) => [p.node, p.name, p.socketId, p.token])), seatsBefore);
  // A vote from the refused phone is not counted.
  assert.equal((await sixth.emitWithAck('vote:cast', { choice: 'A' })).reason, 'NOT_JOINED');
});

// TASK-633 ------------------------------------------------------------------

test('spectators watch read-only: public broadcasts only, no private events, no actions', { timeout: 15000 }, async () => {
  const { roomCode, game } = await startedRoom();
  const seatsBefore = Object.keys(game.players).sort().join();

  // A spectator by handshake, and a refused 6th phone that switches to watching.
  const watcher = connect({ clientType: 'spectator', roomCode });
  const got = { watcher: {}, sixth: {} };
  watcher.onAny((e) => { got.watcher[e] = (got.watcher[e] || 0) + 1; });
  const joined = await once(watcher, 'spectate:joined');
  assert.equal(joined.roomCode, roomCode);

  const sixth = connect({ clientType: 'phone' });
  await once(sixth, 'connect');
  const refused = await sixth.emitWithAck('lobby:join', { name: 'Sixth', room: roomCode });
  assert.equal(refused.canSpectate, true);
  sixth.onAny((e) => { got.sixth[e] = (got.sixth[e] || 0) + 1; });
  const watching = await sixth.emitWithAck('spectate:join', { room: roomCode });
  assert.equal(watching.ok, true);

  const startCycle = game.cycle;
  await until(() => game.cycle >= startCycle + 1 && game.phase === 'DEBATE', 8000);
  for (const who of ['watcher', 'sixth']) {
    assert.ok(got[who].phase > 0, `${who} sees phase broadcasts`);
    for (const secret of ['role:assigned', 'intel:drop', 'override:status', 'score:update', 'finale:ballot', 'state:sync']) {
      assert.equal(got[who][secret], undefined, `${who} never gets ${secret}`);
    }
  }
  // Read-only: actions are refused and the five seats are unchanged.
  assert.equal((await sixth.emitWithAck('vote:cast', { choice: 'A' })).reason, 'NOT_JOINED');
  assert.equal((await sixth.emitWithAck('finale:submit', { text: 'hi' })).reason, 'NOT_JOINED');
  assert.equal(Object.keys(game.players).sort().join(), seatsBefore);
});

test('a spectator with no room gets spectate:error', { timeout: 5000 }, async () => {
  for (const code of Array.from(engine.rooms.keys())) engine.closeRoom(code);
  const lone = connect({ clientType: 'spectator' });
  assert.deepEqual(await once(lone, 'spectate:error'), { reason: 'NO_ROOM' });
});

// TASK-658 (socket) ---------------------------------------------------------

test('host:skipIntro moves INTRO straight on to ROLE_ASSIGN, and only during INTRO', { timeout: 15000 }, async () => {
  const saved = process.env.FAST_TIMER_SECONDS;
  for (const code of Array.from(engine.rooms.keys())) engine.closeRoom(code);
  const host = connect({ clientType: 'host' });
  const { roomCode } = await once(host, 'host:room');
  const game = engine.getRoom(roomCode);
  game.durations.INTRO = 30000; // a real-length intro, so only the skip can end it
  assert.deepEqual(await host.emitWithAck('host:skipIntro', {}), { ok: false, reason: 'NOT_IN_INTRO' });
  for (let i = 0; i < 5; i++) {
    const phone = connect({ clientType: 'phone' });
    await once(phone, 'connect');
    await phone.emitWithAck('lobby:join', { name: `Skip ${i}`, room: roomCode });
    await phone.emitWithAck('lobby:ready', { ready: true });
  }
  await host.emitWithAck('host:start', {});
  assert.equal(game.phase, 'INTRO');
  const next = once(host, 'phase');
  const res = await host.emitWithAck('host:skipIntro', {});
  assert.deepEqual(res, { ok: true, phase: 'ROLE_ASSIGN' });
  assert.equal((await next).phase, 'ROLE_ASSIGN');
  process.env.FAST_TIMER_SECONDS = saved;
});
