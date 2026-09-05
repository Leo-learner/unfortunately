import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../../server/app.js';
import { createMcp } from '../server.js';
import { createApi, readSession, SITE } from '../api.js';
import { createLogin } from '../auth.js';

async function fixture(t) {
  let clock = Date.UTC(2026, 8, 5), code, active = null;
  const directory = mkdtempSync(join(tmpdir(), 'unfortunately-mcp-test-'));
  const file = join(directory, 'session.json');
  const { app, db } = createApp({ adminEmail: 'owner@example.com', secret: 'mcp-test-secret-abcdefghijklmnopqrstuvwxyz', origin: SITE, production: true, now: () => clock, sendCode: async (_, value) => { code = value; } });
  const http = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${http.address().port}`;
  const fetchImpl = (url, options) => fetch(origin + new URL(url).pathname + new URL(url).search, options);
  const api = createApi({ fetchImpl, getSession: () => active });
  const mcp = createMcp({ api });
  const client = new Client({ name: 'test-client', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await mcp.close(); await new Promise(resolve => http.close(resolve)); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const login = createLogin({ file, fetchImpl });
  return {
    client, file, db, api, fetchImpl,
    tick: () => { clock += 61_000; },
    anonymous: () => { active = null; },
    use: value => { active = value; },
    async login(role, email) { clock += 61_000; await login.requestCode(role, email); await login.verify(role, email, code); active = readSession(file); return active; },
    async call(name, args = {}) { return client.callTool({ name, arguments: args }); },
  };
}
const record = { company: '私密公司', role: '前端实习生', kind: 'internship', appliedOn: '2026-09-01', status: 'pending', notes: '私人备注' };
const data = result => { assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent; };

test('real MCP discovery and anonymous boundaries exclude private fields and auth secrets', async t => {
  const f = await fixture(t);
  const tools = (await f.client.listTools()).tools;
  assert.equal(tools.length, 14);
  assert.equal(tools.find(x => x.name === 'delete_comment').annotations.destructiveHint, true);
  assert.equal(tools.find(x => x.name === 'get_application_stats').annotations.readOnlyHint, true);
  assert.ok(!tools.some(x => /login|verify|token|code/.test(x.name)));
  assert.equal(data(await f.call('get_account_status')).administrator, false);
  assert.equal((await f.call('create_application', record)).isError, true);
  assert.equal((await f.call('export_applications')).isError, true);
  await f.login('admin', 'owner@example.com');
  data(await f.call('create_application', record)); f.anonymous();
  const publicRows = data(await f.call('list_applications'));
  assert.equal(publicRows.total, 1);
  assert.ok(!JSON.stringify(publicRows).includes('私密公司'));
  assert.ok(!JSON.stringify(publicRows).includes('私人备注'));
  assert.equal(data(await f.call('get_application_stats')).stats.total, 1);
});

test('administrator can create, filter, update, export and confirmed-delete with version conflicts enforced', async t => {
  const f = await fixture(t); await f.login('admin', 'owner@example.com');
  const created = data(await f.call('create_application', record));
  assert.equal(data(await f.call('get_application', { id: created.id })).item.notes, '私人备注');
  assert.equal(data(await f.call('list_applications', { privateFields: true, query: '私密', kind: 'internship', pageSize: 1 })).items.length, 1);
  assert.equal(data(await f.call('list_applications', { query: '不存在' })).total, 0);
  const updated = data(await f.call('update_application', { ...record, id: created.id, version: 1, status: 'rejected' }));
  assert.equal(updated.version, 2);
  assert.equal(data(await f.call('get_application_stats')).stats.rejected, 1);
  assert.equal((await f.call('update_application', { ...record, id: created.id, version: 1 })).structuredContent.status, 409);
  assert.equal(data(await f.call('export_applications')).applications[0].company, '私密公司');
  assert.equal((await f.call('delete_application', { id: created.id, version: 2, confirm: false })).isError, true);
  assert.equal((await f.call('delete_application', { id: created.id, version: 1, confirm: true })).structuredContent.status, 409);
  data(await f.call('delete_application', { id: created.id, version: 2, confirm: true }));
  assert.equal(data(await f.call('get_application_stats')).stats.total, 0);
});

test('visitor comments, replies, retry idempotency, deletion placeholders and administrator moderation', async t => {
  const f = await fixture(t); const alice = await f.login('visitor', 'alice@example.com');
  data(await f.call('set_comment_nickname', { nickname: '小梨' }));
  const body = '<script>test</script>\n普通文字'; const requestId = randomUUID();
  const root = data(await f.call('post_comment', { body, requestId }));
  assert.equal(data(await f.call('post_comment', { body, requestId })).id, root.id);
  assert.equal((await f.call('post_comment', { body: '另一条', requestId: randomUUID() })).structuredContent.status, 429);
  const bob = await f.login('visitor', 'bob@example.com');
  data(await f.call('set_comment_nickname', { nickname: '小柏' }));
  const reply = data(await f.call('reply_to_comment', { replyToId: root.id, body: '加油', requestId: randomUUID() }));
  assert.equal(data(await f.call('list_replies', { rootId: root.id })).items[0].id, reply.id);
  assert.equal((await f.call('delete_comment', { id: root.id, confirm: true })).structuredContent.status, 403);
  assert.equal((await f.call('create_application', record)).structuredContent.status, 401);
  f.use(alice); data(await f.call('delete_comment', { id: root.id, confirm: true }));
  const visible = data(await f.call('list_comments')).items[0];
  assert.equal(visible.deleted, true); assert.equal(visible.body, null); assert.equal(visible.replies.items.length, 1);
  assert.ok(!JSON.stringify(visible).includes('alice@example.com'));
  f.use(bob); f.tick();
  assert.equal((await f.call('reply_to_comment', { replyToId: root.id, body: '加油', requestId: randomUUID() })).structuredContent.status, 404);
  await f.login('admin', 'owner@example.com'); data(await f.call('delete_comment', { id: reply.id, confirm: true }));
  assert.equal(data(await f.call('list_comments')).totalThreads, 0);
});

test('local authentication saves only a private origin-bound session and logout invalidates it', async t => {
  const f = await fixture(t); const saved = await f.login('admin', 'owner@example.com');
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(f.file, 'utf8').includes('owner@example.com'));
  assert.deepEqual(Object.keys(saved).sort(), ['cookie', 'origin', 'role']);
  chmodSync(f.file, 0o644); assert.throws(() => readSession(f.file)); chmodSync(f.file, 0o600);
  await createLogin({ file: f.file, fetchImpl: f.fetchImpl }).logout();
  assert.equal(readSession(f.file), null);
  assert.equal(data(await f.call('get_account_status')).administrator, false);
  assert.equal((await f.call('export_applications')).structuredContent.status, 401);
});

test('expired sessions and network failure produce safe actionable MCP errors', async t => {
  const f = await fixture(t); await f.login('visitor', 'owner@example.com');
  assert.equal(data(await f.call('get_account_status')).administrator, false);
  assert.equal((await f.call('create_application', record)).structuredContent.status, 401);
  f.db.prepare('UPDATE visitor_sessions SET expiresAt=0').run();
  assert.equal((await f.call('post_comment', { body: '测试', requestId: randomUUID() })).structuredContent.status, 401);
  const failing = createApi({ getSession: () => null, fetchImpl: async () => { throw new Error('secret should not escape'); } });
  await assert.rejects(failing.request('/comments'), e => e.status === 503 && !e.message.includes('secret'));
});

test('standalone stdio entrypoint negotiates with the official SDK without stdout noise', async () => {
  const client = new Client({ name: 'stdio-check', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('index.js')], stderr: 'pipe' });
  try { await client.connect(transport); assert.equal((await client.listTools()).tools.length, 14); }
  finally { await client.close(); }
});
