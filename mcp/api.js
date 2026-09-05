import { homedir } from 'node:os';
import { join } from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';

export const SITE = 'https://unfortunately.dkz12345.com';
export const sessionPath = () => process.env.UNFORTUNATELY_SESSION_FILE || join(homedir(), '.config', 'unfortunately-mcp', 'session.json');
export class WebsiteError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function readSession(file = sessionPath()) {
  let stat;
  try { stat = lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error('无法读取本机登录文件，请重新运行登录程序。'); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('本机登录文件权限不安全，请重新运行登录程序。');
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.origin !== SITE || !['admin', 'visitor'].includes(value.role) || !/^(?:__Host-unfortunately|__Host-unfortunately-visitor)=[a-f0-9]{64}$/.test(value.cookie)) throw new Error();
    return value;
  } catch { throw new Error('本机登录文件无效，请重新运行登录程序。'); }
}
export function createApi({ origin = SITE, getSession = readSession, fetchImpl = fetch } = {}) {
  const request = async (path, method = 'GET', body, { authenticated = true } = {}) => {
    const session = authenticated ? getSession() : null;
    let response;
    try {
      response = await fetchImpl(`${origin}/api${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json', ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...(session ? { Cookie: session.cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new WebsiteError(503, '网站连接失败或请求超时。修改结果可能尚未返回，请先查询确认；发表留言重试时使用相同 requestId。'); }
    let data;
    try { data = await response.json(); } catch { throw new WebsiteError(502, '网站返回了无效响应，请稍后重试。'); }
    if (!response.ok) throw new WebsiteError(response.status, response.status === 401 ? '尚未登录或登录已过期。请在本机运行 MCP 登录程序后重试。' : data.error || '网站操作失败。');
    return data;
  };
  return { request };
}
