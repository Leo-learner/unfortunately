import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { clerkConfig, clerkToken } from './clerk-fixture.js';
const origin = 'http://127.0.0.1:3210';
const adminEmail = 'owner@example.com';
const secret = 'testing-comments-abcdefghijklmnopqrstuvwxyz';
// A signed-in dkz12345 visitor (any Clerk account other than the owner's).
const visitor = (name, email = `${name}@example.com`) => clerkToken(origin, { sub: `user_${name}`, email });
function fixture(t, extra = {}) {
  let clock = Date.parse('2026-09-05T03:00:00Z');
  const { app, db } = createApp({ adminEmail, secret, origin, clerk: clerkConfig, now: () => clock, ...extra });
  t.after(() => { if (db.open) db.close(); });
  const as = (req, who) => who ? req.set('Authorization', `Bearer ${who}`) : req;
  const get = (who, path) => as(request(app).get(path), who);
  const send = (who, method, path, body = {}) => as(request(app)[method]('/api' + path).set('Origin', origin), who).send(body);
  const login = async (who, nickname = '访客') => {
    const result = await get(who, '/api/comments/session').expect(200);
    if (result.body.profile.needsNickname && nickname !== null) await send(who, 'put', '/comments/profile', { nickname }).expect(200);
    return result;
  };
  const post = (who, body = '我的留言', replyToId = null, clientKey = randomUUID()) => send(who, 'post', '/comments', { body, replyToId, clientKey });
  return { app, db, get, send, login, post, owner: clerkToken(origin), advance: n => { clock += n; } };
}

test('the owner comments as 站长; a different account with the owner email never becomes 站长', async t => {
  const f = fixture(t);
  const impostor = visitor('impostor', adminEmail);
  const session = (await f.login(impostor, null)).body;
  assert.equal(session.profile.isOwner, false); assert.equal(session.profile.needsNickname, true);
  assert.equal((await f.get(impostor, '/api/session')).body.access, 'not-owner');
  await f.get(impostor, '/api/admin/applications').expect(403);
  await f.send(impostor, 'put', '/comments/profile', { nickname: '假站长' }).expect(200);
  const row = (await f.post(impostor)).body;
  assert.equal((await f.get(null, '/api/comments')).body.items[0].isOwner, false);
  const owner = (await f.get(f.owner, '/api/comments/session')).body;
  assert.equal(owner.profile.nickname, '站长'); assert.equal(owner.isAdmin, true);
  // An owner session too old to administer still comments as 站长, but cannot moderate.
  const stale = clerkToken(origin, { fva: [800, 800] });
  const staleSession = (await f.get(stale, '/api/comments/session')).body;
  assert.equal(staleSession.profile.isOwner, true); assert.equal(staleSession.isAdmin, false);
  await f.send(stale, 'delete', `/comments/${row.id}`).expect(403);
  await f.send(f.owner, 'delete', `/comments/${row.id}`).expect(200);
});

test('first nickname, public whitelist and no unauthorized deletion or application leakage', async t => {
  const f = fixture(t), a = visitor('alice'), b = visitor('bob');
  await f.login(a, null);
  await f.post(a).expect(409);
  await f.send(a, 'put', '/comments/profile', { nickname: ' ' }).expect(400);
  await f.send(a, 'put', '/comments/profile', { nickname: 'a'.repeat(25) }).expect(400);
  await f.send(a, 'put', '/comments/profile', { nickname: '阿梨' }).expect(200);
  await f.send(a, 'put', '/comments/profile', { nickname: '改名' }).expect(409);
  const root = (await f.post(a, '邮箱绝不应该被接口带出来')).body.id;
  await f.login(b, '小北');
  await f.send(b, 'delete', `/comments/${root}`).expect(403);
  await request(f.app).post('/api/comments').set('Origin', origin).send({ body:'x', clientKey:randomUUID() }).expect(401);
  const response = await request(f.app).get('/api/comments').expect(200);
  assert.equal(response.body.items[0].canDelete, false);
  for (const privateField of ['alice@example.com','bob@example.com','user_alice','clerkUserId','authorId','authorEmail','digest','secret','clientKey']) assert.ok(!response.text.includes(privateField));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal((await f.get(a, '/api/public/applications')).body.updatedAt, null);
});

test('all visitors can reply, nested replies stay two levels, deletion keeps surviving conversation', async t => {
  const f = fixture(t), a = visitor('alice'), b = visitor('bob');
  await f.login(a,'阿梨'); await f.login(b,'小北');
  const root = (await f.post(a,'主评论')).body.id;
  const reply = (await f.post(b,'回复主评论',root)).body.id;
  f.advance(10000);
  const nested = (await f.post(a,'回复小北',reply)).body;
  assert.equal(nested.rootId,root);
  let list=(await f.get(a,'/api/comments')).body;
  assert.equal(list.items[0].replies.items.length,2);
  assert.equal(list.items[0].replies.items[1].replyToNickname,'小北');
  await f.send(a,'delete',`/comments/${root}`).expect(200);
  list=(await f.get(b,'/api/comments')).body;
  assert.equal(list.items[0].deleted,true); assert.equal(list.items[0].body,null); assert.equal(list.items[0].nickname,null);
  f.advance(10000); await f.post(b,'不能回复已删除主评论',root).expect(404);
  await f.post(b,'仍可回复有效回复',nested.id).expect(201);
  await f.send(b,'delete',`/comments/${reply}`).expect(200);
  list=(await f.get(a,'/api/comments')).body;
  assert.equal(list.items[0].replies.items[0].deleted,true);
  assert.equal(list.items[0].replies.items[1].replyToNickname,'已删除的评论');
  for(const item of list.items[0].replies.items) await f.send(f.owner,'delete',`/comments/${item.id}`).expect(200);
  assert.equal((await request(f.app).get('/api/comments')).body.totalThreads,0);
});

test('root pagination newest first, reply cursor oldest first, and page clamp after deletions', async t => {
  const f = fixture(t), a=visitor('alice'); await f.login(a,'阿梨');
  const ids=[];
  for(let i=0;i<12;i++){ids.push((await f.post(a,`留言${i}`).expect(201)).body.id);f.advance(10000);}
  const first=(await f.get(a,'/api/comments')).body;
  assert.equal(first.items.length,10);assert.equal(first.items[0].id,ids[11]);
  const second=(await f.get(a,'/api/comments?page=2')).body;
  assert.deepEqual(second.items.map(i=>i.id),[ids[1],ids[0]]);
  for(let i=0;i<12;i++){await f.post(a,`回复${i}`,ids[11]).expect(201);f.advance(10000);}
  const thread=(await f.get(a,'/api/comments')).body.items[0];
  assert.equal(thread.replies.items.length,10);assert.equal(thread.replies.items[0].body,'回复0');
  const rest=(await f.get(a,`/api/comments/${ids[11]}/replies?after=${thread.replies.nextCursor}`)).body;
  assert.deepEqual(rest.items.map(i=>i.body),['回复10','回复11']); assert.equal(rest.nextCursor,null);
  await f.get(a,'/api/comments?page=-1').expect(400);
  for(const id of ids.slice(0,2)) await f.send(a,'delete',`/comments/${id}`).expect(200);
  assert.equal((await f.get(a,'/api/comments?page=2')).body.page,1);
});

test('body limits, plain-text payloads, idempotency retries and per-user rate limits', async t => {
  const f=fixture(t),a=visitor('alice');await f.login(a,'阿梨');
  await f.post(a,' ').expect(400); await f.post(a,'字'.repeat(2001)).expect(400);
  const body='<script>alert(1)</script>\n**保持原样**';const key=randomUUID();
  const first=(await f.post(a,body,null,key).expect(201)).body;
  assert.equal((await f.post(a,body,null,key).expect(200)).body.id,first.id);
  await f.post(a,'改了内容',null,key).expect(409);
  await f.post(a,'太快').expect(429);
  assert.equal((await f.get(a,'/api/comments')).body.items[0].body,body);
  for(let i=1;i<30;i++){f.advance(10000);await f.post(a,`第${i}条`).expect(201);}
  f.advance(10000);await f.post(a,'第31条').expect(429);
  await request(f.app).post('/api/comments').set('Authorization',`Bearer ${a}`).set('Origin','https://evil.example').send({body:'x',clientKey:randomUUID()}).expect(403);
});

test('a legacy email-code commenter is taken over once by the first Clerk account with that email', async t => {
  const dir=mkdtempSync(join(tmpdir(),'comments-clerk-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'db.sqlite');
  // The previous schema: email-code commenters, no clerkUserId column.
  const old=new Database(path);old.exec(`CREATE TABLE comment_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, nickname TEXT, createdAt INTEGER NOT NULL);
    CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, authorId TEXT NOT NULL REFERENCES comment_users(id), rootId INTEGER REFERENCES comments(id), replyToId INTEGER REFERENCES comments(id), body TEXT, createdAt INTEGER NOT NULL, deletedAt INTEGER, clientKey TEXT NOT NULL, UNIQUE(authorId, clientKey));
    INSERT INTO comment_users VALUES ('legacy-alice','alice@example.com','阿梨',1);
    INSERT INTO comment_users VALUES ('legacy-owner','${adminEmail}','站长',1);
    INSERT INTO comments (authorId, body, createdAt, clientKey) VALUES ('legacy-alice','旧留言',1,'${randomUUID()}');`);old.close();
  const f=fixture(t,{databasePath:path});
  const alice=visitor('alice','Alice@Example.com');
  const session=(await f.get(alice,'/api/comments/session')).body;
  assert.equal(session.profile.nickname,'阿梨'); assert.equal(session.profile.needsNickname,false);
  assert.equal((await f.get(alice,'/api/comments')).body.items[0].canDelete,true);
  assert.equal(f.db.prepare('SELECT clerkUserId FROM comment_users WHERE id=?').get('legacy-alice').clerkUserId,'user_alice');
  // A second account showing the same email later gets its own, fresh identity.
  const other=visitor('other','alice@example.com');
  assert.equal((await f.get(other,'/api/comments/session')).body.profile.needsNickname,true);
  assert.equal((await f.get(other,'/api/comments')).body.items[0].canDelete,false);
  // No email at all still works, with a private placeholder.
  const noEmail=clerkToken(origin,{sub:'user_noemail',email:null});
  assert.equal((await f.login(noEmail,'无名')).body.authenticated,true);
  await f.post(noEmail,'没有邮箱也能留言').expect(201);
  const emails=f.db.prepare('SELECT email FROM comment_users ORDER BY createdAt').all().map(r=>r.email);
  assert.ok(emails.includes('clerk:user_other')); assert.ok(emails.includes('clerk:user_noemail'));
  // The owner keeps the legacy 站长 row.
  assert.equal(f.db.prepare('SELECT clerkUserId FROM comment_users WHERE id=?').get('legacy-owner').clerkUserId,null);
  await f.send(f.owner,'delete','/comments/1').expect(200);
  assert.equal((await f.get(f.owner,'/api/comments/session')).body.profile.nickname,'站长');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM comment_users WHERE email=?").get(adminEmail).n,1);
});

test('additive schema preserves legacy application data, supports restart and cross-device identity',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'comments-upgrade-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'db.sqlite');
  // A database created by an older schema: no comment-related tables.
  const old=new Database(path);old.exec(`CREATE TABLE applications(id TEXT PRIMARY KEY, company TEXT NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,appliedOn TEXT NOT NULL,status TEXT NOT NULL,rejectedOn TEXT,notes TEXT NOT NULL,version INTEGER NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);INSERT INTO applications VALUES('original','private company','岗位','internship','2026-09-01','rejected','2026-09-02','private note',1,'2026-09-01','2026-09-02');CREATE TABLE sessions(digest TEXT PRIMARY KEY,expiresAt INTEGER NOT NULL);INSERT INTO sessions VALUES('existing-session',9999999999999);`);old.close();
  const f=fixture(t,{databasePath:path}),a=visitor('alice');await f.login(a,'阿梨');const id=(await f.post(a,'跨设备留言')).body.id;f.db.close();
  const restored=fixture(t,{databasePath:path});
  const onPhone=visitor('alice');
  assert.equal((await restored.get(onPhone,'/api/comments/session')).body.profile.nickname,'阿梨');
  assert.equal((await restored.get(onPhone,'/api/comments')).body.items[0].canDelete,true);
  assert.equal((await restored.get(onPhone,'/api/public/applications')).body.stats.rejected,1);
  assert.ok(restored.db.prepare('SELECT * FROM sessions WHERE digest=?').get('existing-session'));
  await restored.send(onPhone,'delete',`/comments/${id}`).expect(200);
  const expired=clerkToken(origin,{sub:'user_alice',email:'alice@example.com',exp:Math.floor(Date.now()/1000)-120});
  await restored.post(expired).expect(401);
});
