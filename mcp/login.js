#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync } from 'node:fs';
import { createLogin } from './auth.js';
import { SITE, sessionPath, adminKeyPath } from './api.js';

const auth = createLogin();
if (process.argv.includes('--logout')) {
  try {
    if (existsSync(adminKeyPath())) {
      console.log('当前使用 AI 管理员密钥，不依赖邮箱会话。撤销密钥需删除或更换服务器上的密钥摘要并重启服务；邮箱退出不会撤销密钥。');
      process.exit(0);
    }
    if (existsSync(sessionPath())) await auth.logout();
    console.log('已退出本机 MCP 登录。');
  } catch { console.error('退出失败，登录文件仍保留。请检查网络后重试，以确保服务器会话也被撤销。'); process.exitCode = 1; }
} else {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`连接网站：${SITE}\n此登录在本机终端完成，不要将验证码或会话文件发给 AI。`);
    const choice = (await prompt.question('登录身份：1 站长，2 访客 [1]：')).trim() || '1';
    if (!['1', '2'].includes(choice)) throw new Error('请选择站长或访客。');
    const role = choice === '1' ? 'admin' : 'visitor';
    const email = (await prompt.question('邮箱：')).trim();
    await auth.requestCode(role, email);
    console.log('若邮箱符合登录条件，验证码将发到该邮箱，10 分钟内有效。');
    let completed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = (await prompt.question('输入邮件中的六位验证码：')).trim();
      try {
        const result = await auth.verify(role, email, code);
        console.log('登录成功，凭证已保存到本机私有文件。MCP 后续请求会自动使用，不需要重启客户端。');
        if (result.needsNickname) console.log('首次访客登录还需通过 MCP 设置公开昵称，之后即可留言。');
        completed = true; break;
      } catch (e) { if (e.status !== 400) throw e; console.log('验证码不正确或已过期，请核对后重试。'); }
    }
    if (!completed) throw new Error('本次验证次数已用完，请稍后重新运行登录程序。');
  } catch (e) { console.error(e.status || ['请选择站长或访客。', '本次验证次数已用完，请稍后重新运行登录程序。'].includes(e.message) ? e.message : '登录未完成，请检查网络与本机文件权限后重试。'); process.exitCode = 1; }
  finally { prompt.close(); }
}
