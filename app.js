'use strict';

/* ---------------- 저장소 ---------------- */
const STORE = 'sai.v1';
const DEFAULT_SETTINGS = {
  cycle_start_day: 11,
  categories: ['식비', '카페', '생활', '병원', '교통', '쇼핑', '경조사', '기타'],
  methods: ['카드', '현금', '계좌이체'],
  beneficiaries: ['공동', '아내', '남편'],
};
const USERS = ['아내', '남편'];
const TYPE_LABEL = { expense: '지출', refund: '환불', transfer: '지출 제외' };

let S = load();
function normSettings(x) {
  return Object.assign({}, DEFAULT_SETTINGS, x, { cycle_start_day: Number(x && x.cycle_start_day) || 11 });
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && typeof s === 'object') return Object.assign(blank(), s);
  } catch (e) {}
  return blank();
}
function blank() {
  return { cfg: null, me: null, settings: DEFAULT_SETTINGS, txs: {}, outbox: {}, since: 0, lastSync: 0, pendingSettings: null, draft: null };
}
function save() {
  mergeDisk();
  try { localStorage.setItem(STORE, JSON.stringify(S)); return true; }
  catch (e) { toast('기기 저장공간이 부족해요'); return false; }
}
// 다른 탭/창이 저장한 미전송 기록·거래를 잃지 않도록 디스크 내용과 병합 (수정 시각이 새로운 쪽 우선)
function mergeDisk() {
  let d;
  try { d = JSON.parse(localStorage.getItem(STORE)); } catch (e) { return; }
  if (!d || !d.txs) return;
  const newer = (a, b) => !b || (a && a.updated_at > b.updated_at);
  Object.values(d.txs).forEach(t => { if (newer(t, S.txs[t.id])) S.txs[t.id] = t; });
  Object.values(d.outbox || {}).forEach(t => {
    if (newer(t, S.outbox[t.id]) && newer(t, S.txs[t.id]) || (S.txs[t.id] && S.txs[t.id].updated_at === t.updated_at && !S.outbox[t.id] && !synced.has(t.id + ':' + t.updated_at))) {
      S.outbox[t.id] = t; S.txs[t.id] = t;
    }
  });
}
const synced = new Set();
window.addEventListener('storage', e => { if (e.key === STORE) { mergeDisk(); render(); } });

/* ---------------- 유틸 ---------------- */
const $ = s => document.querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = n => Math.round(n).toLocaleString('ko-KR');
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => ymd(new Date());
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}

/* ---------------- 주기 ---------------- */
function cycleRange(offset) {
  const day = Number(S.settings.cycle_start_day) || 11;
  const startIn = (y, m0) => new Date(y, m0, Math.min(day, new Date(y, m0 + 1, 0).getDate()));
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth();
  if (now.getDate() < startIn(y, m).getDate()) m -= 1;
  m += offset;
  const start = startIn(y, m);
  const next = startIn(y, m + 1);
  const end = new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1);
  return { start: ymd(start), end: ymd(end), label: (start.getMonth() + 1) + '.' + start.getDate() + ' - ' + (end.getMonth() + 1) + '.' + end.getDate(), year: start.getFullYear() };
}
const liveTxs = () => Object.values(S.txs).filter(t => !t.deleted);
const inRange = (t, r) => t.date >= r.start && t.date <= r.end;
const signed = t => t.type === 'refund' ? -t.amount : t.type === 'transfer' ? 0 : t.amount;
const byNewest = (a, b) => (b.date + b.created_at).localeCompare(a.date + a.created_at) || b.created_at - a.created_at;

/* ---------------- 동기화 ---------------- */
let syncing = false, syncAgain = false, syncError = '';
async function sync() {
  if (!S.cfg) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true; syncError = ''; renderStatus();
  try {
    if (S.pendingSettings) {
      const sent = JSON.stringify(S.pendingSettings);
      const r = await api({ action: 'settings', settings: S.pendingSettings });
      if (JSON.stringify(S.pendingSettings) === sent) { S.settings = normSettings(r.settings); S.pendingSettings = null; }
      save();
    }
    const ops = Object.values(S.outbox);
    const res = await api({ action: 'sync', since: S.since, ops });
    // 보낸 기록은 서버의 최종값(최신 수정 우선 결과)으로 확정. 전송 중 다시 고친 기록은 outbox에 남겨 다음에 보낸다
    (res.finals || []).forEach(fin => {
      const sent = ops.find(o => o.id === fin.id);
      const cur = S.outbox[fin.id];
      if (cur && sent && cur.updated_at === sent.updated_at) {
        delete S.outbox[fin.id]; synced.add(fin.id + ':' + sent.updated_at);
        S.txs[fin.id] = fin;
      }
    });
    if (res.rejected.length) syncError = res.rejected.length + '건이 형식 오류로 거부됐어요';
    res.rows.forEach(r => {
      const pend = S.outbox[r.id];
      if (pend && pend.updated_at > r.updated_at) return;
      if (pend) delete S.outbox[r.id];
      const cur = S.txs[r.id];
      if (!cur || r.updated_at >= cur.updated_at) S.txs[r.id] = r;
    });
    S.since = res.now; S.lastSync = Date.now();
    if (!S.pendingSettings) S.settings = normSettings(res.settings);
    save();
  } catch (e) {
    syncError = e.code === 'unauthorized' ? '설정 코드가 바뀌었어요. 설정 → 설정 코드 바꾸기'
      : navigator.onLine === false ? '' : '공유 실패 · 기록은 이 기기에 안전해요';
  } finally {
    syncing = false;
    render();
    if (syncAgain) { syncAgain = false; sync(); }
  }
}
async function api(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(S.cfg.url, {
      method: 'POST', redirect: 'follow', signal: ctrl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ key: S.cfg.key }, body)),
    });
    const data = await res.json();
    if (!data.ok) { const e = new Error(data.error && data.error.message); e.code = data.error && data.error.code; throw e; }
    return data;
  } finally { clearTimeout(timer); }
}
function upsert(rec) {
  const prevTx = S.txs[rec.id], prevOut = S.outbox[rec.id];
  rec = Object.assign({}, rec, { updated_at: Math.max(Date.now(), (prevTx && prevTx.updated_at || 0) + 1) });
  S.txs[rec.id] = rec;
  S.outbox[rec.id] = rec;
  if (!save()) {
    if (prevTx) S.txs[rec.id] = prevTx; else delete S.txs[rec.id];
    if (prevOut) S.outbox[rec.id] = prevOut; else delete S.outbox[rec.id];
    return false;
  }
  sync();
  return true;
}

/* ---------------- 화면 ---------------- */
let tab = 'home', offset = 0, filter = { q: '', kind: 'all', who: '' };

function render() {
  const app = $('#app');
  if (!S.cfg) return app.innerHTML = setupView();
  if (!S.me) return app.innerHTML = whoView();
  app.innerHTML = `<div class="wrap">
    <header class="top"><div class="brand">${logo()}사이</div>
      <button class="who" data-act="tab" data-v="settings">${esc(S.me)}의 기록</button></header>
    ${tab === 'home' ? homeView() : tab === 'list' ? listView() : settingsView()}
  </div>
  <nav class="tabs" aria-label="메뉴">
    ${navBtn('home', '홈', '⌂')}${navBtn('list', '내역', '☰')}
    <button class="plus" data-act="add" aria-label="지출 기록">+</button>
    ${navBtn('settings', '설정', '⚙')}
  </nav>`;
  renderStatus();
}
const navBtn = (k, label, ic) => `<button data-act="tab" data-v="${k}" ${tab === k ? 'aria-current="page"' : ''}><span aria-hidden="true" style="font-size:20px">${ic}</span>${label}</button>`;
const logo = () => `<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="10" cy="13" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="13" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

function renderStatus() {
  const el = $('#status'); if (!el) return;
  const n = Object.keys(S.outbox).length;
  let txt, err = false;
  if (syncing) txt = '공유하는 중…';
  else if (syncError) { txt = syncError; err = true; }
  else if (navigator.onLine === false) txt = n ? `오프라인 · ${n}건 기기에 저장, 연결되면 공유` : '오프라인';
  else if (n) txt = `${n}건 공유 대기`;
  else if (S.lastSync) txt = '공유됨 · ' + new Date(S.lastSync).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  else txt = '';
  el.textContent = txt; el.classList.toggle('err', err);
  if (err) el.innerHTML = esc(txt) + ' <button class="link" data-act="sync">다시 보내기</button>';
}

function setupView() {
  return `<div class="wrap center">
    <div class="brand" style="font-size:28px">${logo()}사이</div>
    <h1>둘이 쓰는 가계부</h1>
    <p style="color:var(--muted);margin:0">처음 한 번, 받은 설정 코드를 붙여넣어 주세요.</p>
    <form data-form="setup" class="field">
      <label for="code">설정 코드</label>
      <textarea id="code" class="in" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false" required></textarea>
      <div class="err" id="setup-err"></div>
      <button class="btn" type="submit">연결하기</button>
    </form>
  </div>`;
}
function whoView() {
  return `<div class="wrap center">
    <div class="brand">${logo()}사이</div>
    <h1>나는 누구인가요?</h1>
    <p style="color:var(--muted);margin:0">이 기기에서 쓴 기록에 이름을 남겨요. 설정에서 바꿀 수 있어요.</p>
    <div class="pick">${USERS.map(u => `<button data-act="me" data-v="${u}">${u}</button>`).join('')}</div>
  </div>`;
}

function homeView() {
  const r = cycleRange(offset);
  const txs = liveTxs().filter(t => inRange(t, r));
  const net = txs.reduce((s, t) => s + signed(t), 0);
  const pendingRefund = liveTxs().filter(t => t.refund_pending).length;
  const cats = {};
  txs.forEach(t => { if (t.type !== 'transfer') cats[t.category || '기타'] = (cats[t.category || '기타'] || 0) + signed(t); });
  const catRows = Object.entries(cats).filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...catRows.map(([, v]) => v));
  const bene = {};
  txs.forEach(t => { if (t.type !== 'transfer') bene[t.beneficiary || '공동'] = (bene[t.beneficiary || '공동'] || 0) + signed(t); });
  const recent = txs.sort(byNewest).slice(0, 6);
  return `
    <section class="hero" aria-label="이번 주기 요약">
      <div class="cyc">
        <button data-act="cyc" data-v="-1" aria-label="이전 주기">‹</button>
        <div class="lbl"><b>${offset === 0 ? '이번 달' : offset === -1 ? '지난 달' : r.year + '년'}</b>${r.label}</div>
        <button data-act="cyc" data-v="1" aria-label="다음 주기" ${offset >= 0 ? 'disabled style="opacity:.3"' : ''}>›</button>
      </div>
      <div class="amt num">${won(net)}<small>원</small></div>
      <div class="sub"><span>${txs.length}건 · 환불 반영</span>${pendingRefund ? `<button class="link" style="color:#fff;min-height:auto;padding:0" data-act="refunds">환불 대기 ${pendingRefund}건 ›</button>` : ''}</div>
    </section>
    <p class="status" id="status"></p>
    ${catRows.length ? `<h2>어디에 썼을까요?</h2><div class="card">${catRows.map(([c, v]) => `
      <div class="bar-row"><div class="bar-top"><span>${esc(c)}</span><b class="num">${won(v)}원</b></div>
      <div class="bar"><i style="width:${Math.max(0, v) / max * 100}%"></i></div></div>`).join('')}</div>` : ''}
    ${Object.keys(bene).length > 1 ? `<h2>누구를 위해</h2><div class="card">${Object.entries(bene).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
      `<div class="bar-row"><div class="bar-top"><span>${esc(k)}</span><b class="num">${won(v)}원</b></div></div>`).join('')}</div>` : ''}
    <h2 style="display:flex;justify-content:space-between;align-items:center">최근 기록 <button class="link" data-act="tab" data-v="list">모두 보기 ›</button></h2>
    <div class="card">${recent.length ? recent.map(txRow).join('') : `<div class="empty">아직 기록이 없어요.<br>아래 + 를 눌러 첫 지출을 남겨보세요.</div>`}</div>`;
}

function txRow(t) {
  const cls = t.type === 'refund' ? 'ref' : t.type === 'transfer' ? 'ex' : '';
  const d = parseDate(t.date);
  return `<button class="tx" data-act="edit" data-v="${esc(t.id)}">
    <span class="ic" aria-hidden="true">${esc((t.category || '·').slice(0, 1))}</span>
    <span class="mid"><span class="m">${esc(t.merchant || t.category || '기록한 지출')}</span>
      <span class="meta">${d.getMonth() + 1}.${d.getDate()} · ${esc(t.category || '미분류')} · ${esc(t.payer || '-')} 결제 · ${esc(t.beneficiary || '공동')}
      ${t.refund_pending ? '<span class="tag">환불 대기</span>' : ''}${t.type === 'transfer' ? '<span class="tag q">지출 제외</span>' : ''}${S.outbox[t.id] ? '<span class="tag q">공유 대기</span>' : ''}</span></span>
    <span class="a num ${cls}">${t.type === 'refund' ? '−' : ''}${won(t.amount)}원</span></button>`;
}

function listView() {
  const r = cycleRange(offset);
  const q = filter.q.trim().toLowerCase();
  let txs = liveTxs().filter(t => filter.kind === 'refund_pending' ? t.refund_pending : inRange(t, r));
  if (filter.kind === 'transfer') txs = txs.filter(t => t.type === 'transfer');
  if (filter.kind === 'refund') txs = txs.filter(t => t.type === 'refund');
  if (filter.who) txs = txs.filter(t => (t.beneficiary || '공동') === filter.who);
  if (q) txs = txs.filter(t => [t.merchant, t.note, t.category, t.method].join(' ').toLowerCase().includes(q));
  txs.sort(byNewest);
  const net = txs.reduce((s, t) => s + signed(t), 0);
  let lastDay = '', rows = '';
  txs.forEach(t => {
    if (t.date !== lastDay) {
      if (rows) rows += '</div>';
      const d = parseDate(t.date);
      rows += `<p class="day">${d.getMonth() + 1}.${d.getDate()} ${WEEK[d.getDay()]}요일</p><div class="card">`;
      lastDay = t.date;
    }
    rows += txRow(t);
  });
  if (rows) rows += '</div>';
  const kinds = [['all', '전체'], ['refund_pending', '환불 대기'], ['refund', '환불'], ['transfer', '지출 제외']];
  return `
    <h1>내역</h1>
    ${filter.kind === 'refund_pending' ? '<p class="hint">환불 대기는 모든 기간에서 보여줘요.</p>' : `
    <div class="hero" style="padding:8px 12px;margin-top:10px"><div class="cyc">
      <button data-act="cyc" data-v="-1" aria-label="이전 주기">‹</button>
      <div class="lbl"><b>${offset === 0 ? '이번 달' : r.year + '년'}</b>${r.label}</div>
      <button data-act="cyc" data-v="1" aria-label="다음 주기" ${offset >= 0 ? 'disabled style="opacity:.3"' : ''}>›</button></div></div>`}
    <input class="in search" type="search" placeholder="거래처, 메모 검색" value="${esc(filter.q)}" data-input="q" aria-label="검색">
    <div class="chips" style="margin-top:10px">${kinds.map(([k, l]) => `<button class="chip" data-act="kind" data-v="${k}" aria-pressed="${filter.kind === k}">${l}</button>`).join('')}</div>
    <div class="field"><select class="in" data-input="who" aria-label="대상">
      <option value="">모든 대상</option>${S.settings.beneficiaries.map(b => `<option ${filter.who === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>
    <p class="status" id="status"></p>
    <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--muted);margin-top:8px"><span>${txs.length}건</span><span class="num">순지출 ${won(net)}원</span></div>
    ${rows || `<div class="empty">${q || filter.kind !== 'all' || filter.who ? '조건에 맞는 기록이 없어요.' : '이 기간의 기록이 없어요.'}</div>`}`;
}

function settingsView() {
  const st = S.settings;
  return `
    <h1>설정</h1>
    <p class="status" id="status"></p>
    <div class="field"><span class="lab">이 기기 사용자</span>
      <div class="chips">${USERS.map(u => `<button class="chip" data-act="me" data-v="${u}" aria-pressed="${S.me === u}">${u}</button>`).join('')}</div></div>
    <form data-form="settings">
      <div class="field"><label for="sd">한 달 시작일 (카드 결제 주기)</label>
        <select id="sd" class="in" name="cycle_start_day">${Array.from({ length: 31 }, (_, i) => i + 1).map(d => `<option value="${d}" ${Number(st.cycle_start_day) === d ? 'selected' : ''}>매월 ${d}일</option>`).join('')}</select>
        <p class="hint">29~31일을 고르면 그날이 없는 달은 말일부터 시작해요.</p></div>
      <div class="field"><label for="cats">분류 (쉼표로 구분)</label><textarea id="cats" class="in" rows="3" name="categories">${esc(st.categories.join(', '))}</textarea></div>
      <div class="field"><label for="mts">결제수단</label><textarea id="mts" class="in" rows="2" name="methods">${esc(st.methods.join(', '))}</textarea></div>
      <div class="field"><label for="bns">누구 몫</label><textarea id="bns" class="in" rows="2" name="beneficiaries">${esc(st.beneficiaries.join(', '))}</textarea>
        <p class="hint">설정은 두 사람에게 같이 적용돼요.</p></div>
      <div class="field"><button class="btn" type="submit">설정 저장</button></div>
    </form>
    <div class="field"><button class="btn ghost" data-act="sync">지금 동기화</button></div>
    <div class="field"><button class="btn ghost" data-act="csv">CSV로 내보내기</button></div>
    <h2>홈 화면에 추가</h2>
    <p class="hint" style="font-size:14px">Safari 아래쪽 공유 버튼 → 홈 화면에 추가. 홈 화면 앱은 Safari와 저장공간이 따로라, 처음 열 때 설정 코드를 한 번 더 넣어야 해요.</p>
    <h2>설정 코드 바꾸기</h2>
    <form data-form="setup"><p class="hint" style="font-size:14px">키를 바꿨을 때 새 코드를 넣어요. 이 기기의 기록과 공유 대기 건은 그대로 남아요.</p>
      <textarea id="code" class="in" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="새 설정 코드"></textarea>
      <div class="err" id="setup-err"></div><button class="btn ghost" type="submit">새 코드로 연결</button></form>
    <div class="field"><button class="btn danger" data-act="disconnect">이 기기 연결 해제</button>
      <p class="hint">공유 대기 중인 기록이 있으면 먼저 동기화돼야 해요.</p></div>
    <p class="hint" style="text-align:center;margin-top:24px">사이 MVP · 기록 원본은 구글 시트에 있어요</p>`;
}

/* ---------------- 입력 시트 ---------------- */
let draft = null, saved = false, editing = false;
function merchantStats() {
  const since = ymd(new Date(Date.now() - 120 * 864e5));
  const m = {};
  liveTxs().filter(t => t.merchant && t.date >= since).forEach(t => {
    const k = t.merchant;
    if (!m[k]) m[k] = { n: 0, last: t };
    m[k].n++;
    if (t.updated_at > m[k].last.updated_at) m[k].last = t;
  });
  return m;
}
function openEntry(id) {
  const ex = id && S.txs[id];
  editing = !!ex;
  const last = Object.values(S.txs).filter(t => t.created_by === S.me).sort((a, b) => b.created_at - a.created_at)[0];
  draft = ex ? Object.assign({}, ex) : {
    id: uid(), date: today(), merchant: '', amount: 0, type: 'expense',
    method: (last && last.method) || S.settings.methods[0] || '', category: '',
    payer: S.me, beneficiary: S.settings.beneficiaries[0] || '공동', note: '', refund_pending: false,
    created_by: S.me, created_at: Date.now(), updated_at: 0, deleted: false,
  };
  if (!ex && S.draft && S.draft.created_by === S.me) draft = Object.assign({}, S.draft, { id: uid(), created_at: Date.now() });
  saved = false;
  const dlg = $('#sheet');
  dlg.innerHTML = entryHtml(!!ex);
  dlg.showModal();
  const a = $('#amount');
  a.focus();
  if (ex) a.setSelectionRange(a.value.length, a.value.length);
}
function entryHtml(isEdit) {
  const d = draft, st = S.settings;
  const stats = merchantStats();
  const top = Object.entries(stats).sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([k]) => k);
  const cats = st.categories.includes(d.category) || !d.category ? st.categories : st.categories.concat(d.category);
  const methods = st.methods.includes(d.method) || !d.method ? st.methods : st.methods.concat(d.method);
  const benes = st.beneficiaries.includes(d.beneficiary) ? st.beneficiaries : st.beneficiaries.concat(d.beneficiary);
  return `<form data-form="entry" novalidate>
    <div class="sheet-h"><button type="button" data-act="close">취소</button><b id="sheet-title">${isEdit ? '기록 수정' : '지출 기록'}</b><button type="submit" class="save">저장</button></div>
    <div class="sheet-b">
      <div class="field"><label for="amount">얼마를 썼나요?</label>
        <div class="amount-in"><input id="amount" name="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${d.amount ? won(d.amount) : ''}" class="num"><span>원</span></div>
        <div class="err" id="entry-err"></div></div>
      <div class="field"><label for="merchant">어디에서?</label>
        <input id="merchant" name="merchant" class="in" list="mlist" autocomplete="off" placeholder="거래처 (선택)" value="${esc(d.merchant)}">
        <datalist id="mlist">${Object.keys(stats).map(m => `<option value="${esc(m)}">`).join('')}</datalist>
        ${top.length ? `<div class="chips" style="margin-top:8px">${top.map(m => `<button type="button" class="chip" data-act="merchant" data-v="${esc(m)}">${esc(m)}</button>`).join('')}</div>` : ''}</div>
      <div class="field"><span class="lab">분류</span><div class="chips" id="cats">${cats.map(c => `<button type="button" class="chip" data-act="cat" data-v="${esc(c)}" aria-pressed="${d.category === c}">${esc(c)}</button>`).join('')}</div></div>
      <details class="more" ${isEdit || d.type !== 'expense' || d.refund_pending || d.note ? 'open' : ''}>
      <summary>날짜·누구 몫·결제수단 <span class="sum">${esc(summaryLine())}</span></summary>
      <div class="field"><span class="lab">누구 몫</span><div class="chips">${benes.map(b => `<button type="button" class="chip" data-act="bene" data-v="${esc(b)}" aria-pressed="${d.beneficiary === b}">${esc(b)}</button>`).join('')}</div></div>
      <div class="row2">
        <div class="field"><label for="date">날짜</label><input id="date" name="date" type="date" class="in" value="${esc(d.date)}" max="${today()}"></div>
        <div class="field"><label for="payer">결제한 사람</label><select id="payer" name="payer" class="in">${USERS.map(u => `<option ${d.payer === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="method">결제수단</label><select id="method" name="method" class="in">${methods.map(m => `<option ${d.method === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
      <div class="field"><span class="lab">종류</span><div class="seg">${Object.entries(TYPE_LABEL).map(([k, l]) => `<button type="button" data-act="type" data-v="${k}" aria-pressed="${d.type === k}">${l}</button>`).join('')}</div>
        <p class="hint">지출 제외 = 카드대금 납부·이체처럼 돈만 옮긴 것. 합계에 안 들어가요.</p></div>
      <div class="field"><label class="toggle" for="rp"><span>환불 받을 예정</span><input type="checkbox" id="rp" name="refund_pending" ${d.refund_pending ? 'checked' : ''}></label></div>
      <div class="field"><label for="note">메모</label><input id="note" name="note" class="in" autocomplete="off" placeholder="예: 선물, 정기검사" value="${esc(d.note)}"></div>
      </details>
      <div class="field"><button class="btn" type="submit">저장</button></div>
      ${isEdit ? `<div class="field"><button type="button" class="btn danger" data-act="delete">이 기록 삭제</button></div>` : ''}
      ${isEdit ? `<p class="hint">기록: ${esc(d.created_by || '-')}</p>` : ''}
    </div></form>`;
}
function summaryLine() {
  const d = draft;
  return [d.date === today() ? '오늘' : d.date.slice(5).replace('-', '.'), d.beneficiary, d.method, d.payer + ' 결제'].filter(Boolean).join(' · ');
}
function refreshSummary() { const el = $('.more .sum'); if (el) el.textContent = summaryLine(); }
function readEntry(form) {
  const fd = new FormData(form);
  draft.amount = Number(String(fd.get('amount') || '').replace(/[^\d]/g, ''));
  draft.merchant = String(fd.get('merchant') || '').trim();
  draft.date = fd.get('date') || today();
  draft.payer = fd.get('payer');
  draft.method = fd.get('method');
  draft.note = String(fd.get('note') || '').trim();
  draft.refund_pending = fd.get('refund_pending') === 'on';
}
function setPressed(container, v) {
  container.querySelectorAll('[aria-pressed]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
}
function suggestFor(merchant) {
  const s = merchantStats()[merchant];
  if (!s) return;
  const t = s.last;
  if (t.category) { draft.category = t.category; setPressed($('#cats'), t.category); }
  if (t.method && S.settings.methods.includes(t.method)) { draft.method = t.method; $('#method').value = t.method; }
  if (t.beneficiary) { draft.beneficiary = t.beneficiary; setPressed($('[data-act=bene]').parentElement, t.beneficiary); }
  refreshSummary();
}

/* ---------------- 이벤트 ---------------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const v = b.dataset.v;
  switch (b.dataset.act) {
    case 'tab': tab = v; if (v === 'list' && filter.kind === 'refund_pending') filter.kind = 'all'; render(); scrollTo(0, 0); break;
    case 'add': openEntry(); break;
    case 'edit': openEntry(v); break;
    case 'close': stashDraft(); $('#sheet').close(); break;
    case 'cyc': offset = Math.min(0, offset + Number(v)); render(); break;
    case 'refunds': tab = 'list'; filter.kind = 'refund_pending'; render(); break;
    case 'kind': filter.kind = v; render(); break;
    case 'me': S.me = v; save(); render(); break;
    case 'sync': sync(); break;
    case 'merchant': $('#merchant').value = v; draft.merchant = v; suggestFor(v); break;
    case 'cat': draft.category = draft.category === v ? '' : v; setPressed(b.parentElement, draft.category); break;
    case 'bene': draft.beneficiary = v; setPressed(b.parentElement, v); refreshSummary(); break;
    case 'type': draft.type = v; setPressed(b.parentElement, v); break;
    case 'delete':
      if (confirm('이 기록을 삭제할까요?')) {
        if (upsert(Object.assign({}, draft, { deleted: true }))) { saved = true; $('#sheet').close(); toast('삭제했어요'); render(); }
      }
      break;
    case 'csv': exportCsv(); break;
    case 'disconnect':
      if (Object.keys(S.outbox).length) { toast('공유 대기 기록이 있어요. 먼저 동기화해 주세요'); break; }
      if (confirm('이 기기 연결을 해제할까요? 기록은 구글 시트에 남아 있어요.')) { localStorage.removeItem(STORE); S = blank(); render(); }
      break;
  }
});
document.addEventListener('input', e => {
  const k = e.target.dataset && e.target.dataset.input;
  if (k === 'q') { filter.q = e.target.value; const pos = e.target.selectionStart; render(); const el = $('[data-input=q]'); el.focus(); el.setSelectionRange(pos, pos); }
  if (k === 'who') { filter.who = e.target.value; render(); }
  if (e.target.id === 'amount') {
    const n = e.target.value.replace(/[^\d]/g, '').slice(0, 10);
    e.target.value = n ? won(Number(n)) : '';
    $('#entry-err').textContent = '';
  }
});
document.addEventListener('change', e => {
  if (e.target.id === 'merchant') { draft.merchant = e.target.value.trim(); suggestFor(draft.merchant); }
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-form]'); if (!f) return;
  e.preventDefault();
  const kind = f.dataset.form;
  if (kind === 'entry') {
    readEntry(f);
    if (!draft.amount) { $('#entry-err').textContent = '금액을 입력해 주세요'; $('#amount').focus(); return; }
    if (draft.date > today()) { $('#entry-err').textContent = '미래 날짜는 기록할 수 없어요'; return; }
    if (upsert(draft)) { saved = true; S.draft = null; save(); $('#sheet').close(); toast('기록했어요'); render(); }
  }
  if (kind === 'setup') {
    try {
      const raw = $('#code').value.trim().replace(/\s/g, '');
      const cfg = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
      if (!/^(https:\/\/script\.google\.com\/|http:\/\/localhost[:/])/.test(cfg.url) || !cfg.key) throw 0;
      S.cfg = cfg; syncError = ''; save(); render(); sync(); toast('연결했어요');
    } catch (err) { $('#setup-err').textContent = '설정 코드를 확인해 주세요'; }
  }
  if (kind === 'settings') {
    const fd = new FormData(f);
    const list = k => String(fd.get(k) || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    S.pendingSettings = { cycle_start_day: Number(fd.get('cycle_start_day')), categories: list('categories'), methods: list('methods'), beneficiaries: list('beneficiaries') };
    S.settings = Object.assign({}, S.settings, S.pendingSettings);
    save(); toast('설정을 저장했어요'); render(); sync();
  }
});
// 저장하지 않고 닫은 새 기록은 초안으로 보관 (다음에 + 누르면 이어서)
function stashDraft() {
  const f = $('[data-form=entry]');
  if (!saved && !editing && draft && f) {
    readEntry(f);
    S.draft = (draft.amount || draft.merchant || draft.note) ? draft : null;
    save();
  }
  draft = null;
}
$('#sheet').addEventListener('cancel', stashDraft);
$('#sheet').addEventListener('close', () => { if (!$('#sheet').open) stashDraft(); }); // 늦게 온 close가 다시 연 창을 비우지 않게

function exportCsv() {
  const cols = ['date', 'merchant', 'amount', 'type', 'method', 'category', 'payer', 'beneficiary', 'note', 'refund_pending', 'created_by', 'id'];
  const head = ['날짜', '거래처', '금액', '종류', '결제수단', '분류', '결제자', '대상', '메모', '환불대기', '기록자', 'id'];
  const cell = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const rows = liveTxs().sort(byNewest).map(t => cols.map(c => c === 'type' ? TYPE_LABEL[t.type] : t[c]).map(cell).join(','));
  const blob = new Blob(['﻿' + [head.join(',')].concat(rows).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = '사이-가계부-' + today() + '.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------------- 아이폰 키보드 대응 ---------------- */
if (window.visualViewport) {
  const fit = () => document.documentElement.style.setProperty('--vvh', visualViewport.height + 'px');
  visualViewport.addEventListener('resize', fit); fit();
}
document.addEventListener('focusin', e => {
  if (e.target.closest('#sheet') && e.target.matches('input:not(#amount),select,textarea')) {
    setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
  }
});

/* ---------------- 시작 ---------------- */
window.addEventListener('online', () => { renderStatus(); sync(); });
window.addEventListener('offline', renderStatus);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
render();
sync();
