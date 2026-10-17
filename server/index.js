import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createApp } from './app.js';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3210);
const { app, db } = createApp({
  databasePath: process.env.DATABASE_PATH || './data/unfortunately.sqlite',
  adminEmail: process.env.ADMIN_EMAIL,
  secret: process.env.SESSION_SECRET,
  mcpAdminKeyHash: process.env.MCP_ADMIN_KEY_HASH_FILE ? readFileSync(process.env.MCP_ADMIN_KEY_HASH_FILE, 'utf8').trim() : '',
  origin: process.env.APP_ORIGIN || `http://127.0.0.1:${port}`,
  // Shared dkz12345 sign-in: the instance's public key only, never the secret key.
  clerk: {
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
    jwtKey: process.env.CLERK_JWT_KEY_FILE ? readFileSync(process.env.CLERK_JWT_KEY_FILE, 'utf8') : process.env.CLERK_JWT_KEY?.replace(/\\n/g, '\n'),
    ownerUserId: process.env.OWNER_CLERK_USER_ID,
  },
  production, staticDir: resolve('dist'), revision: process.env.APP_REVISION || 'development',
});
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`unfortunately listening on ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
