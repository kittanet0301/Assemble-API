import express from 'express';
import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { createStore } from './store.mjs';
import { installAuth } from './auth.mjs';
import { Office } from './office.mjs';
import { ROOMS } from '../shared/world.js';
import { validAppearance } from '../shared/appearance.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const production = process.argv.includes('--production');
const number = (key, fallback, max) =>
  Math.max(1, Math.min(max, Number.parseInt(process.env[key] ?? String(fallback), 10) || fallback));
const parseOrigin = (value, key) => {
  try {
    const origin = new URL(value);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password
    )
      throw new Error('invalid origin');
    return origin.origin;
  } catch {
    throw new Error(`${key} must be an HTTP(S) origin without a path.`);
  }
};

const config = {
  port: number('PORT', 4173, 65535),
  host: process.env.HOST ?? '127.0.0.1',
  origin: parseOrigin(process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173', 'PUBLIC_ORIGIN'),
  officeName: process.env.OFFICE_NAME ?? 'Assemble HQ',
  orgName: process.env.ORG_NAME ?? 'Assemble',
  demo: !production && (process.env.AUTH_MODE ?? 'demo') === 'demo',
  domains: (process.env.ALLOWED_DOMAINS ?? '')
    .toLowerCase()
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  adminEmails: (process.env.ADMIN_EMAILS ?? '')
    .toLowerCase()
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  maxMembers: number('MAX_MEMBERS', 50, 50),
  maxOnline: number('MAX_ONLINE', 20, 20),
  roomCapacity: number('ROOM_CAPACITY', 8, 8),
  retention: number('CHAT_RETENTION_DAYS', 30, 30),
  mediaEnabled: !!(
    process.env.LIVEKIT_URL &&
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET
  ),
};

const wsOrigin = parseOrigin(
  process.env.WS_PUBLIC_ORIGIN ?? `http://localhost:${config.port}`,
  'WS_PUBLIC_ORIGIN',
);
const wsUrl = new URL('/ws', wsOrigin);
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
config.wsUrl = wsUrl.href;

const oidcConfigured =
  (!!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET) ||
  (!!process.env.MICROSOFT_TENANT_ID &&
    !!process.env.MICROSOFT_CLIENT_ID &&
    !!process.env.MICROSOFT_CLIENT_SECRET);

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
if (
  config.demo &&
  (!['127.0.0.1', 'localhost', '::1'].includes(config.host) ||
    !localHosts.has(new URL(config.origin).hostname))
)
  throw new Error('โหมดเดโมเปิดได้เฉพาะเว็บไซต์บนเครื่องเดียวกันเท่านั้น');
if (
  production &&
  (!process.env.DATABASE_URL ||
    !config.domains.length ||
    !config.adminEmails.length ||
    process.env.AUTH_MODE !== 'oidc' ||
    !oidcConfigured ||
    !process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32 ||
    !config.origin.startsWith('https:') ||
    !process.env.WS_PUBLIC_ORIGIN ||
    !wsOrigin.startsWith('https:'))
)
  throw new Error(
    'Production ต้องกำหนด DATABASE_URL, HTTPS PUBLIC_ORIGIN, HTTPS WS_PUBLIC_ORIGIN, ALLOWED_DOMAINS, ADMIN_EMAILS, SESSION_SECRET อย่างน้อย 32 ตัวอักษร และตั้ง AUTH_MODE=oidc พร้อมค่า OIDC provider ให้ครบ',
  );

const secret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const signature = (token) => createHmac('sha256', secret).update(token).digest('base64url');
const sessionToken = (req) => {
  const raw = req.headers.cookie
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith('office_session='))
    ?.slice(15);
  if (!raw || raw.length > 200) return null;
  const [token, supplied] = raw.split('.');
  const expected = signature(token ?? '');
  return supplied &&
    Buffer.byteLength(supplied) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ? token
    : null;
};

const store = createStore(process.env.DATABASE_URL, config.retention);
await store.ready();
await store.cleanup();

const app = express();
const server = createServer(app);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

const allowedOrigins = new Set([
  config.origin,
  ...(config.demo ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : []),
]);
const verifyOrigin = (req, res, next) => {
  if (!allowedOrigins.has(req.headers.origin) || !req.is('application/json'))
    return res.status(403).json({ error: 'คำขอไม่มาจากเว็บไซต์ขององค์กร' });
  next();
};

const rate = new Map();
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET') {
    const forwardedFor = req.headers['x-forwarded-for'];
    const key =
      (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0].trim() ||
      req.socket.remoteAddress ||
      'unknown';
    const now = Date.now();
    const entry = rate.get(key);
    if (!entry || entry.until < now) rate.set(key, { count: 1, until: now + 60_000 });
    else if (++entry.count > 120)
      return res.status(429).json({ error: 'คำขอมากเกินไป กรุณารอสักครู่' });
    if (rate.size > 2000) for (const [storedKey, value] of rate) if (value.until < now) rate.delete(storedKey);
  }
  next();
});
app.use(express.json({ limit: '12kb' }));

const sessionCookie = (res, token, maxAge = 12 * 3600_000) =>
  res.cookie('office_session', `${token}.${signature(token)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.origin.startsWith('https:'),
    path: '/',
    maxAge,
  });
const getUser = async (req) => {
  req.sessionToken = sessionToken(req);
  return store.session(req.sessionToken);
};
const requireUser = async (req, res, next) => {
  try {
    req.user = await getUser(req);
  } catch (error) {
    next(error);
    return;
  }
  if (!req.user) return res.status(401).json({ error: 'กรุณาเข้าสู่ออฟฟิศอีกครั้ง' });
  next();
};
const requireMember = (req, res, next) =>
  req.user.role === 'guest'
    ? res.status(403).json({ error: 'สำหรับสมาชิกองค์กรเท่านั้น' })
    : next();
installAuth(app, { store, config, sessionCookie, getUser, verifyOrigin });

const mediaAdmin = config.mediaEnabled
  ? new RoomServiceClient(
      process.env.LIVEKIT_URL.replace(/^ws/, 'http'),
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
    )
  : null;
const removeMediaParticipant = async (roomId, identity) => {
  if (mediaAdmin)
    try {
      await mediaAdmin.removeParticipant(`assemble-${roomId}`, identity);
    } catch {
      /* participant may already be disconnected */
    }
};
const office = new Office(store, { ...config, removeMediaParticipant });
const websocketTickets = new Map();

app.get('/api/health', async (_req, res) => {
  try {
    await store.health();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: 'ฐานข้อมูลยังไม่พร้อม' });
  }
});
app.get('/api/me', async (req, res) => res.json({ user: await getUser(req) }));
app.post('/api/ws-ticket', verifyOrigin, requireUser, (req, res) => {
  const now = Date.now();
  for (const [ticket, item] of websocketTickets) if (item.expiresAt <= now) websocketTickets.delete(ticket);
  if (websocketTickets.size >= 1000)
    return res.status(429).json({ error: 'กรุณารอสักครู่แล้วลองเชื่อมต่อใหม่' });
  const ticket = randomBytes(32).toString('base64url');
  websocketTickets.set(ticket, { token: req.sessionToken, expiresAt: now + 60_000 });
  res.json({ ticket, wsUrl: config.wsUrl });
});
app.post('/api/me/appearance', verifyOrigin, requireUser, async (req, res) => {
  if (!validAppearance(req.body.appearance))
    return res.status(400).json({ error: 'ตัวเลือกตัวละครไม่ถูกต้อง กรุณาเลือกใหม่' });
  const appearance = await store.setAppearance(req.user.id, req.body.appearance);
  const peer = office.peers.get(req.user.id);
  if (peer) peer.user.appearance = appearance;
  office.broadcast();
  res.json({ appearance });
});
app.get('/api/invites/preview', async (req, res) => {
  const invite = typeof req.query.token === 'string' && (await store.invite(req.query.token));
  if (!invite) return res.status(410).json({ error: 'คำเชิญหมดอายุหรือถูกยกเลิกแล้ว' });
  res.json({
    room: ROOMS.find((room) => room.id === invite.roomId),
    expiresAt: invite.expiresAt,
    orgName: config.orgName,
  });
});
app.post('/api/invites/accept', verifyOrigin, async (req, res) => {
  const invite =
    typeof req.body.token === 'string' ? await store.invite(req.body.token) : null;
  const name = typeof req.body.name === 'string' && req.body.name.trim().slice(0, 40);
  if (!invite) return res.status(410).json({ error: 'คำเชิญหมดอายุหรือถูกยกเลิกแล้ว' });
  if (!name) return res.status(400).json({ error: 'กรุณาใส่ชื่อของคุณ' });
  const token = await store.newSession({
    guestId: `guest-${randomUUID()}`,
    guestName: name,
    inviteId: invite.id,
    expiresAt: invite.expiresAt,
  });
  sessionCookie(res, token, invite.expiresAt - Date.now());
  res.json({ ok: true });
});
app.get('/api/invites', requireUser, requireMember, async (req, res) =>
  res.json({ invites: await store.invites(req.user.id, req.user.role === 'admin') }),
);
app.post('/api/invites', verifyOrigin, requireUser, requireMember, async (req, res) => {
  if (!ROOMS.some((room) => room.id === req.body.roomId))
    return res.status(400).json({ error: 'ไม่พบห้องประชุม' });
  const invite = await store.createInvite(req.body.roomId, req.user.id);
  res.json({
    id: invite.id,
    expiresAt: invite.expiresAt,
    url: `${config.origin}/?invite=${invite.token}`,
  });
});
app.delete('/api/invites/:id', verifyOrigin, requireUser, requireMember, async (req, res) => {
  if (!(await store.revokeInvite(req.params.id, req.user.id, req.user.role === 'admin')))
    return res.status(404).json({ error: 'ไม่พบคำเชิญของคุณ' });
  office.tick(0);
  res.json({ ok: true });
});
app.post('/api/members/:id/revoke', verifyOrigin, requireUser, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'เฉพาะผู้ดูแลเท่านั้น' });
  if (req.params.id === req.user.id)
    return res.status(400).json({ error: 'ผู้ดูแลถอนสิทธิ์ตัวเองไม่ได้' });
  if (!store.member(req.params.id)) return res.status(404).json({ error: 'ไม่พบสมาชิก' });
  await store.revoke(req.params.id);
  office.tick(0);
  office.broadcast();
  res.json({ ok: true });
});
app.post('/api/meeting/token', verifyOrigin, requireUser, async (req, res) => {
  const peer = office.peers.get(req.user.id);
  if (!peer?.roomId || peer.roomId !== req.body.roomId)
    return res.status(403).json({ error: 'เข้าห้องประชุมก่อนเปิดอุปกรณ์' });
  if (!config.mediaEnabled)
    return res.status(503).json({
      error:
        'ยังไม่ได้เชื่อมบริการประชุม ผู้ดูแลต้องตั้งค่า LiveKit ก่อนเปิดไมค์ กล้อง และแชร์หน้าจอ',
    });
  try {
    const ttl = Math.max(1, Math.min(60, Math.floor((req.user.expiresAt - Date.now()) / 1000)));
    const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity: req.user.id,
      name: req.user.name,
      ttl,
    });
    token.addGrant({
      roomJoin: true,
      room: `assemble-${peer.roomId}`,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomRecord: false,
      roomAdmin: false,
    });
    await mediaAdmin.createRoom({
      name: `assemble-${peer.roomId}`,
      maxParticipants: config.roomCapacity,
      emptyTimeout: 60,
    });
    res.json({ token: await token.toJwt(), url: process.env.LIVEKIT_URL });
  } catch {
    res.status(502).json({ error: 'เชื่อมบริการประชุมไม่ได้ กรุณาตรวจ LiveKit ขององค์กร' });
  }
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 8 * 1024,
  handleProtocols: (protocols) => (protocols.has('assemble.v1') ? 'assemble.v1' : false),
});
const rejectUpgrade = (socket) => {
  if (!socket.destroyed)
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
};
const acceptWebSocket = async (req, socket, head) => {
  if (new URL(req.url, config.wsUrl).pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const offered = (req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim());
  const authProtocol = offered.find((value) => value.startsWith('assemble-auth.'));
  const ticket = authProtocol?.slice('assemble-auth.'.length);
  const ticketState = ticket && websocketTickets.get(ticket);
  if (
    !allowedOrigins.has(req.headers.origin) ||
    !offered.includes('assemble.v1') ||
    !ticketState ||
    ticketState.expiresAt <= Date.now()
  ) {
    rejectUpgrade(socket);
    return;
  }
  websocketTickets.delete(ticket);
  const user = await store.session(ticketState.token);
  if (!user) {
    rejectUpgrade(socket);
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const send = (payload) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };
    let peer;
    try {
      peer = office.connect(
        user,
        send,
        (code, text) => ws.close(code, text),
        () => store.isSessionActive(ticketState.token),
      );
    } catch (error) {
      send({ type: 'error', text: error.message });
      ws.close(4004, error.message);
      return;
    }

    void store
      .history(user.role === 'guest' ? user.roomScope : 'general')
      .then((messages) => {
        send({
          type: 'history',
          channel: user.role === 'guest' ? user.roomScope : 'general',
          messages,
        });
      })
      .catch(() => send({ type: 'error', text: 'โหลดประวัติแชตไม่สำเร็จ' }));

    let windowStart = Date.now();
    let count = 0;
    let messageQueue = Promise.resolve();
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => {
      if (Date.now() - windowStart > 1000) {
        count = 0;
        windowStart = Date.now();
      }
      if (++count > 50) {
        ws.close(4008, 'ส่งคำขอเร็วเกินไป');
        return;
      }
      messageQueue = messageQueue
        .then(async () => {
          const message = JSON.parse(raw.toString());
          if (message && typeof message === 'object') await office.handle(peer, message);
        })
        .catch((error) => {
          send({
            type: 'error',
            text: error instanceof SyntaxError ? 'รูปแบบข้อความไม่ถูกต้อง' : error.message,
          });
        });
    });
    ws.on('close', () => office.disconnect(peer));
    ws.on('error', () => office.disconnect(peer));
  });
};
server.on('upgrade', (req, socket, head) => {
  void acceptWebSocket(req, socket, head).catch(() => rejectUpgrade(socket));
});

let lastMovementTick = performance.now();
const safely = (operation) =>
  operation().catch((error) => console.error('Background operation failed:', error.message));
const timers = [
  setInterval(() => {
    const now = performance.now();
    office.tick((now - lastMovementTick) / 1000);
    lastMovementTick = now;
  }, 25),
  setInterval(() => office.broadcast(), 50),
  setInterval(() => void safely(() => store.cleanup()), 3600_000),
  setInterval(() => void safely(() => store.refreshActiveSessions()), 30_000),
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) ws.terminate();
      else {
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, 30_000),
];

app.use((error, _req, res, _next) => {
  console.error(error.message);
  if (!res.headersSent) res.status(500).json({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
});

server.listen(config.port, config.host, () =>
  console.log(
    `\n  Assemble API\n  Local: http://localhost:${config.port}\n  WebSocket: ${config.wsUrl}\n  ${config.demo ? 'Local demo · corporate sign-in is not connected' : 'Organization authentication'}\n`,
  ),
);

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const timer of timers) clearInterval(timer);
    for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
    wss.close();
    server.close(() => void store.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
