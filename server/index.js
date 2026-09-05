import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { createApp } from './app.js';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3210);
const smtpPass = process.env.SMTP_PASS_FILE && existsSync(process.env.SMTP_PASS_FILE)
  ? readFileSync(process.env.SMTP_PASS_FILE, 'utf8').trim() : process.env.SMTP_PASS;
const mailer = smtpPass ? nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.qq.com', port: Number(process.env.SMTP_PORT || 465),
  secure: Number(process.env.SMTP_PORT || 465) === 465, requireTLS: true,
  auth: { user: process.env.SMTP_USER, pass: smtpPass },
  connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
}) : null;
const { app, db } = createApp({
  databasePath: process.env.DATABASE_PATH || './data/unfortunately.sqlite',
  adminEmail: process.env.ADMIN_EMAIL,
  secret: process.env.SESSION_SECRET,
  origin: process.env.APP_ORIGIN || `http://127.0.0.1:${port}`,
  visitorDailyLimit: Number(process.env.VISITOR_MAIL_DAILY_LIMIT || 200),
  production, staticDir: resolve('dist'), revision: process.env.APP_REVISION || 'development',
  sendCode: async (email, code) => {
    if (!mailer) throw new Error('Mail is not configured');
    await mailer.sendMail({ from: { name: 'unfortunately. 登录验证', address: process.env.MAIL_FROM || process.env.SMTP_USER }, to: email,
      subject: '你的 unfortunately. 登录验证码',
      text: `你的登录验证码是：${code}\n\n10 分钟内有效，仅可使用一次。请勿转发。\n如果不是你本人操作，请忽略此邮件。`,
    });
  },
});
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`unfortunately listening on ${port}; email ${mailer ? 'configured' : 'not configured'}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
