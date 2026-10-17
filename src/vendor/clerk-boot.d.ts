// Types for clerk-boot.js (the subset of clerk-js these helpers expose).
export interface ClerkSessionLike {
  getToken(options?: { skipCache?: boolean }): Promise<string | null>;
}
export interface ClerkLike {
  user: { id: string; twoFactorEnabled?: boolean } | null | undefined;
  session: ClerkSessionLike | null | undefined;
  load(): Promise<void>;
  addListener(listener: (resources: { user?: { id: string } | null }) => void): () => void;
  redirectToSignIn(options?: Record<string, unknown>): Promise<unknown>;
  signOut(options?: { redirectUrl?: string }): Promise<void>;
}
export const ACCOUNTS_URL: string;
export const HOME_URL: string;
export function loadClerk(timeoutMs?: number): Promise<ClerkLike>;
export function currentUser(): Promise<ClerkLike["user"] | null>;
export function requireSignIn(returnTo?: string): Promise<ClerkLike>;
export function getToken(): Promise<string | null>;
export function signOut(redirectUrl?: string): Promise<void>;
export function accountPageUrl(): string;
export function refreshAndReload(returnTo?: string): Promise<never>;
export function clearReloadGuard(): void;
