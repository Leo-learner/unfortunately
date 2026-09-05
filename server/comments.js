import { z } from 'zod';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const boundedText = max => z.string().trim().min(1).refine(s => [...s].length <= max);
const nicknameSchema = boundedText(24).refine(s => !/[\u0000-\u001f\u007f]/.test(s));
const postSchema = z.object({
  body: boundedText(2000), replyToId: z.number().int().positive().nullable().default(null),
  clientKey: z.string().uuid(),
}).strict();
const hash = text => createHash('sha256').update(text).digest('hex');
const pageSize = 10;

export function installComments(app, { db, adminEmail, secret, sendCode, production, now, visitorDailyLimit = 200 }) {
  if (!Number.isInteger(visitorDailyLimit) || visitorDailyLimit < 1) throw new Error('Invalid visitor mail daily limit');
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
  const cookieName = production ? '__Host-unfortunately-visitor' : 'unfortunately-visitor';
  const cookieOptions = { httpOnly: true, secure: production, sameSite: 'strict', path: '/' };
  const hmac = text => createHmac('sha256', secret).update(text).digest('hex');
  const digestCode = (email, nonce, code) => hmac(`visitor:${email}:${nonce}:${code}`);
  const ensureUser = (email, owner = false) => {
    db.prepare('INSERT OR IGNORE INTO comment_users VALUES (?, ?, ?, ?)').run(randomUUID(), email, owner ? '站长' : null, now());
    return db.prepare('SELECT * FROM comment_users WHERE email = ?').get(email);
  };
  const cookieDigest = req => {
    const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    return token && /^[a-f0-9]{64}$/.test(token) ? hash(token) : null;
  };
  const clearVisitor = (req, res) => {
    const digest = cookieDigest(req);
    if (digest) db.prepare('DELETE FROM visitor_sessions WHERE digest = ?').run(digest);
    res.clearCookie(cookieName, cookieOptions);
  };
  app.use('/api/comments', (req, res, next) => {
    // An existing administrator session is never inferred from a visitor cookie.
    req.commentUser = req.isAdmin ? ensureUser(adminEmail, true) : db.prepare(`
      SELECT u.* FROM comment_users u JOIN visitor_sessions s ON s.userId = u.id
      WHERE s.digest = ? AND s.expiresAt > ?
    `).get(cookieDigest(req) || '', now());
    next();
  });
  const isOwner = user => user?.email === adminEmail;
  const session = req => ({ authenticated: !!req.commentUser, profile: req.commentUser ? {
    nickname: isOwner(req.commentUser) ? '站长' : req.commentUser.nickname,
    needsNickname: !isOwner(req.commentUser) && !req.commentUser.nickname,
    isOwner: isOwner(req.commentUser),
  } : null, isAdmin: req.isAdmin });
  const requireUser = (req, res, next) => req.commentUser ? next() : res.status(401).json({ error: '请先通过邮箱验证码登录后再留言。' });
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
  const reserveMail = db.transaction((email, ip) => {
    cleanEvents();
    if (count('mail-ip', ip, now() - 15 * 60_000) >= 5) return '验证码请求太频繁，请稍后再试。';
    const recent = last('mail-email', email);
    if (recent !== null && now() - recent < 60_000) return '请等待 60 秒后再获取验证码。';
    if (count('mail-email', email, now() - 60 * 60_000) >= 5) return '该邮箱本小时的验证码次数已用完，请稍后再试。';
    const dayStart = Math.floor((now() + 8 * 60 * 60_000) / 86400000) * 86400000 - 8 * 60 * 60_000;
    if (count('mail-global', 'all', dayStart - 1) >= visitorDailyLimit) return '今天的访客验证码发送额度已用完，请明天再试。';
    log('mail-ip', ip); log('mail-email', email); log('mail-global', 'all');
    return null;
  });
  const reservePost = db.transaction((userId, ip) => {
    cleanEvents();
    const recent = last('post-user', userId);
    if (recent !== null && now() - recent < 10_000) return '说慢一点，请在 10 秒后继续留言。';
    if (count('post-user', userId, now() - 60 * 60_000) >= 30 || count('post-ip', ip, now() - 60 * 60_000) >= 60) return '本小时留言较多，请稍后再试。';
    log('post-user', userId); log('post-ip', ip); return null;
  });

  app.get('/api/comments/session', (req, res) => res.json(session(req)));
  app.post('/api/comments/auth/request-code', async (req, res) => {
    const input = z.object({ email: emailSchema }).strict().safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: '请输入有效的邮箱地址。' });
    const email = input.data.email;
    const error = reserveMail(email, ipKey(req));
    if (error) return res.status(429).json({ error });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const nonce = randomBytes(16).toString('hex');
    db.prepare('INSERT OR REPLACE INTO visitor_challenges VALUES (?, ?, ?, ?, 0, ?)').run(email, digestCode(email, nonce, code), nonce, now() + 10 * 60_000, now());
    try { await sendCode(email, code); res.json({ message: '验证码已发送，请查看邮箱。', retryAfter: 60 }); }
    catch { db.prepare('UPDATE visitor_challenges SET expiresAt = 0 WHERE email = ? AND nonce = ?').run(email, nonce); res.status(503).json({ error: '验证码暂时无法发送，请稍后重试；邮箱地址已保留。' }); }
  });
  app.post('/api/comments/auth/verify', (req, res) => {
    const ip = ipKey(req);
    if (count('verify-ip', ip, now() - 15 * 60_000) >= 30) return res.status(429).json({ error: '验证尝试过多，请稍后再试。' });
    log('verify-ip', ip);
    const input = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }).strict().safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: '邮箱或验证码格式不正确。' });
    const { email, code } = input.data;
    const valid = db.transaction(() => {
      const row = db.prepare('SELECT * FROM visitor_challenges WHERE email = ?').get(email);
      if (!row || row.expiresAt <= now() || row.attempts >= 5) return false;
      db.prepare('UPDATE visitor_challenges SET attempts = attempts + 1 WHERE email = ?').run(email);
      const expected = digestCode(email, row.nonce, code);
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(row.digest))) return false;
      db.prepare('UPDATE visitor_challenges SET expiresAt = 0 WHERE email = ?').run(email);
      return true;
    })();
    if (!valid) return res.status(400).json({ error: '验证码不正确或已过期，请重新获取。' });
    const user = ensureUser(email);
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM visitor_sessions WHERE expiresAt <= ?').run(now());
    db.prepare('INSERT INTO visitor_sessions VALUES (?, ?, ?)').run(hash(token), user.id, now() + 30 * 86400000);
    req.commentUser = user;
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: 30 * 86400000 }).json(session(req));
  });
  app.post('/api/comments/auth/logout', (req, res) => { clearVisitor(req, res); res.json({ ok: true }); });
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
  return { clearVisitor };
}
