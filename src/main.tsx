import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, ArrowUpRight, Search, ChevronLeft, ChevronRight, X, Plus, Download, LogOut, RefreshCw, LockKeyhole, Pencil, Trash2, Check, Mail } from 'lucide-react';
import './style.css';
import { api, ApiError, errorText } from './api';
import { Modal } from './Modal';
import { Comments } from './Comments';

const statuses = {
  rejected: { label: '已婉拒', color: '#c95432' },
  pending: { label: '等待回复', color: '#c9b894' },
  interview: { label: '面试中', color: '#90946b' },
  accepted: { label: '已录用', color: '#626b4e' },
  no_reply: { label: '暂无回复', color: '#a4a5a0' },
  withdrawn: { label: '已撤回', color: '#b6a6a0' },
};
const kinds = { internship: '实习', parttime: '兼职', fulltime: '全职' };
type Status = keyof typeof statuses;
type Kind = keyof typeof kinds;
type Application = { id: string; role: string; company?: string; kind: Kind; appliedOn: string; status: Status; rejectedOn: string | null; notes?: string; version?: number };
type Snapshot = { applications: Application[]; stats: Record<Status, number> & { total: number }; updatedAt: string | null };
type Draft = { company: string; role: string; kind: Kind; appliedOn: string; status: Status; rejectedOn: string; notes: string };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateLabel = (s: string) => s.replaceAll('-', '.');
const freshDraft = (): Draft => ({ company: '', role: '', kind: 'internship', appliedOn: today(), status: 'pending', rejectedOn: today(), notes: '' });
function Login({ onClose, onLogin }: { onClose: () => void; onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (cooldown <= 0) return; const timer = setTimeout(() => setCooldown(cooldown - 1), 1000); return () => clearTimeout(timer); }, [cooldown]);
  async function send() {
    setError(''); setBusy(true);
    try { await api('/auth/request-code', 'POST', { email }); setSent(true); setCooldown(60); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!sent) return send();
    setError(''); setBusy(true);
    try { await api('/auth/verify', 'POST', { email, code }); onLogin(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <Modal title="回到我的记录本" onClose={onClose} busy={busy} className="login-modal">
    <div className="login-symbol"><LockKeyhole size={24} strokeWidth={1.4}/></div>
    <p className="modal-intro">这里人人可看，只有我能改。<br/>使用管理员邮箱接收验证码后登录。</p>
    <form onSubmit={submit}>
      <label>管理员邮箱<input autoFocus type="email" autoComplete="email" required maxLength={254} placeholder="输入你的邮箱地址" value={email} disabled={sent || busy} onChange={e => setEmail(e.target.value)}/></label>
      {sent && <><label>邮箱验证码<input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required placeholder="6 位验证码" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}/></label><p className="form-hint" role="status">如果是管理员邮箱，验证码将发送至该邮箱，10 分钟内有效。也请检查垃圾邮件。</p></>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy}>{busy ? '请稍等…' : sent ? '登录记录本' : '发送验证码'}{sent ? <ArrowRight size={17}/> : <Mail size={17}/>}</button>
      {sent && <div className="login-secondary"><button type="button" className="text-button" disabled={busy || cooldown > 0} onClick={send}>{cooldown > 0 ? `${cooldown} 秒后重新发送` : '重新发送'}</button><button type="button" className="text-button" disabled={busy} onClick={() => { setSent(false); setCode(''); setError(''); }}>更换邮箱</button></div>}
    </form>
  </Modal>;
}

function EditForm({ record, onClose, onSaved, onUnauthorized }: { record: Application | null; onClose: () => void; onSaved: () => void; onUnauthorized: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => record ? { company: record.company || '', role: record.role, kind: record.kind, appliedOn: record.appliedOn, status: record.status, rejectedOn: record.rejectedOn || today(), notes: record.notes || '' } : freshDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(d => ({ ...d, [key]: value }));
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await api(record ? `/admin/applications/${record.id}` : '/admin/applications', record ? 'PUT' : 'POST', { ...draft, rejectedOn: draft.status === 'rejected' ? draft.rejectedOn : null, ...(record ? { version: record.version } : {}) }); onSaved(); }
    catch (e) { if (e instanceof ApiError && e.status === 401) onUnauthorized(); else setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <Modal title={record ? '修改这次投递' : '又投了一份'} busy={busy} onClose={onClose}>
    <p className="modal-intro">投递时记一笔，有消息了再回来更新。</p>
    <form onSubmit={submit}>
      <label>公司名称 <span className="private-label"><LockKeyhole size={11}/>仅自己可见</span><input autoFocus required maxLength={120} placeholder="这次投给了谁？" value={draft.company} onChange={e => change('company', e.target.value)}/></label>
      <label>岗位名称 <span className="public-label">公开展示</span><input required maxLength={120} placeholder="例如：产品设计实习生" value={draft.role} onChange={e => change('role', e.target.value)}/></label>
      <p className="field-hint">岗位名称对所有访客可见，请避免写入公司名称或个人信息。</p>
      <div className="form-grid"><label>申请类型<select value={draft.kind} onChange={e => change('kind', e.target.value as Kind)}>{Object.entries(kinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label><label>投递日期<input type="date" required max={today()} value={draft.appliedOn} onChange={e => change('appliedOn', e.target.value)}/></label></div>
      <div className={draft.status === 'rejected' ? 'form-grid' : ''}><label>当前状态<select value={draft.status} onChange={e => change('status', e.target.value as Status)}>{(['pending', 'no_reply', 'interview', 'rejected', 'accepted', 'withdrawn'] as Status[]).map(s => <option key={s} value={s}>{statuses[s].label}</option>)}</select></label>{draft.status === 'rejected' && <label>被拒日期<input type="date" required min={draft.appliedOn} max={today()} value={draft.rejectedOn} onChange={e => change('rejectedOn', e.target.value)}/></label>}</div>
      <p className="field-hint">“暂无回复”不会计入被拒次数；每条已婉拒的投递只计一次。</p>
      <label>私人备注 <span className="private-label"><LockKeyhole size={11}/>仅自己可见</span><textarea rows={3} maxLength={5000} placeholder="面试反馈、拒信内容，或者只是想吐槽两句。" value={draft.notes} onChange={e => change('notes', e.target.value)}/></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy}>{busy ? '保存中…' : '保存这次投递'}<Check size={17}/></button></div>
    </form>
  </Modal>;
}

function App() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [admin, setAdmin] = useState(false);
  const [login, setLogin] = useState(location.pathname === '/admin');
  const [editing, setEditing] = useState<Application | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Application | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const session = await api<{ authenticated: boolean }>('/session');
      let isAdmin = session.authenticated;
      let result: Snapshot;
      try { result = await api<Snapshot>(isAdmin ? '/admin/applications' : '/public/applications'); }
      catch (e) { if (e instanceof ApiError && e.status === 401) { isAdmin = false; result = await api<Snapshot>('/public/applications'); } else throw e; }
      if (id !== requestId.current) return;
      setAdmin(isAdmin); setData(result); setError('');
      if (isAdmin) setLogin(false);
    } catch (e) { if (id === requestId.current) setError(errorText(e)); }
    finally { if (id === requestId.current) setLoading(false); }
  }, []);
  useEffect(() => {
    refresh();
    const onFocus = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    const timer = setInterval(onFocus, 30_000);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onFocus); window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  useEffect(() => { setPage(1); }, [kind, status, query]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(t); }, [notice]);
  const items = data?.applications.filter(a => (kind === 'all' || a.kind === kind) && (status === 'all' || a.status === status) && `${a.role} ${admin ? a.company || '' : ''}`.toLowerCase().includes(query.trim().toLowerCase())) || [];
  const pages = Math.max(1, Math.ceil(items.length / 5));
  const currentPage = Math.min(page, pages);
  const visible = items.slice((currentPage - 1) * 5, currentPage * 5);
  const stats = data?.stats;
  const total = stats?.total || 0;
  const hasFilters = kind !== 'all' || status !== 'all' || query !== '';
  const unauthorized = () => { setEditing(undefined); setDeleting(null); setAdmin(false); setData(null); setLogin(true); refresh(); };
  function exportRecords() {
    const columns = ['公司', '岗位', '类型', '投递日期', '状态', '被拒日期', '私人备注'];
    const escape = (value: string) => '"' + (/^[\s]*[=+@\-\t\r]/.test(value) ? "'" + value : value).replaceAll('"', '""') + '"';
    const rows = (data?.applications || []).map(a => [a.company || '', a.role, kinds[a.kind], a.appliedOn, statuses[a.status].label, a.rejectedOn || '', a.notes || '']);
    const blob = new Blob(['\ufeff' + [columns, ...rows].map(r => r.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `投递记录-${today()}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('已导出全部记录，文件包含公司名称和私人备注。');
  }
  async function logout() {
    try { await api('/auth/logout', 'POST', {}); setAdmin(false); setData(null); setEditing(undefined); setDeleting(null); await refresh(); setNotice('已退出，回到公开视角。'); }
    catch (e) { setError(errorText(e)); }
  }
  async function remove() {
    if (!deleting) return; setDeleteBusy(true); setDeleteError('');
    try { await api(`/admin/applications/${deleting.id}`, 'DELETE', { version: deleting.version }); setDeleting(null); setNotice('记录已删除，统计已更新。'); refresh(); }
    catch (e) { if (e instanceof ApiError && e.status === 401) unauthorized(); else setDeleteError(errorText(e)); }
    finally { setDeleteBusy(false); }
  }

  return <>
    <header className="site-header"><a className="wordmark" href="/" aria-label="unfortunately 首页">unfortunately<span>.</span></a><nav aria-label="主导航"><a className="records-nav" href="#records">投递记录</a>{admin ? <button className="text-button" onClick={logout}>退出管理<LogOut size={16}/></button> : <button className="text-button" onClick={() => setLogin(true)}>管理登录<ArrowRight size={18}/></button>}</nav></header>
    <main>
      {error && <div className="error-banner" role="alert"><span>{error}{data ? ' 当前显示的是上次成功加载的数据。' : ''}</span><button className="text-button" onClick={refresh}>重试<RefreshCw size={15}/></button></div>}
      <section className="overview" aria-label="投递统计">
        <div className="rejection"><h1>又被婉拒了<span>。</span></h1><p className="intro">一份持续更新的求职记录。谢谢参与，下次再投。</p><div className="big-count"><span className="number">{stats ? stats.rejected : '—'}</span><span className="count-unit">次婉拒</span></div><p className="count-caption">{stats && stats.rejected === 0 ? '还没收到婉拒，故事才刚开始。' : '至少这次有回音。'}</p></div>
        <div className="summary"><h2>当前状态分布</h2><div className="distribution" role="img" aria-label={stats ? Object.entries(statuses).map(([key, v]) => `${v.label} ${stats[key as Status]} 次`).join('，') : '统计加载中'}>{total > 0 ? Object.entries(statuses).filter(([key]) => stats![key as Status] > 0).map(([key, v]) => <span key={key} title={`${v.label}：${stats![key as Status]} 次`} style={{ width: `${stats![key as Status] / total * 100}%`, backgroundColor: v.color }}/>) : <span className="empty-distribution"/>}</div><div className="chart-legend">{total > 0 ? Object.entries(statuses).filter(([key]) => stats![key as Status] > 0).map(([key, v]) => <span key={key}><i style={{ backgroundColor: v.color }}/>{v.label} {Math.round(stats![key as Status] / total * 100)}%</span>) : <span>{stats ? '记下第一份投递，这里就会有变化。' : '正在读取记录…'}</span>}</div><div className="stat-grid">{([{ label: '总投递', value: stats?.total }, { label: '等待回复', value: stats?.pending }, { label: '面试中', value: stats?.interview }, { label: '已录用', value: stats?.accepted }]).map(s => <div className="stat" key={s.label}><span>{s.value ?? '—'}</span><p>{s.label}</p></div>)}</div></div>
      </section>
      <section className="records" id="records" aria-labelledby="records-title">
        <div className="records-top"><div><h2 id="records-title">投递记录</h2><p className="records-caption">{admin ? <><LockKeyhole size={13}/>管理视角 · 公司与备注仅自己可见</> : '公司名称和私人备注已隐藏。'}</p></div><div className="records-tools">{admin && <div className="admin-tools"><button className="text-button" onClick={exportRecords}><Download size={16}/>导出记录</button><button className="primary" onClick={() => setEditing(null)}><Plus size={17}/>新增投递</button></div>}<div className="kind-filters" role="group" aria-label="申请类型">{[['all', '全部'], ...Object.entries(kinds)].map(([k, v]) => <button key={k} aria-pressed={kind === k} className={kind === k ? 'selected' : ''} onClick={() => setKind(k)}>{v}</button>)}</div><div className="search-controls"><div className="search-field"><Search size={17}/><input aria-label={admin ? '搜索岗位或公司' : '搜索岗位'} placeholder={admin ? '搜索岗位或公司…' : '搜索岗位…'} value={query} maxLength={120} onChange={e => setQuery(e.target.value)}/>{query && <button className="icon-button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={15}/></button>}</div><select aria-label="筛选状态" value={status} onChange={e => setStatus(e.target.value)}><option value="all">全部状态</option>{Object.entries(statuses).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div></div></div>
        <div className="table-wrap" aria-busy={loading}>
          <table><thead><tr><th>岗位{admin && ' / 公司'}</th><th>类型</th><th>投递日期</th><th>状态</th>{admin && <th className="actions-head">操作</th>}</tr></thead><tbody>{visible.map(a => <tr key={a.id}><td className="role-cell"><span>{a.role}</span>{admin && <small>{a.company}</small>}</td><td className="kind-cell">{kinds[a.kind]}</td><td className="date-cell">{dateLabel(a.appliedOn)}</td><td className="status-cell"><span className="status" style={{ '--status-color': statuses[a.status].color } as React.CSSProperties}><i/>{statuses[a.status].label}</span></td>{admin && <td className="row-actions"><button className="icon-button" aria-label={`编辑 ${a.role}`} onClick={() => setEditing(a)}><Pencil size={16}/></button><button className="icon-button delete-button" aria-label={`删除 ${a.role}`} onClick={() => { setDeleting(a); setDeleteError(''); }}><Trash2 size={16}/></button></td>}</tr>)}</tbody></table>
          {visible.length === 0 && <div className="empty-state">{!data ? <><span className="empty-mark">…</span><h3>{error ? '记录暂时没能加载' : '正在翻开记录本'}</h3><p>{error ? '请检查网络，稍后重试。' : '很快就好。'}</p></> : hasFilters ? <><span className="empty-mark">∅</span><h3>这一页暂时空着</h3><p>没有符合筛选条件的投递记录。</p><button className="text-button accent" onClick={() => { setKind('all'); setStatus('all'); setQuery(''); }}>清除筛选<ArrowRight size={15}/></button></> : <><span className="empty-mark">01<span> /</span></span><h3>第一份投递，还没落笔。</h3><p>{admin ? '实习、兼职，或是下一份工作。从这里记下。' : '等第一份投递落笔，故事就从这里开始。'}</p>{admin && <button className="primary" onClick={() => setEditing(null)}>记录第一份投递<ArrowUpRight size={17}/></button>}</>}</div>}
        </div>
        <div className="table-bottom"><span>{data ? hasFilters ? `找到 ${items.length} 条 · 共 ${total} 条投递记录` : `共 ${total} 条投递记录` : '正在加载'}{loading && data && <RefreshCw className="loading-icon" size={12}/>}</span><div className="pagination" aria-label="翻页"><button className="icon-button" disabled={currentPage === 1} aria-label="上一页" onClick={() => setPage(currentPage - 1)}><ChevronLeft size={18}/></button><span>{currentPage} <em>/ {pages}</em></span><button className="icon-button" disabled={currentPage === pages} aria-label="下一页" onClick={() => setPage(currentPage + 1)}><ChevronRight size={18}/></button></div></div>
      </section>
      <Comments admin={admin}/>
    </main>
    <footer><p>被拒的是这次申请，不是我。</p><span>{data?.updatedAt ? `最后更新 ${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(data.updatedAt)).replaceAll('/', '.')}` : '记录，慢慢来。'}</span></footer>
    {notice && <div className="toast" role="status"><Check size={17}/>{notice}</div>}
    {login && !admin && <Login onClose={() => { setLogin(false); if (location.pathname === '/admin') history.replaceState(null, '', '/'); }} onLogin={() => { setLogin(false); setNotice('欢迎回来，继续写自己的故事。'); refresh(); }}/ >}
    {editing !== undefined && admin && <EditForm record={editing} onClose={() => setEditing(undefined)} onUnauthorized={unauthorized} onSaved={() => { setEditing(undefined); setNotice('已保存到云端，其他设备刷新即可查看。'); refresh(); }}/ >}
    {deleting && admin && <Modal title="删除这次投递？" busy={deleteBusy} onClose={() => setDeleting(null)}><p className="modal-intro">「{deleting.role}」将从记录中移除，相关统计也会更新。此操作无法撤销。</p>{deleteError && <p className="form-error" role="alert">{deleteError}</p>}<div className="form-actions"><button className="secondary" disabled={deleteBusy} onClick={() => setDeleting(null)}>保留记录</button><button className="primary" disabled={deleteBusy} onClick={remove}>{deleteBusy ? '删除中…' : '确认删除'}</button></div></Modal>}
  </>;
}

createRoot(document.getElementById('root')!).render(<App/>);
