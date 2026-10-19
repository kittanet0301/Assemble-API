import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { resolveAppearance, validAppearance } from '../shared/appearance.js';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const opaqueToken = () => randomBytes(32).toString('base64url');

const publicMember = (row) =>
  row && {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role === 'guest' ? 'guest' : 'member',
    avatar: row.avatar,
    appearance: resolveAppearance(row.appearance, row.id),
    status: row.status,
    seat: row.seat,
    revoked: Boolean(row.revoked),
  };

export function createStore(connectionString, retentionDays = 30) {
  if (!connectionString)
    throw new Error('Set DATABASE_URL to the Supabase Session Pooler connection string.');

  const db = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    ssl: 'require',
  });
  const memberCache = new Map();
  const activeSessions = new Map();

  const cacheMember = (row) => {
    const member = publicMember(row);
    if (member) memberCache.set(member.id, member);
    return member;
  };
  const clearSessions = (predicate) => {
    for (const [hash, session] of activeSessions) if (predicate(session)) activeSessions.delete(hash);
  };

  async function refreshMembers() {
    const rows = await db.unsafe('SELECT * FROM assemble.members ORDER BY created_at');
    memberCache.clear();
    for (const row of rows) cacheMember(row);
    return [...memberCache.values()];
  }

  async function ready() {
    await db.unsafe('SELECT 1');
    await db.unsafe("UPDATE assemble.members SET role='member' WHERE role='admin'");
    await refreshMembers();
  }

  return {
    async ready() {
      await ready();
    },
    async health() {
      await db.unsafe('SELECT 1');
    },
    members() {
      return [...memberCache.values()];
    },
    member(id) {
      return memberCache.get(id) ?? null;
    },
    async upsertMember({ identity, name, email = '', maxMembers = 50 }) {
      const row = await db.begin(async (tx) => {
        // Serialize first-login and capacity checks across concurrent OIDC callbacks.
        await tx.unsafe('SELECT pg_advisory_xact_lock(560249822354)');
        const existing = await tx.unsafe('SELECT * FROM assemble.members WHERE identity=$1 FOR UPDATE', [
          identity,
        ]);
        if (existing[0]?.revoked)
          throw new Error('บัญชีนี้ถูกถอนสิทธิ์แล้ว กรุณาติดต่อผู้ดูแล');
        if (existing[0]) {
          const updated = await tx.unsafe(
            'UPDATE assemble.members SET name=$1,email=$2,role=$3 WHERE id=$4 RETURNING *',
            [name, email, 'member', existing[0].id],
          );
          return updated[0];
        }

        const countRows = await tx.unsafe(
          'SELECT count(*)::integer AS count FROM assemble.members WHERE revoked=false',
        );
        if (Number(countRows[0].count) >= maxMembers)
          throw new Error('สมาชิกครบจำนวนสำหรับกลุ่มทดลองแล้ว');

        const totalRows = await tx.unsafe('SELECT count(*)::integer AS count FROM assemble.members');
        const colors = ['#e7af85', '#b5a2de', '#86bfae', '#e0bc64', '#94b7da', '#d99dba'];
        const inserted = await tx.unsafe(
          'INSERT INTO assemble.members(id,identity,name,email,role,avatar,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [
            randomUUID(),
            identity,
            name,
            email,
            'member',
            colors[Number(totalRows[0].count) % colors.length],
            Date.now(),
          ],
        );
        return inserted[0];
      });
      return cacheMember(row);
    },
    async setStatus(id, status) {
      const rows = await db.unsafe(
        'UPDATE assemble.members SET status=$1 WHERE id=$2 AND revoked=false RETURNING *',
        [status, id],
      );
      if (rows[0]) cacheMember(rows[0]);
    },
    async setAppearance(id, appearance) {
      if (!validAppearance(appearance)) throw new Error('ตัวเลือกตัวละครไม่ถูกต้อง');
      const serialized = JSON.stringify(appearance);
      const memberRows = await db.unsafe(
        'UPDATE assemble.members SET appearance=$1 WHERE id=$2 AND revoked=false RETURNING *',
        [serialized, id],
      );
      if (memberRows[0]) {
        cacheMember(memberRows[0]);
        return resolveAppearance(appearance);
      }
      const guestRows = await db.unsafe(
        'UPDATE assemble.sessions SET appearance=$1 WHERE guest_id=$2 RETURNING guest_id',
        [serialized, id],
      );
      if (!guestRows.length) throw new Error('ไม่พบผู้ใช้งาน');
      return resolveAppearance(appearance);
    },
    async setSeat(id, seat) {
      try {
        const rows = await db.unsafe(
          'UPDATE assemble.members SET seat=$1 WHERE id=$2 AND revoked=false RETURNING *',
          [seat, id],
        );
        if (rows[0]) cacheMember(rows[0]);
      } catch (error) {
        if (error?.code === '23505')
          throw new Error('ที่นั่งนี้มีเจ้าของแล้ว เลือกที่นั่งอื่นได้เลย');
        throw error;
      }
    },
    async newSession({
      memberId = null,
      guestName = null,
      guestId = null,
      inviteId = null,
      expiresAt = Date.now() + 12 * 3600_000,
    }) {
      const token = opaqueToken();
      const hash = digest(token);
      await db.unsafe(
        'INSERT INTO assemble.sessions(token_hash,member_id,guest_name,guest_id,invite_id,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [hash, memberId, guestName, guestId, inviteId, expiresAt],
      );
      activeSessions.set(hash, { memberId, inviteId, expiresAt });
      return token;
    },
    async session(token, now = Date.now()) {
      if (!token) return null;
      const hash = digest(token);
      const rows = await db.unsafe(
        'SELECT * FROM assemble.sessions WHERE token_hash=$1 AND expires_at>$2',
        [hash, now],
      );
      const session = rows[0];
      if (!session) {
        activeSessions.delete(hash);
        return null;
      }
      const expiresAt = Number(session.expires_at);
      if (session.member_id) {
        const members = await db.unsafe('SELECT * FROM assemble.members WHERE id=$1', [session.member_id]);
        if (!members[0] || members[0].revoked) {
          activeSessions.delete(hash);
          return null;
        }
        const member = cacheMember(members[0]);
        activeSessions.set(hash, { memberId: member.id, inviteId: null, expiresAt });
        return { ...member, expiresAt };
      }

      const invites = await db.unsafe(
        `SELECT i.id,i.room_id,i.expires_at,i.creator_id
         FROM assemble.invites i
         JOIN assemble.members m ON m.id=i.creator_id
         WHERE i.id=$1 AND i.expires_at>$2 AND i.revoked=false AND m.revoked=false`,
        [session.invite_id, now],
      );
      const invite = invites[0];
      if (!invite) {
        activeSessions.delete(hash);
        return null;
      }
      activeSessions.set(hash, {
        memberId: null,
        inviteId: invite.id,
        expiresAt: Math.min(expiresAt, Number(invite.expires_at)),
      });
      return {
        id: session.guest_id,
        name: session.guest_name,
        role: 'guest',
        avatar: '#a1bac4',
        appearance: resolveAppearance(session.appearance, session.guest_id),
        status: 'available',
        seat: null,
        roomScope: invite.room_id,
        inviteId: invite.id,
        expiresAt: Math.min(expiresAt, Number(invite.expires_at)),
      };
    },
    isSessionActive(token, now = Date.now()) {
      if (!token) return false;
      const hash = digest(token);
      const session = activeSessions.get(hash);
      if (!session || session.expiresAt <= now) {
        activeSessions.delete(hash);
        return false;
      }
      return !session.memberId || !memberCache.get(session.memberId)?.revoked;
    },
    async refreshActiveSessions() {
      const hashes = [...activeSessions.keys()];
      if (!hashes.length) return;
      const rows = await db.unsafe(
        `SELECT s.token_hash
         FROM assemble.sessions s
         LEFT JOIN assemble.members m ON m.id=s.member_id
         LEFT JOIN assemble.invites i ON i.id=s.invite_id
         LEFT JOIN assemble.members creator ON creator.id=i.creator_id
         WHERE s.token_hash=ANY($1::text[]) AND s.expires_at>$2
           AND ((s.member_id IS NOT NULL AND m.id IS NOT NULL AND m.revoked=false)
             OR (s.member_id IS NULL AND i.id IS NOT NULL AND i.revoked=false
                 AND i.expires_at>$2 AND creator.id IS NOT NULL AND creator.revoked=false))`,
        [hashes, Date.now()],
      );
      const stillActive = new Set(rows.map((row) => row.token_hash));
      for (const hash of hashes) if (!stillActive.has(hash)) activeSessions.delete(hash);
    },
    async deleteSession(token) {
      if (!token) return;
      const hash = digest(token);
      await db.unsafe('DELETE FROM assemble.sessions WHERE token_hash=$1', [hash]);
      activeSessions.delete(hash);
    },
    async createInvite(roomId, creatorId, now = Date.now()) {
      const token = opaqueToken();
      const invite = {
        id: randomUUID(),
        token,
        roomId,
        expiresAt: now + 24 * 3600_000,
      };
      await db.unsafe(
        'INSERT INTO assemble.invites(id,token_hash,room_id,creator_id,expires_at,revoked) VALUES($1,$2,$3,$4,$5,false)',
        [invite.id, digest(token), roomId, creatorId, invite.expiresAt],
      );
      return invite;
    },
    async invite(token, now = Date.now()) {
      const rows = await db.unsafe(
        `SELECT i.id,i.room_id,i.expires_at
         FROM assemble.invites i
         JOIN assemble.members m ON m.id=i.creator_id
         WHERE i.token_hash=$1 AND i.expires_at>$2 AND i.revoked=false AND m.revoked=false`,
        [digest(token), now],
      );
      return rows[0]
        ? { id: rows[0].id, roomId: rows[0].room_id, expiresAt: Number(rows[0].expires_at) }
        : null;
    },
    async invites(creatorId) {
      const rows = await db.unsafe(
        'SELECT id,room_id AS "roomId",creator_id AS "creatorId",expires_at AS "expiresAt",revoked FROM assemble.invites WHERE creator_id=$1 AND expires_at>$2 ORDER BY expires_at',
        [creatorId, Date.now()],
      );
      return rows.map((row) => ({ ...row, expiresAt: Number(row.expiresAt) }));
    },
    async revokeInvite(id, creatorId) {
      const rows = await db.unsafe(
        'UPDATE assemble.invites SET revoked=true WHERE id=$1 AND creator_id=$2 AND revoked=false RETURNING id',
        [id, creatorId],
      );
      if (rows[0]) clearSessions((session) => session.inviteId === id);
      return rows.length;
    },
    async history(channel) {
      const rows = await db.unsafe(
        `SELECT id,channel,sender_id AS "senderId",name,avatar,appearance,text,created_at AS "createdAt"
         FROM assemble.messages
         WHERE channel=$1 AND created_at>$2
         ORDER BY created_at DESC LIMIT 80`,
        [channel, Date.now() - retentionDays * 86400_000],
      );
      return rows
        .reverse()
        .map((message) => ({
          ...message,
          createdAt: Number(message.createdAt),
          appearance: resolveAppearance(message.appearance, message.senderId),
        }));
    },
    async addMessage(user, channel, text) {
      const message = {
        id: randomUUID(),
        channel,
        senderId: user.id,
        name: user.name,
        avatar: user.avatar,
        appearance: resolveAppearance(user.appearance, user.id),
        text,
        createdAt: Date.now(),
      };
      await db.unsafe(
        'INSERT INTO assemble.messages(id,channel,sender_id,name,avatar,appearance,text,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          message.id,
          channel,
          message.senderId,
          message.name,
          message.avatar,
          JSON.stringify(message.appearance),
          text,
          message.createdAt,
        ],
      );
      return message;
    },
    async cleanup(now = Date.now()) {
      await db.unsafe('DELETE FROM assemble.messages WHERE created_at<$1', [
        now - retentionDays * 86400_000,
      ]);
      await db.unsafe('DELETE FROM assemble.sessions WHERE expires_at<$1', [now]);
      clearSessions((session) => session.expiresAt < now);
    },
    async close() {
      await db.end({ timeout: 5 });
    },
  };
}
