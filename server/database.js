import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY, company TEXT NOT NULL, role TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('internship','parttime','fulltime')),
      appliedOn TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','no_reply','interview','rejected','accepted','withdrawn')),
      rejectedOn TEXT, notes TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges (
      email TEXT PRIMARY KEY, digest TEXT NOT NULL, nonce TEXT NOT NULL,
      expiresAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sentAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

export const publicFields = ({ id, role, kind, appliedOn, status, rejectedOn }) => ({ id, role, kind, appliedOn, status, rejectedOn });

export function snapshot(db, privateView = false) {
  const all = db.prepare('SELECT * FROM applications ORDER BY appliedOn DESC, createdAt DESC, id DESC').all();
  const counts = { pending: 0, no_reply: 0, interview: 0, rejected: 0, accepted: 0, withdrawn: 0 };
  for (const row of all) counts[row.status]++;
  const updatedAt = db.prepare("SELECT value FROM metadata WHERE key = 'updatedAt'").get()?.value ?? null;
  return { applications: privateView ? all : all.map(publicFields), stats: { total: all.length, ...counts }, updatedAt };
}
