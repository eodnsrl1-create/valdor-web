// Field load test (T049 §9): N bots hunt in one field channel; reports server step time, memory and per-bot downstream.
// Usage: node tools/load/field-bots.mjs [ws://localhost:2567] [bots=40] [seconds=60] [highlandBots=0] [shuttleBots=0]
//   highlandBots hunt in the field_highlands room (D054); shuttleBots walk the region seam both ways
//   (outskirts east edge 57.5,18 ⇄ highlands west stairs 8,70), passing the one-use handoff token (SERVER T074 §11.2)
// Server needs GUEST_RATE_PER_HOUR >= bots (or run against a valdor_loadtest.db).
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/'); // ops copy: @colyseus/sdk installed next to it
const { Client } = require('@colyseus/sdk');
const url = process.argv[2] ?? 'ws://localhost:2567';
const N = Number(process.argv[3] ?? 40);
const SEC = Number(process.argv[4] ?? 60);
const HI = Number(process.argv[5] ?? 0);
const SH = Number(process.argv[6] ?? 0);
const http = url.replace(/^ws/, 'http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const metric = async () => {
  // /metrics answers loopback callers only (or METRICS_TOKEN): run the server with --network host, or pass METRICS_TOKEN
  const r = await fetch(`${http}/metrics`, { headers: process.env.METRICS_TOKEN ? { authorization: `Bearer ${process.env.METRICS_TOKEN}` } : {} });
  if (!r.ok) throw new Error(`/metrics ${r.status}: start the server with --network host (loopback) or set METRICS_TOKEN on both sides`);
  return Object.fromEntries((await r.text()).trim().split('\n').map((l) => l.split(' ')).map(([k, v]) => [k, Number(v)]));
};

const bots = [];
let bytes = 0;
let crossings = 0;
const watch = (room) => {
  const ws = room.connection?.transport?.ws;
  ws?.addEventListener?.('message', (e) => (bytes += e.data?.byteLength ?? e.data?.length ?? 0));
};
for (let i = 0; i < N + HI + SH; i++) {
  const g = await (await fetch(`${http}/api/v1/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ classId: ['warrior', 'cleric', 'elf', 'mage'][i % 4] }) })).json();
  const kind = i < N ? 'hunt' : i < N + HI ? 'hunt' : 'shuttle';
  const roomName = i >= N && i < N + HI ? 'field_highlands' : 'field';
  const room = await new Client(url).joinOrCreate(roomName, { token: g.deviceToken });
  watch(room);
  const b = { room, roomName, token: g.deviceToken, kind, x: 0, y: 0, leg: 0, busy: false };
  room.onMessage('*', (t, m) => t === 'field:seam' && void cross(b, m));
  bots.push(b);
  await sleep(50);
}
const N_ALL = bots.length;
/** shuttle: leave, join the next region with the handoff token, start the walk back */
async function cross(b, m) {
  if (b.busy) return;
  b.busy = true;
  const next = await new Client(url).joinOrCreate(m.room, { token: b.token, handoff: m.handoff }).catch((e) => (console.log('seam join failed', e.message), null));
  await b.room.leave().catch(() => {});
  if (next) {
    watch(next);
    next.onMessage('*', (t, mm) => t === 'field:seam' && void cross(b, mm));
    b.room = next;
    b.roomName = m.room;
    b.x = m.x;
    b.y = m.y;
    b.leg = m.room === 'field' ? ROUTE.field.length - 2 : 0; // arrived at the ridge east edge / highland stairs: head straight back
    crossings++;
  }
  setTimeout(() => (b.busy = false), 3200); // seam_retrigger_cooldown
}
// SERVER §11.6 C waypoints: outskirts town → north gate → ridge → east edge; highlands arrival (15,63.5) → west stairs (8,70)
const ROUTE = { field: [[33.6, 99], [33.6, 89.5], [30, 88.5], [30, 21], [52, 20.5], [55, 18], [57.3, 18]], field_highlands: [[12, 66], [8.5, 69.5]] };
const SEAM = { field: 'seam_to_highlands', field_highlands: 'seam_to_outskirts' };
const rooms = new Set(bots.map((b) => b.room.roomId));
console.log(`${N} outskirts + ${HI} highland hunters + ${SH} shuttles joined ${rooms.size} room(s)`);
await sleep(500);
for (const b of bots) {
  const me = b.room.state.players.get(b.room.sessionId);
  b.x = me.x_q / 100;
  b.y = me.y_q / 100;
}
const t0 = Date.now();
const samples = [];
let lastBytes = 0;
let lastT = Date.now();
const tick = setInterval(() => {
  for (const b of bots) {
    if (b.kind === 'shuttle') {
      if (b.busy) continue;
      const wp = ROUTE[b.roomName][b.leg];
      if (!wp) { b.room.send('portal', { id: SEAM[b.roomName] }); continue; }
      const d = Math.hypot(wp[0] - b.x, wp[1] - b.y);
      if (d < 0.4) { b.leg++; continue; }
      const st = Math.min(0.45, d);
      b.x += ((wp[0] - b.x) / d) * st;
      b.y += ((wp[1] - b.y) / d) * st;
      b.room.send('pos', { x: b.x, y: b.y, f: 0, mv: true });
      continue;
    }
    const mobs = [...(b.room.state.mobs?.entries() ?? [])].filter(([, m]) => !m.dead).map(([id, m]) => ({ id, x: m.x_q / 100, y: m.y_q / 100 }));
    const tg = mobs.sort((p, q) => Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(q.x - b.x, q.y - b.y))[0];
    if (!tg) { // D050/D052: leave the town around the fountain and through the north gate
      if (b.roomName !== 'field') continue;
      const wp = [[33.6, 89.5], [30, 88.5], [30, 70]].find(([, y]) => b.y > y + 0.3);
      const t = b.y > 95 && b.x < 33.3 ? [33.6, b.y] : wp;
      if (t) { const d = Math.hypot(t[0] - b.x, t[1] - b.y) || 1; const s = Math.min(0.45, d); b.x += ((t[0] - b.x) / d) * s; b.y += ((t[1] - b.y) / d) * s; b.room.send('pos', { x: b.x, y: b.y, f: -1.57, mv: true }); }
      continue;
    }
    const d = Math.hypot(tg.x - b.x, tg.y - b.y);
    if (d > 1.3) {
      const s = Math.min(0.45, d - 1.2);
      b.x += ((tg.x - b.x) / d) * s;
      b.y += ((tg.y - b.y) / d) * s;
      b.room.send('pos', { x: b.x, y: b.y, f: Math.atan2(tg.y - b.y, tg.x - b.x), mv: true });
    } else b.room.send('atk', { slot: Math.random() < 0.2 ? 'skill_1' : 'basic' });
    const me = b.room.state.players.get(b.room.sessionId);
    if (me?.dead || (me && Math.hypot(me.x_q / 100 - b.x, me.y_q / 100 - b.y) > 3)) ((b.x = me.x_q / 100), (b.y = me.y_q / 100));
  }
}, 100);
while (Date.now() - t0 < SEC * 1000) {
  await sleep(5000);
  const m = await metric();
  const now = Date.now();
  const kbps = ((bytes - lastBytes) * 8) / 1000 / ((now - lastT) / 1000) / N_ALL;
  lastBytes = bytes;
  lastT = now;
  samples.push({ step: m.valdor_field_step_ms, rss: m.valdor_rss_bytes / 1048576, kbps });
  console.log(`t=${Math.round((now - t0) / 1000)}s step=${m.valdor_field_step_ms.toFixed(2)}ms rss=${(m.valdor_rss_bytes / 1048576).toFixed(0)}MB down/bot=${kbps.toFixed(1)}kbps mobsVisible(avg)=${(bots.reduce((s, b) => s + (b.room.state?.mobs?.size ?? 0), 0) / N_ALL).toFixed(1)} crossings=${crossings}`);
}
clearInterval(tick);
const avg = (k) => samples.reduce((s, x) => s + x[k], 0) / samples.length;
console.log(`RESULT bots=${N_ALL} (outskirts ${N}, highlands ${HI}, shuttles ${SH}) crossings=${crossings} rooms=${rooms.size} step_ms_avg=${avg('step').toFixed(2)} step_ms_max=${Math.max(...samples.map((s) => s.step)).toFixed(2)} rss_max=${Math.max(...samples.map((s) => s.rss)).toFixed(0)}MB down_per_bot_kbps=${avg('kbps').toFixed(1)} total_down_mbps=${((avg('kbps') * N_ALL) / 1000).toFixed(2)}`);
for (const b of bots) await b.room.leave().catch(() => {});
process.exit(0);
