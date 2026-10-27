"use strict";
/* 小四张 · 联机服务端（零依赖：只用 Node 内置模块）
   玩法与单机版一致：108 张、每家 13 张、理牌留 4 张、5 张成胡、自摸赔 2、点炮赔 1、摸完牌墙结算 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, "mahjong-108.html");

/* ================= 一、牌与规则 ================= */
const SUITS = ["w", "t", "b"];
function buildDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 1; r <= 9; r++) for (let c = 0; c < 4; c++) d.push(s + r);
  return shuffle(d);
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function cntOf(keys) {
  const m = {};
  keys.forEach(k => (m[k] = (m[k] || 0) + 1));
  return m;
}
const SUIT_IDX = { w: 0, t: 1, b: 2 };
function sortKeys(keys) {
  return keys.slice().sort((a, b) => {
    const sa = SUIT_IDX[a[0]], sb = SUIT_IDX[b[0]];
    if (sa !== sb) return sa - sb;
    return +a.slice(1) - +b.slice(1);
  });
}
function isMeld3(a, b, c) {
  if (a[0] !== b[0] || b[0] !== c[0]) return false;
  const r = [a, b, c].map(k => +k.slice(1)).sort((x, y) => x - y);
  return (r[0] === r[1] && r[1] === r[2]) || (r[0] + 1 === r[1] && r[1] + 1 === r[2]);
}
// 5 张 = 1 副面子 + 1 对将
function isWin5(keys) {
  if (keys.length !== 5) return false;
  const cnt = cntOf(keys);
  for (const pk of Object.keys(cnt)) {
    if (cnt[pk] < 2) continue;
    const rest = Object.assign({}, cnt);
    rest[pk] -= 2;
    if (!rest[pk]) delete rest[pk];
    const rk = Object.keys(rest);
    if (rk.length === 1 && rest[rk[0]] === 3) return true;
    if (rk.length === 3) {
      const single = rk.filter(k => rest[k] === 1);
      if (single.length === 3 && isMeld3(single[0], single[1], single[2])) return true;
    }
  }
  return false;
}
function canHuWith(keys, key, kongCount) {
  const test = keys.concat([key]);
  const need = 1 - kongCount;
  if (need < 0) return false;
  if (need === 0) return test.length === 2 && test[0] === test[1];
  return need === 1 && isWin5(test);
}
function isWinNow(keys, kongCount) {
  const need = 1 - kongCount;
  if (need < 0) return false;
  if (need === 0) return keys.length === 2 && keys[0] === keys[1];
  return keys.length === 5 && isWin5(keys);
}
// 超时自动理牌：找一副面子 + 一对将
function autoKeep(keys) {
  const arr = keys.slice();
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if (arr[i] !== arr[j]) continue;
      const rest = arr.filter((_, x) => x !== i && x !== j);
      for (let a = 0; a < rest.length; a++)
        for (let b = a + 1; b < rest.length; b++)
          for (let c = b + 1; c < rest.length; c++) {
            if (isMeld3(rest[a], rest[b], rest[c])) return [arr[i], arr[i], rest[a], rest[b], rest[c]];
          }
    }
  }
  return arr.slice(0, 4);
}
function canMingGang(g, seat, key) {
  if (g.kongs[seat].length > 0) return false;
  return (cntOf(g.hands[seat].map(t => t.k))[key] || 0) >= 3;
}
function canAnGang(g, seat) {
  if (g.kongs[seat].length > 0) return [];
  const m = cntOf(g.hands[seat].map(t => t.k));
  return Object.keys(m).filter(k => m[k] >= 4);
}

/* ================= 二、极简 WebSocket ================= */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function wsAccept(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}
function frame(str) {
  const p = Buffer.from(str, "utf8");
  const len = p.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6);
  }
  return Buffer.concat([head, p]);
}
function attach(socket) {
  const conn = { socket, buf: Buffer.alloc(0), alive: true, id: null, sendable: true };
  conn.send = obj => {
    if (!conn.sendable) return;
    try { socket.write(frame(JSON.stringify(obj))); } catch (e) { conn.sendable = false; }
  };
  conn.close = () => { try { socket.destroy(); } catch (e) {} };
  socket.on("data", chunk => {
    conn.buf = Buffer.concat([conn.buf, chunk]);
    for (;;) {
      const b = conn.buf;
      if (b.length < 2) return;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = b.readUInt32BE(6); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (b.length < off + maskLen + len) return;
      let payload = b.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = b.slice(off, off + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      conn.buf = b.slice(off + maskLen + len);
      if (opcode === 0x8) { conn.alive = false; conn.close(); return; }
      if (opcode === 0x9) { try { socket.write(Buffer.concat([Buffer.from([0x8a, 0]), frame("").slice(2)])); } catch (e) {} continue; }
      if (opcode === 0x1) {
        let msg = null;
        try { msg = JSON.parse(payload.toString("utf8")); } catch (e) {}
        if (msg) onMessage(conn, msg);
      }
    }
  });
  socket.on("error", () => { conn.alive = false; });
  socket.on("close", () => { conn.alive = false; onClose(conn); });
  return conn;
}

/* ================= 三、房间 ================= */
const rooms = new Map();
let uid = 1;
function nextId() { return uid++; }
function makeCode() {
  const cs = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c;
  do {
    c = "";
    for (let i = 0; i < 4; i++) c += cs[Math.floor(Math.random() * cs.length)];
  } while (rooms.has(c));
  return c;
}
function newGame(scores) {
  const wall = buildDeck();
  const g = {
    wall, hands: [[], [], [], []], locked: [[], [], [], []],
    kongs: [[], [], [], []], discards: [[], [], [], []], wins: [[], [], [], []],
    scores: scores || [0, 0, 0, 0], roundGains: [0, 0, 0, 0],
    roundWins: [0, 0, 0, 0], roundDian: [0, 0, 0, 0],
    round: 1, dealer: 0, turn: 0, phase: "arrange", wallTotal: 0,
    drawn: null, lastDiscard: null, pending: null, log: [], dice: null
  };
  for (let r = 0; r < 13; r++) for (let s = 0; s < 4; s++) g.hands[s].push({ id: nextId(), k: wall.pop() });
  g.hands = g.hands.map(h => sortTiles(h));
  g.wallTotal = wall.length;
  return g;
}
function sortTiles(tiles) {
  return tiles.slice().sort((a, b) => {
    const sa = SUIT_IDX[a.k[0]], sb = SUIT_IDX[b.k[0]];
    if (sa !== sb) return sa - sb;
    return +a.k.slice(1) - +b.k.slice(1);
  });
}
function logLine(room, html, cls) {
  const g = room.game;
  g.log.push({ html, cls: cls || "" });
  if (g.log.length > 120) g.log.shift();
}

const LABELS = ["你", "下家", "对家", "上家"];
function view(room, seat) {
  const g = room.game;
  const rot = i => (i - seat + 4) % 4;
  const players = [0, 1, 2, 3].map(i => {
    const orig = (seat + i) % 4;
    const nick = (room.seats[orig] && room.seats[orig].nick) || "玩家" + (orig + 1);
    const name = i === 0 ? "你（" + nick + "）" : LABELS[i] + " " + nick;
    const lockedSet = new Set(g.locked[orig]);
    const base = g.hands[orig].filter(t => lockedSet.has(t.id)).map(t => ({ s: t.k[0], r: +t.k.slice(1) }));
    const mine = i === 0;
    return {
      name, score: g.scores[orig], isHuman: true,
      hand: mine
        ? g.hands[orig].map(t => ({ id: t.id, s: t.k[0], r: +t.k.slice(1), lk: lockedSet.has(t.id) }))
        : g.hands[orig].map((t, n) => ({ id: -(n + 1), s: "w", r: 1 })),
      handCount: g.hands[orig].length,
      base,
      kongs: g.kongs[orig].map(k => ({ tile: { s: k.k[0], r: +k.k.slice(1) }, open: k.open })),
      discards: g.discards[orig],
      wins: g.wins[orig].map(w => ({ tile: w.tile, kind: w.kind, from: w.from == null ? null : rot(w.from) })),
      roundGain: g.roundGains[orig], roundWins: g.roundWins[orig], roundDian: g.roundDian[orig],
      waits: []
    };
  });
  const gDrawn = g.drawn && g.drawn.seat === seat ? { id: g.drawn.id } : null;
  let pending = null;
  if (g.pending && g.pending.seat === seat) {
    pending = { type: g.pending.type, from: rot(g.pending.from), tile: { s: g.pending.k[0], r: +g.pending.k.slice(1) } };
  }
  return {
    phase: g.phase, turn: rot(g.turn), dealer: rot(g.dealer), round: g.round,
    wall: new Array(g.wall.length).fill(0), wallTotal: g.wallTotal,
    drawn: gDrawn, pending, players, log: g.log,
    code: room.code, seat, seats: room.seats.map(s => ({ nick: s ? s.nick : "", online: !!(s && s.conn && s.conn.alive) })),
    dice: g.dice
  };
}
function broadcast(room) {
  if (!room || !room.game) return;
  room.seats.forEach((s, i) => { if (s && s.conn) s.conn.send({ t: "state", s: view(room, i) }); });
}
function sendSeat(room, seat, obj) {
  const s = room.seats[seat];
  if (s && s.conn) s.conn.send(obj);
}
function clearTimers(room) {
  (room.timers || []).forEach(t => clearTimeout(t));
  room.timers = [];
}
function later(room, ms, fn) {
  const t = setTimeout(() => { if (!room.dead) fn(); }, ms);
  room.timers.push(t);
  return t;
}

/* ================= 四、行牌流程 ================= */
function startRound(room, isNew) {
  clearTimers(room);
  const g = newGame(isNew ? room.game.scores : [0, 0, 0, 0]);
  if (isNew) { g.round = room.game.round + 1; g.scores = room.game.scores.slice(); }
  room.game = g;
  const a = 1 + Math.floor(Math.random() * 6);
  const b = 1 + Math.floor(Math.random() * 6);
  g.dealer = (a + b) % 4;
  g.dice = { a, b };
  g.phase = "arrange";
  logLine(room, `第 ${g.round} 局开始，骰子 ${a}+${b}=${a + b} 点，庄家：${(room.seats[g.dealer] && room.seats[g.dealer].nick) || "玩家"}`, "hl");
  logLine(room, "每家 13 张，理牌只留 4 张（1 副面子 + 1 对将），其余全部弃掉。", "dim");
  broadcast(room);
  room.seats.forEach((s, i) => {
    if (s) s.ready = false;
  });
  later(room, 45000, () => {
    if (room.game !== g || g.phase !== "arrange") return;
    [0, 1, 2, 3].forEach(i => { if (!g.locked[i].length) applyArrange(room, i, autoKeep(g.hands[i].map(t => t.k))); });
  });
}
function applyArrange(room, seat, keepKeys) {
  const g = room.game;
  if (g.phase !== "arrange" || g.locked[seat].length) return;
  const keys = keepKeys.filter(k => /^[wtb][1-9]$/.test(k));
  if (keys.length !== 4) return;
  const pool = g.hands[seat].map(t => t.k);
  for (const k of keys) {
    const i = pool.indexOf(k);
    if (i < 0) return;
    pool.splice(i, 1);
  }
  const keep = new Set(keys);
  const kept = [];
  const used = new Set();
  for (const t of g.hands[seat]) {
    if (keep.has(t.k) && !used.has(t.id)) {
      kept.push(t);
      used.add(t.id);
      if (kept.length === 4) break;
    }
  }
  if (kept.length !== 4) return;
  g.hands[seat] = sortTiles(kept);
  g.locked[seat] = kept.map(t => t.id);
  if (g.hands.every((_, i) => g.locked[i].length === 4)) beginPlay(room);
}
function beginPlay(room) {
  const g = room.game;
  if (g.phase !== "arrange") return;
  g.phase = "play";
  g.turn = g.dealer;
  logLine(room, "全部理牌完成，开始行牌。牌墙剩余 " + g.wall.length + " 张。", "dim");
  broadcast(room);
  later(room, 600, () => beginTurn(room));
}
function beginTurn(room) {
  const g = room.game;
  if (!g || g.phase !== "play") return;
  if (g.wall.length === 0) { settle(room); return; }
  const seat = g.turn;
  const t = { id: nextId(), k: g.wall.pop() };
  g.hands[seat].push(t);
  g.hands[seat] = sortTiles(g.hands[seat]);
  g.drawn = { seat, id: t.id };
  if (isWinNow(g.hands[seat].map(x => x.k), g.kongs[seat].length)) {
    zimo(room, seat, t.id);
    return;
  }
  broadcast(room);
  later(room, 20000, () => {
    if (room.game !== g || g.phase !== "play" || g.turn !== seat || !g.drawn) return;
    const free = g.hands[seat].filter(x => !g.locked[seat].includes(x.id));
    if (free.length) doDiscard(room, seat, free[free.length - 1].id, true);
  });
}
function doDiscard(room, seat, id, auto) {
  const g = room.game;
  if (!g || g.phase !== "play" || g.turn !== seat) return;
  const idx = g.hands[seat].findIndex(t => t.id === id);
  if (idx < 0) return;
  if (g.locked[seat].includes(id)) return;
  const [t] = g.hands[seat].splice(idx, 1);
  g.discards[seat].push({ s: t.k[0], r: +t.k.slice(1) });
  g.drawn = null;
  g.lastDiscard = { seat, k: t.k };
  logLine(room, nameOf(room, seat) + (auto ? " 超时自动打出 " : " 打出 ") + "<b>" + t.k.slice(1) + suitCn(t.k[0]) + "</b>");
  broadcast(room);
  later(room, 260, () => resolveClaims(room, seat, [1, 2, 3].map(n => (seat + n) % 4)));
}
function suitCn(s) { return s === "w" ? "万" : s === "t" ? "条" : "饼"; }
function nameOf(room, seat) {
  return (room.seats[seat] && room.seats[seat].nick) || "玩家" + (seat + 1);
}
function resolveClaims(room, from, queue) {
  const g = room.game;
  if (!g || g.phase !== "play" || !g.lastDiscard) { nextTurn(room); return; }
  const k = g.lastDiscard.k;
  for (let i = 0; i < queue.length; i++) {
    const seat = queue[i];
    if (!canHuWith(g.hands[seat].map(t => t.k), k, g.kongs[seat].length)) continue;
    g.pending = { seat, type: "hu", from, k };
    broadcast(room);
    const rest = queue.slice(i + 1);
    later(room, 4000, () => {
      const p = g.pending;
      if (!p || p.seat !== seat || p.type !== "hu") return;
      g.pending = null;
      logLine(room, nameOf(room, seat) + " 放过收点机会。", "dim");
      resolveClaims(room, from, rest);
    });
    return;
  }
  for (let i = 0; i < queue.length; i++) {
    const seat = queue[i];
    if (!canMingGang(g, seat, k)) continue;
    g.pending = { seat, type: "gang", from, k };
    broadcast(room);
    const rest = queue.slice(i + 1);
    later(room, 4000, () => {
      const p = g.pending;
      if (!p || p.seat !== seat || p.type !== "gang") return;
      g.pending = null;
      resolveClaims(room, from, rest);
    });
    return;
  }
  nextTurn(room);
}
function nextTurn(room) {
  const g = room.game;
  if (!g || g.phase !== "play") return;
  g.pending = null;
  g.lastDiscard = null;
  g.turn = (g.turn + 1) % 4;
  broadcast(room);
  later(room, 260, () => beginTurn(room));
}
function zimo(room, seat, winTileId) {
  const g = room.game;
  for (let i = 0; i < 4; i++) if (i !== seat) { g.scores[i] -= 2; g.roundGains[i] -= 2; }
  g.scores[seat] += 6; g.roundGains[seat] += 6; g.roundWins[seat]++;
  const tile = g.hands[seat].find(t => t.id === winTileId);
  if (tile) {
    g.wins[seat].push({ tile: { s: tile.k[0], r: +tile.k.slice(1) }, kind: "zimo", from: null });
    g.hands[seat] = g.hands[seat].filter(t => t.id !== winTileId);
  }
  g.drawn = null;
  g.pending = null;
  logLine(room, "<b>" + nameOf(room, seat) + "</b> 自摸 <b>" + (tile ? tile.k.slice(1) + suitCn(tile.k[0]) : "") + "</b>，其余三家各赔 2 分。", "win");
  broadcast(room);
  const tiles = tile ? [{ s: tile.k[0], r: +tile.k.slice(1) }] : [];
  room.seats.forEach((s, i) => { if (s && s.conn) s.conn.send({ t: "ev", ev: { kind: "zimo", seat: (seat - i + 4) % 4, tiles } }); });
  g.lastDiscard = null;
  later(room, 1500, () => nextTurn(room));
}
function dianpao(room, seat, from, k) {
  const g = room.game;
  g.scores[seat] += 1; g.roundGains[seat] += 1; g.roundDian[seat]++;
  g.scores[from] -= 1; g.roundGains[from] -= 1;
  if (g.discards[from].length) g.discards[from].pop();
  g.wins[seat].push({ tile: { s: k[0], r: +k.slice(1) }, kind: "dianpao", from });
  g.pending = null;
  g.lastDiscard = null;
  logLine(room, "<b>" + nameOf(room, seat) + "</b> 收点 <b>" + k.slice(1) + suitCn(k[0]) + "</b>，" + nameOf(room, from) + " 点炮，赔 1 分。", "win");
  broadcast(room);
  room.seats.forEach((s, i) => {
    if (s && s.conn) s.conn.send({ t: "ev", ev: { kind: "dianpao", seat: (seat - i + 4) % 4, tiles: [{ s: k[0], r: +k.slice(1) }], fromName: nameOf(room, from) } });
  });
  later(room, 1500, () => nextTurn(room));
}
function mingGang(room, seat, k) {
  const g = room.game;
  g.hands[seat] = removeK(g.hands[seat], k, 3);
  g.kongs[seat].push({ k, open: true });
  g.turn = seat;
  g.pending = null;
  g.lastDiscard = null;
  if (g.discards[g.pending ? g.pending.from : seat]) { /* 被杠走的牌进杠区 */ }
  logLine(room, nameOf(room, seat) + " 明杠 <b>" + k.slice(1) + suitCn(k[0]) + "</b>", "hl");
  broadcast(room);
  later(room, 500, () => gangDraw(room, seat));
}
function anGang(room, seat, k) {
  const g = room.game;
  if (g.phase !== "play" || g.turn !== seat) return;
  if (!canAnGang(g, seat).includes(k)) return;
  g.hands[seat] = removeK(g.hands[seat], k, 4);
  g.kongs[seat].push({ k, open: false });
  g.drawn = null;
  logLine(room, nameOf(room, seat) + " 暗杠 <b>" + k.slice(1) + suitCn(k[0]) + "</b>", "hl");
  broadcast(room);
  later(room, 500, () => gangDraw(room, seat));
}
function removeK(tiles, k, n) {
  let left = n;
  return tiles.filter(t => {
    if (left > 0 && t.k === k) { left--; return false; }
    return true;
  });
}
function gangDraw(room, seat) {
  const g = room.game;
  if (!g || g.phase !== "play") return;
  if (g.wall.length === 0) { settle(room); return; }
  const t = { id: nextId(), k: g.wall.pop() };
  g.hands[seat].push(t);
  g.hands[seat] = sortTiles(g.hands[seat]);
  if (!g.hands[seat].some(x => g.locked[seat].includes(x.id))) g.locked[seat].push(t.id);
  g.drawn = { seat, id: t.id };
  logLine(room, nameOf(room, seat) + " 杠后补摸一张。", "dim");
  broadcast(room);
  if (isWinNow(g.hands[seat].map(x => x.k), g.kongs[seat].length)) { zimo(room, seat, t.id); return; }
  later(room, 20000, () => {
    if (room.game !== g || g.phase !== "play" || g.turn !== seat || !g.drawn) return;
    const free = g.hands[seat].filter(x => !g.locked[seat].includes(x.id));
    if (free.length) doDiscard(room, seat, free[0].id, true);
    else nextTurn(room);
  });
}
function settle(room) {
  const g = room.game;
  if (!g || g.phase === "over") return;
  g.phase = "over";
  g.pending = null;
  logLine(room, "牌墙已摸到最后一张，本局结束。", "win");
  broadcast(room);
}

/* ================= 五、消息处理 ================= */
function lobbyMsg(room) {
  return {
    t: "lobby", code: room.code,
    seats: room.seats.map(s => (s ? { nick: s.nick, online: !!(s.conn && s.conn.alive) } : null))
  };
}
function broadcastLobby(room) {
  room.seats.forEach(s => { if (s && s.conn) s.conn.send(lobbyMsg(room)); });
}

function onMessage(conn, m) {
  connecting: {
    if (m.t === "create") {
      if (conn.room) { conn.send({ t: "err", m: "已在房间中" }); break connecting; }
      const code = makeCode();
      const r = { code, seats: [seatObj(conn, m.nick), null, null, null], game: null, timers: [], dead: false };
      rooms.set(code, r);
      conn.room = r;
      conn.seat = 0;
      conn.send({ t: "joined", code, seat: 0 });
      broadcastLobby(r);
      break connecting;
    }
    if (m.t === "join") {
      const code = (m.code || "").toUpperCase().trim();
      const r = rooms.get(code);
      if (!r) { conn.send({ t: "err", m: "房间不存在" }); break connecting; }
      if (conn.room) { conn.send({ t: "err", m: "已在房间中" }); break connecting; }
      const free = r.seats.findIndex(s => !s);
      if (free < 0) { conn.send({ t: "err", m: "房间已满（4 人）" }); break connecting; }
      r.seats[free] = seatObj(conn, m.nick);
      conn.room = r;
      conn.seat = free;
      conn.send({ t: "joined", code, seat: free });
      if (r.seats.every(s => s) && !r.game) {
        startRound(r, false);
      } else if (r.game) {
        conn.send({ t: "state", s: view(r, free) });
      } else {
        broadcastLobby(r);
      }
      break connecting;
    }
    const room = conn.room;
    if (!room) { conn.send({ t: "err", m: "尚未加入房间" }); break connecting; }
    const g = room.game;
    const seat = conn.seat;
    if (m.t === "arrange") {
      applyArrange(room, seat, m.keep || []);
      broadcast(room);
      break connecting;
    }
    if (m.t === "discard") {
      doDiscard(room, seat, m.id);
      break connecting;
    }
    if (m.t === "hu") {
      const p = g && g.pending;
      if (p && p.seat === seat && p.type === "hu") dianpao(room, seat, p.from, p.k);
      break connecting;
    }
    if (m.t === "pass") {
      const p = g && g.pending;
      if (p && p.seat === seat) {
        const from = p.from, rest = [];
        g.pending = null;
        logLine(room, nameOf(room, seat) + " 选择过。", "dim");
        broadcast(room);
        resolveClaims(room, from, [1, 2, 3].map(n => (from + n) % 4).filter(x => x !== seat));
      }
      break connecting;
    }
    if (m.t === "gang") {
      const p = g && g.pending;
      if (p && p.seat === seat && p.type === "gang") {
        const from = p.from, k = p.k;
        // 明杠：自己的 3 张 + 别人的 1 张
        room.game.pending = null;
        if (room.game.discards[from].length) room.game.discards[from].pop();
        mingGang(room, seat, k);
      }
      break connecting;
    }
    if (m.t === "angang") {
      anGang(room, seat, m.key || "");
      break connecting;
    }
    if (m.t === "next") {
      if (g && g.phase === "over") startRound(room, true);
      break connecting;
    }
  }
}
function seatObj(conn, nick) {
  return { conn, nick: (nick || "").slice(0, 8) || "玩家", ready: false };
}
function modalRoom(conn) { return conn.room || null; }
function onClose(conn) {
  const room = conn.room;
  if (!room) return;
  const seat = conn.seat;
  const s = room.seats[seat];
  if (s && s.conn === conn) {
    s.conn = null;
    s.online = false;
    const g = room.game;
    if (g && g.phase === "play" && g.turn === seat) {
      const free = g.hands[seat].filter(x => !g.locked[seat].includes(x.id));
      if (free.length) doDiscard(room, seat, free[free.length - 1].id, true);
      else nextTurn(room);
    }
    broadcast(room);
    if (room.seats.every(x => !x || !x.conn)) {
      room.dead = true;
      clearTimers(room);
      rooms.delete(room.code);
    }
  }
}

/* ================= 六、HTTP ================= */
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/mahjong-108.html" || url === "/index.html") {
    fs.readFile(HTML_FILE, (err, buf) => {
      if (err) { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); res.end("找不到 mahjong-108.html"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(buf);
    });
    return;
  }
  if (url === "/health") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok"); return; }
  res.writeHead(404); res.end("not found");
});
server.on("upgrade", (req, socket, head) => {
  if ((req.headers.upgrade || "").toLowerCase() !== "websocket") { socket.destroy(); return; }
  const key = req.headers["sec-websocket-key"];
  const accept = wsAccept(key);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  attach(socket);
});
server.listen(PORT, () => console.log("小四张联机服务已启动：http://localhost:" + PORT));
