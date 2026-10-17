// Clerk session tokens for tests, signed with a throwaway key (no network).
import { createTestSigner, TEST_PUBLISHABLE_KEY } from '../server/clerk-gate/test-signer.js';

const signer = createTestSigner();
export const OWNER = 'user_owner';
export const clerkConfig = { publishableKey: TEST_PUBLISHABLE_KEY, jwtKey: signer.jwtKey, ownerUserId: OWNER };

// A fresh two-factor session minted for `origin`; claims override the defaults.
export const clerkToken = (origin, claims = {}) => signer.token({
  sub: OWNER, azp: origin, fva: [0, 0], email: 'owner-clerk@example.com',
  exp: Math.floor(Date.now() / 1000) + 600, ...claims,
});
