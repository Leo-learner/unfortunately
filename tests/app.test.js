import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { createHash, randomBytes } from 'node:crypto';
import { clerkConfig, clerkToken } from './clerk-fixture.js';

const origin = 'http://127.0.0.1:3210';
const email = 'owner@example.com';
const secret = 'test-only-secret-abcdefghijklmnopqrstuvwxyz';
const draft = { company: 'PRIVATE_COMPANY', role: '产品设计实习生', kind: 'internship', appliedOn: '2026-09-01', status: 'pending', notes: 'PRIVATE_NOTES' };
const bearer = token => ({ Authorization: `Bearer ${token}` });
test('dedicated administrator key works without Clerk, never leaks, and cannot be used as a cookie', async t => {
  const key = 'uf_ai_' + randomBytes(32).toString('hex');
  const digest = createHash('sha256').update(key).digest('hex');
  const f = fixture(t, { mcpAdminKeyHash: digest });
  const auth = req => req.set('Authorization', `Bearer ${key}`);
  assert.deepEqual((await auth(request(f.app).get('/api/session'))).body, { authenticated: true, access: 'owner' });
  const created = await auth(request(f.app).post('/api/admin/applications')).set('Origin', origin).send(draft).expect(201);
  const commentSession = await auth(request(f.app).get('/api/comments/session')).expect(200);
  assert.equal(commentSession.body.isAdmin, true);
  assert.equal(commentSession.body.profile.isOwner, true);
  for (const path of ['/api/health', '/api/session', '/api/comments/session', '/api/public/applications']) {
    const res = await auth(request(f.app).get(path));
    assert.ok(!res.text.includes(key)); assert.ok(!res.text.includes(digest));
    assert.equal(res.headers['set-cookie'], undefined);
  }
  await request(f.app).get('/api/admin/applications').set('Cookie', `unfortunately-session=${key}`).expect(401);
  await request(f.app).get('/api/admin/applications').set('Authorization', `Bearer ${digest}`).expect(401);
  await auth(request(f.app).post('/api/admin/applications')).set('Origin', 'https://other.example').send(draft).expect(403);
  await auth(request(f.app).delete(`/api/admin/applications/${created.body.id}`)).set('Origin', origin).send({ version: 1 }).expect(200);
});
test('disabled or rotated keys fail closed while the owner Clerk session keeps working', async t => {
  const key = 'uf_ai_' + randomBytes(32).toString('hex');
  for (const mcpAdminKeyHash of ['', createHash('sha256').update('different-key').digest('hex')]) {
    const f = fixture(t, { mcpAdminKeyHash });
    await request(f.app).get('/api/admin/applications').set('Authorization', `Bearer ${key}`).expect(401);
    await request(f.app).get('/api/admin/applications').set(bearer(f.owner)).expect(200);
    await request(f.app).get('/api/admin/applications').set('Authorization', 'Bearer invalid').expect(401);
  }
  assert.throws(() => createApp({ adminEmail: email, secret, origin, clerk: clerkConfig, mcpAdminKeyHash: 'broken' }), /MCP administrator key/);
});
function fixture(t, opts = {}) {
  let time = Date.parse('2026-09-05T03:00:00Z');
  const { app, db } = createApp({ adminEmail: email, secret, origin, clerk: clerkConfig, now: () => time, ...opts });
  t.after(() => { if (db.open) db.close(); });
  const client = request.agent(app);
  const owner = clerkToken(origin);
  const call = (method, path, body) => client[method]('/api' + path).set('Origin', origin).set(bearer(owner)).send(body);
  return { app, db, client, call, owner, advance: n => { time += n; } };
}

test('public responses exclude company, notes, owner email, version and session details', async t => {
  const f = fixture(t);
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
  const f = fixture(t);
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
test('only a fresh two-factor owner session administers; others get signed-out, NOT_OWNER or REAUTH_REQUIRED', async t => {
  const f = fixture(t);
  const access = async headers => (await request(f.app).get('/api/session').set(headers)).body;
  assert.deepEqual(await access({}), { authenticated: false, access: 'signed-out' });
  assert.deepEqual(await access(bearer(f.owner)), { authenticated: true, access: 'owner' });
  const stranger = clerkToken(origin, { sub: 'user_stranger', email: 'stranger@example.com' });
  assert.deepEqual(await access(bearer(stranger)), { authenticated: false, access: 'not-owner' });
  const forbidden = await request(f.app).get('/api/admin/applications').set(bearer(stranger)).expect(403);
  assert.equal(forbidden.body.code, 'NOT_OWNER');
  // Older than 12 hours, or never through a second factor (fva[1] = -1).
  for (const fva of [[721, 721], [0, 721], [0, -1]]) {
    const stale = clerkToken(origin, { fva });
    assert.deepEqual(await access(bearer(stale)), { authenticated: false, access: 'reauth-required' });
    const res = await request(f.app).post('/api/admin/applications').set('Origin', origin).set(bearer(stale)).send(draft).expect(403);
    assert.equal(res.body.code, 'REAUTH_REQUIRED');
  }
  assert.equal((await access(bearer(clerkToken(origin, { fva: [719, 719] })))).access, 'owner');
});
test('Clerk tokens count only as a valid Bearer for this origin; cookies and forgeries are signed out', async t => {
  const f = fixture(t);
  const cases = [
    { Cookie: `__session=${f.owner}` },
    bearer(f.owner.slice(0, -6) + 'AAAAAA'),
    bearer(clerkToken('https://games.dkz12345.com')),
    bearer(clerkToken(origin, { exp: Math.floor(Date.now() / 1000) - 120 })),
    bearer(clerkToken(origin, { iss: 'https://clerk.example.com' })),
  ];
  for (const headers of cases) {
    assert.equal((await request(f.app).get('/api/session').set(headers)).body.access, 'signed-out');
    await request(f.app).get('/api/admin/applications').set(headers).expect(401);
  }
  // The old email-code login and logout endpoints are gone.
  for (const path of ['/auth/request-code', '/auth/verify', '/auth/logout', '/comments/auth/request-code', '/comments/auth/verify', '/comments/auth/logout']) {
    await request(f.app).post('/api' + path).set('Origin', origin).send({ email }).expect(404);
  }
  assert.throws(() => createApp({ adminEmail: email, secret, origin }), /Clerk sign-in configuration/);
  assert.throws(() => createApp({ adminEmail: email, secret, origin, clerk: { ...clerkConfig, ownerUserId: 'owner' } }), /Clerk sign-in configuration/);
});
test('CSRF, cross-origin, malformed payloads and invalid dates are rejected', async t => {
  const f = fixture(t);
  await f.client.post('/api/admin/applications').set(bearer(f.owner)).send(draft).expect(403);
  await f.client.post('/api/admin/applications').set(bearer(f.owner)).set('Origin','https://evil.example').send(draft).expect(403);
  await f.client.post('/api/admin/applications').set(bearer(f.owner)).set('Origin',origin).type('form').send(draft).expect(403);
  await f.client.post('/api/admin/applications').set(bearer(f.owner)).set('Origin',origin).set('Content-Type','application/json').send('{bad').expect(400);
  for (const value of [{ ...draft, appliedOn: '2026-02-30' },{ ...draft, appliedOn: '2027-01-01' },{ ...draft, company: ' ' },{ ...draft, status: 'invalid' },{ ...draft, role: 'r'.repeat(121) },{ ...draft, status: 'rejected', rejectedOn: '2026-08-31' },{ ...draft, status: 'rejected', rejectedOn: '2026-09-06' }]) await f.call('post','/admin/applications',value).expect(400);
});
test('data survives application restart', async t => {
  const dir = mkdtempSync(join(tmpdir(),'unfortunately-test-')); t.after(() => rmSync(dir,{ recursive:true,force:true }));
  const path = join(dir,'data.sqlite');
  const f = fixture(t,{ databasePath:path }); await f.call('post','/admin/applications',draft).expect(201); f.db.close();
  const f2 = fixture(t,{ databasePath:path });
  assert.equal((await f2.client.get('/api/public/applications')).body.stats.total,1);
  assert.equal((await f2.call('get','/admin/applications').expect(200)).body.applications[0].company,'PRIVATE_COMPANY');
});
test('CSP allows the Clerk script, API and Protect, and nothing else new', async t => {
  const f = fixture(t, { production: true });
  const csp = (await request(f.app).get('/api/health')).headers['content-security-policy'];
  assert.match(csp, /script-src 'self' https:\/\/clerk\.dkz12345\.com https:\/\/\*\.protect\.clerk\.com;/);
  assert.match(csp, /connect-src 'self' https:\/\/clerk\.dkz12345\.com https:\/\/\*\.protect\.clerk\.com:\*;/);
  assert.match(csp, /frame-src https:\/\/\*\.protect\.clerk\.com;/);
  assert.match(csp, /worker-src 'self' blob:(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
});
