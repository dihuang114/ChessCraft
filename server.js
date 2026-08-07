/* ============================================================
 * server.js — 棋匠 本地服务（端口 8765，零依赖）
 *
 * 作用：
 *   1. 以 http://localhost:8765 打开页面（file:// 下浏览器无法遍历 preset 目录）
 *   2. GET  /api/presets            列出 preset/*.json，按 name 字段显示
 *   3. GET  /api/preset?file=xx     读取单个预设内容（自对弈新标签页用）
 *   4. POST /api/preset/save        保存当前规则 → preset/棋匠-<名称>.json
 *   5. POST /api/standalone         保存独立版单文件 HTML → game/<名称>.html（相对项目根目录）
 *   6. GET  /api/engine/status      引擎状态（engine/fairy-stockfish）
 *   7. POST /api/engine/configure   规则 JSON → engine/variants.ini + 重启引擎
 *   8. POST /api/engine/move        FEN + 变体 → 引擎着法（UCI）
 *
 * 用法: node server.js  （或双击 启动棋匠.bat）
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const DIR = __dirname;
const PRESET_DIR = path.join(DIR, 'preset');
if (!fs.existsSync(PRESET_DIR)) fs.mkdirSync(PRESET_DIR, { recursive: true });
const GAME_DIR = path.join(DIR, 'game');   // 独立版输出目录（相对项目根目录）
if (!fs.existsSync(GAME_DIR)) fs.mkdirSync(GAME_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.bat': 'text/plain; charset=utf-8'
};

function safeName(s, fallback) {
  const t = String(s || '').replace(/[\\/:*?"<>|\r\n]/g, '').trim();
  return t || fallback;
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 3e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
  });
}

/* ============================================================
 * Fairy-Stockfish 引擎模块（engine/ 目录；variants.ini 由规则 JSON 自动生成）
 * ============================================================ */
const ENGINE_DIR = path.join(DIR, 'engine');
const ENGINE_EXE = path.join(ENGINE_DIR, 'fairy-stockfish-largeboard_x86-64.exe');
const ENGINE_INI = path.join(ENGINE_DIR, 'variants.ini');

let fsf = null;
let fsfReady = false;
let fsfVariant = null;
let fsfStyle = 'balanced';

// 风格 → FSF UCI 选项（Skill Level: 稳健 20 / 平衡 16 / 随机 12 + MultiPV 多主变）
function applyFsfStyle() {
  if (!fsf || !fsfReady) return;
  if (fsfStyle === 'random') {
    fsf.stdin.write('setoption name Skill Level value 12\n');
    fsf.stdin.write('setoption name MultiPV value 8\n');
  } else if (fsfStyle === 'solid') {
    fsf.stdin.write('setoption name Skill Level value 20\n');
    fsf.stdin.write('setoption name MultiPV value 1\n');
  } else {
    fsf.stdin.write('setoption name Skill Level value 16\n');
    fsf.stdin.write('setoption name MultiPV value 1\n');
  }
}

// 深度 → 思考时间（FSF 无 Depth 选项，用 movetime 近似）
const DEPTH_MS = [0, 200, 400, 800, 1500, 2500];

// PAT 走法 → Betza 近似（全向直线/日/田/方向子集；复杂走法跳过，返回 null）
// 方向以白方视角（黑方 FSF 自动镜像）：u→f 前、d→b 后、l→l、r→r
function patToBetza(pat) {
  if (!pat || typeof pat !== 'object') return null;
  const dirs = pat.dirs || [];
  const slide = pat.dist === 'slide';
  const orth = ['u', 'd', 'l', 'r'], diag = ['ul', 'ur', 'dl', 'dr'];
  const hasOrth = orth.every((d) => dirs.indexOf(d) >= 0);
  const hasDiag = diag.every((d) => dirs.indexOf(d) >= 0);
  const n = typeof pat.dist === 'number' ? Math.min(9, pat.dist) : 0;
  if (pat.style === 'knight') return 'N';
  if (pat.style === 'tian') return 'A';          // 田字跳 ≈ alfil
  if (pat.style === 'line') {
    if (slide) {
      if (hasOrth && hasDiag) return 'Q';
      if (hasOrth) return 'R';
      if (hasDiag) return 'B';
      // 方向子集滑行（如只前进/只横走）
      let bz = '';
      if (dirs.indexOf('u') >= 0) bz += 'fR';
      if (dirs.indexOf('d') >= 0) bz += 'bR';
      if (dirs.indexOf('l') >= 0) bz += 'lR';
      if (dirs.indexOf('r') >= 0) bz += 'rR';
      return bz || null;
    }
    if (n > 0 && n <= 9) {
      if (hasOrth && hasDiag) return 'Q' + n;
      if (hasOrth) return 'R' + n;
      if (hasDiag) return 'B' + n;
      // 方向子集定步（如盾：前进+横走各 1 格）
      let bz = '';
      if (dirs.indexOf('u') >= 0) bz += 'f' + (n === 1 ? 'W' : 'R' + n);
      if (dirs.indexOf('d') >= 0) bz += 'b' + (n === 1 ? 'W' : 'R' + n);
      if (dirs.indexOf('l') >= 0) bz += 'l' + (n === 1 ? 'W' : 'R' + n);
      if (dirs.indexOf('r') >= 0) bz += 'r' + (n === 1 ? 'W' : 'R' + n);
      return bz || null;
    }
  }
  return null;
}

// 规则 JSON → variants.ini（FSF 变体定义；仅映射可映射部分，差异大的用 JS AI 兜底）
function buildVariantIni(rules) {
  const name = safeName(rules && rules.name || '变体', 'Variant');
  const L = [];
  L.push('# 由棋匠根据规则 JSON 自动生成，修改请直接编辑页面规则，本文件会被覆盖');
  L.push('');
  L.push('[' + name + ':xiangqi]');
  const pieces = (rules && rules.pieces) || {};
  const e = pieces.e;
  if (e && e.canCrossRiver) {
    // 象过河（参考 newchess/variants.ini）
    L.push('mobilityRegionWhiteElephant = *1 *2 *3 *4 *5 *6 *7 *8 *9 *10');
    L.push('mobilityRegionBlackElephant = *1 *2 *3 *4 *5 *6 *7 *8 *9 *10');
  }
  // 自定义棋子（Betza 近似）
  const custom = (rules && rules.custom) || [];
  custom.forEach((c, i) => {
    if (!c || !c.moveB || !c.moveB.length) return;
    const betza = patToBetza(c.moveB[0]);
    if (!betza) return;
    const abbr = ['v', 'w', 'x', 'y', 'z'][i] || ('v' + (i + 1));   // FEN 字符必须单字符（页面 boardToFen 同步）
    L.push('customPiece' + (i + 1) + ' = ' + abbr + ':' + betza);
    if (c.name) L.push('pieceToCharTable = ' + abbr + '=' + c.name.charAt(0) + ' ...');
  });
  L.push('');
  return L.join('\n');
}

function startFsf() {
  if (fsf) { try { fsf.kill(); } catch (e) {} }
  fsf = null; fsfReady = false;
  if (!fs.existsSync(ENGINE_EXE)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const proc = spawn(ENGINE_EXE, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    fsf = proc;
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      fsfReady = ok;
      resolve(ok);
    };
    proc.on('error', (err) => { console.error('FSF spawn error:', err.message); done(false); });
    proc.on('close', () => {
      fsfReady = false;
      if (fsf === proc) fsf = null;
      done(false);
    });
    // 引擎 stderr 诊断（启动失败原因）
    proc.stderr.on('data', (d) => { const t = String(d).trim(); if (t) console.log('[FSF]', t.slice(0, 200)); });
    // 启动超时保护（10s 未就绪视为失败）
    const timer = setTimeout(() => done(false), 10000);
    let step = 0;
    const onData = (d) => {
      if (!fsf || fsf !== proc) return;   // 引擎已退出（close 已触发）
      const lines = d.toString().split('\n');
      for (const l of lines) {
        const t = l.trim();
        if (step === 0 && t === 'uciok') {
          if (!proc.stdin || proc.stdin.destroyed) { done(false); return; }
          proc.stdin.write('setoption name VariantPath value ' + ENGINE_INI + '\n');
          proc.stdin.write('setoption name UCI_Variant value ' + (fsfVariant || 'xiangqi') + '\n');
          proc.stdin.write('isready\n');
          step = 1;
        } else if (step === 1 && t === 'readyok') {
          clearTimeout(timer);
          applyFsfStyle();
          proc.stdout.removeListener('data', onData);
          done(true);
        }
      }
    };
    proc.stdin.on('error', () => { /* EPIPE：进程已退出，交给 close 处理 */ });
    proc.stdout.on('data', onData);
    proc.stdin.write('uci\n');
  });
}

function fsfMove(fen, movetime) {
  return new Promise((resolve) => {
    if (!fsf || !fsfReady) { resolve(null); return; }
    let resolved = false;
    const done = (move) => {
      if (resolved) return;
      resolved = true;
      fsf.stdout.removeListener('data', onData);
      clearTimeout(timer);
      resolve(move);
    };
    const onData = (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const l of lines) {
        const t = l.trim();
        if (t.indexOf('bestmove') === 0) { done(t.split(/\s+/)[1] || null); return; }
      }
    };
    fsf.stdout.on('data', onData);
    fsf.stdin.write('position fen ' + fen + '\n');
    fsf.stdin.write('go movetime ' + Math.min(movetime || 1500, 10000) + '\n');
    const timer = setTimeout(() => {
      if (fsf) fsf.stdin.write('stop\n');
      done(null);
    }, (movetime || 1500) + 4000);
  });
}

// ============ 联机房间模块（合并进主服务 8765；手机/局域网访问页面地址即可联机） ============
const rooms = new Map();
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TTL = { waiting: 60 * 60 * 1000, playing: 120 * 60 * 1000, over: 30 * 60 * 1000 };
function genRoomId() {
  for (let i = 0; i < 3; i++) {
    let id = '';
    for (let j = 0; j < 5; j++) id += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
    if (!rooms.has(id)) return id;
  }
  return null;
}
function hashRules(rules) {
  return crypto.createHash('sha1').update(JSON.stringify(rules)).digest('hex').slice(0, 8);
}
function touchRoom(room) { room.expiresAt = Date.now() + TTL[room.status]; }
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, id) => { if (room.expiresAt < now) rooms.delete(id); });
}, 60 * 1000);
function roomErr(res, code, ecode, msg) { send(res, code, { ok: false, error: ecode, msg: msg }); }
function getMember(room, side) { return room.members[side] === true; }

function handleRoomApi(req, res, u, body) {
  const p = u.pathname;
  const b = body || {};

  if (p === '/api/room/create') {
    let rules = null, rulesHash = null;
    if (b.rules !== undefined && b.rules !== null) {
      if (JSON.stringify(b.rules).length > 256 * 1024) return roomErr(res, 413, 'RULES_TOO_LARGE', '规则数据过大');
      try { rules = JSON.parse(JSON.stringify(b.rules)); } catch (e) { return roomErr(res, 400, 'BAD_JSON', '规则数据不可序列化'); }
      rulesHash = hashRules(rules);
    }
    const id = genRoomId();
    if (!id) return roomErr(res, 503, 'NO_SLOT', '暂时无法创建房间，请重试');
    rooms.set(id, { id, rules, rulesHash, members: [true, false], moves: [], epoch: 1, status: 'waiting',
                    overResult: null, restartAgree: { 0: false, 1: false }, expiresAt: Date.now() + TTL.waiting });
    return send(res, 200, { ok: true, roomId: id, side: 0, status: 'waiting', epoch: 1, turn: 0, rulesHash, rulesSize: rules ? JSON.stringify(rules).length : 0 });
  }
  if (p === '/api/room/join') {
    const room = rooms.get(String(b.roomId || '').toUpperCase());
    if (!room) return roomErr(res, 404, 'ROOM_NOT_FOUND', '房间不存在或已过期');
    if (room.members[1]) return roomErr(res, 409, 'ROOM_FULL', '房间已满（2 人）');
    if (room.status === 'over') return roomErr(res, 409, 'ROOM_BUSY', '对局已结束');
    room.members[1] = true;
    if (room.status === 'waiting') room.status = 'playing';
    touchRoom(room);
    return send(res, 200, { ok: true, roomId: room.id, side: 1, status: room.status, epoch: room.epoch,
                            turn: room.moves.length % 2, moves: room.moves, rules: room.rules, rulesHash: room.rulesHash });
  }
  if (p === '/api/room/move') {
    const room = rooms.get(String(b.roomId || '').toUpperCase());
    if (!room) return roomErr(res, 404, 'ROOM_NOT_FOUND', '房间不存在或已过期');
    if (!getMember(room, b.side)) return roomErr(res, 403, 'NOT_MEMBER', '你不在该房间中');
    if (room.status === 'over') return roomErr(res, 403, 'GAME_OVER', '对局已结束');
    if (room.status !== 'playing') return roomErr(res, 403, 'WAITING_PEER', '等待对手加入');
    const mv = b.mv;
    if (!mv || !mv.from || !mv.to || !mv.piece) return roomErr(res, 400, 'BAD_MOVE_SHAPE', '着法格式错误');
    if (b.side !== room.moves.length % 2) return roomErr(res, 403, 'NOT_YOUR_TURN', '还没轮到你走棋');
    if (b.basedOn !== room.moves.length) return roomErr(res, 409, 'STALE', '局面已变化，请重拉后重试');
    room.moves.push(mv);
    touchRoom(room);
    return send(res, 200, { ok: true, seq: room.moves.length - 1 });
  }
  if (p === '/api/room/poll') {
    const room = rooms.get(String(b.roomId || '').toUpperCase());
    if (!room) return roomErr(res, 404, 'ROOM_NOT_FOUND', '房间不存在或已过期');
    if (!getMember(room, b.side)) return roomErr(res, 403, 'NOT_MEMBER', '你不在该房间中');
    const since = Math.max(0, b.since | 0);
    const newMoves = since < room.moves.length
      ? room.moves.slice(since).map((mv, i) => ({ seq: since + i, side: (since + i) % 2, mv }))
      : [];
    const out = {
      ok: true, roomId: room.id, status: room.status, turn: room.moves.length % 2,
      since: room.moves.length, moves: newMoves, epoch: room.epoch,
      over: room.status === 'over', result: room.overResult,
      peerGone: room.members.filter(Boolean).length < 2,
      restart: room.restartAgree, rulesHash: room.rulesHash
    };
    if (b.rulesHash !== room.rulesHash) out.rules = room.rules;
    touchRoom(room);
    return send(res, 200, out);
  }
  if (p === '/api/room/restart') {
    const room = rooms.get(String(b.roomId || '').toUpperCase());
    if (!room) return roomErr(res, 404, 'ROOM_NOT_FOUND', '房间不存在或已过期');
    if (!getMember(room, b.side)) return roomErr(res, 403, 'NOT_MEMBER', '你不在该房间中');
    room.restartAgree[b.side] = true;
    const both = room.restartAgree[0] && room.restartAgree[1];
    if (both || room.members.filter(Boolean).length < 2) {
      room.moves = []; room.epoch++; room.status = room.members.filter(Boolean).length >= 2 ? 'playing' : 'waiting';
      room.overResult = null; room.restartAgree = { 0: false, 1: false };
    }
    touchRoom(room);
    return send(res, 200, { ok: true, needPeer: !both && room.members.filter(Boolean).length >= 2, epoch: room.epoch });
  }
  if (p === '/api/room/over') {
    const room = rooms.get(String(b.roomId || '').toUpperCase());
    if (!room) return roomErr(res, 404, 'ROOM_NOT_FOUND', '房间不存在或已过期');
    if (!getMember(room, b.side)) return roomErr(res, 403, 'NOT_MEMBER', '你不在该房间中');
    if (room.status !== 'over') { room.status = 'over'; room.overResult = b.result || null; }
    touchRoom(room);
    return send(res, 200, { ok: true, status: 'over' });
  }
  if (p === '/api/room/leave') {
    const room = rooms.get(String(b.roomId || '').toUpperCase());
    if (!room) return send(res, 200, { ok: true });
    if (getMember(room, b.side)) room.members[b.side] = false;
    const left = room.members.filter(Boolean).length;
    if (left === 0) { rooms.delete(room.id); return send(res, 200, { ok: true }); }
    if (left === 1) { room.status = 'waiting'; room.restartAgree = { 0: false, 1: false }; }
    touchRoom(room);
    return send(res, 200, { ok: true });
  }
  return roomErr(res, 404, 'NOT_FOUND', '未知接口');
}

async function engineRoutes(req, res, u) {
  if (u.pathname === '/api/engine/status' && req.method === 'GET') {
    send(res, 200, { ok: true, ready: fsfReady && !!fsf, variant: fsfVariant, exe: fs.existsSync(ENGINE_EXE) });
    return true;
  }
  if (u.pathname === '/api/engine/configure' && req.method === 'POST') {
    const body = await readBody(req);
    const rules = body && body.rules;
    if (!rules || typeof rules !== 'object') { send(res, 400, { ok: false, error: '规则数据缺失' }); return true; }
    const name = safeName(rules.name || '变体', 'Variant');
    try {
      // 引擎已就绪且变体相同：不重启，仅更新风格（避免并发 configure 反复重启导致竞态）
      if (fsfReady && fsf && fsfVariant === name) {
        fsfStyle = body.style === 'solid' || body.style === 'random' ? body.style : 'balanced';
        applyFsfStyle();
        send(res, 200, { ok: true, variant: name, ready: true, reused: true });
        return true;
      }
      if (!fs.existsSync(ENGINE_DIR)) fs.mkdirSync(ENGINE_DIR, { recursive: true });
      fs.writeFileSync(ENGINE_INI, buildVariantIni(rules), 'utf8');
      fsfVariant = name;
      fsfStyle = body.style === 'solid' || body.style === 'random' ? body.style : 'balanced';
      await startFsf();
      send(res, 200, { ok: true, variant: name, ready: fsfReady });
    } catch (err) {
      send(res, 500, { ok: false, error: '引擎配置失败：' + err.message });
    }
    return true;
  }
  if (u.pathname === '/api/engine/move' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.fen) { send(res, 400, { ok: false, error: 'FEN 缺失' }); return true; }
    const d = Math.max(1, Math.min(5, parseInt(body.depth, 10) || 4));
    const mv = await fsfMove(body.fen, body.movetime || DEPTH_MS[d] || 1500);
    send(res, 200, { ok: !!mv, move: mv });
    return true;
  }
  return false;
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { send(res, 404, { ok: false, error: 'NOT_FOUND' }); return; }
    const ext = path.extname(filePath).toLowerCase();
    // 禁用缓存：index.html 持续迭代，浏览器缓存旧版会导致"功能没反应"等假象
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, 'http://localhost');

  // ---------- 本机局域网 IP（页面联机提示用；优先物理网卡，虚拟网卡（VMware/VirtualBox/WSL）排除） ----------
  if (u.pathname === '/api/ip' && req.method === 'GET') {
    const ifs = require('os').networkInterfaces();
    const list = [];
    for (const name of Object.keys(ifs)) {
      for (const it of ifs[name] || []) {
        if (it.family !== 'IPv4' || it.internal) continue;
        const virt = /vmware|virtualbox|vethernet|wsl|hyper-v|loopback/i.test(name);
        list.push({ name: name, ip: it.address, virt: virt });
      }
    }
    // 物理网卡优先，虚拟网卡排后（首选 = 第一个物理网卡）
    list.sort((a, b) => (a.virt ? 1 : 0) - (b.virt ? 1 : 0));
    const ip = list.length ? list[0].ip : 'localhost';
    send(res, 200, { ok: true, ip: ip, list: list.map((x) => ({ name: x.name, ip: x.ip, virt: x.virt })) });
    return;
  }

  // ---------- 联机房间 API（合并同端口，局域网/手机直接访问页面地址即可） ----------
  if (u.pathname.indexOf('/api/room/') === 0) {
    if (req.method === 'GET' && u.pathname === '/api/room/status') {
      const room = rooms.get(String(u.searchParams.get('roomId') || '').toUpperCase());
      if (!room) { send(res, 404, { ok: false, error: 'ROOM_NOT_FOUND', msg: '房间不存在或已过期' }); return; }
      send(res, 200, { ok: true, exists: true, status: room.status, players: room.members.filter(Boolean).length,
                       turn: room.moves.length % 2, since: room.moves.length, epoch: room.epoch });
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      handleRoomApi(req, res, u, body);
      return;
    }
  }

  // ---------- 引擎 API（Fairy-Stockfish） ----------
  if (await engineRoutes(req, res, u)) return;

  // ---------- API ----------
  if (u.pathname === '/api/presets' && req.method === 'GET') {
    let list = [];
    try {
      const files = fs.readdirSync(PRESET_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(PRESET_DIR, f), 'utf8'));
          list.push({ file: f, name: (data && data.name) ? String(data.name) : f.replace(/\.json$/i, '') });
        } catch (e) { /* 跳过损坏文件 */ }
      }
    } catch (e) { /* 目录不存在则返回空 */ }
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    send(res, 200, { ok: true, presets: list });
    return;
  }

  if (u.pathname === '/api/preset' && req.method === 'GET') {
    const f = String(u.searchParams.get('file') || '').replace(/^[\\/]+/, '');
    if (!f || path.basename(f) !== f || !f.toLowerCase().endsWith('.json')) { send(res, 400, { ok: false, error: 'BAD_FILE' }); return; }
    serveStatic(res, path.join(PRESET_DIR, f));
    return;
  }

  if (u.pathname === '/api/preset/save' && req.method === 'POST') {
    const body = await readBody(req);
    const rules = body && body.rules;
    if (!rules || typeof rules !== 'object') { send(res, 400, { ok: false, error: '规则数据缺失' }); return; }
    const name = safeName(rules.name || '我的变体', '变体');
    const file = '棋匠-' + name + '.json';
    try {
      fs.writeFileSync(path.join(PRESET_DIR, file), JSON.stringify(rules, null, 2), 'utf8');
      send(res, 200, { ok: true, file: file, name: name });
    } catch (e) {
      send(res, 500, { ok: false, error: '写入失败：' + e.message });
    }
    return;
  }

  if (u.pathname === '/api/standalone' && req.method === 'POST') {
    const body = await readBody(req);
    const html = body && typeof body.html === 'string' ? body.html : '';
    if (!html) { send(res, 400, { ok: false, error: '内容缺失' }); return; }
    const title = safeName(body.title || '变体', '变体');
    const file = title + '.html';
    try {
      fs.writeFileSync(path.join(GAME_DIR, file), html, 'utf8');
      send(res, 200, { ok: true, file: file, relPath: 'game/' + file });
    } catch (e) {
      send(res, 500, { ok: false, error: '写入失败：' + e.message });
    }
    return;
  }

  // ---------- 静态文件 ----------
  let rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (!rel) { send(res, 404, { ok: false, error: 'NOT_FOUND' }); return; }
  if (rel.startsWith('preset/')) {
    // 预设文件（preset/*.json）优先放行——修复：此前 basename 检查先行导致 preset 路径全部 404
    const sub = rel.slice(7);
    if (!sub || path.basename(sub) !== sub || !sub.toLowerCase().endsWith('.json')) { send(res, 404, { ok: false, error: 'NOT_FOUND' }); return; }
    serveStatic(res, path.join(PRESET_DIR, sub));
    return;
  }
  if (rel.startsWith('game/')) {
    // 独立版游戏文件（game/*.html）——与 preset 同理放行，页面可直开 http://localhost:8765/game/xxx.html
    const sub = rel.slice(5);
    if (!sub || path.basename(sub) !== sub) { send(res, 404, { ok: false, error: 'NOT_FOUND' }); return; }
    serveStatic(res, path.join(GAME_DIR, sub));
    return;
  }
  if (path.basename(rel) !== rel) { send(res, 404, { ok: false, error: 'NOT_FOUND' }); return; }   // 其余仅放行根目录文件名
  serveStatic(res, path.join(DIR, rel));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Port 8765 already in use - server may already be running.');
    console.log('If the page opens normally, no action needed; otherwise close the old window first.');
    process.exit(0);
  }
  console.error('Server error:', err.message);
  process.exit(1);
});

server.listen(8765, () => {
  console.log('========================================');
  console.log(' ChessCraft local server: http://localhost:8765');
  console.log(' Presets: preset/ (auto-listed on page)');
  console.log(' Engine: engine/fairy-stockfish-largeboard_x86-64.exe');
  console.log(' Close this window to stop the server');
  console.log('========================================');
});
