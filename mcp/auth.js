import { mkdirSync, writeFileSync, renameSync, chmodSync, unlinkSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SITE, readSession, sessionPath, WebsiteError } from './api.js';

export function saveSession(session, file = sessionPath()) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('登录目录不能是符号链接。');
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(session), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}
export function createLogin({ origin = SITE, file = sessionPath(), fetchImpl = fetch } = {}) {
  async function post(path, body, cookie) {
    const res = await fetchImpl(`${origin}/api${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new WebsiteError(res.status, data.error || '登录失败，请稍后重试。');
    return { res, data };
  }
  const prefix = role => role === 'admin' ? '/auth' : '/comments/auth';
  return {
    requestCode: (role, email) => post(`${prefix(role)}/request-code`, { email }),
    async verify(role, email, code) {
      const { res, data } = await post(`${prefix(role)}/verify`, { email, code });
      const cookieName = origin.startsWith('https:') ? role === 'admin' ? '__Host-unfortunately' : '__Host-unfortunately-visitor' : role === 'admin' ? 'unfortunately-session' : 'unfortunately-visitor';
      const cookie = res.headers.getSetCookie().map(s => s.split(';')[0]).find(s => s.startsWith(cookieName + '='));
      if (!cookie || !/=[a-f0-9]{64}$/.test(cookie)) throw new Error('未收到有效登录凭证。');
      saveSession({ origin, role, cookie }, file);
      return { needsNickname: !!data.profile?.needsNickname };
    },
    async logout() {
      const session = readSession(file);
      if (session) await post(`${prefix(session.role)}/logout`, {}, session.cookie);
      unlinkSync(file);
    },
  };
}
