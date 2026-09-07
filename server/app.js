import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { openDatabase, snapshot } from './database.js';
import { installComments } from './comments.js';

const hash = s => createHash('sha256').update(s).digest('hex');
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(+d) && d.toISOString().slice(0, 10) === s;
}, '日期无效');
const fields = z.object({
  company: z.string().trim().min(1).max(120), role: z.string().trim().min(1).max(120),
  kind: z.enum(['internship', 'parttime', 'fulltime']), appliedOn: dateSchema,
  status: z.enum(['pending', 'no_reply', 'interview', 'rejected', 'accepted', 'withdrawn']),
  rejectedOn: dateSchema.nullable().optional(), notes: z.string().max(5000).default(''),
  version: z.number().int().positive().optional(),
}).strict();

export function createApp({ databasePath = ':memory:', adminEmail, secret, origin, sendCode, production = false, now = Date.now, staticDir, revision = 'development', visitorDailyLimit = 200, mcpAdminKeyHash = '' }) {
  if (!adminEmail || !secret || secret.length < 32 || !origin) throw new Error('Missing secure application configuration');
  if (mcpAdminKeyHash && !/^[a-f0-9]{64}$/.test(mcpAdminKeyHash)) throw new Error('Invalid MCP administrator key hash');
  adminEmail = emailSchema.parse(adminEmail);
  const db = openDatabase(databasePath);
  const app = express();
  app.disable('x-powered-by');
  // Only the loopback nginx reverse proxy is trusted.
  app.set('trust proxy', 'loopback');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: production ? [] : null } }, hsts: production ? undefined : false }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('origin') !== origin || !req.is('application/json')) return res.status(403).json({ error: '请求来源无效，请刷新页面后重试。' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  const cookieName = production ? '__Host-unfortunately' : 'unfortunately-session';
  const cookieOptions = { httpOnly: true, secure: production, sameSite: 'strict', path: '/' };
  const sessionDigest = req => {
    const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    return token && /^[a-f0-9]{64}$/.test(token) ? hash(token) : null;
  };
  app.use('/api', (req, res, next) => {
    req.sessionDigest = sessionDigest(req);
    const authorization = req.get('authorization');
    const apiKey = authorization?.match(/^Bearer (uf_ai_[a-f0-9]{64})$/)?.[1];
    // A dedicated key never becomes a browser cookie or a visitor session.
    const keyAdmin = !!(mcpAdminKeyHash && apiKey && timingSafeEqual(Buffer.from(hash(apiKey), 'hex'), Buffer.from(mcpAdminKeyHash, 'hex')));
    req.isAdmin = authorization ? keyAdmin : !!(req.sessionDigest && db.prepare('SELECT digest FROM sessions WHERE digest = ? AND expiresAt > ?').get(req.sessionDigest, now()));
    next();
  });
  const mustAdmin = (req, res, next) => req.isAdmin ? next() : res.status(401).json({ error: '请先登录管理员账号。' });
  const otpDigest = (code, nonce) => createHmac('sha256', secret).update(`${adminEmail}:${nonce}:${code}`).digest('hex');
  const sameDigest = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const limited = (limit, windowMs) => rateLimit({ limit, windowMs, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '操作太频繁，请稍后再试。' } });

  app.get('/api/health', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true, revision }); });
  app.get('/api/session', (req, res) => res.json({ authenticated: req.isAdmin }));
  app.get('/api/public/applications', (req, res) => res.json(snapshot(db)));
  app.get('/api/admin/applications', mustAdmin, (req, res) => res.json(snapshot(db, true)));
  app.post('/api/auth/request-code', limited(5, 15 * 60_000), async (req, res) => {
    const email = emailSchema.safeParse(req.body?.email);
    if (!email.success) return res.status(400).json({ error: '请输入有效的邮箱地址。' });
    const generic = { message: '如果是管理员邮箱，验证码会发送到你的邮箱。', retryAfter: 60 };
    if (email.data !== adminEmail) return res.json(generic);
    const existing = db.prepare('SELECT sentAt FROM challenges WHERE email = ?').get(adminEmail);
    if (existing && now() - existing.sentAt < 60_000) return res.status(429).json({ error: '请等待 60 秒后再获取验证码。' });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const nonce = randomBytes(16).toString('hex');
    db.prepare('INSERT OR REPLACE INTO challenges (email, digest, nonce, expiresAt, attempts, sentAt) VALUES (?, ?, ?, ?, 0, ?)').run(adminEmail, otpDigest(code, nonce), nonce, now() + 10 * 60_000, now());
    try {
      await sendCode(adminEmail, code);
      res.json(generic);
    } catch {
      db.prepare('UPDATE challenges SET expiresAt = 0 WHERE email = ? AND nonce = ?').run(adminEmail, nonce);
      res.status(503).json({ error: '验证码暂时无法发送，请稍后再试。' });
    }
  });
  app.post('/api/auth/verify', limited(20, 15 * 60_000), (req, res) => {
    const input = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!input.success || input.data.email !== adminEmail) return res.status(400).json({ error: '邮箱或验证码不正确。' });
    const valid = db.transaction(() => {
      const challenge = db.prepare('SELECT * FROM challenges WHERE email = ?').get(adminEmail);
      if (!challenge || challenge.expiresAt <= now() || challenge.attempts >= 5) return false;
      db.prepare('UPDATE challenges SET attempts = attempts + 1 WHERE email = ?').run(adminEmail);
      if (!sameDigest(challenge.digest, otpDigest(input.data.code, challenge.nonce))) return false;
      // Retain sentAt for the cooldown even after successful verification.
      db.prepare('UPDATE challenges SET expiresAt = 0 WHERE email = ?').run(adminEmail);
      return true;
    })();
    if (!valid) return res.status(400).json({ error: '验证码不正确或已过期，请重新获取。' });
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(now());
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run(hash(token), now() + 30 * 24 * 60 * 60_000);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60_000 }).json({ authenticated: true });
  });
  const { clearVisitor } = installComments(app, { db, adminEmail, secret, sendCode, production, now, visitorDailyLimit });
  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionDigest) db.prepare('DELETE FROM sessions WHERE digest = ?').run(req.sessionDigest);
    clearVisitor(req, res);
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()));
  const normalize = (body, current) => {
    const result = fields.safeParse(body);
    if (!result.success) return { error: '请检查公司、岗位、日期和状态；公司与岗位最多 120 字，备注最多 5000 字。' };
    const value = result.data;
    value.rejectedOn = value.status === 'rejected' ? (value.rejectedOn || (current?.status === 'rejected' ? current.rejectedOn : null) || today()) : null;
    if (value.appliedOn > today()) return { error: '投递日期不能晚于今天。' };
    if (value.rejectedOn && (value.rejectedOn < value.appliedOn || value.rejectedOn > today())) return { error: '被拒日期须在投递日期与今天之间。' };
    return { value };
  };
  const markUpdated = stamp => db.prepare("INSERT OR REPLACE INTO metadata VALUES ('updatedAt', ?)").run(stamp);
  app.post('/api/admin/applications', mustAdmin, (req, res) => {
    const { value, error } = normalize(req.body);
    if (error) return res.status(400).json({ error });
    const stamp = new Date(now()).toISOString();
    const row = { ...value, id: randomUUID(), version: 1, createdAt: stamp, updatedAt: stamp };
    db.transaction(() => {
      db.prepare('INSERT INTO applications (id, company, role, kind, appliedOn, status, rejectedOn, notes, version, createdAt, updatedAt) VALUES (@id,@company,@role,@kind,@appliedOn,@status,@rejectedOn,@notes,@version,@createdAt,@updatedAt)').run(row);
      markUpdated(stamp);
    })();
    res.status(201).json(row);
  });
  app.put('/api/admin/applications/:id', mustAdmin, (req, res) => {
    const current = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: '这条记录已不存在，请刷新列表。' });
    if (req.body?.version !== current.version) return res.status(409).json({ error: '这条记录已在另一台设备修改。请关闭编辑窗口并刷新列表后重试。' });
    const { value, error } = normalize(req.body, current);
    if (error) return res.status(400).json({ error });
    const stamp = new Date(now()).toISOString();
    const row = { ...current, ...value, version: current.version + 1, updatedAt: stamp };
    db.transaction(() => {
      db.prepare('UPDATE applications SET company=@company, role=@role, kind=@kind, appliedOn=@appliedOn, status=@status, rejectedOn=@rejectedOn, notes=@notes, version=@version, updatedAt=@updatedAt WHERE id=@id').run(row);
      markUpdated(stamp);
    })();
    res.json(row);
  });
  app.delete('/api/admin/applications/:id', mustAdmin, (req, res) => {
    const current = db.prepare('SELECT version FROM applications WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: '这条记录已不存在。' });
    if (req.body?.version !== current.version) return res.status(409).json({ error: '记录已更新，请刷新后再删除。' });
    db.transaction(() => { db.prepare('DELETE FROM applications WHERE id = ?').run(req.params.id); markUpdated(new Date(now()).toISOString()); })();
    res.json({ ok: true });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在。' }));
  if (staticDir) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(['/', '/admin'], (req, res) => res.set('Cache-Control', 'no-cache').sendFile('index.html', { root: staticDir }));
  }
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({ error: status === 500 ? '暂时无法完成操作，请稍后重试。' : '提交的内容无效或过长。' });
  });
  return { app, db };
}
