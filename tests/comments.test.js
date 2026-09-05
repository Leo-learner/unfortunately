import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
const origin = 'http://127.0.0.1:3210';
const adminEmail = 'owner@example.com';
const secret = 'testing-comments-abcdefghijklmnopqrstuvwxyz';
function fixture(t, extra = {}) {
  let clock = Date.parse('2026-09-05T03:00:00Z');
  const mails = [];
  const { app, db } = createApp({ adminEmail, secret, origin, now: () => clock, sendCode: async (email, code) => mails.push({ email, code }), ...extra });
  t.after(() => { if (db.open) db.close(); });
  const agent = () => request.agent(app);
  const send = (client, method, path, body = {}) => client[method]('/api' + path).set('Origin', origin).send(body);
  const code = email => mails.findLast(m => m.email === email)?.code;
  const login = async (client, email, nickname = '访客') => {
    await send(client, 'post', '/comments/auth/request-code', { email }).expect(200);
    const result = await send(client, 'post', '/comments/auth/verify', { email, code: code(email) }).expect(200);
    if (result.body.profile.needsNickname && nickname !== null) await send(client, 'put', '/comments/profile', { nickname }).expect(200);
    return result;
  };
  const adminLogin = async client => { await send(client, 'post', '/auth/request-code', { email: adminEmail }).expect(200); await send(client, 'post', '/auth/verify', { email: adminEmail, code: code(adminEmail) }).expect(200); };
  const post = (client, body = '我的留言', replyToId = null, clientKey = randomUUID()) => send(client, 'post', '/comments', { body, replyToId, clientKey });
  return { app, db, agent, send, code, mails, login, adminLogin, post, advance: n => { clock += n; } };
}

test('visitor identity is separate from administrator even when verified email belongs to owner', async t => {
  const f = fixture(t); const visitor = f.agent(); await f.login(visitor, adminEmail);
  assert.equal((await visitor.get('/api/session')).body.authenticated, false);
  await visitor.get('/api/admin/applications').expect(401);
  await f.send(visitor, 'post', '/admin/applications', {}).expect(401);
  const row = (await f.post(visitor)).body;
  assert.equal((await visitor.get('/api/comments')).body.items[0].isOwner, true);
  assert.ok(row.id);
  const admin = f.agent(); await f.adminLogin(admin);
  assert.equal((await admin.get('/api/comments/session')).body.profile.nickname, '站长');
  await f.send(admin, 'post', '/auth/logout').expect(200);
  assert.equal((await admin.get('/api/comments/session')).body.authenticated, false);
});

test('first nickname, public whitelist and no unauthorized deletion or application leakage', async t => {
  const f = fixture(t), a = f.agent(), b = f.agent();
  await f.login(a, 'alice@example.com', null);
  await f.post(a).expect(409);
  await f.send(a, 'put', '/comments/profile', { nickname: ' ' }).expect(400);
  await f.send(a, 'put', '/comments/profile', { nickname: 'a'.repeat(25) }).expect(400);
  await f.send(a, 'put', '/comments/profile', { nickname: '阿梨' }).expect(200);
  await f.send(a, 'put', '/comments/profile', { nickname: '改名' }).expect(409);
  const root = (await f.post(a, '邮箱绝不应该被接口带出来')).body.id;
  await f.login(b, 'bob@example.com', '小北');
  await f.send(b, 'delete', `/comments/${root}`).expect(403);
  await request(f.app).post('/api/comments').set('Origin', origin).send({ body:'x', clientKey:randomUUID() }).expect(401);
  const response = await request(f.app).get('/api/comments').expect(200);
  assert.equal(response.body.items[0].canDelete, false);
  for (const privateField of ['alice@example.com','bob@example.com','authorId','authorEmail','digest','secret','clientKey']) assert.ok(!response.text.includes(privateField));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal((await a.get('/api/public/applications')).body.updatedAt, null);
});

test('all visitors can reply, nested replies stay two levels, deletion keeps surviving conversation', async t => {
  const f = fixture(t), a = f.agent(), b = f.agent(), owner = f.agent();
  await f.login(a,'alice@example.com','阿梨'); await f.login(b,'bob@example.com','小北');
  const root = (await f.post(a,'主评论')).body.id;
  const reply = (await f.post(b,'回复主评论',root)).body.id;
  f.advance(10000);
  const nested = (await f.post(a,'回复小北',reply)).body;
  assert.equal(nested.rootId,root);
  let list=(await a.get('/api/comments')).body;
  assert.equal(list.items[0].replies.items.length,2);
  assert.equal(list.items[0].replies.items[1].replyToNickname,'小北');
  await f.send(a,'delete',`/comments/${root}`).expect(200);
  list=(await b.get('/api/comments')).body;
  assert.equal(list.items[0].deleted,true); assert.equal(list.items[0].body,null); assert.equal(list.items[0].nickname,null);
  f.advance(10000); await f.post(b,'不能回复已删除主评论',root).expect(404);
  await f.post(b,'仍可回复有效回复',nested.id).expect(201);
  await f.send(b,'delete',`/comments/${reply}`).expect(200);
  list=(await a.get('/api/comments')).body;
  assert.equal(list.items[0].replies.items[0].deleted,true);
  assert.equal(list.items[0].replies.items[1].replyToNickname,'已删除的评论');
  await f.adminLogin(owner);
  for(const item of list.items[0].replies.items) await f.send(owner,'delete',`/comments/${item.id}`).expect(200);
  assert.equal((await request(f.app).get('/api/comments')).body.totalThreads,0);
});

test('root pagination newest first, reply cursor oldest first, and page clamp after deletions', async t => {
  const f = fixture(t), a=f.agent(); await f.login(a,'alice@example.com','阿梨');
  const ids=[];
  for(let i=0;i<12;i++){ids.push((await f.post(a,`留言${i}`).expect(201)).body.id);f.advance(10000);}
  const first=(await a.get('/api/comments')).body;
  assert.equal(first.items.length,10);assert.equal(first.items[0].id,ids[11]);
  const second=(await a.get('/api/comments?page=2')).body;
  assert.deepEqual(second.items.map(i=>i.id),[ids[1],ids[0]]);
  for(let i=0;i<12;i++){await f.post(a,`回复${i}`,ids[11]).expect(201);f.advance(10000);}
  const thread=(await a.get('/api/comments')).body.items[0];
  assert.equal(thread.replies.items.length,10);assert.equal(thread.replies.items[0].body,'回复0');
  const rest=(await a.get(`/api/comments/${ids[11]}/replies?after=${thread.replies.nextCursor}`)).body;
  assert.deepEqual(rest.items.map(i=>i.body),['回复10','回复11']); assert.equal(rest.nextCursor,null);
  await a.get('/api/comments?page=-1').expect(400);
  for(const id of ids.slice(0,2)) await f.send(a,'delete',`/comments/${id}`).expect(200);
  assert.equal((await a.get('/api/comments?page=2')).body.page,1);
});

test('body limits, plain-text payloads, idempotency retries and per-user rate limits', async t => {
  const f=fixture(t),a=f.agent();await f.login(a,'alice@example.com','阿梨');
  await f.post(a,' ').expect(400); await f.post(a,'字'.repeat(2001)).expect(400);
  const body='<script>alert(1)</script>\n**保持原样**';const key=randomUUID();
  const first=(await f.post(a,body,null,key).expect(201)).body;
  assert.equal((await f.post(a,body,null,key).expect(200)).body.id,first.id);
  await f.post(a,'改了内容',null,key).expect(409);
  await f.post(a,'太快').expect(429);
  assert.equal((await a.get('/api/comments')).body.items[0].body,body);
  for(let i=1;i<30;i++){f.advance(10000);await f.post(a,`第${i}条`).expect(201);}
  f.advance(10000);await f.post(a,'第31条').expect(429);
  await a.post('/api/comments').set('Origin','https://evil.example').send({body:'x',clientKey:randomUUID()}).expect(403);
});

test('visitor codes expire, are single-use, attempts capped, and cannot authenticate admin', async t => {
  const f=fixture(t),a=f.agent();const email='alice@example.com';
  await f.send(a,'post','/comments/auth/request-code',{email}).expect(200);
  const code=f.code(email);
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM visitor_challenges').all()).includes(code));
  await f.send(a,'post','/auth/verify',{email:adminEmail,code}).expect(400);
  f.advance(600000);await f.send(a,'post','/comments/auth/verify',{email,code}).expect(400);
  await f.send(a,'post','/comments/auth/request-code',{email}).expect(200);
  const bad=f.code(email)==='000000'?'000001':'000000';
  for(let i=0;i<5;i++)await f.send(a,'post','/comments/auth/verify',{email,code:bad}).expect(400);
  await f.send(a,'post','/comments/auth/verify',{email,code:f.code(email)}).expect(400);
  f.advance(61000);await f.login(a,email,'阿梨');
  await f.send(a,'post','/comments/auth/verify',{email,code:f.code(email)}).expect(400);
  await f.send(a,'post','/comments/auth/logout').expect(200);
  await f.post(a).expect(401);
});

test('mail quotas persist, isolate visitor and admin allowance, and failed send is not usable', async t => {
  const f=fixture(t,{visitorDailyLimit:2}),a=f.agent();
  await f.send(a,'post','/comments/auth/request-code',{email:'a@example.com'}).expect(200);
  await f.send(a,'post','/comments/auth/request-code',{email:'a@example.com'}).expect(429);
  f.advance(60000);
  await f.send(a,'post','/comments/auth/request-code',{email:'b@example.com'}).expect(200);
  await f.send(a,'post','/comments/auth/request-code',{email:'c@example.com'}).expect(429);
  await f.adminLogin(a);
  assert.equal((await a.get('/api/session')).body.authenticated,true);
  const failure=fixture(t,{sendCode:async()=>{throw Error('SMTP failure');}}),v=failure.agent();
  await failure.send(v,'post','/comments/auth/request-code',{email:'x@example.com'}).expect(503);
  assert.equal(failure.db.prepare('SELECT expiresAt FROM visitor_challenges').get().expiresAt,0);
});

test('per-email hourly and per-IP mail limits are enforced independently', async t => {
  const f=fixture(t),a=f.agent();
  for(let i=0;i<5;i++) {await f.send(a,'post','/comments/auth/request-code',{email:'a@example.com'}).set('X-Forwarded-For',`192.0.2.${i+1}`).expect(200);f.advance(60000);}
  await f.send(a,'post','/comments/auth/request-code',{email:'a@example.com'}).set('X-Forwarded-For','192.0.2.20').expect(429);
  for(let i=0;i<5;i++) await f.send(a,'post','/comments/auth/request-code',{email:`visitor${i}@example.com`}).set('X-Forwarded-For','192.0.2.30').expect(200);
  await f.send(a,'post','/comments/auth/request-code',{email:'extra@example.com'}).set('X-Forwarded-For','192.0.2.30').expect(429);
});

test('additive schema preserves legacy application data, supports restart and cross-device identity',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'comments-upgrade-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'db.sqlite');
  // A database created by the previous schema: no comment-related tables.
  const old=new Database(path);old.exec(`CREATE TABLE applications(id TEXT PRIMARY KEY, company TEXT NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,appliedOn TEXT NOT NULL,status TEXT NOT NULL,rejectedOn TEXT,notes TEXT NOT NULL,version INTEGER NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);INSERT INTO applications VALUES('original','private company','岗位','internship','2026-09-01','rejected','2026-09-02','private note',1,'2026-09-01','2026-09-02');CREATE TABLE sessions(digest TEXT PRIMARY KEY,expiresAt INTEGER NOT NULL);INSERT INTO sessions VALUES('existing-session',9999999999999);`);old.close();
  const f=fixture(t,{databasePath:path}),a=f.agent();await f.login(a,'alice@example.com','阿梨');const id=(await f.post(a,'跨设备留言')).body.id;f.db.close();
  const restored=fixture(t,{databasePath:path}),b=restored.agent();restored.advance(61000);const logged=await restored.login(b,'alice@example.com');
  assert.equal(logged.body.profile.nickname,'阿梨');
  assert.equal((await b.get('/api/comments')).body.items[0].canDelete,true);
  assert.equal((await b.get('/api/public/applications')).body.stats.rejected,1);
  assert.ok(restored.db.prepare('SELECT * FROM sessions WHERE digest=?').get('existing-session'));
  await restored.send(b,'delete',`/comments/${id}`).expect(200);
  restored.advance(31*86400000);await restored.post(b).expect(401);
});
