import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

const origin = 'http://127.0.0.1:3210';
const email = 'owner@example.com';
const secret = 'test-only-secret-abcdefghijklmnopqrstuvwxyz';
const draft = { company: 'PRIVATE_COMPANY', role: '产品设计实习生', kind: 'internship', appliedOn: '2026-09-01', status: 'pending', notes: 'PRIVATE_NOTES' };
function fixture(t, opts = {}) {
  let code, time = Date.parse('2026-09-05T03:00:00Z'), mails = 0;
  const { app, db } = createApp({ adminEmail: email, secret, origin, now: () => time, sendCode: async (_, value) => { code = value; mails++; }, ...opts });
  t.after(() => { if (db.open) db.close(); });
  const client = request.agent(app);
  const call = (method, path, body) => client[method]('/api' + path).set('Origin', origin).send(body);
  return { app, db, client, call, code: () => code, mails: () => mails, advance: n => { time += n; }, login: async () => { await call('post', '/auth/request-code', { email }).expect(200); await call('post', '/auth/verify', { email, code }).expect(200); } };
}

test('public responses exclude company, notes, owner email, version and session details', async t => {
  const f = fixture(t); await f.login();
  await f.call('post', '/admin/applications', draft).expect(201);
  const response = await request(f.app).get('/api/public/applications').expect(200);
  assert.equal(response.body.stats.total, 1);
  assert.deepEqual(Object.keys(response.body.applications[0]).sort(), ['appliedOn','id','kind','rejectedOn','role','status']);
  for (const privateText of ['PRIVATE_COMPANY', 'PRIVATE_NOTES', email, secret]) assert.ok(!response.text.includes(privateText));
  assert.equal(response.headers['cache-control'], 'no-store');
  await request(f.app).get('/api/admin/applications').expect(401);
  for (const [method, path] of [['post', '/admin/applications'], ['put', '/admin/applications/fake'], ['delete', '/admin/applications/fake']]) await request(f.app)[method]('/api' + path).set('Origin', origin).send(draft).expect(401);
});
test('full CRUD counts current rejection once and handles no reply, corrections, stale writes and deletion', async t => {
  const f = fixture(t); await f.login();
  let row = (await f.call('post', '/admin/applications', draft).expect(201)).body;
  const update = async status => { row = (await f.call('put', '/admin/applications/' + row.id, { ...draft, status, version: row.version }).expect(200)).body; };
  await update('no_reply');
  assert.equal((await f.client.get('/api/public/applications')).body.stats.rejected, 0);
  await update('rejected'); await update('rejected');
  let stats = (await f.client.get('/api/public/applications')).body.stats;
  assert.equal(stats.rejected, 1); assert.equal(stats.total, 1); assert.equal(row.rejectedOn, '2026-09-05');
  await f.call('put', '/admin/applications/' + row.id, { ...draft, version: 1 }).expect(409);
  await f.call('delete', '/admin/applications/' + row.id, { version: 1 }).expect(409);
  await update('accepted'); assert.equal(row.rejectedOn, null);
  assert.equal((await f.client.get('/api/public/applications')).body.stats.rejected, 0);
  await f.call('delete', '/admin/applications/' + row.id, { version: row.version }).expect(200);
  const final = (await f.client.get('/api/public/applications')).body;
  assert.equal(final.stats.total, 0); assert.ok(final.updatedAt);
});
test('only allowlisted email receives codes; challenge codes stored hashed; one-time use and logout', async t => {
  const f = fixture(t);
  await f.call('post', '/auth/request-code', { email: 'stranger@example.com' }).expect(200); assert.equal(f.mails(), 0);
  await f.login(); assert.equal(f.mails(), 1);
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM challenges').all()).includes(f.code()));
  await f.call('post', '/auth/verify', { email, code: f.code() }).expect(400);
  assert.equal((await f.client.get('/api/session')).body.authenticated, true);
  await f.call('post', '/auth/logout', {}).expect(200);
  await f.client.get('/api/admin/applications').expect(401);
});
test('codes expire, attempts are capped, and resend cooldown survives successful login', async t => {
  const f = fixture(t);
  await f.call('post', '/auth/request-code', { email }).expect(200);
  await f.call('post', '/auth/request-code', { email }).expect(429);
  f.advance(10 * 60_000);
  await f.call('post', '/auth/verify', { email, code: f.code() }).expect(400);
  await f.call('post', '/auth/request-code', { email }).expect(200);
  const bad = f.code() === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) await f.call('post', '/auth/verify', { email, code: bad }).expect(400);
  await f.call('post', '/auth/verify', { email, code: f.code() }).expect(400);
  f.advance(61_000); await f.login();
  await f.call('post', '/auth/request-code', { email }).expect(429);
});
test('CSRF, cross-origin, malformed payloads and invalid dates are rejected', async t => {
  const f = fixture(t); await f.login();
  await f.client.post('/api/admin/applications').send(draft).expect(403);
  await f.client.post('/api/admin/applications').set('Origin','https://evil.example').send(draft).expect(403);
  await f.client.post('/api/admin/applications').set('Origin',origin).type('form').send(draft).expect(403);
  await f.client.post('/api/admin/applications').set('Origin',origin).set('Content-Type','application/json').send('{bad').expect(400);
  for (const value of [{ ...draft, appliedOn: '2026-02-30' },{ ...draft, appliedOn: '2027-01-01' },{ ...draft, company: ' ' },{ ...draft, status: 'invalid' },{ ...draft, role: 'r'.repeat(121) },{ ...draft, status: 'rejected', rejectedOn: '2026-08-31' },{ ...draft, status: 'rejected', rejectedOn: '2026-09-06' }]) await f.call('post','/admin/applications',value).expect(400);
});
test('mail failure never creates a usable code or claims success', async t => {
  const f = fixture(t, { sendCode: async () => { throw new Error('SMTP unavailable'); } });
  await f.call('post','/auth/request-code',{ email }).expect(503);
  assert.equal(f.db.prepare('SELECT expiresAt FROM challenges').get().expiresAt, 0);
  await f.call('post','/auth/verify',{ email, code:'000000' }).expect(400);
});
test('data and sessions survive application restart; session expiry enforced', async t => {
  const dir = mkdtempSync(join(tmpdir(),'unfortunately-test-')); t.after(() => rmSync(dir,{ recursive:true,force:true }));
  const path = join(dir,'data.sqlite');
  const f = fixture(t,{ databasePath:path }); await f.login(); await f.call('post','/admin/applications',draft).expect(201); f.db.close();
  const f2 = fixture(t,{ databasePath:path });
  assert.equal((await f2.client.get('/api/public/applications')).body.stats.total,1);
  assert.equal(f2.db.prepare('SELECT count(*) AS n FROM sessions').get().n,1);
  f2.advance(61_000); await f2.login(); f2.advance(31 * 24 * 60 * 60_000);
  await f2.client.get('/api/admin/applications').expect(401);
});
test('production cookie is secure, HttpOnly, strict and unavailable on public payloads', async t => {
  const f = fixture(t,{ production:true });
  await f.call('post','/auth/request-code',{ email }).expect(200);
  const res = await f.call('post','/auth/verify',{ email, code:f.code() }).expect(200);
  const cookie = res.headers['set-cookie'][0];
  for (const field of ['__Host-unfortunately=','HttpOnly','Secure','SameSite=Strict','Path=/']) assert.ok(cookie.includes(field));
  assert.ok(!cookie.includes('Domain='));
});
