import { homedir } from 'node:os';
import { join } from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';

export const SITE = 'https://unfortunately.dkz12345.com';
export const adminKeyPath = () => process.env.UNFORTUNATELY_ADMIN_KEY_FILE || join(homedir(), '.config', 'unfortunately-mcp', 'admin-key.txt');
export class WebsiteError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function readAdminKey(file = adminKeyPath()) {
  let stat;
  try { stat = lstatSync(file); } catch (e) { if (e.code === 'ENOENT' && !process.env.UNFORTUNATELY_ADMIN_KEY_FILE) return null; throw new Error('无法读取本机 AI 管理员密钥文件。'); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('AI 管理员密钥文件必须仅当前用户可读写。');
  const key = readFileSync(file, 'utf8').trim();
  if (!/^uf_ai_[a-f0-9]{64}$/.test(key)) throw new Error('AI 管理员密钥格式无效。');
  return key;
}
// The website signs people in with the shared dkz12345 Clerk account; this
// local client acts only as the owner, through the private AI administrator key.
export function createApi({ origin = SITE, getAdminKey = readAdminKey, fetchImpl = fetch } = {}) {
  const request = async (path, method = 'GET', body, { authenticated = true } = {}) => {
    const adminKey = authenticated ? getAdminKey() : null;
    let response;
    try {
      response = await fetchImpl(`${origin}/api${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json', ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...(adminKey ? { Authorization: `Bearer ${adminKey}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new WebsiteError(503, '网站连接失败或请求超时。修改结果可能尚未返回，请先查询确认；发表留言重试时使用相同 requestId。'); }
    let data;
    try { data = await response.json(); } catch { throw new WebsiteError(502, '网站返回了无效响应，请稍后重试。'); }
    if (!response.ok) throw new WebsiteError(response.status, response.status === 401 ? adminKey ? 'AI 管理员密钥未被网站接受，请检查服务器配置或密钥是否已更换。' : '尚未配置 AI 管理员密钥，只能读取公开数据。' : data.error || '网站操作失败。');
    return data;
  };
  return { request };
}
