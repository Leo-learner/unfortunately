import { basename } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
if (!/^[a-f0-9]{40}$/.test(basename(process.cwd()))) throw new Error('Run from a verified release directory');
const digest = readFileSync(0, 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Expected a SHA-256 digest on stdin');
const root = '/opt/apps/unfortunately';
const file = `${root}/shared/runtime.env`;
const keyFile = `${root}/shared/mcp-admin-key.sha256`;
const original = readFileSync(file, 'utf8');
const backup = `${root}/backups/mcp-key-${Date.now()}`;
mkdirSync(backup, { mode: 0o700 });
writeFileSync(`${backup}/runtime-before.env`, original, { mode: 0o600, flag: 'wx' });
try { writeFileSync(`${backup}/key-hash-before.txt`, readFileSync(keyFile), { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const line = `MCP_ADMIN_KEY_HASH_FILE=${keyFile}`;
const updated = /^MCP_ADMIN_KEY_HASH_FILE=.*$/m.test(original) ? original.replace(/^MCP_ADMIN_KEY_HASH_FILE=.*$/m, line) : `${original.trimEnd()}\n${line}\n`;
for (const [path, contents] of [[keyFile, `${digest}\n`], [file, updated]]) {
  const temporary = `${path}.next-${process.pid}`;
  writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
console.log('MCP administrator key digest configured; restart service to apply.');
