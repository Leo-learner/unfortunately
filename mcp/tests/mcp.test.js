import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../../server/app.js';
import { clerkConfig, clerkToken } from '../../tests/clerk-fixture.js';
import { createMcp } from '../server.js';
import { createApi, readAdminKey, SITE } from '../api.js';

async function fixture(t) {
  let clock = Date.UTC(2026, 8, 5), useKey = true;
  const key = 'uf_ai_' + randomBytes(32).toString('hex');
  const directory = mkdtempSync(join(tmpdir(), 'unfortunately-mcp-test-'));
  const { app, db } = createApp({ adminEmail: 'owner@example.com', secret: 'mcp-test-secret-abcdefghijklmnopqrstuvwxyz', origin: SITE, clerk: clerkConfig, production: true, mcpAdminKeyHash: createHash('sha256').update(key).digest('hex'), now: () => clock });
  const http = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${http.address().port}`;
  const fetchImpl = (url, options) => fetch(origin + new URL(url).pathname + new URL(url).search, options);
  const keyFile = join(directory, 'admin-key.txt');
  writeFileSync(keyFile, key, { mode: 0o600 });
  const api = createApi({ fetchImpl, getAdminKey: () => useKey ? readAdminKey(keyFile) : null });
  const mcp = createMcp({ api });
  const client = new Client({ name: 'test-client', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await mcp.close(); await new Promise(resolve => http.close(resolve)); db.close(); rmSync(directory, { recursive: true, force: true }); });
  // Visitors use the website with their dkz12345 Clerk account, not this MCP.
  const asVisitor = (name, path, method = 'GET', body) => fetchImpl(`${SITE}/api${path}`, {
    method, headers: { Authorization: `Bearer ${clerkToken(SITE, { sub: `user_${name}`, email: `${name}@example.com` })}`, ...(body ? { Origin: SITE, 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async res => ({ status: res.status, body: await res.json() }));
  return {
    client, keyFile, key, db, asVisitor,
    tick: () => { clock += 61_000; },
    anonymous: () => { useKey = false; },
    admin: () => { useKey = true; },
    async call(name, args = {}) { return client.callTool({ name, arguments: args }); },
  };
}
const record = { company: '私密公司', role: '前端实习生', kind: 'internship', appliedOn: '2026-09-01', status: 'pending', notes: '私人备注' };
const data = result => { assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent; };

test('MCP reads the private administrator key automatically and completes real tools', async t => {
  const f = await fixture(t);
  assert.equal(data(await f.call('get_account_status')).administrator, true);
  const created = data(await f.call('create_application', record));
  assert.equal(data(await f.call('get_application', { id: created.id })).item.notes, record.notes);
  assert.ok(!JSON.stringify(await f.call('get_account_status')).includes(f.key));
  chmodSync(f.keyFile, 0o644);
  assert.equal((await f.call('get_account_status')).isError, true);
  chmodSync(f.keyFile, 0o600);
  writeFileSync(f.keyFile, 'uf_ai_' + randomBytes(32).toString('hex'));
  assert.equal((await f.call('export_applications')).structuredContent.status, 401);
  writeFileSync(f.keyFile, f.key);
  assert.equal(data(await f.call('get_account_status')).administrator, true);
});

test('public queries send no key and private key requests send no cookies and follow no redirects', async () => {
  const key = 'uf_ai_' + randomBytes(32).toString('hex');
  const seen = [];
  const api = createApi({ getAdminKey: () => key, fetchImpl: async (url, options) => { seen.push(options); return { ok: true, json: async () => ({ ok: true }) }; } });
  await api.request('/public/applications', 'GET', undefined, { authenticated: false });
  await api.request('/admin/applications');
  assert.equal(seen[0].headers.Authorization, undefined);
  assert.equal(seen[1].headers.Authorization, `Bearer ${key}`);
  assert.equal(seen[1].headers.Cookie, undefined);
  assert.equal(seen[1].redirect, 'error');
});

test('real MCP discovery and anonymous boundaries exclude private fields and auth secrets', async t => {
  const f = await fixture(t);
  const tools = (await f.client.listTools()).tools;
  assert.equal(tools.length, 13);
  assert.equal(tools.find(x => x.name === 'delete_comment').annotations.destructiveHint, true);
  assert.equal(tools.find(x => x.name === 'get_application_stats').annotations.readOnlyHint, true);
  assert.ok(!tools.some(x => /login|verify|token|code|nickname/.test(x.name)));
  data(await f.call('create_application', record));
  f.anonymous();
  assert.equal(data(await f.call('get_account_status')).administrator, false);
  assert.equal((await f.call('create_application', record)).structuredContent.status, 401);
  assert.equal((await f.call('export_applications')).isError, true);
  const publicRows = data(await f.call('list_applications'));
  assert.equal(publicRows.total, 1);
  assert.ok(!JSON.stringify(publicRows).includes('私密公司'));
  assert.ok(!JSON.stringify(publicRows).includes('私人备注'));
  assert.equal(data(await f.call('get_application_stats')).stats.total, 1);
});

test('administrator can create, filter, update, export and confirmed-delete with version conflicts enforced', async t => {
  const f = await fixture(t);
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

test('the owner replies to visitor comments, retries idempotently and moderates through MCP', async t => {
  const f = await fixture(t);
  assert.equal((await f.asVisitor('alice', '/comments/profile', 'PUT', { nickname: '小梨' })).status, 200);
  const root = (await f.asVisitor('alice', '/comments', 'POST', { body: '<script>test</script>\n普通文字', replyToId: null, clientKey: randomUUID() })).body;
  assert.equal(data(await f.call('get_account_status')).nickname, '站长');
  const requestId = randomUUID();
  const reply = data(await f.call('reply_to_comment', { replyToId: root.id, body: '加油', requestId }));
  assert.equal(data(await f.call('reply_to_comment', { replyToId: root.id, body: '加油', requestId })).id, reply.id);
  const listed = data(await f.call('list_replies', { rootId: root.id })).items[0];
  assert.equal(listed.id, reply.id); assert.equal(listed.isOwner, true); assert.equal(listed.replyToNickname, '小梨');
  f.tick();
  const own = data(await f.call('post_comment', { body: '站长留言', requestId: randomUUID() }));
  assert.equal((await f.asVisitor('alice', `/comments/${own.id}`, 'DELETE', {})).status, 403);
  data(await f.call('delete_comment', { id: root.id, confirm: true }));
  const visible = data(await f.call('list_comments')).items.find(item => item.id === root.id);
  assert.equal(visible.deleted, true); assert.equal(visible.body, null); assert.equal(visible.replies.items.length, 1);
  assert.ok(!JSON.stringify(visible).includes('alice@example.com'));
  f.tick();
  assert.equal((await f.call('reply_to_comment', { replyToId: root.id, body: '加油', requestId: randomUUID() })).structuredContent.status, 404);
  f.anonymous();
  assert.equal((await f.call('post_comment', { body: '测试', requestId: randomUUID() })).structuredContent.status, 401);
});

test('network failure produces a safe actionable MCP error', async () => {
  const failing = createApi({ getAdminKey: () => null, fetchImpl: async () => { throw new Error('secret should not escape'); } });
  await assert.rejects(failing.request('/comments'), e => e.status === 503 && !e.message.includes('secret'));
});

test('standalone stdio entrypoint negotiates with the official SDK without stdout noise', async () => {
  const client = new Client({ name: 'stdio-check', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('index.js')], stderr: 'pipe' });
  try { await client.connect(transport); assert.equal((await client.listTools()).tools.length, 13); }
  finally { await client.close(); }
});
