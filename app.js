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
// 결제자 목록 = 두 사람 + 공유 설정의 목록(시트 Settings의 beneficiaries 키를 결제자 목록으로 재사용, v16)
const payerList = () => [...new Set([...USERS, ...(S.settings.beneficiaries || [])])];
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
function toast(msg, action, onAction) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('act', !!action);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = action;
    b.onclick = () => { t.classList.remove('on'); clearTimeout(toastTimer); onAction(); };
    t.appendChild(b);
  }
  t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), action ? 5000 : 2200);
}

/* ---------------- 삭제: 확인 창 + 되돌리기 ---------------- */
function askDelete(id, after) {
  const t = S.txs[id]; if (!t) return;
  const dlg = $('#confirm');
  dlg.innerHTML = `<div class="confirm-box" tabindex="-1" autofocus>
    <b>이 기록을 삭제할까요?</b>
    <p>${esc(t.merchant || t.category || '기록한 지출')} · ${won(t.amount)}원<br><span class="muted">${md(t.date)} · 두 사람 모두에게서 지워져요</span></p>
    <div class="confirm-btns"><button type="button" value="cancel" class="btn ghost">취소</button><button type="button" value="ok" class="btn btn-del">삭제</button></div></div>`;
  // 닫힘 이벤트 대신 버튼에서 바로 처리 (close 이벤트는 늦게 올 수 있음)
  dlg.querySelector('[value=cancel]').onclick = () => { dlg.close(); closeSwipes(); };
  dlg.querySelector('[value=ok]').onclick = () => {
    dlg.close();
    const before = Object.assign({}, S.txs[id]);
    if (!upsert(Object.assign({}, before, { deleted: true }))) return;
    if (after) after();
    render();
    toast('삭제했어요', '되돌리기', () => { if (upsert(Object.assign({}, S.txs[id], { deleted: false }))) { render(); toast('되돌렸어요'); } });
  };
  dlg.oncancel = () => closeSwipes();
  dlg.showModal();
}

/* ---------------- 스와이프로 삭제 버튼 열기 (iOS 기본 앱처럼) ---------------- */
const SWIPE_W = 84;
let sw = null, swipedAt = 0;
function setX(row, x, animate) {
  const tx = row.querySelector('.tx'), del = row.querySelector('.swipe-del');
  tx.style.transition = del.style.transition = animate ? '' : 'none';
  tx.style.transform = x ? `translate3d(${x}px,0,0)` : '';
  const p = Math.max(0, Math.min(1, -x / SWIPE_W));
  del.tabIndex = row.classList.contains('open') ? 0 : -1;
  del.style.opacity = p ? String(0.35 + 0.65 * p) : '';
}
function closeSwipes(except) {
  document.querySelectorAll('.swipe.open, .swipe.dragging').forEach(el => {
    if (el !== except) { el.classList.remove('open', 'dragging'); setX(el, 0, true); }
  });
}
function swipeStart(row, x, y, t) {
  sw = { row, x, y, t, lastX: x, lastT: t, v: 0, base: row.classList.contains('open') ? -SWIPE_W : 0, cur: 0, mode: '' };
}
function swipeMove(x, y, t, ev) {
  if (!sw) return;
  const dx = x - sw.x, dy = y - sw.y;
  if (!sw.mode) {
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    sw.mode = Math.abs(dx) > Math.abs(dy) * 1.1 ? 'h' : 'v';
    if (sw.mode === 'h') { closeSwipes(sw.row); sw.row.classList.add('dragging'); }
  }
  if (sw.mode !== 'h') return;
  if (ev && ev.cancelable) ev.preventDefault(); // 가로로 미는 동안 세로 스크롤 멈춤
  const dt = Math.max(1, t - sw.lastT);
  sw.v = 0.8 * ((x - sw.lastX) / dt) + 0.2 * sw.v; sw.lastX = x; sw.lastT = t;
  let pos = sw.base + dx;
  if (pos > 0) pos = pos / 4;                                    // 오른쪽 끝 고무줄
  if (pos < -SWIPE_W) pos = -SWIPE_W + (pos + SWIPE_W) / 3;      // 왼쪽 끝 고무줄
  sw.cur = pos;
  setX(sw.row, pos, false);
}
function swipeEnd() {
  if (!sw) return;
  if (sw.mode === 'h') {
    const moved = sw.cur - sw.base;
    // 빠르게 튕기거나 20px 이상 밀면 그 방향으로 확정
    const open = Math.abs(moved) < 12 ? sw.base < 0
      : sw.v < -0.3 ? true : sw.v > 0.3 ? false : sw.base === 0 ? moved <= -20 : moved < 20;
    sw.row.classList.remove('dragging');
    sw.row.classList.toggle('open', open);
    setX(sw.row, open ? -SWIPE_W : 0, true);
    if (Math.abs(moved) >= 12) swipedAt = Date.now();
  }
  sw = null;
}
// 터치: iOS에서 가장 매끄러운 경로. 세로 스크롤과 충돌하지 않게 가로일 때만 preventDefault
document.addEventListener('touchstart', e => {
  const row = e.target.closest('.swipe');
  if (!row) { closeSwipes(); return; }
  if (e.target.closest('.swipe-del')) return;
  const p = e.touches[0]; swipeStart(row, p.clientX, p.clientY, e.timeStamp);
}, { passive: true });
document.addEventListener('touchmove', e => { const p = e.touches[0]; swipeMove(p.clientX, p.clientY, e.timeStamp, e); }, { passive: false });
document.addEventListener('touchend', swipeEnd);
function swipeCancel() {
  if (!sw) return;
  sw.row.classList.remove('dragging');
  setX(sw.row, sw.base, true);
  sw = null;
}
document.addEventListener('touchcancel', swipeCancel);
// 마우스(맥 브라우저)
document.addEventListener('pointerdown', e => {
  if (e.pointerType === 'touch') return;
  const row = e.target.closest('.swipe');
  if (!row) { closeSwipes(); return; }
  if (e.target.closest('.swipe-del')) return;
  swipeStart(row, e.clientX, e.clientY, e.timeStamp);
});
document.addEventListener('pointermove', e => { if (e.pointerType !== 'touch') swipeMove(e.clientX, e.clientY, e.timeStamp, null); });
document.addEventListener('pointerup', e => { if (e.pointerType !== 'touch') swipeEnd(); });
document.addEventListener('pointercancel', e => { if (e.pointerType !== 'touch') swipeCancel(); });
window.addEventListener('blur', swipeCancel);

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
    if (fillPayers()) syncAgain = true;
  } catch (e) {
    const why = e.code ? e.code + ' · ' + (e.message || '') : e.name === 'AbortError' ? '30초 응답 없음' : (e.name || '') + ' ' + (e.message || '');
    syncError = e.code === 'unauthorized' ? '설정 코드가 바뀌었어요. 설정 → 설정 코드 바꾸기'
      : navigator.onLine === false ? '' : '공유 실패 (' + why.trim().slice(0, 120) + ') · 기록은 이 기기에 안전해요';
  } finally {
    syncing = false;
    render();
    if (syncAgain) { syncAgain = false; sync(); }
  }
}
// 이관한 기존 기록은 결제자가 비어 있다 → 예전 '누구 몫' 값(없으면 공동)으로 채워 시트에도 반영
function fillPayers() {
  const todo = liveTxs().filter(t => !t.payer && !S.outbox[t.id]);
  todo.forEach(t => upsert(Object.assign({}, t, { payer: t.beneficiary || '공동' })));
  return todo.length > 0;
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
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (err) { const e = new Error('HTTP ' + res.status + ' JSON 아님: ' + text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 80)); e.code = 'bad_response'; throw e; }
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

// Patch only changed UI nodes. Stable keys keep focus, disclosures and transaction rows alive.
const painted = new WeakMap(), dirtyControls = new WeakSet();
let renderedScreen = '', lastMarkup = '';
const uiKey = el => el.nodeType === 1 ? el.id || el.dataset.uiKey || el.dataset.id
  || (el.dataset.act ? el.dataset.act + ':' + (el.dataset.v || '') : '')
  || (el.dataset.input ? 'input:' + el.dataset.input : '')
  || (el.dataset.form ? 'form:' + el.dataset.form : '') : '';
function patchUI(parent, next) {
  const old = [...parent.childNodes], used = new Set();
  const keyed = new Map(old.filter(uiKey).map(el => [uiKey(el), el]));
  let cursor = parent.firstChild;
  for (const wanted of [...next.childNodes]) {
    const key = uiKey(wanted);
    let current = key ? keyed.get(key) : old.find(el => !used.has(el) && !uiKey(el) && el.nodeType === wanted.nodeType && el.nodeName === wanted.nodeName);
    if (current && (current.nodeType !== wanted.nodeType || current.nodeName !== wanted.nodeName)) current = null;
    if (!current) current = wanted.cloneNode(true);
    used.add(current);
    if (current !== cursor) parent.insertBefore(current, cursor);
    if (current.nodeType === 1) {
      const markup = wanted.outerHTML;
      if (painted.get(current) !== markup) {
        const preserveValue = dirtyControls.has(current);
        const value = preserveValue ? current.value : null;
        for (const attr of [...current.attributes]) {
          if (current.tagName === 'DETAILS' && attr.name === 'open') continue;
          if (!wanted.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        }
        for (const attr of wanted.attributes) {
          if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
        }
        patchUI(current, wanted);
        if (preserveValue) current.value = value;
        else if (current.matches('input,select,textarea') && current.value !== wanted.value) current.value = wanted.value;
        painted.set(current, markup);
      }
    } else if (current.nodeValue !== wanted.nodeValue) current.nodeValue = wanted.nodeValue;
    cursor = current.nextSibling;
  }
  old.forEach(el => { if (!used.has(el)) el.remove(); });
}
function render() {
  const app = $('#app');
  const nextScreen = !S.cfg ? 'setup' : !S.me ? 'who' : tab;
  const markup = !S.cfg ? setupView() : !S.me ? whoView() : `<div class="wrap">
    <header class="top"><div class="brand">${logo()}사이</div>
      <button class="who" data-act="tab" data-v="settings">${esc(S.me)}의 기록</button></header>
    <main id="view">${tab === 'home' ? homeView() : tab === 'list' ? listView() : tab === 'recur' ? recurView() : settingsView()}</main>
  </div>
  <nav class="tabs" aria-label="메뉴">
    ${navBtn('home', '홈', 'home')}${navBtn('list', '내역', 'ledger')}
    <button class="plus" data-act="add" aria-label="지출 기록"><span class="add-icon">${icon('plus')}</span><span>기록</span></button>
    ${navBtn('recur', '정기', 'recurring')}${navBtn('settings', '설정', 'settings')}
  </nav>`;
  if (renderedScreen !== nextScreen) {
    app.innerHTML = markup;
    renderedScreen = nextScreen;
  } else if (markup !== lastMarkup) {
    const y = scrollY, active = document.activeElement;
    const selection = active && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    const anchor = [...app.querySelectorAll('[data-ui-key]')].find(el => {
      const r = el.getBoundingClientRect(); return r.top <= 100 && r.bottom > 100;
    });
    const top = anchor && anchor.getBoundingClientRect().top;
    const template = document.createElement('template');
    template.innerHTML = markup;
    patchUI(app, template.content);
    if (active && active.isConnected && document.activeElement !== active) {
      active.focus({ preventScroll: true });
      if (selection) active.setSelectionRange(...selection);
    }
    const shift = anchor && anchor.isConnected ? anchor.getBoundingClientRect().top - top : 0;
    scrollTo(0, Math.max(0, y + shift));
  }
  lastMarkup = markup;
  renderStatus();
}
const navBtn = (k, label, ic) => `<button data-act="tab" data-v="${k}" ${tab === k ? 'aria-current="page"' : ''}><span class="nav-icon">${icon(ic)}</span><span>${label}</span></button>`;
const logo = () => `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="M3 4H7Q9.25 4 11 5.5V20Q9.25 18.5 7 18.5H3Z M5 10V12H9V10Z"/><path d="M13 5.5Q14.75 4 17 4H21V18.5H17Q14.75 18.5 13 20Z M15 10V12H19V10Z"/></svg>`;

// 장부 로고의 둥근 모서리와 열린 선을 공유하는 24px 아이콘.
const ICONS = {
  home: '<path d="m3 10 9-7 9 7M5 9v11h5v-6h4v6h5V9"/>',
  ledger: '<path d="M3 4h5a6 6 0 0 1 4 1.5A6 6 0 0 1 16 4h5v15h-5a6 6 0 0 0-4 1.5A6 6 0 0 0 8 19H3Z M12 5.5v15M6 9h3m6 0h3M6 13h3m6 0h3"/>',
  settings: '<path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h2m4 0h10"/><rect x="8" y="3.5" width="4" height="5" rx="1.5"/><rect x="14" y="9.5" width="4" height="5" rx="1.5"/><rect x="6" y="15.5" width="4" height="5" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="m14 6-6 6 6 6"/>',
  right: '<path d="m10 6 6 6-6 6"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  food: '<path d="M4 3v5a3 3 0 0 0 6 0V3M7 3v18M19 21V3c-4 2-5 7-5 10h5"/>',
  cafe: '<path d="M4 8h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5ZM16 9h2a3 3 0 0 1 0 6h-2M3 21h16M8 3v2m5-2v2"/>',
  parcel: '<path d="m3 7 9-4 9 4v11l-9 4-9-4ZM3 7l9 4 9-4M12 11v11M7.5 5l9 4v5"/>',
  shopping: '<path d="M5 8h14l1 13H4ZM8 9V6a4 4 0 0 1 8 0v3"/>',
  living: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 14h6v7"/>',
  health: '<rect x="3" y="6" width="18" height="15" rx="3"/><path d="M8 6V3h8v3M12 10v7m-3-3.5h6"/>',
  transit: '<rect x="5" y="3" width="14" height="16" rx="4"/><path d="M5 11h14M9 19l-2 3m8-3 2 3M8 15h1m6 0h1M9 6h6"/>',
  car: '<path d="m5 10 2-6h10l2 6M4 17h16v-7H4ZM6 17v3m12-3v3M7 13h1m8 0h1"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13M12 8H8a3 3 0 1 1 3-3Zm0 0h4a3 3 0 1 0-3-3Z"/>',
  recurring: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 10h18m-6 5a3 3 0 1 0 0 3m0-5v3h-3"/>',
  other: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  uncategorized: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/>',
};
function icon(name) {
  return `<svg class="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.other}</svg>`;
}
const CATEGORY_ICONS = { '식비': 'food', '카페': 'cafe', '쿠팡': 'parcel', '쇼핑': 'shopping', '생활': 'living', '병원': 'health', '교통': 'transit', '차량유지': 'car', '경조사': 'gift', '고정지출': 'recurring', '대출': 'recurring', '통신비': 'recurring', '보험': 'health', '구독': 'recurring', '기타': 'other', '미분류': 'uncategorized' };
function categoryIcon(category) {
  const key = category || '미분류';
  return Object.prototype.hasOwnProperty.call(CATEGORY_ICONS, key) ? icon(CATEGORY_ICONS[key]) : esc(Array.from(key)[0]);
}

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

/* ---------------- 홈: 분석 ---------------- */
let view = Object.assign({ mode: 'month', from: '', to: '', cats: [], benes: [], payers: [] }, S.view || {}, { benes: [] }); // 누구 몫은 v15에서 뺌
if (!['day', 'week', 'month', 'custom'].includes(view.mode)) view.mode = 'month'; // 예전 '주기' 보기 → 1개월
let hOff = 0; // 홈 기간 이동(0 = 오늘/이번 주/이번 달)
function saveView() { S.view = view; save(); }

const addDays = (s, k) => { const d = parseDate(s); d.setDate(d.getDate() + k); return ymd(d); };
const dayDiff = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);
const md = s => { const d = parseDate(s); return (d.getMonth() + 1) + '.' + d.getDate(); };
const man = n => {
  const a = Math.abs(n);
  const s = a >= 1e8 ? (a / 1e8).toFixed(a >= 1e9 ? 0 : 1).replace(/\.0$/, '') + '억'
    : a >= 1e5 ? (Math.round(a / 1e3) / 10).toLocaleString('ko-KR', { maximumFractionDigits: a >= 1e6 ? 0 : 1 }) + '만'
    : a >= 1e4 ? (a / 1e4).toFixed(1).replace(/\.0$/, '') + '만' : won(a);
  return (n < 0 ? '−' : '') + s;
};
const MODES = [['day', '1일'], ['week', '1주'], ['month', '1개월'], ['custom', '기간 지정']];
const UNIT = { day: { name: '일', prev: '전날', trend: 14, trendName: '일별' }, week: { name: '주', prev: '지난주', trend: 8, trendName: '주별' }, month: { name: '달', prev: '지난달', trend: 6, trendName: '월별' } };

/* 단위 기간: 1일, 1주(월~일), 1개월(카드 결제 주기) */
function unitRange(unit, off) {
  if (unit === 'day') { const d = addDays(today(), off); return { start: d, end: d }; }
  if (unit === 'week') {
    const now = parseDate(today()), mon = addDays(today(), -((now.getDay() + 6) % 7) + 7 * off);
    return { start: mon, end: addDays(mon, 6) };
  }
  const c = cycleRange(off); return { start: c.start, end: c.end };
}
function unitLabel(unit, off, r) {
  if (unit === 'day') {
    const d = parseDate(r.start);
    return { title: off === 0 ? '오늘' : off === -1 ? '어제' : (d.getMonth() + 1) + '월 ' + d.getDate() + '일', range: md(r.start) + ' (' + WEEK[d.getDay()] + ')' };
  }
  if (unit === 'week') return { title: off === 0 ? '이번 주' : off === -1 ? '지난주' : -off + '주 전', range: md(r.start) + ' - ' + md(r.end) };
  return { title: off === 0 ? '이번 달' : off === -1 ? '지난달' : parseDate(r.start).getFullYear() + '년 ' + (parseDate(r.start).getMonth() + 1) + '월', range: md(r.start) + ' - ' + md(r.end) };
}

function periodRange() {
  if (view.mode === 'custom' && view.from && view.to) {
    const [a, b] = view.from <= view.to ? [view.from, view.to] : [view.to, view.from];
    return { start: a, end: b, title: '지정 기간', label: md(a) + ' - ' + md(b), custom: true };
  }
  const unit = view.mode === 'custom' ? 'month' : view.mode;
  const r = unitRange(unit, hOff), l = unitLabel(unit, hOff, r);
  return Object.assign(r, { unit, title: l.title, label: l.range });
}
function prevRange(r) {
  if (r.custom) { const len = dayDiff(r.start, r.end) + 1; const end = addDays(r.start, -1); return { start: addDays(end, -(len - 1)), end }; }
  return unitRange(r.unit, hOff - 1);
}
function cycleOffsetOf(date) {
  for (let k = 0; k > -120; k--) if (cycleRange(k).start <= date) return k;
  return -120;
}
const matches = t => (!view.cats.length || view.cats.includes(t.category || '미분류'))
  && (!view.payers.length || view.payers.includes(t.payer || '공동'));
const pick = r => liveTxs().filter(t => t.type !== 'transfer' && t.date >= r.start && t.date <= r.end && matches(t));
const sum = txs => txs.reduce((s, t) => s + signed(t), 0);
function groupSum(txs, key) {
  const m = {};
  txs.forEach(t => { const k = key(t); m[k] = (m[k] || 0) + signed(t); });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(x => f <= x) * p;
}

function homeView() {
  const r = periodRange(), pr = prevRange(r), td = today();
  const txs = pick(r), prevTxs = pick(pr);
  const total = sum(txs), prevTotal = sum(prevTxs);
  const running = td >= r.start && td <= r.end;
  const spanDays = dayDiff(r.start, r.end) + 1;
  const elapsed = running ? dayDiff(r.start, td) + 1 : spanDays;
  const avg = elapsed > 0 ? total / elapsed : 0;
  const cmpName = r.custom ? '이전 같은 기간'
    : hOff === 0 ? { day: '어제', week: '지난주', month: '지난달' }[r.unit]
    : { day: '그 전날', week: '그 전 주', month: '그 전 달' }[r.unit];
  const diff = total - prevTotal;
  const filtered = view.cats.length + view.payers.length;

  let pace = '';
  if (running && r.unit === 'month' && elapsed >= 3 && total > 0) {
    const proj = Math.round(avg * spanDays);
    const prevSame = sum(prevTxs.filter(t => dayDiff(pr.start, t.date) < elapsed));
    const d2 = total - prevSame;
    pace = `<div class="pace" aria-label="이번 달 예상과 지난달 같은 시점 비교"><span>예상 <b class="num">약 ${man(proj)}원</b></span>` +
      (prevTxs.length ? `<span>지난달 이맘때 <b class="num">${d2 >= 0 ? '+' : '−'}${man(Math.abs(d2))}원</b></span>` : '') + `</div>`;
  }

  const periods = `<div class="seg seg4" role="group" aria-label="기간">${MODES.map(([k, l]) => `<button data-act="vmode" data-v="${k}" aria-pressed="${view.mode === k}">${l}</button>`).join('')}</div>`;
  const head = `
    ${view.mode === 'custom' ? `<div class="row2 custom-dates" data-ui-key="custom-dates">
      <label>시작일<input type="date" class="in" data-input="vfrom" value="${esc(view.from || r.start)}" max="${td}" aria-label="시작일"></label>
      <label>끝일<input type="date" class="in" data-input="vto" value="${esc(view.to || r.end)}" max="${td}" aria-label="끝일"></label></div>` : ''}
    <div class="filters" data-ui-key="filters" role="group" aria-label="지출 필터">
      ${[['cats', '분류'], ['payers', '결제자']].map(([k, l]) => `<button class="chip" data-act="vfilter" data-v="${k}" aria-pressed="${view[k].length > 0}"><span>${l}${view[k].length ? ' ' + view[k].length : ''}</span>${icon('down')}</button>`).join('')}
      ${filtered ? '<button class="link" data-act="vclear">초기화</button>' : ''}
    </div>
    ${filtered ? `<p class="hint filter-summary" data-ui-key="filter-summary">${esc([...view.cats, ...view.payers.map(p => p + ' 결제')].join(' · '))}만 보는 중</p>` : ''}
    <p class="status" id="status" role="status"></p>`;

  const hero = `
    <section data-ui-key="hero" class="hero home-hero" aria-label="기간 요약">
      <div class="cyc">
        <div class="lbl"><b>${esc(r.title)} ${filtered ? '선택 지출' : '순지출'}</b><span>${r.label}</span></div>
        ${r.custom ? '' : `<div class="cyc-actions"><button data-act="hcyc" data-v="-1" aria-label="이전 ${UNIT[r.unit].name}">${icon('left')}</button><button data-act="hcyc" data-v="1" aria-label="다음 ${UNIT[r.unit].name}" ${hOff >= 0 ? 'disabled' : ''}>${icon('right')}</button></div>`}
      </div>
      <div class="amt num">${won(total)}<small>원</small></div>
      <div class="sub"><span>${txs.length}건${spanDays > 1 ? ` · 하루 평균 ${man(Math.round(avg))}원` : ''}</span></div>
      ${prevTxs.length || prevTotal ? `<div class="delta">${cmpName} 대비 <b class="num">${diff >= 0 ? '+' : '−'}${won(Math.abs(diff))}원</b>${prevTotal > 0 ? ` <span>(${diff >= 0 ? '+' : '−'}${Math.abs(Math.round(diff / prevTotal * 100))}%)</span>` : ''}</div>` : `<div class="delta">${cmpName} 기록이 쌓이면 비교해 드려요</div>`}
      ${pace}
      ${periods}
    </section>`;

  const budget = filtered ? '' : budgetBlock(r, total, running, elapsed, spanDays);
  if (!txs.length) {
    return hero + budget + head + recentBlock() + `<div class="card empty-period" data-ui-key="empty-period"><div class="empty">${filtered ? '이 조건의 지출이 없어요.<br>필터를 바꾸면 다른 기록을 볼 수 있어요.' : '이 기간의 지출이 없어요.<br>기록이 쌓이면 여기에 분석이 보여요.'}</div></div>`;
  }

  const cats = groupSum(txs, t => t.category || '미분류');
  const payers = groupSum(txs, t => t.payer || '공동');
  const merch = groupSum(txs.filter(t => t.merchant), t => t.merchant).slice(0, 5);
  const counts = {}; txs.forEach(t => { if (t.merchant) counts[t.merchant] = (counts[t.merchant] || 0) + 1; });

  return hero + budget + head + recentBlock() +
    (r.unit === 'month' ? paceChart(r, pr, txs, prevTxs, running ? elapsed : spanDays) : '') +
    trendChart(r) +
    `<h2 data-ui-key="cats-title">분류별 <span class="h2sub">눌러서 그 분류만 보기</span></h2>` + rankBars(cats, 'vcat', view.cats, 8) +
    (payers.length > 1 || view.payers.length ? `<h2 data-ui-key="payers-title">결제자</h2>` + rankBars(payers, 'vpayer', view.payers) : '') +
    (merch.length ? `<h2 data-ui-key="merchants-title">많이 쓴 곳</h2><div class="card" data-ui-key="merchants">${merch.map(([m, v], i) => `
      <div class="bar-row"><div class="bar-top"><span>${i + 1}. ${esc(m)} <span class="muted">${counts[m]}건</span></span><b class="num">${won(v)}원</b></div></div>`).join('')}</div>` : '');
}

/* ---------------- 예산 ---------------- */
// 예산은 공유 설정 prefs.budget = { total, cats: { 분류: 금액 } }. 한 달 = 카드 결제 주기.
const budgetOf = () => (S.settings.prefs && S.settings.prefs.budget) || { total: 0, cats: {} };
function budgetBlock(r, total, running, elapsed, spanDays) {
  if (r.unit !== 'month' || r.custom) return '';
  const b = budgetOf(), cats = Object.entries(b.cats || {}).filter(([, v]) => v > 0);
  if (!b.total && !cats.length) {
    return hOff === 0 ? `<button class="budget-cta" data-act="budget" data-ui-key="budget-cta">${icon('plus')}<span>이번 달 예산 정하기 <span class="muted">남은 돈과 하루 쓸 돈을 보여드려요</span></span></button>` : '';
  }
  const left = Math.max(0, spanDays - elapsed) + (running ? 1 : 0); // 오늘 포함 남은 날
  const line = (spent, budget) => {
    const rest = budget - spent;
    if (rest < 0) return `<span class="over">예산보다 ${won(-rest)}원 더 썼어요</span>`;
    return running ? `남은 돈 <b class="num">${won(rest)}원</b>${left > 0 ? ` · 하루 <b class="num">${won(Math.floor(rest / left))}원</b>` : ''}`
      : `<b class="num">${won(rest)}원</b> 남기고 마감했어요`;
  };
  const bar = (spent, budget) => `<div class="bar budget-bar${spent > budget ? ' full' : ''}" aria-hidden="true"><i style="width:${Math.min(100, Math.max(0, spent) / budget * 100)}%"></i>${running && spanDays > 1 ? `<s style="left:${Math.min(100, elapsed / spanDays * 100)}%"></s>` : ''}</div>`;
  const all = pick(r);
  const catRows = cats.map(([c, v]) => {
    const spent = sum(all.filter(t => (t.category || '미분류') === c));
    return `<div class="bar-row"><div class="bar-top"><span>${esc(c)}</span><span class="num">${won(spent)} / ${won(v)}원</span></div>${bar(spent, v)}<div class="budget-line">${line(spent, v)}</div></div>`;
  }).join('');
  return `<section class="card budget" data-ui-key="budget" aria-label="예산">
    <div class="budget-h"><b>${hOff === 0 ? '이번 달' : '그 달'} 예산</b><button class="link" data-act="budget">수정</button></div>
    ${b.total ? `<div class="bar-row"><div class="bar-top"><span class="num">${won(total)} / ${won(b.total)}원</span><span class="pct num">${Math.round(Math.max(0, total) / b.total * 100)}%</span></div>${bar(total, b.total)}<div class="budget-line">${line(total, b.total)}</div></div>` : ''}
    ${catRows}
    ${running && spanDays > 1 ? '<p class="hint" style="margin:6px 0 8px">세로선은 오늘까지 지난 날의 비율이에요.</p>' : ''}
  </section>`;
}
function openBudget() {
  if (!S.settings.prefs) { toast('서버 업데이트가 필요해요 (Apps Script 새 버전)'); return; }
  const b = budgetOf(), cats = S.settings.categories;
  const dlg = $('#sheet');
  dlg.classList.remove('filter-sheet');
  dlg.innerHTML = `<form data-form="budget" novalidate>
    <div class="sheet-h"><button type="button" data-act="close">취소</button><b id="sheet-title" tabindex="-1" autofocus>예산</b><button type="submit" class="save">저장</button></div>
    <div class="sheet-b">
      <p class="hint" style="font-size:14px">한 달(카드 결제 주기) 기준이에요. 비워 두면 그 예산은 쓰지 않아요. 두 사람에게 같이 적용돼요.</p>
      <div class="field"><label for="b-total">한 달 전체 예산</label>
        <div class="amount-in"><input id="b-total" name="total" data-money inputmode="numeric" autocomplete="off" placeholder="0" value="${b.total ? won(b.total) : ''}" class="num"><span>원</span></div></div>
      <h2 style="margin-top:8px">분류별 예산 <span class="h2sub">필요한 분류만</span></h2>
      <div class="card">${cats.map((c, i) => `<label class="budget-cat" for="bc${i}"><span>${categoryIcon(c)}${esc(c)}</span>
        <span class="budget-in"><input id="bc${i}" name="cat:${esc(c)}" data-money inputmode="numeric" autocomplete="off" placeholder="-" value="${b.cats && b.cats[c] ? won(b.cats[c]) : ''}" class="num"><span>원</span></span></label>`).join('')}</div>
      <div class="field"><button class="btn" type="submit">저장</button></div>
    </div></form>`;
  dlg.showModal();
}
function saveBudget(f) {
  const fd = new FormData(f), num = v => Number(String(v || '').replace(/[^\d]/g, '')) || 0;
  const cats = {};
  for (const [k, v] of fd.entries()) if (k.startsWith('cat:') && num(v) > 0) cats[k.slice(4)] = num(v);
  const prefs = Object.assign({}, S.settings.prefs, { budget: { total: num(fd.get('total')), cats } });
  S.settings = Object.assign({}, S.settings, { prefs });
  S.pendingSettings = Object.assign({}, S.pendingSettings, { prefs });
  $('#sheet').close(); save(); render(); sync(); toast('예산을 저장했어요');
}

function rankBars(entries, act, selected, limit) {
  let list = entries;
  if (limit && list.length > limit) {
    const rest = list.slice(limit - 1);
    list = list.slice(0, limit - 1).concat([[`그 외 ${rest.length}개`, rest.reduce((s, e) => s + e[1], 0), true]]);
  }
  const pos = entries.reduce((s, e) => s + Math.max(0, e[1]), 0) || 1;
  const max = Math.max(1, ...list.map(e => e[1]));
  return `<div class="card" data-ui-key="rank-${act}">${list.map(([k, v, other]) => {
    const pct = Math.round(Math.max(0, v) / pos * 1000) / 10;
    const on = selected.includes(k);
    const inner = `<div class="bar-top"><span>${esc(k)}</span><span><b class="num">${won(v)}원</b> <span class="pct num">${pct}%</span></span></div>
      <div class="bar" aria-hidden="true"><i style="width:${Math.max(0, v) / max * 100}%"></i></div>`;
    return other ? `<div class="bar-row">${inner}</div>`
      : `<button class="bar-row as-btn${on ? ' on' : ''}" data-act="${act}" data-v="${esc(k)}" aria-pressed="${on}">${inner}</button>`;
  }).join('')}</div>`;
}

function recentBlock() {
  // 분석 기간을 바꿔도 방금 입력한 기록은 바로 확인할 수 있다.
  const recent = liveTxs().sort(byNewest).slice(0, 3);
  return `<section data-ui-key="recent" class="recent" aria-label="최근 기록">
    <div class="section-head"><div><h2>최근 기록</h2><p class="hint">전체 기간 · 최근 3건</p></div>
      <button class="quick-add" data-act="add">${icon('plus')}<span>지출 기록</span></button></div>
    <div class="card">${recent.length ? recent.map(txRow).join('') : '<div class="empty">첫 지출을 기록해 보세요.<br>두 사람의 기록이 여기에 모여요.</div>'}</div>
    <button class="recent-link link" data-act="tab" data-v="list">내역 보기${icon('right')}</button>
  </section>`;
}

/* 누적 지출: 이번 주기 vs 지난 주기 (같은 날짜 차수끼리) */
function paceChart(r, pr, txs, prevTxs, upto) {
  const N = dayDiff(r.start, r.end) + 1, M = dayDiff(pr.start, pr.end) + 1, D = Math.max(N, M);
  const cum = (list, start, len) => {
    const daily = Array(len).fill(0);
    list.forEach(t => { const i = dayDiff(start, t.date); if (i >= 0 && i < len) daily[i] += signed(t); });
    let s = 0; return daily.map(v => (s += v));
  };
  const cur = cum(txs, r.start, N).slice(0, upto), prev = prevTxs.length ? cum(prevTxs, pr.start, M) : [];
  const W = 340, H = 168, L = 40, R = 12, T = 14, B = 24;
  const ymax = niceMax(Math.max(1, ...cur, ...prev));
  const x = i => L + (D === 1 ? 0 : i / (D - 1) * (W - L - R));
  const y = v => T + (1 - Math.max(0, v) / ymax) * (H - T - B);
  const path = arr => arr.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join('');
  const ticks = [0, ymax / 2, ymax];
  const last = cur.length - 1;
  const pts = Array.from({ length: D }, (_, i) => ({ x: x(i), label: `${i + 1}일째 (${md(addDays(r.start, i))})`, a: cur[i], b: prev[i] }));
  return `<h2 data-ui-key="pace-title">누적 지출 흐름</h2>
  <div class="card chart-card" data-ui-key="pace-chart">
    <div class="legend"><span><i class="key" style="background:var(--accent)"></i>${hOff === 0 ? '이번 달' : '선택한 달'}</span>${prev.length ? `<span><i class="key" style="background:var(--prev)"></i>${hOff === 0 ? '지난달' : '그 전달'}</span>` : ''}</div>
    <div class="chart" data-pts='${esc(JSON.stringify(pts))}' data-w="${W}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="이번 달 누적 ${won(cur[last] || 0)}원${prev.length ? ', 지난달 최종 ' + won(prev[prev.length - 1]) + '원' : ''}">
      ${ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${man(v)}</text>`).join('')}
      <text x="${L}" y="${H - 6}" class="axis">1일</text><text x="${W - R}" y="${H - 6}" class="axis" text-anchor="end">${D}일</text>
      ${prev.length ? `<path d="${path(prev)}" class="ln prev"/>` : ''}
      ${cur.length ? `<path d="${path(cur)}L${x(last)} ${y(0)}L${x(0)} ${y(0)}Z" class="area"/><path d="${path(cur)}" class="ln cur"/>
      <circle cx="${x(last)}" cy="${y(cur[last])}" r="4.5" class="dot"/>` : ''}
      <line class="xh" y1="${T}" y2="${H - B}" x1="-10" x2="-10"/>
    </svg><div class="tip" role="status"></div></div>
    <p class="hint">달 시작(${md(r.start)})부터 같은 날짜끼리 비교해요. 누르면 그날까지 누적 금액이 보여요.</p>
  </div>`;
}

/* 주기별 지출 막대: 선택 기간에 걸친 주기는 진하게 */
function trendChart(r) {
  const unit = r.custom ? 'month' : r.unit, u = UNIT[unit];
  const endOff = r.custom ? cycleOffsetOf(r.end) : hOff;
  const n = u.trend;
  const periods = Array.from({ length: n }, (_, i) => { const off = endOff - (n - 1) + i, pr = unitRange(unit, off); return Object.assign(pr, unitLabel(unit, off, pr)); });
  const vals = periods.map(p => sum(pick(p)));
  const sel = periods.map(p => p.end >= r.start && p.start <= r.end);
  const W = 340, H = 160, L = 40, R = 8, T = 18, B = 24;
  const ymax = niceMax(Math.max(1, ...vals));
  const band = (W - L - R) / n, bw = Math.min(24, band * 0.6);
  const y = v => T + (1 - Math.max(0, v) / ymax) * (H - T - B);
  const td = today();
  const every = n > 8 ? 2 : 1;
  const bars = vals.map((v, i) => {
    const cx = L + band * (i + .5), top = y(v), base = y(0), h = Math.max(0, base - top), rr = Math.min(4, h);
    const d = h <= 0 ? '' : `M${cx - bw / 2} ${base}V${top + rr}Q${cx - bw / 2} ${top} ${cx - bw / 2 + rr} ${top}H${cx + bw / 2 - rr}Q${cx + bw / 2} ${top} ${cx + bw / 2} ${top + rr}V${base}Z`;
    const running = unit !== 'day' && td >= periods[i].start && td <= periods[i].end;
    const showX = (n - 1 - i) % every === 0;
    return `<path d="${d}" class="col${sel[i] ? ' sel' : ''}${running ? ' run' : ''}"/>
      ${showX ? `<text x="${cx}" y="${H - 6}" class="axis" text-anchor="middle">${md(periods[i].start)}</text>` : ''}
      ${sel[i] && h > 0 ? `<text x="${cx}" y="${top - 5}" class="val" text-anchor="middle">${man(v)}</text>` : ''}`;
  }).join('');
  const pts = periods.map((p, i) => ({ x: L + band * (i + .5), label: p.title + ' ' + p.range + (unit !== 'day' && td >= p.start && td <= p.end ? ' (진행 중)' : ''), a: vals[i] }));
  const done = vals.filter((v, i) => periods[i].end < td);
  const avg = done.length ? done.reduce((s, v) => s + v, 0) / done.length : 0;
  return `<h2 data-ui-key="trend-title">${u.trendName} 지출 <span class="h2sub">최근 ${n}${unit === 'month' ? '개월' : unit === 'week' ? '주' : '일'}</span></h2>
  <div class="card chart-card" data-ui-key="trend-chart">
    <div class="chart" data-pts='${esc(JSON.stringify(pts))}' data-w="${W}" data-bar="1">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="최근 ${n}${u.name} 지출, 평균 ${won(Math.round(avg))}원">
      <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="var(--soft)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--accent)" stroke-width="3"/></pattern></defs>
      ${[0, ymax / 2, ymax].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${man(v)}</text>`).join('')}
      ${bars}
    </svg><div class="tip" role="status"></div></div>
    <p class="hint">${done.length ? `${u.name === '일' ? '하루' : '한 ' + u.name} 평균 ${won(Math.round(avg))}원 (지난 ${done.length}${unit === 'month' ? '개월' : u.name} 기준)` : '비교할 지난 기간이 아직 없어요'}${unit !== 'day' ? ' · 진행 중은 빗금' : ''}</p>
    <details class="tbl"><summary>숫자로 보기</summary><table>${periods.map((p, i) => `<tr><td>${esc(p.title)} ${p.range}</td><td class="num">${won(vals[i])}원</td></tr>`).join('')}</table></details>
  </div>`;
}

/* 차트 탭/호버: 가장 가까운 점의 값을 보여준다 */
const chartPoints = new WeakMap();
function chartPoint(e) {
  const box = e.target.closest('.chart'); if (!box) return;
  let cached = chartPoints.get(box);
  if (!cached || cached.source !== box.dataset.pts) {
    cached = { source: box.dataset.pts, points: JSON.parse(box.dataset.pts) }; chartPoints.set(box, cached);
  }
  const pts = cached.points, svg = box.querySelector('svg'), rect = svg.getBoundingClientRect();
  const sx = (e.clientX - rect.left) / rect.width * Number(box.dataset.w);
  let best = 0; pts.forEach((p, i) => { if (Math.abs(p.x - sx) < Math.abs(pts[best].x - sx)) best = i; });
  const p = pts[best], tip = box.querySelector('.tip');
  if (p.a == null && p.b == null) { tip.classList.remove('on'); return; }
  tip.innerHTML = `<b>${esc(p.label)}</b>` + (p.a != null ? `<span>${box.dataset.bar ? '' : '이번 '}${won(p.a)}원</span>` : '') + (p.b != null ? `<span class="muted">지난 ${won(p.b)}원</span>` : '');
  const px = p.x / Number(box.dataset.w) * rect.width;
  const half = Math.min(tip.offsetWidth / 2, rect.width / 2);
  tip.style.left = Math.min(Math.max(px, half), rect.width - half) + 'px';
  tip.classList.add('on');
  const xh = box.querySelector('.xh'); if (xh) { xh.setAttribute('x1', p.x); xh.setAttribute('x2', p.x); xh.classList.add('on'); }
}
document.addEventListener('pointerdown', e => { if (e.target.closest('.chart')) chartPoint(e); else document.querySelectorAll('.tip.on,.xh.on').forEach(t => t.classList.remove('on')); });
document.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' && e.target.closest('.chart')) chartPoint(e); });

function filterSheet(kind) {
  const title = { cats: '분류', benes: '누구 몫', payers: '결제자' }[kind];
  const opts = kind === 'cats' ? [...new Set([...S.settings.categories, ...liveTxs().map(t => t.category || '미분류')])]
    : kind === 'benes' ? [...new Set([...S.settings.beneficiaries, ...liveTxs().map(t => t.beneficiary || '공동')])]
    : payerList();
  const dlg = $('#sheet');
  dlg.classList.add('filter-sheet');
  dlg.innerHTML = `<div class="sheet-h"><button type="button" data-act="close">닫기</button><b id="sheet-title" tabindex="-1" autofocus>${title}만 보기</b><button type="button" class="save" data-act="vapply" data-v="${kind}">적용</button></div>
    <div class="sheet-b"><p class="hint">여러 개 고를 수 있어요. 아무것도 안 고르면 전체예요.</p>
    <div class="chips" id="vopts" style="margin-top:12px">${opts.map(o => `<button type="button" class="chip" data-act="vtoggle" data-v="${esc(o)}" aria-pressed="${view[kind].includes(o)}">${esc(o)}</button>`).join('')}</div>
    <div class="field"><button type="button" class="btn" data-act="vapply" data-v="${kind}">적용</button></div>
    <div class="field"><button type="button" class="btn ghost" data-act="vnone" data-v="${kind}">전체 보기</button></div></div>`;
  dlg.showModal();
}

function txRow(t) {
  const cls = t.type === 'refund' ? 'ref' : t.type === 'transfer' ? 'ex' : '';
  const d = parseDate(t.date);
  return `<div class="swipe" data-id="${esc(t.id)}"><button class="swipe-del" data-act="askdel" data-v="${esc(t.id)}" tabindex="-1" aria-label="삭제">삭제</button><button class="tx" data-act="edit" data-v="${esc(t.id)}">
    <span class="ic" aria-hidden="true">${categoryIcon(t.category)}</span>
    <span class="mid"><span class="m">${esc(t.merchant || t.category || '기록한 지출')}</span>
      <span class="meta">${d.getMonth() + 1}.${d.getDate()} · ${esc(t.category || '미분류')} · ${esc(t.payer || '공동')} 결제
      ${t.refund_pending ? '<span class="tag">환불 대기</span>' : ''}${t.type === 'transfer' ? '<span class="tag q">지출 제외</span>' : ''}${t.created_by === '정기' ? '<span class="tag q">정기</span>' : ''}${S.outbox[t.id] ? '<span class="tag q">공유 대기</span>' : ''}</span></span>
    <span class="a num ${cls}">${t.type === 'refund' ? '<span class="refund-label">환불</span>+' : ''}${won(t.amount)}원</span></button></div>`;
}

function listView() {
  const r = cycleRange(offset);
  const q = filter.q.trim().toLowerCase();
  let txs = liveTxs().filter(t => filter.kind === 'refund_pending' ? t.refund_pending : inRange(t, r));
  if (filter.kind === 'transfer') txs = txs.filter(t => t.type === 'transfer');
  if (filter.kind === 'refund') txs = txs.filter(t => t.type === 'refund');
  if (filter.who) txs = txs.filter(t => t.payer === filter.who);
  if (q) txs = txs.filter(t => [t.merchant, t.note, t.category, t.method].join(' ').toLowerCase().includes(q));
  txs.sort(byNewest);
  const net = txs.reduce((s, t) => s + signed(t), 0);
  let lastDay = '', rows = '';
  txs.forEach(t => {
    if (t.date !== lastDay) {
      if (rows) rows += '</div>';
      const d = parseDate(t.date);
      rows += `<p class="day" data-ui-key="day-${t.date}">${d.getMonth() + 1}.${d.getDate()} ${WEEK[d.getDay()]}요일</p><div class="card" data-ui-key="rows-${t.date}">`;
      lastDay = t.date;
    }
    rows += txRow(t);
  });
  if (rows) rows += '</div>';
  const cal = view.list === 'cal' && filter.kind !== 'refund_pending';
  const kinds = [['all', '전체'], ['refund_pending', '환불 대기'], ['refund', '환불'], ['transfer', '지출 제외']];
  return `
    <div class="list-h"><h1>내역</h1>${filter.kind === 'refund_pending' ? '' : `<div class="seg seg2 lmode" role="group" aria-label="보기">${[['rows', '목록'], ['cal', '달력']].map(([k, l]) => `<button data-act="lmode" data-v="${k}" aria-pressed="${(view.list === 'cal') === (k === 'cal')}">${l}</button>`).join('')}</div>`}</div>
    ${filter.kind === 'refund_pending' ? '<p class="hint">환불 대기는 모든 기간에서 보여줘요.</p>' : `
    <div class="hero" data-ui-key="list-cycle" style="padding:8px 12px;margin-top:10px"><div class="cyc">
      <button data-act="cyc" data-v="-1" aria-label="이전 주기">${icon('left')}</button>
      <div class="lbl"><b>${offset === 0 ? '이번 달' : r.year + '년'}</b>${r.label}</div>
      <button data-act="cyc" data-v="1" aria-label="다음 주기" ${offset >= 0 ? 'disabled' : ''}>${icon('right')}</button></div></div>`}
    <input class="in search" type="search" placeholder="거래처, 메모 검색" value="${esc(filter.q)}" data-input="q" aria-label="검색">
    <div class="chips" data-ui-key="list-kinds" style="margin-top:10px">${kinds.map(([k, l]) => `<button class="chip" data-act="kind" data-v="${k}" aria-pressed="${filter.kind === k}">${l}</button>`).join('')}</div>
    <div class="field"><select class="in" data-input="who" aria-label="결제자">
      <option value="">모든 결제자</option>${payerList().map(b => `<option ${filter.who === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>
    <p class="status" id="status"></p>
    <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--muted);margin-top:8px"><span>${txs.length}건</span><span class="num">순지출 ${won(net)}원</span></div>
    ${cal ? calendar(r, txs) : rows || `<div class="empty">${q || filter.kind !== 'all' || filter.who ? '조건에 맞는 기록이 없어요.' : '이 기간의 기록이 없어요.'}</div>`}`;
}
// 달력: 한 달(결제 주기)을 일~토 격자로. 칸 = 그날 순지출, 진할수록 많이 쓴 날. 날짜를 누르면 그날 기록
let calDay = '';
const calAmt = n => { const a = Math.abs(n), s = a >= 1e5 ? Math.round(a / 1e4) + '만' : a >= 1e4 ? (a / 1e4).toFixed(1).replace(/\.0$/, '') + '만' : won(a); return (n < 0 ? '−' : '') + s; };
function calendar(r, txs) {
  const td = today(), byDay = {};
  txs.forEach(t => { (byDay[t.date] = byDay[t.date] || []).push(t); });
  const net = d => (byDay[d] || []).reduce((s, t) => s + signed(t), 0);
  const max = Math.max(1, ...Object.keys(byDay).map(net));
  const first = parseDate(r.start), cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push('<span class="cal-c pad"></span>');
  let spendDays = 0, zeroDays = 0;
  for (let d = r.start; d <= r.end; d = addDays(d, 1)) {
    const dt = parseDate(d), n = net(d), has = !!byDay[d], future = d > td;
    if (!future) { if (n > 0) spendDays++; else if (!has) zeroDays++; }
    const lvl = n > 0 ? Math.max(6, Math.round(n / max * 28)) : 0;
    const label = (dt.getDate() === 1 || d === r.start ? (dt.getMonth() + 1) + '.' : '') + dt.getDate();
    cells.push(`<button class="cal-c${future ? ' fut' : ''}${d === td ? ' today' : ''}${d === calDay ? ' sel' : ''}${dt.getDay() === 0 ? ' sun' : ''}" data-act="calday" data-v="${d}" ${future ? 'disabled' : ''}
      style="${lvl ? `--lvl:${lvl}%` : ''}" aria-label="${dt.getMonth() + 1}월 ${dt.getDate()}일 ${has ? won(n) + '원' : future ? '' : '지출 없음'}">
      <span class="cal-d">${label}</span>${has ? (n ? `<span class="cal-a num${n < 0 ? ' in' : ''}">${n < 0 ? '+' + calAmt(-n) : calAmt(n)}</span>` : '') : !future ? '<span class="cal-z" aria-hidden="true"></span>' : ''}</button>`);
  }
  const sel = calDay && byDay[calDay] ? byDay[calDay].slice().sort(byNewest) : null;
  return `<div class="card cal" data-ui-key="calendar">
    <div class="cal-g cal-w">${WEEK.map(w => `<span>${w}</span>`).join('')}</div>
    <div class="cal-g">${cells.join('')}</div>
    <p class="cal-legend"><span>지출한 날 ${spendDays}일</span><span><i class="cal-z"></i> 지출 없는 날 ${zeroDays}일</span></p></div>
    ${calDay ? `<p class="day" data-ui-key="calsel">${md(calDay)} ${WEEK[parseDate(calDay).getDay()]}요일</p>${sel ? `<div class="card" data-ui-key="calrows">${sel.map(txRow).join('')}</div>` : '<div class="card"><div class="empty">이날은 지출이 없어요.</div></div>'}`
      : '<p class="hint" style="text-align:center">날짜를 누르면 그날 기록을 보여줘요.</p>'}`;
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
      <div class="field"><label for="bns">결제자 (쉼표로 구분)</label><textarea id="bns" class="in" rows="2" name="beneficiaries">${esc(st.beneficiaries.join(', '))}</textarea>
        <p class="hint">아내·남편은 항상 있어요. 설정은 두 사람에게 같이 적용돼요.</p></div>
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
    <h2>앱 업데이트</h2>
    <p class="hint" style="font-size:14px" id="ver">${esc(verText())}</p>
    <div class="field"><button class="btn ghost" data-act="update">최신 버전 받기</button>
      <p class="hint">기록은 그대로 남아요. 홈 화면 앱을 지우고 다시 추가할 필요 없어요.</p></div>
    <p class="hint" style="text-align:center;margin-top:24px">사이 MVP · 기록 원본은 구글 시트에 있어요</p>`;
}

/* ---------------- 정기 지출 ---------------- */
// 규칙은 공유 설정(recurring)에 저장하고, 기록은 서버가 동기화·매일 새벽에 만든다(같은 날짜는 한 번만).
const rules = () => Array.isArray(S.settings.recurring) ? S.settings.recurring : null;
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const ruleWhen = r => r.freq === 'week' ? '매주 ' + DAY_NAMES[r.day] + '요일' : '매월 ' + (r.day >= 29 ? r.day + '일(없으면 말일)' : r.day + '일');
function nextDate(r) {
  const d = parseDate(r.start > today() ? r.start : today());
  for (let i = 0; i < 400; i++, d.setDate(d.getDate() + 1)) {
    const hit = r.freq === 'week' ? d.getDay() === r.day : d.getDate() === Math.min(r.day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate());
    const s = ymd(d);
    if (r.end && s > r.end) return '';
    if (hit && !S.txs['rec-' + r.id + '-' + s.replace(/-/g, '')]) return s; // 이미 기록된 날은 건너뜀
  }
  return '';
}
function recurView() {
  const list = rules();
  if (!list) return `<h1>정기 지출</h1>
    <div class="card"><div class="empty">서버 업데이트가 필요해요.<br>구글 시트의 Apps Script를 새 버전으로 바꾸면 쓸 수 있어요.</div></div>`;
  const total = list.filter(r => r.active && r.freq === 'month').reduce((a, r) => a + r.amount, 0);
  return `<h1>정기 지출</h1>
    <p class="hint" style="font-size:14px;margin-top:0">대출·통신비·보험처럼 정해진 날 나가는 돈을 등록하면 그날 자동으로 기록돼요. 금액이 달라지면 그 기록만 고치면 돼요.</p>
    ${list.length ? `<div class="card" data-ui-key="rules">${list.map(r => {
      const nx = r.active ? nextDate(r) : '';
      return `<div class="rule${r.active ? '' : ' off'}"><button class="tx" data-act="rule" data-v="${esc(r.id)}">
        <span class="ic" aria-hidden="true">${categoryIcon(r.category)}</span>
        <span class="mid"><span class="m">${esc(r.name)}</span>
          <span class="meta">${ruleWhen(r)} · ${esc(r.category || '미분류')}${r.active ? (nx ? ' · 다음 ' + Number(nx.slice(5, 7)) + '.' + Number(nx.slice(8)) : ' · 종료') : ' · 멈춤'}</span></span>
        <span class="a num">${won(r.amount)}원</span></button>
        <label class="rule-sw"><input type="checkbox" data-act="rtoggle" data-v="${esc(r.id)}" ${r.active ? 'checked' : ''} aria-label="${esc(r.name)} 자동 기록"></label></div>`;
    }).join('')}</div>
    ${total ? `<p class="hint">매월 고정으로 나가는 돈 ${won(total)}원 (매주 항목 제외)</p>` : ''}` : `<div class="card"><div class="empty">등록한 정기 지출이 없어요.</div></div>`}
    <div class="field"><button class="btn" data-act="rule">정기 지출 추가</button></div>`;
}
let ruleDraft = null;
function openRule(id) {
  const ex = id && (rules() || []).find(r => r.id === id);
  ruleDraft = ex ? Object.assign({}, ex) : {
    id: uid().replace(/[^A-Za-z0-9]/g, '').slice(0, 12), name: '', amount: 0, category: '', method: S.settings.methods[0] || '',
    payer: S.me, beneficiary: defaultBene(), freq: 'month', day: new Date().getDate(), start: today(), end: '', active: true, isNew: true,
  };
  const dlg = $('#sheet');
  dlg.classList.remove('filter-sheet');
  dlg.innerHTML = ruleHtml();
  dlg.showModal();
}
function ruleHtml() {
  const d = ruleDraft, st = S.settings;
  const methods = st.methods.includes(d.method) || !d.method ? st.methods : st.methods.concat(d.method);
  const days = d.freq === 'week' ? DAY_NAMES.map((n, i) => [i, n + '요일']) : Array.from({ length: 31 }, (_, i) => [i + 1, (i + 1) + '일']);
  return `<form data-form="rule" novalidate>
    <div class="sheet-h"><button type="button" data-act="close">취소</button><b id="sheet-title" tabindex="-1" autofocus>${d.isNew ? '정기 지출 추가' : '정기 지출 수정'}</b><button type="submit" class="save">저장</button></div>
    <div class="sheet-b">
      <div class="field"><label for="r-name">이름</label><input id="r-name" name="name" class="in" autocomplete="off" placeholder="예: 핸드폰비, 주택담보대출, 실손보험" value="${esc(d.name)}"></div>
      <div class="field"><label for="r-amount">금액</label>
        <div class="amount-in"><input id="r-amount" name="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${d.amount ? won(d.amount) : ''}" class="num"><span>원</span></div>
        <div class="err" id="rule-err"></div></div>
      <div class="field"><label for="r-cat">분류</label><input id="r-cat" name="category" class="in" list="r-cats" autocomplete="off" placeholder="예: 대출, 통신비, 보험" value="${esc(d.category)}">
        <datalist id="r-cats">${[...new Set(['대출', '통신비', '보험', '구독', ...st.categories])].map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <p class="hint">새 분류를 적으면 분류 목록에도 추가돼요.</p></div>
      <div class="field"><span class="lab">반복</span><div class="seg seg2">${[['month', '매월'], ['week', '매주']].map(([k, l]) => `<button type="button" data-act="rfreq" data-v="${k}" aria-pressed="${d.freq === k}">${l}</button>`).join('')}</div></div>
      <div class="field"><label for="r-day">${d.freq === 'week' ? '요일' : '날짜'}</label><select id="r-day" name="day" class="in">${days.map(([v, l]) => `<option value="${v}" ${Number(d.day) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${d.freq === 'month' ? '<p class="hint">29~31일은 그날이 없는 달엔 말일에 기록돼요.</p>' : ''}</div>
      <div class="row2">
        <div class="field"><label for="r-payer">결제자</label><select id="r-payer" name="payer" class="in">${payerList().map(u => `<option ${d.payer === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
        <div class="field"><label for="r-method">결제수단</label><select id="r-method" name="method" class="in">${methods.map(m => `<option ${d.method === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
      </div>
      <div class="row2">
        <div class="field"><label for="r-start">시작일</label><input id="r-start" name="start" type="date" class="in" value="${esc(d.start)}"></div>
        <div class="field"><label for="r-end">종료일 (선택)</label><input id="r-end" name="end" type="date" class="in" value="${esc(d.end)}"></div>
      </div>
      <p class="hint">시작일을 과거로 잡으면 그때부터 빠진 달도 한 번에 기록돼요. 대출 만기처럼 끝나는 날이 있으면 종료일을 넣어요.</p>
      <div class="field"><button class="btn" type="submit">저장</button></div>
      ${d.isNew ? '' : `<div class="field"><button type="button" class="btn danger" data-act="rdelete">이 정기 지출 삭제</button><p class="hint">이미 기록된 지출은 남아요.</p></div>`}
    </div></form>`;
}
function putRules(list, extra) {
  S.settings = Object.assign({}, S.settings, extra || {}, { recurring: list });
  S.pendingSettings = Object.assign({}, S.pendingSettings, extra || {}, { recurring: list });
  save(); render(); sync();
}
function readRule(f) {
  const fd = new FormData(f), d = ruleDraft;
  d.name = String(fd.get('name') || '').trim();
  d.amount = Number(String(fd.get('amount') || '').replace(/[^\d]/g, ''));
  d.category = String(fd.get('category') || '').trim();
  d.day = Number(fd.get('day')); d.payer = fd.get('payer'); d.method = fd.get('method');
  d.start = fd.get('start') || today(); d.end = fd.get('end') || '';
}
function saveRule(f) {
  readRule(f);
  const d = ruleDraft;
  const err = m => { $('#rule-err').textContent = m; };
  if (!d.name) return err('이름을 입력해 주세요');
  if (!d.amount) return err('금액을 입력해 주세요');
  if (d.end && d.end < d.start) return err('종료일이 시작일보다 빨라요');
  const isNew = d.isNew; delete d.isNew;
  const list = (rules() || []).filter(r => r.id !== d.id);
  const old = (rules() || []).findIndex(r => r.id === d.id);
  list.splice(old < 0 ? list.length : old, 0, d);
  const extra = d.category && !S.settings.categories.includes(d.category) ? { categories: S.settings.categories.concat(d.category) } : null;
  $('#sheet').close();
  putRules(list, extra);
  toast(isNew ? '정기 지출을 등록했어요' : '정기 지출을 고쳤어요');
}
function toggleRule(id) {
  putRules((rules() || []).map(r => r.id === id ? Object.assign({}, r, { active: !r.active }) : r));
}
function deleteRule() {
  if (!confirm('이 정기 지출을 삭제할까요? 이미 기록된 지출은 남아요.')) return;
  const id = ruleDraft.id;
  $('#sheet').close();
  putRules((rules() || []).filter(r => r.id !== id));
  toast('삭제했어요');
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
// 누구 몫은 화면에서 뺐고(v15) 데이터에는 '공동'으로 남긴다
const defaultBene = () => S.settings.beneficiaries.includes('공동') ? '공동' : S.settings.beneficiaries[0] || '공동';
function openEntry(id) {
  const ex = id && S.txs[id];
  editing = !!ex;
  const last = Object.values(S.txs).filter(t => t.created_by === S.me).sort((a, b) => b.created_at - a.created_at)[0];
  draft = ex ? Object.assign({}, ex) : {
    id: uid(), date: today(), merchant: '', amount: 0, type: 'expense',
    method: (last && last.method) || S.settings.methods[0] || '', category: '',
    payer: S.me, beneficiary: defaultBene(), note: '', refund_pending: false,
    created_by: S.me, created_at: Date.now(), updated_at: 0, deleted: false,
  };
  if (!ex && S.draft && S.draft.created_by === S.me) draft = Object.assign({}, S.draft, { id: uid(), created_at: Date.now() });
  saved = false;
  const dlg = $('#sheet');
  dlg.classList.remove('filter-sheet');
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
  return `<form data-form="entry" novalidate>
    <div class="sheet-h"><button type="button" data-act="close">취소</button><b id="sheet-title" tabindex="-1" autofocus>${isEdit ? '기록 수정' : '지출 기록'}</b><button type="submit" class="save">저장</button></div>
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
      <summary>날짜·결제자·결제수단 <span class="sum">${esc(summaryLine())}</span></summary>
      <div class="row2">
        <div class="field"><label for="date">날짜</label><input id="date" name="date" type="date" class="in" value="${esc(d.date)}" max="${today()}"></div>
        <div class="field"><label for="payer">결제자</label><select id="payer" name="payer" class="in">${payerList().map(u => `<option ${d.payer === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
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
  return [d.date === today() ? '오늘' : d.date.slice(5).replace('-', '.'), d.payer + ' 결제', d.method].filter(Boolean).join(' · ');
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
  refreshSummary();
}

/* ---------------- 이벤트 ---------------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const v = b.dataset.v;
  switch (b.dataset.act) {
    case 'tab': tab = v; if (v === 'list' && filter.kind === 'refund_pending') filter.kind = 'all'; render(); scrollTo(0, 0); break;
    case 'add': openEntry(); break;
    case 'edit': {
      const row = b.closest('.swipe');
      if (Date.now() - swipedAt < 350) break;
      if (row && row.classList.contains('open')) { closeSwipes(); break; }
      openEntry(v); break;
    }
    case 'askdel': askDelete(v); break;
    case 'close': stashDraft(); $('#sheet').close(); break;
    case 'cyc': offset = Math.min(0, offset + Number(v)); render(); break;
    case 'vmode': if (view.mode === v) break; view.mode = v; hOff = 0; if (v === 'custom' && !view.from) { const r = cycleRange(0); view.from = r.start; view.to = today(); } saveView(); render(); break;
    case 'hcyc': hOff = Math.min(0, hOff + Number(v)); render(); break;
    case 'vfilter': filterSheet(v); break;
    case 'vtoggle': b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); break;
    case 'vapply': view[v] = [...document.querySelectorAll('#vopts [aria-pressed=true]')].map(x => x.dataset.v); saveView(); $('#sheet').close(); render(); break;
    case 'vnone': view[v] = []; saveView(); $('#sheet').close(); render(); break;
    case 'vclear': view.cats = []; view.benes = []; view.payers = []; saveView(); render(); break;
    case 'vcat': case 'vbene': case 'vpayer': {
      const k = { vcat: 'cats', vbene: 'benes', vpayer: 'payers' }[b.dataset.act];
      view[k] = view[k].includes(v) ? view[k].filter(x => x !== v) : [...view[k], v]; saveView(); render(); break;
    }
    case 'refunds': tab = 'list'; filter.kind = 'refund_pending'; render(); break;
    case 'kind': if (filter.kind === v) break; filter.kind = v; render(); break;
    case 'me': S.me = v; save(); render(); break;
    case 'sync': sync(); break;
    case 'merchant': $('#merchant').value = v; draft.merchant = v; suggestFor(v); break;
    case 'cat': draft.category = draft.category === v ? '' : v; setPressed(b.parentElement, draft.category); break;
    case 'type': draft.type = v; setPressed(b.parentElement, v); break;
    case 'delete':
      { const id = draft.id; askDelete(id, () => { saved = true; $('#sheet').close(); }); }
      break;
    case 'csv': exportCsv(); break;
    case 'update': applyUpdate(); break;
    case 'rule': openRule(v); break;
    case 'budget': openBudget(); break;
    case 'lmode': view.list = v; calDay = ''; saveView(); render(); break;
    case 'calday': calDay = calDay === v ? '' : v; render(); break;
    case 'rfreq': readRule($('[data-form=rule]')); ruleDraft.freq = v; ruleDraft.day = v === 'week' ? 1 : Math.min(28, new Date().getDate()); $('#sheet').innerHTML = ruleHtml(); break;
    case 'rtoggle': toggleRule(v); break;
    case 'rdelete': deleteRule(); break;
    case 'disconnect':
      if (Object.keys(S.outbox).length) { toast('공유 대기 기록이 있어요. 먼저 동기화해 주세요'); break; }
      if (confirm('이 기기 연결을 해제할까요? 기록은 구글 시트에 남아 있어요.')) { localStorage.removeItem(STORE); S = blank(); render(); }
      break;
  }
});
document.addEventListener('input', e => {
  const k = e.target.dataset && e.target.dataset.input;
  if (e.target.matches('[data-form=settings] input,[data-form=settings] select,[data-form=settings] textarea,[data-form=setup] input,[data-form=setup] textarea')) dirtyControls.add(e.target);
  if (k === 'q') { filter.q = e.target.value; if (!e.isComposing) render(); }
  if (k === 'who') { filter.who = e.target.value; render(); }
  if (k === 'vfrom' || k === 'vto') { if (e.target.value) { view[k === 'vfrom' ? 'from' : 'to'] = e.target.value; saveView(); render(); } }
  if (e.target.id === 'amount' || e.target.id === 'r-amount' || e.target.dataset.money !== undefined) {
    const n = e.target.value.replace(/[^\d]/g, '').slice(0, 10);
    e.target.value = n ? won(Number(n)) : '';
    const err = $(e.target.id === 'amount' ? '#entry-err' : '#rule-err'); if (err) err.textContent = '';
  }
});
document.addEventListener('compositionend', e => { if (e.target.dataset.input === 'q') { filter.q = e.target.value; render(); } });
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
  if (kind === 'rule') { saveRule(f); return; }
  if (kind === 'budget') { saveBudget(f); return; }
  if (kind === 'setup') {
    let cfg;
    try {
      const raw = $('#code').value.trim().replace(/\s/g, '');
      cfg = JSON.parse(decodeURIComponent(escape(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))));
      if (!cfg.key) throw 0;
    } catch (err) { $('#setup-err').textContent = '설정 코드를 확인해 주세요'; return; }
    // 편집기에서 만든 코드는 주소가 테스트용(/dev)일 수 있다 → 배포 주소(/exec)를 따로 받는다
    const execEl = $('#exec-url');
    const execUrl = execEl ? execEl.value.trim() : '';
    if (execUrl) {
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(execUrl)) { $('#setup-err').textContent = '…/exec 로 끝나는 배포 주소를 넣어 주세요'; return; }
      cfg.url = execUrl;
    }
    if (!/^(https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$|http:\/\/localhost[:/])/.test(cfg.url)) {
      if (!execEl) {
        f.insertAdjacentHTML('beforeend', `<div class="field" id="exec-box"><label for="exec-url">배포 주소 (…/exec)</label>
          <input id="exec-url" class="in" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec">
          <p class="hint">설정 코드 속 주소가 배포 주소가 아니에요. Apps Script → 배포 → 배포 관리에서 웹 앱 URL을 복사해 넣고 다시 눌러 주세요.</p></div>`);
        f.appendChild(f.querySelector('button[type=submit]'));
      }
      $('#setup-err').textContent = '배포 주소가 필요해요';
      $('#exec-url').focus();
      return;
    }
    S.cfg = cfg; syncError = ''; save(); render(); sync(); toast('연결했어요');
  }
  if (kind === 'settings') {
    const fd = new FormData(f);
    const list = k => String(fd.get(k) || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    S.pendingSettings = Object.assign({}, S.pendingSettings, { cycle_start_day: Number(fd.get('cycle_start_day')), categories: list('categories'), methods: list('methods'), beneficiaries: list('beneficiaries') });
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
  const fit = () => {
    document.documentElement.style.setProperty('--vvh', visualViewport.height + 'px');
    document.documentElement.style.setProperty('--vvt', visualViewport.offsetTop + 'px');
  };
  visualViewport.addEventListener('resize', fit);
  visualViewport.addEventListener('scroll', fit); fit();
}
document.addEventListener('focusin', e => {
  if (e.target.closest('#sheet') && e.target.matches('input:not(#amount),select,textarea')) {
    setTimeout(() => {
      if (document.activeElement === e.target && e.target.isConnected) e.target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }, 250);
  }
});

/* ---------------- 앱 업데이트 ---------------- */
// 버전 = sw.js의 CACHE 이름. 이 화면을 연 시점의 버전과 지금 서버의 sw.js를 비교한다.
let verRunning = '', verLatest = '', verCheckedAt = 0;
function verText() {
  if (!verRunning) return '버전 확인 중';
  return '현재 ' + verRunning + (verLatest !== verRunning ? ' · 새 버전이 있어요 (' + verLatest + ')' : ' · 최신이에요');
}
async function checkUpdate(force) {
  if (!force && Date.now() - verCheckedAt < 5 * 60e3) return verLatest !== verRunning;
  verCheckedAt = Date.now();
  try {
    const src = await (await fetch('sw.js?t=' + Date.now(), { cache: 'no-store' })).text();
    const v = (src.match(/sai-shell-([\w.-]+)/) || [])[1];
    if (v) { verLatest = v; if (!verRunning) verRunning = v; }
  } catch (e) { return false; }
  const el = $('#ver'); if (el) el.textContent = verText();
  return verLatest !== verRunning;
}
async function applyUpdate() {
  if ($('#sheet').open) { toast('입력을 마친 뒤 업데이트해 주세요'); return; }
  if (!('serviceWorker' in navigator)) { location.reload(); return; }
  toast('최신 버전을 받는 중이에요');
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      await reg.update();
      const w = reg.installing || reg.waiting;
      if (w && w.state !== 'activated') await new Promise(r => { w.addEventListener('statechange', () => { if (w.state === 'activated' || w.state === 'redundant') r(); }); setTimeout(r, 8000); });
    }
  } catch (e) { /* 오프라인이면 그냥 다시 연다 */ }
  location.reload();
}
async function autoCheckUpdate() {
  if (await checkUpdate(false) && !$('#sheet').open) toast('새 버전이 있어요', '적용', applyUpdate);
}

/* ---------------- 시작 ---------------- */
window.addEventListener('online', () => { renderStatus(); sync(); });
window.addEventListener('offline', renderStatus);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { sync(); autoCheckUpdate(); } });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
render();
sync();
setTimeout(autoCheckUpdate, 3000);
