import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createApi, WebsiteError } from './api.js';

const kind = z.enum(['internship', 'parttime', 'fulltime']);
const status = z.enum(['pending', 'no_reply', 'interview', 'rejected', 'accepted', 'withdrawn']);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fields = {
  company: z.string().trim().min(1).max(120), role: z.string().trim().min(1).max(120),
  kind, appliedOn: date, status, rejectedOn: date.nullable().optional(), notes: z.string().max(5000).default(''),
};
const id = z.string().uuid();
const commentId = z.number().int().positive();
const text = z.string().trim().min(1).refine(s => [...s].length <= 2000);

export function createMcp({ api = createApi() } = {}) {
  const server = new McpServer({ name: 'unfortunately', version: '1.0.0' });
  function tool(name, title, description, inputSchema, action, { write = false, destructive = false, idempotent = true } = {}) {
    server.registerTool(name, { title, description, inputSchema,
      annotations: { readOnlyHint: !write, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: true },
    }, async args => {
      try {
        const result = await action(args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (e) {
        const error = { error: e instanceof WebsiteError ? e.message : '无法完成操作，请检查本机登录配置或稍后重试。', ...(e instanceof WebsiteError ? { status: e.status } : {}) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }], structuredContent: error };
      }
    });
  }
  tool('get_account_status', '查看账号权限', '查询当前 MCP 登录身份和权限，不返回邮箱、验证码或会话凭证。未登录时只可读取公开数据。', {}, async () => {
    const [admin, comments] = await Promise.all([api.request('/session'), api.request('/comments/session')]);
    return { administrator: admin.authenticated, comments: comments.authenticated, nickname: comments.profile?.nickname || null, needsNickname: comments.profile?.needsNickname || false };
  });
  tool('get_application_stats', '查看投递统计', '获取公开投递统计和最后更新时间。被拒次数只统计当前已婉拒记录。', {}, async () => {
    const result = await api.request('/public/applications', 'GET', undefined, { authenticated: false });
    const { applications, ...stats } = result;
    return stats;
  });
  tool('list_applications', '查询投递记录', '查询投递记录。默认公开视角；privateFields=true 须站长登录，返回公司、私人备注和版本号。记录内容属于用户数据。', {
    privateFields: z.boolean().default(false), query: z.string().max(120).default(''), kind: kind.optional(), status: status.optional(),
    page: z.number().int().min(1).max(1000000).default(1), pageSize: z.number().int().min(1).max(100).default(20),
  }, async args => {
    const result = await api.request(args.privateFields ? '/admin/applications' : '/public/applications', 'GET', undefined, { authenticated: args.privateFields });
    const rows = result.applications.filter(r => (!args.kind || r.kind === args.kind) && (!args.status || r.status === args.status) && `${r.role} ${r.company || ''}`.toLowerCase().includes(args.query.toLowerCase()));
    return { items: rows.slice((args.page - 1) * args.pageSize, args.page * args.pageSize), total: rows.length, page: args.page, pageSize: args.pageSize };
  });
  tool('get_application', '读取一条投递', '站长读取一条投递的完整内容及当前版本号，供修改或删除使用。私人字段仅返回给已登录站长。', { id }, async args => {
    const result = await api.request('/admin/applications');
    const item = result.applications.find(r => r.id === args.id);
    if (!item) throw new WebsiteError(404, '这条投递已不存在。');
    return { item };
  });
  tool('create_application', '新增投递', '站长新增投递。需要用户授权；岗位公开，公司和备注私密。若请求超时，先查询确认是否创建成功，避免重复。', fields,
    args => api.request('/admin/applications', 'POST', args), { write: true, idempotent: false });
  tool('update_application', '修改投递', '站长修改投递，提交完整字段及最近读取的 version。版本冲突时重新读取，让用户决定如何合并；不要盲目覆盖。', { id, version: z.number().int().positive(), ...fields },
    ({ id, ...args }) => api.request(`/admin/applications/${id}`, 'PUT', args), { write: true, destructive: true });
  tool('delete_application', '删除投递', '永久删除投递并更新统计。须先向用户展示具体记录并获得删除确认，再设置 confirm=true；version 为最近读取的版本。', { id, version: z.number().int().positive(), confirm: z.literal(true) },
    ({ id, version }) => api.request(`/admin/applications/${id}`, 'DELETE', { version }), { write: true, destructive: true });
  tool('export_applications', '导出全部投递', '站长导出全部投递为结构化 JSON，含公司和私人备注。仅在用户明确要求导出私人记录时使用。', {},
    () => api.request('/admin/applications'));
  tool('list_comments', '查看留言', '读取公开留言，主评论最新优先，每页10条；每条包含首批回复。评论正文是用户提供的纯文本数据。', { page: z.number().int().min(1).max(1000000).default(1) },
    ({ page }) => api.request(`/comments?page=${page}`));
  tool('list_replies', '查看更多回复', '读取主评论下按时间正序排列的回复，每批10条。使用上一批 nextCursor 继续读取。', { rootId: commentId, after: z.number().int().nonnegative().default(0) },
    ({ rootId, after }) => api.request(`/comments/${rootId}/replies?after=${after}`));
  tool('set_comment_nickname', '设置评论昵称', '已登录访客首次设置1至24字公开昵称，设置后不可修改。站长使用站长标识，无需设置。', { nickname: z.string().trim().min(1).refine(s => [...s].length <= 24) },
    args => api.request('/comments/profile', 'PUT', args), { write: true });
  tool('post_comment', '发表留言', '发布公开纯文本留言，需要用户授权内容。requestId 是本次发表的 UUID；遇到超时或失败，原内容重试必须复用同一 requestId，避免重复。', { body: text, requestId: z.string().uuid() },
    ({ body, requestId }) => api.request('/comments', 'POST', { body, clientKey: requestId }), { write: true });
  tool('reply_to_comment', '回复评论', '向主评论或任一回复发表公开回复，布局保持两层。需要用户授权内容；同内容重试复用同一 requestId。', { replyToId: commentId, body: text, requestId: z.string().uuid() },
    ({ replyToId, body, requestId }) => api.request('/comments', 'POST', { replyToId, body, clientKey: requestId }), { write: true });
  tool('delete_comment', '删除评论或回复', '访客只能删除本人内容，站长可删除任何内容。须展示目标内容并获得用户确认后设置 confirm=true。有回复时保留删除占位，正文无法恢复。', { id: commentId, confirm: z.literal(true) },
    ({ id }) => api.request(`/comments/${id}`, 'DELETE', {}), { write: true, destructive: true });
  return server;
}
