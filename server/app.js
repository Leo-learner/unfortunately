import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { openDatabase, snapshot } from './database.js';
import { installComments } from './comments.js';
import { createClerkGate } from './clerk-gate/clerk-gate.js';
import { ownerSessionAcceptable } from './clerk-gate/owner-policy.js';

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

// clerk: the shared dkz12345 Clerk sign-in. Public values only (no Clerk secret
// key): { publishableKey, jwtKey (PEM public key), ownerUserId }.
export function createApp({ databasePath = ':memory:', adminEmail, secret, origin, clerk, production = false, now = Date.now, staticDir, revision = 'development', mcpAdminKeyHash = '' }) {
  if (!adminEmail || !secret || secret.length < 32 || !origin) throw new Error('Missing secure application configuration');
  if (!clerk?.publishableKey || !clerk.jwtKey || !clerk.ownerUserId?.startsWith('user_')) throw new Error('Missing Clerk sign-in configuration');
  if (mcpAdminKeyHash && !/^[a-f0-9]{64}$/.test(mcpAdminKeyHash)) throw new Error('Invalid MCP administrator key hash');
  adminEmail = emailSchema.parse(adminEmail);
  const gate = createClerkGate({ publishableKey: clerk.publishableKey, jwtKey: clerk.jwtKey, authorizedParties: [origin] });
  const db = openDatabase(databasePath);
  const app = express();
  app.disable('x-powered-by');
  // Only the loopback nginx reverse proxy is trusted.
  app.set('trust proxy', 'loopback');
  // Clerk's script and API, plus Clerk Protect (bot checks) with its worker.
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://clerk.dkz12345.com', 'https://*.protect.clerk.com'], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", 'https://clerk.dkz12345.com', 'https://*.protect.clerk.com:*'], frameSrc: ['https://*.protect.clerk.com'], workerSrc: ["'self'", 'blob:'], frameAncestors: ["'none'"], upgradeInsecureRequests: production ? [] : null } }, hsts: production ? undefined : false }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('origin') !== origin || !req.is('application/json')) return res.status(403).json({ error: '请求来源无效，请刷新页面后重试。' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  // Who is asking: the AI administrator key, or a dkz12345 Clerk session token.
  // Both arrive as `Authorization: Bearer`; the Clerk __session cookie is ignored.
  // access: owner | reauth-required (owner, but the session fails the owner
  // policy) | not-owner (any other signed-in account) | signed-out.
  app.use('/api', async (req, res, next) => {
    const authorization = req.get('authorization');
    const apiKey = authorization?.match(/^Bearer (uf_ai_[a-f0-9]{64})$/)?.[1];
    req.clerkUser = null;
    if (apiKey) {
      // A dedicated key never becomes a browser or visitor session.
      req.isAdmin = !!(mcpAdminKeyHash && timingSafeEqual(Buffer.from(hash(apiKey), 'hex'), Buffer.from(mcpAdminKeyHash, 'hex')));
      req.access = req.isAdmin ? 'owner' : 'signed-out';
      return next();
    }
    const result = authorization ? await gate.authenticate({ authorization }) : { ok: false };
    if (!result.ok) { req.isAdmin = false; req.access = 'signed-out'; return next(); }
    req.clerkUser = result.user;
    const owner = result.user.id === clerk.ownerUserId;
    req.isAdmin = owner && ownerSessionAcceptable(result.claims, 'unfortunately') === true;
    req.access = !owner ? 'not-owner' : req.isAdmin ? 'owner' : 'reauth-required';
    next();
  });
  const mustAdmin = (req, res, next) => {
    if (req.isAdmin) return next();
    if (req.access === 'signed-out') return res.status(401).json({ error: '请先登录管理员账号。' });
    const notOwner = req.access === 'not-owner';
    res.status(403).json({ error: notOwner ? '这个账号不是站长。' : '请重新登录并完成两步验证。', code: notOwner ? 'NOT_OWNER' : 'REAUTH_REQUIRED' });
  };

  app.get('/api/health', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true, revision }); });
  app.get('/api/session', (req, res) => res.json({ authenticated: req.isAdmin, access: req.access }));
  app.get('/api/public/applications', (req, res) => res.json(snapshot(db)));
  app.get('/api/admin/applications', mustAdmin, (req, res) => res.json(snapshot(db, true)));
  installComments(app, { db, adminEmail, ownerUserId: clerk.ownerUserId, secret, now });
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
