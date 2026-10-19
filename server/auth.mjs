import * as oidc from 'openid-client';
import { randomUUID } from 'node:crypto';

export function installAuth(app, { store, config, sessionCookie, getUser, verifyOrigin }) {
  const pending = new Map(),
    configurations = new Map();
  const providerConfig = (name) =>
    name === 'google'
      ? {
          issuer: 'https://accounts.google.com',
          id: process.env.GOOGLE_CLIENT_ID,
          secret: process.env.GOOGLE_CLIENT_SECRET,
        }
      : name === 'microsoft' && process.env.MICROSOFT_TENANT_ID
        ? {
            issuer: `https://login.microsoftonline.com/${encodeURIComponent(process.env.MICROSOFT_TENANT_ID)}/v2.0`,
            id: process.env.MICROSOFT_CLIENT_ID,
            secret: process.env.MICROSOFT_CLIENT_SECRET,
          }
        : null;
  const readyProviders = () =>
    ['google', 'microsoft'].filter((name) => {
      const p = providerConfig(name);
      return !!(p?.id && p?.secret);
    });
  const oidcConfig = async (name) => {
    if (!readyProviders().includes(name))
      throw new Error('ยังไม่ได้เชื่อมบัญชีบริษัทสำหรับผู้ให้บริการนี้');
    if (!configurations.has(name)) {
      const p = providerConfig(name);
      configurations.set(name, await oidc.discovery(new URL(p.issuer), p.id, p.secret));
    }
    return configurations.get(name);
  };
  app.get('/api/config', (_req, res) =>
    res.json({
      officeName: config.officeName,
      orgName: config.orgName,
      demo: config.demo,
      preview: false,
      providers: readyProviders(),
      mediaEnabled: config.mediaEnabled,
      maxOnline: config.maxOnline,
      roomCapacity: config.roomCapacity,
    }),
  );
  app.post('/api/auth/demo', verifyOrigin, async (req, res) => {
    if (!config.demo) return res.status(404).json({ error: 'ไม่พบเส้นทางนี้' });
    const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 40) : '';
    if (!name) return res.status(400).json({ error: 'ใส่ชื่อที่อยากให้เพื่อนร่วมงานเห็นก่อนครับ' });
    try {
      const existing = await store.demoIdentity(name);
      const member = await store.upsertMember({
        identity: existing?.identity ?? `demo:${randomUUID()}`,
        name,
        email: '',
        maxMembers: config.maxMembers,
      });
      sessionCookie(res, await store.newSession({ memberId: member.id }));
      res.json({ user: member });
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });
  app.get('/api/auth/:provider', async (req, res) => {
    try {
      const provider = req.params.provider,
        client = await oidcConfig(provider);
      const state = oidc.randomState(),
        nonce = oidc.randomNonce(),
        verifier = oidc.randomPKCECodeVerifier();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      for (const [key, item] of pending) if (item.expires < Date.now()) pending.delete(key);
      if (pending.size > 500) return res.status(429).send('กรุณาลองเข้าสู่ระบบอีกครั้งในภายหลัง');
      pending.set(state, { provider, nonce, verifier, expires: Date.now() + 10 * 60_000 });
      res.cookie('office_oauth', state, {
        httpOnly: true,
        sameSite: 'lax',
        secure: !config.demo && config.origin.startsWith('https:'),
        path: '/api/auth',
        maxAge: 10 * 60_000,
      });
      const url = oidc.buildAuthorizationUrl(client, {
        redirect_uri: `${config.origin}/api/auth/${provider}/callback`,
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      res.redirect(url.href);
    } catch {
      res.redirect(
        '/?authError=' +
          encodeURIComponent('เชื่อมบัญชีบริษัทไม่สำเร็จ กรุณาตรวจการตั้งค่าผู้ให้บริการ'),
      );
    }
  });
  app.get('/api/auth/:provider/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const flow = pending.get(state);
    pending.delete(state);
    res.clearCookie('office_oauth', { path: '/api/auth' });
    try {
      const cookie = req.headers.cookie
        ?.split(';')
        .map((x) => x.trim())
        .find((x) => x.startsWith('office_oauth='))
        ?.slice(13);
      if (
        !flow ||
        flow.expires < Date.now() ||
        flow.provider !== req.params.provider ||
        cookie !== state
      )
        throw new Error('การเข้าสู่ระบบหมดอายุ กรุณาลองใหม่');
      const client = await oidcConfig(flow.provider);
      const url = new URL(req.originalUrl, config.origin);
      const tokens = await oidc.authorizationCodeGrant(client, url, {
        pkceCodeVerifier: flow.verifier,
        expectedState: state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      const email = String(claims.email ?? claims.preferred_username ?? '').toLowerCase();
      if (!email || !config.domains.includes(email.split('@')[1]))
        throw new Error('บัญชีนี้อยู่นอกองค์กรที่อนุญาต');
      if (flow.provider === 'google' && claims.email_verified !== true)
        throw new Error('ต้องยืนยันอีเมลบริษัทก่อน');
      if (flow.provider === 'microsoft' && claims.tid !== process.env.MICROSOFT_TENANT_ID)
        throw new Error('บัญชีไม่อยู่ใน tenant ขององค์กร');
      const member = await store.upsertMember({
        identity: `${claims.iss}:${claims.sub}`,
        email,
        name: String(claims.name ?? email.split('@')[0]).slice(0, 60),
        maxMembers: config.maxMembers,
      });
      sessionCookie(res, await store.newSession({ memberId: member.id }));
      res.redirect('/');
    } catch (error) {
      res.redirect(
        '/?authError=' +
          encodeURIComponent(
            error.message.includes('บัญชี') ||
              error.message.includes('หมดอายุ') ||
              error.message.includes('ถอนสิทธิ์')
              ? error.message
              : 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองอีกครั้ง',
          ),
      );
    }
  });
  app.post('/api/auth/logout', verifyOrigin, async (req, res) => {
    const user = await getUser(req);
    await store.deleteSession(req.sessionToken);
    res.clearCookie('office_session', { path: '/' });
    res.json({ ok: true, userId: user?.id });
  });
}
