import { z } from 'zod';
import { createHmac, randomUUID } from 'node:crypto';

const boundedText = max => z.string().trim().min(1).refine(s => [...s].length <= max);
const nicknameSchema = boundedText(24).refine(s => !/[\u0000-\u001f\u007f]/.test(s));
const postSchema = z.object({
  body: boundedText(2000), replyToId: z.number().int().positive().nullable().default(null),
  clientKey: z.string().uuid(),
}).strict();
const pageSize = 10;

// Commenters sign in with any dkz12345 Clerk account (req.clerkUser, set by the
// /api auth middleware). The owner comments as 站长 under adminEmail.
export function installComments(app, { db, adminEmail, ownerUserId, secret, now }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comment_users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, nickname TEXT, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS visitor_sessions (
      digest TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES comment_users(id), expiresAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS visitor_challenges (
      email TEXT PRIMARY KEY, digest TEXT NOT NULL, nonce TEXT NOT NULL,
      expiresAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sentAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, authorId TEXT NOT NULL REFERENCES comment_users(id),
      rootId INTEGER REFERENCES comments(id), replyToId INTEGER REFERENCES comments(id),
      body TEXT, createdAt INTEGER NOT NULL, deletedAt INTEGER,
      clientKey TEXT NOT NULL, UNIQUE(authorId, clientKey)
    );
    CREATE INDEX IF NOT EXISTS comments_root_idx ON comments(rootId, id);
    CREATE INDEX IF NOT EXISTS comments_target_idx ON comments(replyToId, deletedAt);
    CREATE TABLE IF NOT EXISTS comment_rate_events (
      kind TEXT NOT NULL, subject TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comment_rate_idx ON comment_rate_events(kind, subject, at);
  `);
  if (!db.prepare('PRAGMA table_info(comment_users)').all().some(c => c.name === 'clerkUserId')) db.exec('ALTER TABLE comment_users ADD COLUMN clerkUserId TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS comment_users_clerk_idx ON comment_users(clerkUserId)');
  const hmac = text => createHmac('sha256', secret).update(text).digest('hex');
  const ensureOwner = () => {
    db.prepare('INSERT OR IGNORE INTO comment_users (id, email, nickname, createdAt) VALUES (?, ?, ?, ?)').run(randomUUID(), adminEmail, '站长', now());
    return db.prepare('SELECT * FROM comment_users WHERE email = ?').get(adminEmail);
  };
  // Old visitors proved their email with a code, and a Clerk primary email is
  // verified too, so the first Clerk sign-in with the same email takes over that
  // commenter. A missing, already-claimed or owner email gets a private
  // placeholder instead (emails are never shown), so nobody inherits 站长.
  const visitorFor = db.transaction(clerkUser => {
    const linked = db.prepare('SELECT * FROM comment_users WHERE clerkUserId = ?').get(clerkUser.id);
    if (linked) return linked;
    const email = clerkUser.email?.trim().toLowerCase() || null;
    const usable = email && email !== adminEmail;
    const existing = usable ? db.prepare('SELECT * FROM comment_users WHERE email = ?').get(email) : null;
    if (existing && !existing.clerkUserId) db.prepare('UPDATE comment_users SET clerkUserId = ? WHERE id = ?').run(clerkUser.id, existing.id);
    else db.prepare('INSERT INTO comment_users (id, email, nickname, createdAt, clerkUserId) VALUES (?, ?, NULL, ?, ?)')
      .run(randomUUID(), usable && !existing ? email : `clerk:${clerkUser.id}`, now(), clerkUser.id);
    return db.prepare('SELECT * FROM comment_users WHERE clerkUserId = ?').get(clerkUser.id);
  });
  app.use('/api/comments', (req, res, next) => {
    // The owner's account comments as 站长 even when its session is too old for
    // administration; moderating other people's comments still needs req.isAdmin.
    const owner = req.isAdmin || req.clerkUser?.id === ownerUserId;
    req.commentUser = owner ? ensureOwner() : req.clerkUser ? visitorFor(req.clerkUser) : null;
    next();
  });
  const isOwner = user => user?.email === adminEmail;
  const session = req => ({ authenticated: !!req.commentUser, profile: req.commentUser ? {
    nickname: isOwner(req.commentUser) ? '站长' : req.commentUser.nickname,
    needsNickname: !isOwner(req.commentUser) && !req.commentUser.nickname,
    isOwner: isOwner(req.commentUser),
  } : null, isAdmin: req.isAdmin });
  const requireUser = (req, res, next) => req.commentUser ? next() : res.status(401).json({ error: '请先登录 dkz12345 统一账号后再留言。' });
  const publicComment = (row, req) => ({
    id: row.id, rootId: row.rootId, replyToId: row.replyToId,
    nickname: row.deletedAt !== null ? null : row.authorEmail === adminEmail ? '站长' : row.nickname,
    isOwner: row.deletedAt === null && row.authorEmail === adminEmail,
    body: row.deletedAt === null ? row.body : null, createdAt: row.createdAt, deleted: row.deletedAt !== null,
    replyToNickname: row.replyToId === null ? null : row.targetDeleted !== null ? '已删除的评论' : row.targetEmail === adminEmail ? '站长' : row.targetNickname,
    canDelete: row.deletedAt === null && !!(req.isAdmin || req.commentUser?.id === row.authorId),
  });
  const selectColumns = `SELECT c.*, u.nickname, u.email AS authorEmail, t.deletedAt AS targetDeleted,
    tu.nickname AS targetNickname, tu.email AS targetEmail
    FROM comments c JOIN comment_users u ON u.id = c.authorId
    LEFT JOIN comments t ON t.id = c.replyToId LEFT JOIN comment_users tu ON tu.id = t.authorId`;
  const visibleReply = `(c.deletedAt IS NULL OR EXISTS (SELECT 1 FROM comments child WHERE child.replyToId = c.id AND child.deletedAt IS NULL))`;
  const visibleRoot = `(c.deletedAt IS NULL OR EXISTS (SELECT 1 FROM comments child WHERE child.rootId = c.id AND child.deletedAt IS NULL))`;
  const replies = (rootId, after, req) => {
    const rows = db.prepare(`${selectColumns} WHERE c.rootId = ? AND c.id > ? AND ${visibleReply} ORDER BY c.id ASC LIMIT ?`).all(rootId, after, pageSize + 1);
    const more = rows.length > pageSize;
    const items = rows.slice(0, pageSize).map(row => publicComment(row, req));
    return { items, nextCursor: more ? items.at(-1).id : null };
  };
  const count = (kind, subject, since) => db.prepare('SELECT count(*) AS n FROM comment_rate_events WHERE kind = ? AND subject = ? AND at > ?').get(kind, subject, since).n;
  const last = (kind, subject) => db.prepare('SELECT max(at) AS at FROM comment_rate_events WHERE kind = ? AND subject = ?').get(kind, subject).at;
  const log = (kind, subject) => db.prepare('INSERT INTO comment_rate_events VALUES (?, ?, ?)').run(kind, subject, now());
  const ipKey = req => hmac(`ip:${req.ip}`);
  const cleanEvents = () => db.prepare('DELETE FROM comment_rate_events WHERE at <= ?').run(now() - 25 * 60 * 60_000);
  const reservePost = db.transaction((userId, ip) => {
    cleanEvents();
    const recent = last('post-user', userId);
    if (recent !== null && now() - recent < 10_000) return '说慢一点，请在 10 秒后继续留言。';
    if (count('post-user', userId, now() - 60 * 60_000) >= 30 || count('post-ip', ip, now() - 60 * 60_000) >= 60) return '本小时留言较多，请稍后再试。';
    log('post-user', userId); log('post-ip', ip); return null;
  });

  app.get('/api/comments/session', (req, res) => res.json(session(req)));
  app.put('/api/comments/profile', requireUser, (req, res) => {
    const parsed = z.object({ nickname: nicknameSchema }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: '昵称须为 1–24 字，不能包含换行。' });
    if (req.commentUser.nickname || isOwner(req.commentUser)) return res.status(409).json({ error: '昵称已设置，无需再次填写。' });
    db.prepare('UPDATE comment_users SET nickname = ? WHERE id = ? AND nickname IS NULL').run(parsed.data.nickname, req.commentUser.id);
    req.commentUser = db.prepare('SELECT * FROM comment_users WHERE id = ?').get(req.commentUser.id);
    res.json(session(req));
  });
  app.get('/api/comments', (req, res) => {
    const page = Number(req.query.page || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) return res.status(400).json({ error: '页码无效。' });
    const totalThreads = db.prepare(`SELECT count(*) AS n FROM comments c WHERE c.rootId IS NULL AND ${visibleRoot}`).get().n;
    const actualPage = Math.min(page, Math.max(1, Math.ceil(totalThreads / pageSize)));
    const rows = db.prepare(`${selectColumns} WHERE c.rootId IS NULL AND ${visibleRoot} ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(pageSize, (actualPage - 1) * pageSize);
    res.json({ items: rows.map(row => ({ ...publicComment(row, req), replies: replies(row.id, 0, req), replyCount: db.prepare(`SELECT count(*) AS n FROM comments c WHERE c.rootId = ? AND ${visibleReply}`).get(row.id).n })),
      totalThreads, totalComments: db.prepare('SELECT count(*) AS n FROM comments WHERE deletedAt IS NULL').get().n, page: actualPage, pageSize });
  });
  app.get('/api/comments/:id/replies', (req, res) => {
    const id = Number(req.params.id), after = Number(req.query.after || 0);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(after) || after < 0) return res.status(400).json({ error: '回复位置无效。' });
    const root = db.prepare(`SELECT id FROM comments c WHERE c.id = ? AND c.rootId IS NULL AND ${visibleRoot}`).get(id);
    if (!root) return res.status(404).json({ error: '这条留言已不存在，请刷新列表。' });
    res.json(replies(id, after, req));
  });
  app.post('/api/comments', requireUser, (req, res) => {
    if (!req.commentUser.nickname && !isOwner(req.commentUser)) return res.status(409).json({ error: '请先设置一个公开昵称。' });
    const parsed = postSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: '留言须为 1–2000 字，不能只包含空白。' });
    const { body, replyToId, clientKey } = parsed.data;
    const previous = db.prepare('SELECT * FROM comments WHERE authorId = ? AND clientKey = ?').get(req.commentUser.id, clientKey);
    if (previous) {
      if (previous.deletedAt !== null) return res.status(410).json({ error: '这条留言已被删除。' });
      if (previous.body !== body || previous.replyToId !== replyToId) return res.status(409).json({ error: '内容已经变化，请重新提交。' });
      return res.json({ id: previous.id, rootId: previous.rootId });
    }
    let rootId = null;
    if (replyToId !== null) {
      const target = db.prepare('SELECT * FROM comments WHERE id = ?').get(replyToId);
      if (!target || target.deletedAt !== null) return res.status(404).json({ error: '要回复的评论已删除，请重新选择回复对象。' });
      rootId = target.rootId || target.id;
    }
    const error = reservePost(req.commentUser.id, ipKey(req));
    if (error) return res.status(429).json({ error });
    const result = db.prepare('INSERT INTO comments (authorId, rootId, replyToId, body, createdAt, clientKey) VALUES (?, ?, ?, ?, ?, ?)').run(req.commentUser.id, rootId, replyToId, body, now(), clientKey);
    res.status(201).json({ id: Number(result.lastInsertRowid), rootId });
  });
  app.delete('/api/comments/:id', requireUser, (req, res) => {
    const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: '这条评论已不存在。' });
    if (!req.isAdmin && row.authorId !== req.commentUser.id) return res.status(403).json({ error: '只能删除自己的评论。' });
    if (row.deletedAt === null) db.prepare('UPDATE comments SET body = NULL, deletedAt = ? WHERE id = ?').run(now(), row.id);
    res.json({ ok: true });
  });
}
