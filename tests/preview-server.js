// Local browser QA only. This file is never run by the production service.
// Uses a temporary database and throwaway Clerk test keys; no production credentials.
import { createApp } from '../server/app.js';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { clerkConfig } from './clerk-fixture.js';
const { app, db } = createApp({ adminEmail:'qa@example.com', secret:'local-qa-only-abcdefghijklmnopqrstuvwxyz', origin:'http://127.0.0.1:3211', clerk: clerkConfig, staticDir:resolve('dist') });
if (process.env.QA_SEED === '1') {
  const roles = ['产品设计实习生','前端开发实习生','咖啡店店员','运营实习生','平面设计师'];
  const counts = ['rejected','pending','interview','rejected','accepted',...Array(10).fill('rejected'),...Array(8).fill('pending'),...Array(4).fill('interview'),'accepted'];
  counts.forEach((status,i) => db.prepare('INSERT INTO applications VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),'QA 私密公司 '+i,roles[i % 5],i===2?'parttime':i===4?'fulltime':'internship',`2026-${i<5?'09':'08'}-${String(i<5?3-i:29-(i-5)).padStart(2,'0')}`.replace('09-00','08-31').replace('09--1','08-30'),status,status==='rejected'?'2026-09-05':null,'QA 私人备注',1,'2026-09-05T00:00:00Z','2026-09-05T00:00:00Z'));
}
app.listen(3211,'127.0.0.1',()=>console.log('Local QA preview on 3211'));
