import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

const sourceFlag = process.argv.indexOf('--source');
const sourcePath =
  (sourceFlag >= 0 ? process.argv[sourceFlag + 1] : process.env.SQLITE_SOURCE) ?? '';
if (!sourcePath) throw new Error('Pass the old database path with --source <file>.');
const source = resolve(sourcePath);
if (!existsSync(source)) throw new Error(`SQLite database not found: ${source}`);
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the Supabase Session Pooler URL.');

const sqlite = new DatabaseSync(source, { readOnly: true });
const tableNames = new Set(
  sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
);
for (const table of ['members', 'invites', 'sessions', 'messages'])
  if (!tableNames.has(table)) throw new Error(`The SQLite source is missing the ${table} table.`);

const rows = Object.fromEntries(
  ['members', 'invites', 'sessions', 'messages'].map((table) => [
    table,
    sqlite.prepare(`SELECT * FROM ${table}`).all(),
  ]),
);
sqlite.close();

const db = postgres(process.env.DATABASE_URL, {
  max: 1,
  connect_timeout: 10,
  prepare: false,
  ssl: 'require',
});

try {
  await db.begin(async (tx) => {
    for (const row of rows.members)
      await tx.unsafe(
        `INSERT INTO assemble.members
          (id,identity,name,email,role,avatar,status,seat,revoked,created_at,appearance)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING`,
        [
          row.id,
          row.identity,
          row.name,
          row.email,
          row.role,
          row.avatar,
          row.status,
          row.seat,
          Boolean(row.revoked),
          row.created_at,
          row.appearance ?? null,
        ],
      );

    for (const row of rows.invites)
      await tx.unsafe(
        `INSERT INTO assemble.invites(id,token_hash,room_id,creator_id,expires_at,revoked)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING`,
        [row.id, row.token_hash, row.room_id, row.creator_id, row.expires_at, Boolean(row.revoked)],
      );

    for (const row of rows.sessions)
      await tx.unsafe(
        `INSERT INTO assemble.sessions
          (token_hash,member_id,guest_name,guest_id,invite_id,expires_at,appearance)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [
          row.token_hash,
          row.member_id,
          row.guest_name,
          row.guest_id,
          row.invite_id,
          row.expires_at,
          row.appearance ?? null,
        ],
      );

    for (const row of rows.messages)
      await tx.unsafe(
        `INSERT INTO assemble.messages
          (id,channel,sender_id,name,avatar,text,created_at,appearance)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [
          row.id,
          row.channel,
          row.sender_id,
          row.name,
          row.avatar,
          row.text,
          row.created_at,
          row.appearance ?? null,
        ],
      );
  });
  console.log(
    `Imported ${rows.members.length} members, ${rows.invites.length} invites, ${rows.sessions.length} sessions, and ${rows.messages.length} messages.`,
  );
} finally {
  await db.end({ timeout: 5 });
}
