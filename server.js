// ============================================================================
//  HI-LO ARCADE — authoritative online multiplayer server
//  Node 18+ (ESM) + ws. Serves the client (index.html) and runs game rooms.
//
//  Phase 1: room lobby (create/join by code) + Speed Race drill.
//  Phase 2/3 (planned): Pop Quiz Race, shared authoritative blackjack table.
// ============================================================================
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const CLIENT_FILE = path.join(__dirname, 'index.html');
const GAMES_DIR  = path.join(__dirname, 'games');

/* ------------------------------------------------------------------ HTTP */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(CLIENT_FILE, (err, buf) => {
      if (err) { res.writeHead(500); res.end('client not found'); }
      else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buf); }
    });
  } else if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  } else if (url.startsWith('/assets/')) {
    serveAsset(url, res);
  } else if (url.startsWith('/games/')) {
    serveGame(url, res);
  } else {
    res.writeHead(404); res.end('not found');
  }
});

/* Static assets (images and the like). Paths are resolved
   under ./assets and rejected if they escape it. */
const ASSET_DIR = path.join(__dirname, 'assets');
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
/* The arcade cabinets: single-file HTML games in /games, served like assets. */
function serveGame(url, res) {
  let rel;
  try { rel = decodeURIComponent(url.slice('/games/'.length)); }
  catch { res.writeHead(400); res.end('bad path'); return; }
  if (!/^[a-z0-9-]+\.html$/.test(rel)) { res.writeHead(404); res.end('not found'); return; }
  const file = path.join(GAMES_DIR, rel);
  if (path.relative(GAMES_DIR, file).startsWith('..')) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    res.end(buf);
  });
}

function serveAsset(url, res) {
  let rel;
  try { rel = decodeURIComponent(url.slice('/assets/'.length)); }
  catch { res.writeHead(400); res.end('bad path'); return; }
  const file = path.join(ASSET_DIR, rel);
  if (path.relative(ASSET_DIR, file).startsWith('..') || path.isAbsolute(path.relative(ASSET_DIR, file))) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
  });
}

/* --------------------------------------------------------------- Hi-Lo engine */
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function countValue(r) {
  if (['2', '3', '4', '5', '6'].includes(r)) return 1;
  if (['7', '8', '9'].includes(r)) return 0;
  return -1; // 10 J Q K A
}
function shuffledCards(numDecks) {
  const cards = [];
  for (let d = 0; d < numDecks; d++)
    for (const s of SUITS)
      for (const r of RANKS)
        cards.push({ rank: r, suit: s });
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

/* ------------------------------------------------------------------ Rooms */
const rooms = new Map(); // code -> room
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
function makeCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
let nextPid = 1;

const lobby = new Set(); // sockets browsing the open-room list (not yet in a room)
function roomSummary(r) {
  const h = r.players.get(r.hostId);
  return { id: r.code, host: h ? h.name : '—', mode: r.mode, count: r.players.size,
           phase: r.table ? r.table.phase : (r.game ? r.game.phase : 'lobby') };
}
function broadcastRooms() {
  const data = JSON.stringify({ t: 'rooms', rooms: [...rooms.values()].map(roomSummary) });
  for (const ws of lobby) if (ws.readyState === 1) { try { ws.send(data); } catch {} }
}

function playerList(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId }));
}
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values())
    if (p.ws && p.ws.readyState === 1) { try { p.ws.send(data); } catch {} }
}
function sendTo(ws, msg) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch {} } }

function clearRoomTimers(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers = [];
}
function closeRoom(room) {
  clearRoomTimers(room);
  rooms.delete(room.code);
}

/* --------------------------------------------------- Speed Race game logic */
function startSpeedRace(room, config) {
  clearRoomTimers(room);
  const count = Math.max(5, Math.min(260, config.count | 0 || 26));
  const speedMs = Math.max(150, Math.min(2000, config.speedMs | 0 || 600));
  const seq = shuffledCards(Math.max(1, Math.ceil(count / 52))).slice(0, count);
  let running = 0;
  for (const c of seq) running += countValue(c.rank);

  room.game = { mode: 'speed', phase: 'countdown', seq, count, speedMs, finalCount: running, answers: new Map(), promptAt: 0 };
  broadcast(room, { t: 'raceStart', mode: 'speed', count, speedMs });
  broadcastRooms();

  // 3-2-1 countdown, then deal
  let n = 3;
  const tick = () => {
    if (n > 0) { broadcast(room, { t: 'countdown', n }); n--; room.timers.push(setTimeout(tick, 800)); }
    else { dealNext(room, 0); }
  };
  tick();
}
function dealNext(room, i) {
  const g = room.game;
  if (!g || g.mode !== 'speed') return;
  if (i >= g.seq.length) {
    g.phase = 'prompt';
    g.promptAt = Date.now();
    broadcast(room, { t: 'prompt' });
    // answer window
    room.timers.push(setTimeout(() => finishSpeedRace(room), 25000));
    return;
  }
  g.phase = 'dealing';
  const c = g.seq[i];
  broadcast(room, { t: 'card', index: i, total: g.seq.length, rank: c.rank, suit: c.suit });
  room.timers.push(setTimeout(() => dealNext(room, i + 1), g.speedMs));
}
function submitSpeedAnswer(room, player, value) {
  const g = room.game;
  if (!g || g.phase !== 'prompt') return;
  if (g.answers.has(player.id)) return; // one shot
  g.answers.set(player.id, { value, ms: Date.now() - g.promptAt });
  // everyone connected has answered?
  const connected = [...room.players.values()].filter(p => p.ws && p.ws.readyState === 1);
  if (connected.every(p => g.answers.has(p.id))) finishSpeedRace(room);
}
function finishSpeedRace(room) {
  const g = room.game;
  if (!g || g.phase === 'done') return;
  clearRoomTimers(room);
  g.phase = 'done';
  const rows = [...room.players.values()].map(p => {
    const a = g.answers.get(p.id);
    return {
      name: p.name,
      answered: !!a,
      answer: a ? a.value : null,
      ok: a ? a.value === g.finalCount : false,
      ms: a ? a.ms : null
    };
  });
  rows.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;      // correct first
    if (a.ok && b.ok) return a.ms - b.ms;          // then fastest
    return (a.ms ?? 9e9) - (b.ms ?? 9e9);
  });
  broadcast(room, { t: 'result', actual: g.finalCount, leaderboard: rows });
}

/* -------------------------------------------------- Shared TABLE (blackjack) */
const UNIT = 10, START_BANKROLL = 1000, NUM_DECKS = 6, PENETRATION = 0.75, DEALER_HITS_SOFT_17 = false;
function bjValue(r) { if (r === 'A') return 11; if (['10', 'J', 'Q', 'K'].includes(r)) return 10; return Number(r); }
function tHandValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { if (!c.faceUp) continue; if (c.rank === 'A') { aces++; total += 11; } else total += bjValue(c.rank); }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}
function isBJ(cards) { return cards.length === 2 && tHandValue(cards).total === 21; }
function mkHand(bet) { return { cards: [], bet, done: false, doubled: false, fromSplit: false, fromSplitAce: false, natural: false, result: '' }; }
function isConn(room, pid) { const p = room.players.get(pid); return !!(p && p.ws && p.ws.readyState === 1); }

function tBuildShoe(t) { t.shoe = shuffledCards(NUM_DECKS).map(c => ({ rank: c.rank, suit: c.suit, faceUp: true, counted: false })); t.runningCount = 0; t.cardsDealt = 0; }
function tDraw(t, faceUp = true) { const c = t.shoe.pop(); c.faceUp = faceUp; t.cardsDealt++; if (faceUp) { t.runningCount += countValue(c.rank); c.counted = true; } return c; }
function tReveal(t, c) { if (!c.faceUp) { c.faceUp = true; if (!c.counted) { t.runningCount += countValue(c.rank); c.counted = true; } } }

function startTable(room) {
  clearRoomTimers(room);
  const t = room.table = { phase: 'betting', shoe: [], runningCount: 0, cardsDealt: 0, dealer: [], order: [], seats: new Map(), inSeats: [], activeIdx: 0, activeHand: 0, shoesPlayed: 1, msg: 'Place your bets — host deals.' };
  tBuildShoe(t);
  reconcileSeats(room);
  broadcastTable(room);
  broadcastRooms();
}
function reconcileSeats(room) {
  const t = room.table;
  for (const pid of [...t.seats.keys()]) if (!room.players.has(pid)) t.seats.delete(pid);
  t.order = t.order.filter(pid => room.players.has(pid));
  for (const p of room.players.values()) if (!t.seats.has(p.id)) { t.seats.set(p.id, { name: p.name, bankroll: START_BANKROLL, bet: UNIT, hands: [], sessionNet: 0 }); t.order.push(p.id); }
}
function tSetBet(room, pid, amount) {
  const t = room.table; if (!t || (t.phase !== 'betting' && t.phase !== 'over')) return;
  const s = t.seats.get(pid); if (!s) return;
  s.bet = Math.max(0, Math.min(s.bankroll, amount | 0));
  broadcastTable(room);
}
function tDealRound(room) {
  const t = room.table; if (!t || (t.phase !== 'betting' && t.phase !== 'over')) return;
  reconcileSeats(room);
  let shuffled = false;
  if (t.shoe.length === 0 || t.cardsDealt >= NUM_DECKS * 52 * PENETRATION) { tBuildShoe(t); shuffled = true; t.shoesPlayed = (t.shoesPlayed || 1) + 1; }
  t.dealer = [];
  const inSeats = t.order.filter(pid => { const s = t.seats.get(pid); return s && s.bet >= UNIT && s.bet <= s.bankroll; });
  if (inSeats.length === 0) { t.msg = 'At least one player needs a bet ≥ $' + UNIT + '.'; broadcastTable(room); return; }
  t.inSeats = inSeats;
  for (const pid of inSeats) { const s = t.seats.get(pid); s.bankroll -= s.bet; s.hands = [mkHand(s.bet)]; }
  for (const pid of inSeats) t.seats.get(pid).hands[0].cards.push(tDraw(t, true));
  t.dealer.push(tDraw(t, true));
  for (const pid of inSeats) t.seats.get(pid).hands[0].cards.push(tDraw(t, true));
  t.dealer.push(tDraw(t, false));
  for (const pid of inSeats) { const h = t.seats.get(pid).hands[0]; if (isBJ(h.cards)) h.natural = true; }
  t.phase = 'player'; t.activeIdx = 0; t.activeHand = 0; t.msg = shuffled ? 'New shoe — count reset to 0.' : '';
  const up = t.dealer[0];
  if ((up.rank === 'A' || bjValue(up.rank) === 10) && isBJ([t.dealer[0], { ...t.dealer[1], faceUp: true }])) { tReveal(t, t.dealer[1]); tSettle(room, true); return; }
  tResolveTurn(room);
}
function tActivePid(t) { return t.inSeats[t.activeIdx]; }
function tCurHand(t) { const s = t.seats.get(tActivePid(t)); return s ? s.hands[t.activeHand] : null; }
function tPlayable(t) { const h = tCurHand(t); return h && !h.done && !h.natural && tHandValue(h.cards).total < 21; }
function tResolveTurn(room) {
  const t = room.table; const pid = tActivePid(t);
  if (isConn(room, pid) && tPlayable(t)) { broadcastTable(room); }
  else { if (!isConn(room, pid)) t.seats.get(pid).hands.forEach(x => x.done = true); tAdvance(room); }
}
function tAdvance(room) {
  const t = room.table;
  const step = () => {
    const s = t.seats.get(tActivePid(t));
    if (t.activeHand < s.hands.length - 1) { t.activeHand++; return true; }
    if (t.activeIdx < t.inSeats.length - 1) { t.activeIdx++; t.activeHand = 0; return true; }
    return false;
  };
  while (step()) {
    const pid = tActivePid(t);
    const h = tCurHand(t);
    if (h.cards.length === 1) h.cards.push(tDraw(t, true)); // freshly split hand gets 2nd card
    if (!isConn(room, pid)) { t.seats.get(pid).hands.forEach(x => x.done = true); continue; }
    if (tPlayable(t)) { broadcastTable(room); return; }
  }
  tDealerPlay(room);
}
function tAction(room, pid, action) {
  const t = room.table; if (!t || t.phase !== 'player') return;
  if (tActivePid(t) !== pid) return;               // only the player whose turn it is
  const s = t.seats.get(pid), h = tCurHand(t); if (!h) return;
  if (action === 'hit') { h.cards.push(tDraw(t, true)); if (tHandValue(h.cards).total >= 21) { h.done = true; tAdvance(room); } else broadcastTable(room); }
  else if (action === 'stand') { h.done = true; tAdvance(room); }
  else if (action === 'double') { if (h.cards.length === 2 && s.bankroll >= h.bet && !h.fromSplitAce) { s.bankroll -= h.bet; h.bet *= 2; h.doubled = true; h.cards.push(tDraw(t, true)); h.done = true; tAdvance(room); } }
  else if (action === 'split') {
    if (h.cards.length === 2 && h.cards[0].rank === h.cards[1].rank && s.bankroll >= h.bet) {
      s.bankroll -= h.bet; const aces = h.cards[0].rank === 'A'; const moved = h.cards.pop();
      const nh = mkHand(h.bet); nh.cards = [moved]; nh.fromSplit = true; nh.fromSplitAce = aces;
      h.fromSplit = true; h.fromSplitAce = aces; s.hands.splice(t.activeHand + 1, 0, nh);
      h.cards.push(tDraw(t, true));
      if (aces) { h.done = true; nh.cards.push(tDraw(t, true)); nh.done = true; tAdvance(room); } else broadcastTable(room);
    }
  }
}
function tDealerPlay(room) {
  const t = room.table; t.phase = 'dealer'; tReveal(t, t.dealer[1]);
  const alive = t.inSeats.some(pid => t.seats.get(pid).hands.some(h => !h.natural && tHandValue(h.cards).total <= 21));
  if (alive) { let dv = tHandValue(t.dealer); while (dv.total < 17 || (dv.total === 17 && dv.soft && DEALER_HITS_SOFT_17)) { t.dealer.push(tDraw(t, true)); dv = tHandValue(t.dealer); } }
  tSettle(room, false);
}
function tSettle(room, dealerNatural) {
  const t = room.table; tReveal(t, t.dealer[1]); const dv = tHandValue(t.dealer); const dbust = dv.total > 21;
  for (const pid of t.inSeats) { const s = t.seats.get(pid); for (const h of s.hands) {
    const pv = tHandValue(h.cards).total;
    let d = 0; // net win/loss for this hand (stake already deducted at deal)
    if (h.natural) { if (dealerNatural) { h.result = 'push'; s.bankroll += h.bet; d = 0; } else { h.result = 'BJ'; s.bankroll += Math.round(h.bet * 2.5); d = Math.round(h.bet * 1.5); } }
    else if (dealerNatural) { h.result = 'lose'; d = -h.bet; }
    else if (pv > 21) { h.result = 'lose'; d = -h.bet; }
    else if (dbust || pv > dv.total) { h.result = 'win'; s.bankroll += h.bet * 2; d = h.bet; }
    else if (pv < dv.total) { h.result = 'lose'; d = -h.bet; }
    else { h.result = 'push'; s.bankroll += h.bet; d = 0; }
    s.sessionNet = (s.sessionNet || 0) + d;
  } }
  t.phase = 'over'; t.msg = dealerNatural ? 'Dealer blackjack.' : (dbust ? 'Dealer busts.' : 'Dealer ' + dv.total + '.');
  for (const pid of t.inSeats) { const s = t.seats.get(pid); if (s.bankroll < UNIT) s.bankroll = START_BANKROLL; if (s.bet > s.bankroll) s.bet = Math.floor(s.bankroll / 5) * 5; }
  broadcastTable(room);
}
function broadcastTable(room) {
  const t = room.table; if (!t) return;
  const dealerHidden = t.dealer.some(c => !c.faceUp);
  const seats = t.order.map(pid => {
    const s = t.seats.get(pid);
    return {
      pid, name: s.name, bankroll: s.bankroll, bet: s.bet, sessionNet: s.sessionNet || 0,
      inRound: t.inSeats.includes(pid),
      connected: isConn(room, pid),
      hands: s.hands.map(h => {
        const v = tHandValue(h.cards);
        return { cards: h.cards.map(c => ({ rank: c.rank, suit: c.suit })), total: v.total, soft: v.soft, bet: h.bet,
          done: h.done, natural: h.natural, result: h.result,
          pair: h.cards.length === 2 && h.cards[0].rank === h.cards[1].rank, fromSplitAce: h.fromSplitAce };
      })
    };
  });
  broadcast(room, {
    t: 'table', phase: t.phase, msg: t.msg,
    dealer: t.dealer.map(c => c.faceUp ? { rank: c.rank, suit: c.suit } : { hidden: true }),
    dealerTotal: tHandValue(t.dealer).total, dealerHidden,
    seats, activePid: t.phase === 'player' ? tActivePid(t) : null, activeHand: t.activeHand,
    hostId: room.hostId,
    count: { running: t.runningCount, cardsDealt: t.cardsDealt, decksLeft: +(t.shoe.length / 52).toFixed(2) },
    session: { shoes: t.shoesPlayed || 1 }
  });
}

/* ------------------------------------------------------------------ WS */
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    const player = room && ws.pid ? room.players.get(ws.pid) : null;

    switch (m.t) {
      case 'list': {
        lobby.add(ws);
        sendTo(ws, { t: 'rooms', rooms: [...rooms.values()].map(roomSummary) });
        break;
      }
      case 'create': {
        const code = makeCode();
        const pid = nextPid++;
        const r = { code, hostId: pid, mode: m.mode || 'speed', players: new Map(), timers: [], game: null };
        r.players.set(pid, { id: pid, name: cleanName(m.name), ws });
        rooms.set(code, r);
        ws.roomCode = code; ws.pid = pid; lobby.delete(ws);
        sendTo(ws, { t: 'joined', code, youId: pid, isHost: true, mode: r.mode, players: playerList(r) });
        broadcastRooms();
        break;
      }
      case 'join': {
        const r = rooms.get((m.code || '').toUpperCase());
        if (!r) { sendTo(ws, { t: 'error', msg: 'Room no longer exists' }); break; }
        if (r.players.size >= 8) { sendTo(ws, { t: 'error', msg: 'Room is full' }); break; }
        const pid = nextPid++;
        r.players.set(pid, { id: pid, name: cleanName(m.name), ws });
        ws.roomCode = r.code; ws.pid = pid; lobby.delete(ws);
        sendTo(ws, { t: 'joined', code: r.code, youId: pid, isHost: pid === r.hostId, mode: r.mode, players: playerList(r) });
        broadcast(r, { t: 'players', players: playerList(r) });
        if (r.mode === 'table' && r.table) { reconcileSeats(r); broadcastTable(r); } // show live table to new joiner
        broadcastRooms();
        break;
      }
      case 'start': {
        if (!room || !player) break;
        if (player.id !== room.hostId) break; // host only
        if (room.mode === 'speed') startSpeedRace(room, m.config || {});
        else if (room.mode === 'table') startTable(room);
        break;
      }
      case 'answer': {
        if (!room || !player) break;
        if (room.mode === 'speed') submitSpeedAnswer(room, player, m.value | 0);
        break;
      }
      case 'bet': {
        if (room && player && room.mode === 'table') tSetBet(room, player.id, m.amount | 0);
        break;
      }
      case 'deal': {
        if (room && player && room.mode === 'table' && player.id === room.hostId) tDealRound(room);
        break;
      }
      case 'hit': case 'stand': case 'double': case 'split': {
        if (room && player && room.mode === 'table') tAction(room, player.id, m.t);
        break;
      }
      case 'leave': {
        dropPlayer(ws);
        break;
      }
    }
  });

  ws.on('close', () => { lobby.delete(ws); dropPlayer(ws); });
  ws.on('error', () => {});
});

function cleanName(n) {
  n = (typeof n === 'string' ? n : '').trim().slice(0, 16);
  return n || 'Player';
}
function dropPlayer(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return;
  const wasPid = ws.pid;
  room.players.delete(ws.pid);
  ws.roomCode = null;
  if (room.players.size === 0) { closeRoom(room); broadcastRooms(); return; }
  if (room.hostId === wasPid) room.hostId = room.players.keys().next().value; // promote someone
  broadcast(room, { t: 'players', players: playerList(room) });
  // if a table round is live and the leaver was on the clock, force their hands done and advance
  const t = room.table;
  if (t && t.phase === 'player' && t.inSeats.includes(wasPid)) {
    const s = t.seats.get(wasPid); if (s) s.hands.forEach(h => h.done = true);
    if (tActivePid(t) === wasPid) tAdvance(room); else broadcastTable(room);
  } else if (t) broadcastTable(room);
  broadcastRooms();
}

// keepalive: drop dead sockets
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

server.listen(PORT, () => console.log(`HI-LO ARCADE server listening on :${PORT}`));
