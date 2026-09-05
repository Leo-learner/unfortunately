import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Mail, MessageCircle, Reply, Trash2 } from 'lucide-react';
import { api, ApiError, errorText } from './api';
import { Modal } from './Modal';
import './comments.css';

type Profile = { nickname: string | null; needsNickname: boolean; isOwner: boolean };
type Session = { authenticated: boolean; profile: Profile | null; isAdmin: boolean };
type Comment = { id: number; rootId: number | null; replyToId: number | null; nickname: string | null;
  body: string | null; createdAt: number; deleted: boolean; isOwner: boolean; canDelete: boolean; replyToNickname: string | null };
type Replies = { items: Comment[]; nextCursor: number | null };
type Thread = Comment & { replies: Replies; replyCount: number };
type CommentPage = { items: Thread[]; totalThreads: number; totalComments: number; page: number; pageSize: number };
const anonymous: Session = { authenticated: false, profile: null, isAdmin: false };
const formatDate = (n: number) => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(n));
const lengthOf = (s: string) => [...s.trim()].length;

function CommentLogin({ session, onClose, onSuccess }: { session: Session; onClose: () => void; onSuccess: () => void }) {
  const [step, setStep] = useState<'email' | 'code' | 'nickname'>(session.profile?.needsNickname ? 'nickname' : 'email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => { if (cooldown <= 0) return; const t = setTimeout(() => setCooldown(cooldown - 1), 1000); return () => clearTimeout(t); }, [cooldown]);
  async function send() {
    setBusy(true); setError('');
    try { await api('/comments/auth/request-code', 'POST', { email }); setStep('code'); setCooldown(60); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (step === 'email') return send();
    setBusy(true); setError('');
    try {
      if (step === 'code') {
        const result = await api<Session>('/comments/auth/verify', 'POST', { email, code });
        if (result.profile?.needsNickname) setStep('nickname'); else onSuccess();
      } else {
        await api('/comments/profile', 'PUT', { nickname }); onSuccess();
      }
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.status === 401) setStep('email');
    } finally { setBusy(false); }
  }
  return <Modal title={step === 'nickname' ? '怎么称呼你？' : '登录后，聊两句'} onClose={onClose} busy={busy} className="login-modal">
    <p className="modal-intro">{step === 'nickname' ? '选一个公开昵称，用它留下你的声音。' : '用邮箱验证码登录，无需设置密码。邮箱仅用于登录，不会公开展示。'}</p>
    <form onSubmit={submit}>
      {step !== 'nickname' && <label>你的邮箱<input type="email" autoComplete="email" required maxLength={254} value={email} disabled={step === 'code' || busy} placeholder="输入邮箱地址" onChange={e => setEmail(e.target.value)}/></label>}
      {step === 'code' && <><label>访客验证码<input autoFocus required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} placeholder="6 位验证码" onChange={e => setCode(e.target.value.replace(/\D/g, ''))}/></label><p className="form-hint">验证码已发送，10 分钟内有效。也请检查垃圾邮件。</p></>}
      {step === 'nickname' && <label>公开昵称<input autoFocus required value={nickname} maxLength={48} placeholder="1–24 字，不必使用真实姓名" onChange={e => setNickname(e.target.value)}/></label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy || (step === 'nickname' && (lengthOf(nickname) < 1 || lengthOf(nickname) > 24))}>{busy ? '请稍等…' : step === 'email' ? '发送验证码' : step === 'code' ? '验证并登录' : '保存昵称'}{step === 'email' ? <Mail size={16}/> : <ArrowRight size={16}/>}</button>
      {step === 'code' && <div className="login-secondary"><button type="button" className="text-button" disabled={busy || cooldown > 0} onClick={send}>{cooldown > 0 ? `${cooldown} 秒后重新发送` : '重新发送'}</button><button type="button" className="text-button" disabled={busy} onClick={() => { setStep('email'); setCode(''); setError(''); }}>更换邮箱</button></div>}
    </form>
  </Modal>;
}

function CommentBody({ item, onReply, onDelete }: { item: Comment; onReply: (c: Comment) => void; onDelete: (c: Comment) => void }) {
  return <article className={`comment ${item.deleted ? 'comment-deleted' : ''}`} aria-label={item.deleted ? '已删除的评论' : `${item.nickname}的评论`}>
    <div className="comment-meta"><span className="comment-name">{item.deleted ? '评论已删除' : item.nickname}</span>{item.isOwner && <span className="owner-label">站长</span>}<time dateTime={new Date(item.createdAt).toISOString()}>{formatDate(item.createdAt)}</time></div>
    {!item.deleted && <><p className="comment-content">{item.replyToId !== null && <span className="reply-to">回复 {item.replyToNickname}： </span>}{item.body}</p><div className="comment-actions"><button className="text-button" aria-label={`回复 ${item.nickname}的评论`} onClick={() => onReply(item)}><Reply size={14}/>回复</button>{item.canDelete && <button className="text-button" aria-label={`删除 ${item.nickname}的评论`} onClick={() => onDelete(item)}><Trash2 size={13}/>删除</button>}</div></>}
  </article>;
}

export function Comments({ admin }: { admin: boolean }) {
  const [session, setSession] = useState<Session>(anonymous);
  const [data, setData] = useState<CommentPage | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState('');
  const [replyDraft, setReplyDraft] = useState('');
  const [replying, setReplying] = useState<Comment | null>(null);
  const [login, setLogin] = useState(false);
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [postError, setPostError] = useState('');
  const [replyError, setReplyError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState<number | null>(null);
  const generation = useRef(0);
  const rootKey = useRef(crypto.randomUUID());
  const replyKey = useRef(crypto.randomUUID());
  const posting = useRef(false);
  
  const refresh = useCallback(async () => {
    const id = ++generation.current;
    setLoading(true);
    try {
      const [current, result] = await Promise.all([api<Session>('/comments/session'), api<CommentPage>(`/comments?page=${page}`)]);
      if (id !== generation.current) return;
      setSession(current); setData(result); setError('');
    } catch (e) { if (id === generation.current) setError(errorText(e)); }
    finally { if (id === generation.current) setLoading(false); }
  }, [page]);
  useEffect(() => { refresh(); return () => { generation.current++; }; }, [refresh, admin]);
  useEffect(() => {
    const onFocus = () => { if (!document.hidden && !posting.current) refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  function beginReply(item: Comment) {
    if (busy) return;
    if (replying?.id !== item.id) { setReplyDraft(''); replyKey.current = crypto.randomUUID(); }
    setReplying(item); setReplyError('');
  }
  async function publish(e: FormEvent, reply = false) {
    e.preventDefault();
    if (posting.current) return;
    if (!session.authenticated || session.profile?.needsNickname) { setLogin(true); return; }
    const text = reply ? replyDraft : draft;
    const setFailure = reply ? setReplyError : setPostError;
    if (lengthOf(text) < 1 || lengthOf(text) > 2000) { setFailure('留言须为 1–2000 字。'); return; }
    posting.current = true; setBusy(reply ? 'reply' : 'post'); setFailure(''); setNotice('');
    try {
      await api('/comments', 'POST', { body: text, replyToId: reply ? replying!.id : null, clientKey: reply ? replyKey.current : rootKey.current });
      if (reply) { setReplyDraft(''); setReplying(null); replyKey.current = crypto.randomUUID(); }
      else { setDraft(''); rootKey.current = crypto.randomUUID(); }
      setNotice(reply ? '回复已发表。' : '留言已发表，谢谢你的声音。');
      if (!reply && page !== 1) setPage(1); else await refresh();
    } catch (e) {
      setFailure(errorText(e));
      if (e instanceof ApiError && e.status === 401) { setSession(anonymous); setLogin(true); }
    } finally { posting.current = false; setBusy(null); }
  }
  async function remove() {
    if (!deleting || busy) return;
    setBusy('delete'); setDeleteError('');
    try {
      await api(`/comments/${deleting.id}`, 'DELETE', {});
      if (replying?.id === deleting.id) setReplying(null);
      setDeleting(null); setNotice('评论已删除。'); await refresh();
    } catch (e) { setDeleteError(errorText(e)); }
    finally { setBusy(null); }
  }
  async function logout() {
    if (busy) return; setBusy('logout');
    try { await api('/comments/auth/logout', 'POST', {}); setSession(anonymous); setNotice('已退出留言账号，草稿仍保留在当前页面。'); await refresh(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function loadMore(thread: Thread) {
    if (!thread.replies.nextCursor || moreBusy) return;
    setMoreBusy(thread.id); const id = generation.current;
    try {
      const result = await api<Replies>(`/comments/${thread.id}/replies?after=${thread.replies.nextCursor}`);
      if (generation.current !== id) return;
      setData(current => current && ({ ...current, items: current.items.map(t => t.id === thread.id ? { ...t, replies: { items: [...t.replies.items, ...result.items.filter(r => !t.replies.items.some(old => old.id === r.id))], nextCursor: result.nextCursor } } : t) }));
    } catch (e) { setError(errorText(e)); } finally { setMoreBusy(null); }
  }
  const loginLabel = session.authenticated ? '设置昵称后发表' : '验证邮箱后发表';
  const canPost = session.authenticated && !session.profile?.needsNickname;
  const composer = (reply: boolean) => <form className={`comment-composer ${reply ? 'reply-composer' : ''}`} onSubmit={e => publish(e, reply)}>
    {reply && <div className="reply-composer-title"><span>回复 {replying?.nickname}</span><button type="button" className="text-button" disabled={!!busy} onClick={() => setReplying(null)}>取消回复</button></div>}
    <label className="sr-only" htmlFor={reply ? 'comment-reply' : 'comment-draft'}>{reply ? '回复内容' : '留言内容'}</label>
    <textarea id={reply ? 'comment-reply' : 'comment-draft'} autoFocus={reply} readOnly={!!busy} rows={reply ? 3 : 4} value={reply ? replyDraft : draft} maxLength={4000} placeholder={reply ? '写下你的回复…' : '说说你的求职故事，或者留一句「我也是」。'} onChange={e => { if (reply) { setReplyDraft(e.target.value); replyKey.current = crypto.randomUUID(); } else { setDraft(e.target.value); rootKey.current = crypto.randomUUID(); } }}/>
    <div className="composer-bottom"><span className={lengthOf(reply ? replyDraft : draft) > 2000 ? 'over-limit' : ''}>{[...(reply ? replyDraft : draft)].length} / 2000</span><button className="primary" disabled={!!busy || (canPost && (lengthOf(reply ? replyDraft : draft) < 1 || lengthOf(reply ? replyDraft : draft) > 2000))}>{busy === (reply ? 'reply' : 'post') ? '发表中…' : canPost ? reply ? '发表回复' : '发表留言' : loginLabel}<ArrowRight size={15}/></button></div>
    {(reply ? replyError : postError) && <p className="form-error" role="alert">{reply ? replyError : postError}</p>}
  </form>;
  return <section className="comments-section" id="comments" aria-labelledby="comments-heading">
    <div className="comments-heading"><div><h2 id="comments-heading">留言区 <span>{data ? data.totalComments : '—'}</span></h2><p>求职路上，也听听你的故事。</p></div><div className="comment-account">{session.authenticated ? <><span>{session.profile?.nickname || '还差一个昵称'}{session.profile?.isOwner && <small>站长</small>}</span>{!session.isAdmin && <button className="text-button" disabled={!!busy} onClick={logout}>退出</button>}</> : <span><Mail size={14}/>邮箱验证后即可留言</span>}</div></div>
    {composer(false)}
    <p className="comment-privacy">昵称和留言会公开展示，邮箱不会公开。请勿在内容中留下私人信息。</p>
    {notice && <p className="comment-notice" role="status">{notice}</p>}
    {error && <div className="error-banner" role="alert"><span>{error}</span><button className="text-button" onClick={refresh}>重新加载</button></div>}
    <div className="comment-list" aria-busy={loading}>
      {data?.items.map(thread => <div key={thread.id} className="comment-thread"><CommentBody item={thread} onReply={beginReply} onDelete={item => { setDeleting(item); setDeleteError(''); }}/>
        {(thread.replies.items.length > 0 || replying?.id === thread.id || replying?.rootId === thread.id) && <div className="thread-replies">{thread.replies.items.map(item => <div key={item.id}><CommentBody item={item} onReply={beginReply} onDelete={comment => { setDeleting(comment); setDeleteError(''); }}/></div>)}{thread.replies.nextCursor && <button className="text-button more-replies" disabled={moreBusy !== null} onClick={() => loadMore(thread)}>{moreBusy === thread.id ? '加载中…' : '加载更多回复'}</button>}{(replying?.id === thread.id || replying?.rootId === thread.id) && composer(true)}</div>}
      </div>)}
      {data && data.items.length === 0 && <div className="comments-empty"><MessageCircle size={25} strokeWidth={1.2}/><h3>这里还很安静。</h3><p>第一句，就交给你了。</p></div>}
      {!data && !error && <p className="comments-loading">正在翻看留言…</p>}
    </div>
    {data && data.totalThreads > 10 && <div className="comments-pagination"><span>第 {data.page} / {Math.ceil(data.totalThreads / 10)} 页</span><div className="pagination"><button className="icon-button" aria-label="上一页留言" disabled={loading || data.page <= 1} onClick={() => { setPage(data.page - 1); setReplying(null); }}><ChevronLeft size={17}/></button><button className="icon-button" aria-label="下一页留言" disabled={loading || data.page >= Math.ceil(data.totalThreads / 10)} onClick={() => { setPage(data.page + 1); setReplying(null); }}><ChevronRight size={17}/></button></div></div>}
    {login && <CommentLogin session={session} onClose={() => { setLogin(false); refresh(); }} onSuccess={() => { setLogin(false); setNotice('已登录，可以发表你的留言了。'); refresh(); }}/ >}
    {deleting && <Modal title="删除这条评论？" onClose={() => setDeleting(null)} busy={busy === 'delete'}><p className="modal-intro">评论内容将被移除，无法撤销。如果已有回复，会保留“评论已删除”的占位。</p>{deleteError && <p className="form-error" role="alert">{deleteError}</p>}<div className="form-actions"><button className="secondary" disabled={!!busy} onClick={() => setDeleting(null)}>保留评论</button><button className="primary" disabled={!!busy} onClick={remove}>{busy === 'delete' ? '删除中…' : '确认删除评论'}</button></div></Modal>}
  </section>;
}
