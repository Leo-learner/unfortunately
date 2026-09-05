export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res: Response;
  try { res = await fetch('/api' + path, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error('网络暂时连不上，请检查连接后重试。'); }
  const value = await res.json();
  if (!res.ok) throw new ApiError(value.error || '操作失败，请重试。', res.status);
  return value;
}
export const errorText = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重试。';

