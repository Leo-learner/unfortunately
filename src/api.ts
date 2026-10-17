import type { ClerkLike } from './vendor/clerk-boot.js';
export class ApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
// Requests carry the dkz12345 Clerk session token once clerk-js has loaded.
let clerk: ClerkLike | null = null;
export const setClerkSession = (instance: ClerkLike | null) => { clerk = instance; };
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res: Response;
  try {
    const token = clerk?.session ? await clerk.session.getToken().catch(() => null) : null;
    res = await fetch('/api' + path, { method, credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  catch { throw new Error('网络暂时连不上，请检查连接后重试。'); }
  const value = await res.json();
  if (!res.ok) throw new ApiError(value.error || '操作失败，请重试。', res.status, value.code);
  return value;
}
export const errorText = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重试。';
