'use strict';

/* ---------------- 데이터 층 연결 ----------------
 * 저장·동기화·연결은 store.js(store.*)만 거친다. 여기서는 S를 읽기만 한다. */
const USERS = ['아내', '남편'];
// 결제자 목록 = 두 사람 + 공유 설정의 목록(시트 Settings의 beneficiaries 키를 결제자 목록으로 재사용, v16)
const payerList = () => [...new Set([...USERS, ...(S.settings.beneficiaries || [])])];
const TYPE_LABEL = { expense: '지출', refund: '환불', transfer: '지출 제외' };
const upsert = rec => store.upsert(rec);
const sync = () => store.sync();
store.on('change', () => render());
store.on('status', () => renderStatus());
store.on('notice', msg => toast(msg));

/* ---------------- 유틸 ---------------- */
const $ = s => document.querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = n => Math.round(n).toLocaleString('ko-KR');
const { pad, ymd, parseDate, addDays, dayDiff, signed } = core; // 순수 로직은 core.js
const today = () => ymd(new Date());
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

let toastTimer;
function toast(msg, action, onAction, ms) {
  // 시트(모달)가 열려 있으면 시트 안의 알림 칸에 띄운다: 모달 뒤에 가려지지 않게. 시트를 다시 그려도 새로 만든다
  const dlg = $('#sheet');
  let t = $('#toast');
  if (dlg.open) {
    t = dlg.querySelector('.toast.in-sheet');
    if (!t) { t = document.createElement('div'); t.className = 'toast in-sheet'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); dlg.appendChild(t); }
  }
  t.textContent = msg;
  t.classList.toggle('act', !!action);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = action;
    b.onclick = () => { t.classList.remove('on'); clearTimeout(toastTimer); onAction(); };
    t.appendChild(b);
  }
  t.classList.add('on');
  const dur = ms || (action ? 8000 : 4000);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), dur);
  t.onpointerenter = t.onfocusin = () => clearTimeout(toastTimer);
  t.onpointerleave = t.onfocusout = () => { clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2500); };
}

/* ---------------- 삭제: 확인 창 + 되돌리기 ---------------- */
function askDelete(id, after) {
  const t = store.get(id); if (!t) return;
  const dlg = $('#confirm');
  dlg.innerHTML = `<div class="confirm-box" tabindex="-1" autofocus>
    <b>이 기록을 삭제할까요?</b>
    <p>${esc(t.merchant || t.category || '기록한 지출')} · ${won(t.amount)}원<br><span class="muted">${md(t.date)} · 두 사람 모두에게서 지워져요</span></p>
    <div class="confirm-btns"><button type="button" value="cancel" class="btn ghost">취소</button><button type="button" value="ok" class="btn btn-del">삭제</button></div></div>`;
  // 닫힘 이벤트 대신 버튼에서 바로 처리 (close 이벤트는 늦게 올 수 있음)
  dlg.querySelector('[value=cancel]').onclick = () => { dlg.close(); closeSwipes(); };
  dlg.querySelector('[value=ok]').onclick = () => {
    dlg.close();
    const before = Object.assign({}, store.get(id));
    if (!upsert(Object.assign({}, before, { deleted: true }))) return;
    if (after) after();
    render();
    toast('삭제했어요', '되돌리기', () => { if (upsert(Object.assign({}, store.get(id), { deleted: false }))) { render(); toast('되돌렸어요'); } });
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
const cycleRange = offset => core.cycleRange(S.settings.cycle_start_day, offset, new Date());
const liveTxs = () => store.list();
const inRange = (t, r) => t.date >= r.start && t.date <= r.end;
const byNewest = (a, b) => (b.date + b.created_at).localeCompare(a.date + a.created_at) || b.created_at - a.created_at;

/* ---------------- 화면 ---------------- */
let tab = 'home', offset = 0;

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
  const nextScreen = !store.connected() ? 'setup' : !S.me ? 'who' : tab;
  const markup = !store.connected() ? setupView() : !S.me ? whoView() : `<div class="wrap">
    <header class="top"><div class="brand">${logo()}사이<span class="brand-sub">둘이 쓰는 가계부</span></div>
      <button class="who" data-act="tab" data-v="settings" aria-label="${esc(S.me)}로 기록 중. 설정 열기">${esc(S.me)}</button></header>
    <main id="view">${tab === 'home' ? homeView() : tab === 'list' ? listView() : tab === 'recur' ? recurView() : settingsView()}</main>
  </div>
  <nav class="tabs" aria-label="메뉴">
    ${navBtn('home', '홈', 'home')}${navBtn('list', '내역', 'ledger')}
    <button class="plus" data-act="add" aria-label="지출 기록"><span class="add-icon">${icon('plus')}</span><span>기록</span></button>
    ${navBtn('recur', '정기', 'repeat')}${navBtn('settings', '설정', 'gear')}
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
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9Z"/>',
  starOn: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9Z" fill="currentColor"/>',
  paste: '<rect x="5" y="4" width="14" height="17" rx="3"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>',
  file: '<path d="M6 3h8l5 5v13H6Z M14 3v5h5M9 13h6M9 17h6"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  repeat: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4m0 13.6v2.4M4.9 4.9l1.7 1.7m10.8 10.8 1.7 1.7M2.8 12h2.4m13.6 0h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/><circle cx="12" cy="12" r="7"/>',
  filter: '<path d="M4 7h16M7 12h10M10 17h4"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4m8-4v4M4 10h16"/>',
  upload: '<path d="M12 15V4m-4 4 4-4 4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18Z"/>',
  alert: '<path d="M12 4 3 20h18Zm0 6v4m0 3h.01"/>',
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
  const n = store.pendingCount(), st = store.status();
  let txt, err = false;
  if (st.syncing) txt = '공유하는 중…';
  else if (st.error) { txt = st.error; err = true; }
  else if (navigator.onLine === false) txt = n ? `오프라인 · ${n}건 기기에 저장, 연결되면 공유` : '오프라인';
  else if (n) txt = `${n}건 공유 대기`;
  else if (st.lastSync) txt = '내 구글 시트에 공유됨 · ' + new Date(st.lastSync).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  else txt = '';
  const ic = err ? 'alert' : navigator.onLine === false || n ? 'cloud' : st.lastSync ? 'check' : '';
  el.classList.toggle('err', err);
  el.innerHTML = txt ? (ic ? icon(ic) : '') + '<span>' + esc(txt) + '</span>' + (err ? ' <button class="link" data-act="sync">다시 보내기</button>' : '') : '';
}

function setupView() {
  return `<div class="wrap center">
    <div class="brand" style="font-size:28px">${logo()}사이</div>
    <h1>둘이 쓰는 가계부</h1>
    <p class="lead-muted">기록은 내 구글 시트에 남아요. 광고 없이, 오프라인에서도 기록해요.<br>처음 한 번, 받은 설정 코드를 붙여넣어 주세요.</p>
    <form data-form="setup" class="field">
      <label for="code">설정 코드</label>
      <textarea id="code" class="in" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false" required></textarea>
      <div class="err" id="setup-err"></div>
      <button class="btn" type="submit">연결하기</button>
    </form>
  </div>`;
}
/* 화면 모드: 기기 설정 / 라이트 / 다크 (이 기기에만 저장) */
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name=theme-color]').forEach(m => { m.setAttribute('content', dark ? '#10141B' : '#F5F7FB'); m.removeAttribute('media'); });
}
applyTheme(S.theme);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!S.theme) applyTheme(null); });
function whoView() {
  return `<div class="wrap center">
    <div class="brand">${logo()}사이</div>
    <h1>나는 누구인가요?</h1>
    <p class="lead-muted">이 기기에서 쓴 기록에 결제자 기본값과 기록자로 남겨요. 설정에서 바꿀 수 있어요.</p>
    <div class="pick">${USERS.map(u => `<button data-act="me" data-v="${u}">${u}</button>`).join('')}</div>
  </div>`;
}

/* ---------------- 홈: 분석 ---------------- */
let view = Object.assign({ mode: 'month', from: '', to: '', cats: [], benes: [], payers: [] }, S.view || {}, { benes: [] }); // 누구 몫은 v15에서 뺌
if (!['day', 'week', 'month', 'custom'].includes(view.mode)) view.mode = 'month'; // 예전 '주기' 보기 → 1개월
let hOff = 0; // 홈 기간 이동(0 = 오늘/이번 주/이번 달)
function saveView() { store.setLocal('view', view); }

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
  return { title: off === 0 ? '이번 주기' : off === -1 ? '지난 주기' : parseDate(r.start).getFullYear() + '년 ' + (parseDate(r.start).getMonth() + 1) + '월 주기', range: md(r.start) + ' ~ ' + md(r.end) };
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

function analysisView() {
  const r = periodRange(), pr = prevRange(r), td = today();
  const txs = pick(r), prevTxs = pick(pr);
  const total = sum(txs), prevTotal = sum(prevTxs);
  const running = td >= r.start && td <= r.end;
  const spanDays = dayDiff(r.start, r.end) + 1;
  const elapsed = running ? dayDiff(r.start, td) + 1 : spanDays;
  const avg = elapsed > 0 ? total / elapsed : 0;
  const cmpName = r.custom ? '이전 같은 기간'
    : hOff === 0 ? { day: '어제', week: '지난주', month: '지난 주기' }[r.unit]
    : { day: '그 전날', week: '그 전 주', month: '그 전 주기' }[r.unit];
  const diff = total - prevTotal;
  const filtered = view.cats.length + view.payers.length;

  let pace = '';
  if (running && r.unit === 'month' && elapsed >= 3 && total > 0) {
    const proj = Math.round(avg * spanDays);
    const prevSame = sum(prevTxs.filter(t => dayDiff(pr.start, t.date) < elapsed));
    const d2 = total - prevSame;
    pace = `<div class="pace" aria-label="이번 주기 예상과 지난 주기 같은 시점 비교"><span>예상 <b class="num">약 ${man(proj)}원</b></span>` +
      (prevTxs.length ? `<span>지난 주기 이맘때 <b class="num">${d2 >= 0 ? '+' : '−'}${man(Math.abs(d2))}원</b></span>` : '') + `</div>`;
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
    ${filtered ? `<p class="hint filter-summary" data-ui-key="filter-summary">${esc([...view.cats, ...view.payers.map(p => p + ' 결제')].join(' · '))}만 보는 중</p>` : ''}`;

  const hero = `
    <section data-ui-key="an-hero" class="card an-hero" aria-label="분석 기간 요약">
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
    return hero + budget + head + `<div class="card empty-period" data-ui-key="empty-period"><div class="empty">${filtered ? '이 조건의 지출이 없어요.<br>필터를 바꾸면 다른 기록을 볼 수 있어요.' : '이 기간의 지출이 없어요.<br>기록이 쌓이면 여기에 분석이 보여요.'}</div></div>`;
  }

  const cats = groupSum(txs, t => t.category || '미분류');
  const payers = groupSum(txs, t => t.payer || '공동');
  const merch = groupSum(txs.filter(t => t.merchant), t => t.merchant).slice(0, 5);
  const counts = {}; txs.forEach(t => { if (t.merchant) counts[t.merchant] = (counts[t.merchant] || 0) + 1; });

  return hero + budget + head +
    (r.unit === 'month' ? paceChart(r, pr, txs, prevTxs, running ? elapsed : spanDays) : '') +
    trendChart(r) +
    `<h2 data-ui-key="cats-title">분류별 <span class="h2sub">눌러서 그 분류만 보기</span></h2>` + rankBars(cats, 'vcat', view.cats, 8) +
    (payers.length > 1 || view.payers.length ? `<h2 data-ui-key="payers-title">결제자</h2>` + rankBars(payers, 'vpayer', view.payers) : '') +
    (merch.length ? `<h2 data-ui-key="merchants-title">많이 쓴 곳</h2><div class="card" data-ui-key="merchants">${merch.map(([m, v], i) => `
      <div class="bar-row"><div class="bar-top"><span>${i + 1}. ${esc(m)} <span class="muted">${counts[m]}건</span></span><b class="num">${won(v)}원</b></div></div>`).join('')}</div>` : '');
}

let homeOff = 0; // 홈 요약 주기 이동 (0 = 이번 주기)
function homeView() {
  const r = cycleRange(homeOff), td = today();
  const txs = liveTxs().filter(t => inRange(t, r));
  const s = core.summarize(txs), b = budgetOf();
  const running = td >= r.start && td <= r.end;
  const spanDays = dayDiff(r.start, r.end) + 1, left = running ? dayDiff(td, r.end) + 1 : 0;
  const rest = b.total - s.net;
  const budgetLine = b.total ? `<div class="budget-track${rest < 0 ? ' over' : ''}" aria-hidden="true"><i style="width:${Math.min(100, Math.max(0, s.net) / b.total * 100)}%"></i>${running && spanDays > 1 ? `<s style="left:${Math.min(100, (spanDays - left) / spanDays * 100)}%"></s>` : ''}</div>
      <div class="spread caption"><span>예산 ${man(b.total)}원</span><span>${rest < 0 ? `<b class="over-t">${won(-rest)}원 넘었어요</b>` : `남은 돈 <b>${won(rest)}원</b>${running && left > 0 ? ` · 하루 ${won(Math.floor(rest / left))}원` : ''}`}</span></div>` : '';
  const cats = groupSum(txs.filter(t => t.type !== 'transfer'), t => t.category || '미분류').filter(([, v]) => v > 0);
  const recent = txs.slice().sort(byNewest).slice(0, 3);
  const anyTx = liveTxs().length > 0, pendingRefunds = liveTxs().filter(t => t.refund_pending).length;
  return `
    <section data-ui-key="hero" class="card hero home-hero" aria-label="주기 요약">
      <div class="hero-top"><button class="period-btn" data-act="hperiod" aria-label="집계 주기 바꾸기">${r.year}년 ${md(r.start)} ~ ${md(r.end)}${icon('down')}</button>
        <span class="cyc-actions"><button data-act="hoff" data-v="-1" aria-label="이전 주기">${icon('left')}</button><button data-act="hoff" data-v="1" aria-label="다음 주기" ${homeOff >= 0 ? 'disabled' : ''}>${icon('right')}</button></span></div>
      <p class="eyebrow">${homeOff === 0 ? '이번 주기' : '그 주기'}, 함께 쓴 돈</p>
      <div class="amt num">${won(s.net)}<small>원</small></div>
      <div class="summary-sub"><span>지출 ${won(s.expense)}원</span>${s.refund ? `<span>환불 ${won(s.refund)}원</span>` : ''}<span>${s.count}건</span></div>
      ${budgetLine}
    </section>
    <p class="status state-line" id="status" role="status"></p>
    <div class="quick-grid" data-ui-key="quick">
      <button data-act="impopen" data-v="paste">${icon('paste')}<span>카드 알림 붙여넣기</span></button>
      <button data-act="favlist">${icon('star')}<span>즐겨찾기로 기록</span></button>
    </div>
    ${pendingRefunds ? `<button class="refund-line" data-act="refunds" data-ui-key="refund-line">${icon('alert')}<span>환불 대기 <b>${pendingRefunds}건</b> · 전체 기간</span>${icon('right')}</button>` : ''}
    <div class="section-head" data-ui-key="recent-h"><h2>최근 기록</h2>${txs.length ? `<button class="link" data-act="homelist">모두 보기${icon('right')}</button>` : ''}</div>
    <div class="card list-card recent" data-ui-key="recent">${recent.length ? recent.map(t => txRow(t)).join('')
      : `<div class="empty">${anyTx ? '이 주기에는 기록이 없어요.' : '<b>첫 기록을 남겨보세요</b><br>금액만 입력해도 괜찮아요.'}</div>${anyTx ? '' : '<button class="btn" data-act="add">지출 기록</button>'}`}</div>
    <div class="section-head" data-ui-key="cats-h"><h2>어디에 썼나요?</h2><span class="caption">같은 주기 기준</span></div>
    <div class="card" data-ui-key="home-cats">${cats.length ? cats.slice(0, 3).map(([c, v]) => {
      const cb = b.cats && b.cats[c];
      return `<button class="bar-row as-btn" data-act="homecat" data-v="${esc(c)}"><div class="bar-top"><span>${esc(c)}</span><b class="num">${won(v)}원${cb ? ` <span class="muted">/ ${man(cb)}</span>` : ''}</b></div>
        <div class="bar${cb && v > cb ? ' full' : ''}" aria-hidden="true"><i style="width:${Math.max(0, cb ? v / cb : v / Math.max(s.net, 1)) * 100 > 100 ? 100 : Math.max(0, cb ? v / cb : v / Math.max(s.net, 1)) * 100}%"></i></div></button>`;
    }).join('') : '<p class="meta">기록이 쌓이면 분류별로 볼 수 있어요.</p>'}
      <div class="card-links"><button class="link" data-act="homelist">분류별 내역 살펴보기${icon('right')}</button><button class="link" data-act="budget">${b.total || Object.keys(b.cats || {}).length ? '예산 수정' : '예산 정하기'}</button></div></div>
    <button class="analysis-toggle" data-act="analysis" aria-expanded="${!!view.analysis}" data-ui-key="an-toggle"><span><b>분석 더 보기</b><span class="caption">1일·1주·1개월·기간 지정, 흐름·추이·분류·결제자</span></span>${icon('down')}</button>
    ${view.analysis ? `<div class="analysis" data-ui-key="analysis">${analysisView()}</div>` : ''}
    <p class="fine-print">광고 없이, 우리 기록에만 집중해요 · 기록 원본은 내 구글 시트</p>`;
}
// 홈 요약의 주기 고르기: 최근 12개 주기와 순지출
function openPeriodSheet() {
  const items = Array.from({ length: 12 }, (_, i) => { const r = cycleRange(-i); return Object.assign(r, { off: -i, net: core.summarize(liveTxs().filter(t => inRange(t, r))).net }); });
  showSheet(`<div class="sheet-wrap">${sheetHead('집계 주기')}
    <div class="sheet-b"><p class="hint" style="margin-top:12px">카드 결제 주기(매월 ${S.settings.cycle_start_day}일 시작) 기준 집계 기간이에요. 청구액·납부일과는 다를 수 있어요.</p>
      <div class="card list-card">${items.map(r => `<button class="settings-row" data-act="hpick" data-v="${r.off}" aria-pressed="${r.off === homeOff}"><span><b>${r.off === 0 ? '이번 주기' : r.off === -1 ? '지난 주기' : r.year + '년'} ${md(r.start)} ~ ${md(r.end)}</b></span><span class="num">${won(r.net)}원</span></button>`).join('')}</div>
    </div></div>`, true);
}

/* ---------------- 예산 ---------------- */
// 예산은 공유 설정 prefs.budget = { total, cats: { 분류: 금액 } }. 한 달 = 카드 결제 주기.
const budgetOf = () => (store.prefs() && store.prefs().budget) || { total: 0, cats: {} };
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
    <div class="budget-h"><b>${hOff === 0 ? '이번 주기' : '그 주기'} 예산</b><button class="link" data-act="budget">수정</button></div>
    ${b.total ? `<div class="bar-row"><div class="bar-top"><span class="num">${won(total)} / ${won(b.total)}원</span><span class="pct num">${Math.round(Math.max(0, total) / b.total * 100)}%</span></div>${bar(total, b.total)}<div class="budget-line">${line(total, b.total)}</div></div>` : ''}
    ${catRows}
    ${running && spanDays > 1 ? '<p class="hint" style="margin:6px 0 8px">세로선은 오늘까지 지난 날의 비율이에요.</p>' : ''}
  </section>`;
}
function openBudget() {
  if (!store.prefs()) { toast('서버 업데이트가 필요해요 (Apps Script 새 버전)'); return; }
  const b = budgetOf(), cats = S.settings.categories;
  const pr = cycleRange(-1), lastTx = liveTxs().filter(t => t.type !== 'transfer' && t.date >= pr.start && t.date <= pr.end);
  const lastOf = c => sum(lastTx.filter(t => (t.category || '미분류') === c)), lastAll = sum(lastTx);
  const ph = v => v > 0 ? '지난달 ' + man(v) : '-';
  const dlg = $('#sheet');
  dlg.classList.remove('filter-sheet');
  dlg.innerHTML = `<form data-form="budget" class="sheet-wrap" novalidate>
    ${sheetHead('예산')}
    <div class="sheet-b">
      <p class="hint" style="font-size:14px">한 달(카드 결제 주기) 기준이에요. 비워 두면 그 예산은 쓰지 않아요. 두 사람에게 같이 적용돼요.</p>
      <div class="field"><label for="b-total">한 달 전체 예산</label>
        <div class="amount-in"><input id="b-total" name="total" data-money inputmode="numeric" autocomplete="off" placeholder="${lastAll > 0 ? '지난달 ' + won(lastAll) : '0'}" value="${b.total ? won(b.total) : ''}" class="num"><span>원</span></div>
        <p class="hint">흐린 숫자는 지난달(${pr.label}) 쓴 돈이에요. 참고해서 정해 보세요.</p></div>
      <h2 style="margin-top:8px">분류별 예산 <span class="h2sub">필요한 분류만</span></h2>
      <div class="card">${cats.map((c, i) => `<label class="budget-cat" for="bc${i}"><span>${categoryIcon(c)}${esc(c)}</span>
        <span class="budget-in"><input id="bc${i}" name="cat:${esc(c)}" data-money inputmode="numeric" autocomplete="off" placeholder="${ph(lastOf(c))}" value="${b.cats && b.cats[c] ? won(b.cats[c]) : ''}" class="num"><span>원</span></span></label>`).join('')}</div>
    </div>
    <div class="sheet-footer"><button class="btn save" type="submit">저장</button></div></form>`;
  dlg.showModal();
}
function saveBudget(f) {
  const fd = new FormData(f), num = v => Number(String(v || '').replace(/[^\d]/g, '')) || 0;
  const cats = {};
  for (const [k, v] of fd.entries()) if (k.startsWith('cat:') && num(v) > 0) cats[k.slice(4)] = num(v);
  if (!store.setPrefs({ budget: { total: num(fd.get('total')), cats } })) return;
  $('#sheet').close(); toast('예산을 저장했어요');
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
    <div class="legend"><span><i class="key" style="background:var(--accent)"></i>${hOff === 0 ? '이번 주기' : '선택한 주기'}</span>${prev.length ? `<span><i class="key" style="background:var(--prev)"></i>${hOff === 0 ? '지난 주기' : '그 전 주기'}</span>` : ''}</div>
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
  dlg.innerHTML = `<div class="sheet-wrap">${sheetHead(title + '만 보기')}
    <div class="sheet-b"><p class="hint">여러 개 고를 수 있어요. 아무것도 안 고르면 전체예요.</p>
    <div class="chips" id="vopts" style="margin-top:12px">${opts.map(o => `<button type="button" class="chip" data-act="vtoggle" data-v="${esc(o)}" aria-pressed="${view[kind].includes(o)}">${esc(o)}</button>`).join('')}</div></div>
    <div class="sheet-footer two"><button type="button" class="btn ghost" data-act="vnone" data-v="${kind}">전체 보기</button><button type="button" class="btn" data-act="vapply" data-v="${kind}">적용</button></div></div>`;
  dlg.showModal();
}

function txRow(t, noDate) {
  const cls = t.type === 'refund' ? 'ref' : t.type === 'transfer' ? 'ex' : '';
  const d = parseDate(t.date);
  return `<div class="swipe" data-id="${esc(t.id)}"><button class="swipe-del" data-act="askdel" data-v="${esc(t.id)}" tabindex="-1" aria-label="삭제">삭제</button><button class="tx" data-act="edit" data-v="${esc(t.id)}">
    <span class="ic" aria-hidden="true">${categoryIcon(t.category)}</span>
    <span class="mid"><span class="m">${esc(t.merchant || t.category || '기록한 지출')}</span>
      <span class="meta">${noDate ? '' : `${d.getMonth() + 1}.${d.getDate()} · `}${esc(t.category || '미분류')} · ${esc(t.payer || '공동')} 결제
      ${t.refund_pending ? '<span class="tag">환불 대기</span>' : ''}${t.type === 'transfer' ? '<span class="tag q">지출 제외</span>' : ''}${t.created_by === '정기' ? '<span class="tag q">정기</span>' : ''}${store.isPending(t.id) ? '<span class="tag q">공유 대기</span>' : ''}</span></span>
    <span class="a num ${cls}">${t.type === 'refund' ? '<span class="refund-label">환불</span>+' : ''}${won(t.amount)}원</span></button></div>`;
}

function listView() {
  const range = listRange(), r = cycleRange(offset);
  const cal = view.list === 'cal' && lf.period === 'cycle';
  const all = core.filterTxs(liveTxs(), lf, range).sort(byNewest);
  const s = core.summarize(all), nAct = lfActive(lf);
  const txs = cal ? all : all.slice(0, lfLimit);
  let lastDay = '', rows = '';
  txs.forEach(t => {
    if (t.date !== lastDay) {
      if (rows) rows += '</div>';
      const d = parseDate(t.date);
      const rel = t.date === today() ? ' 오늘' : t.date === addDays(today(), -1) ? ' 어제' : ' ' + WEEK[d.getDay()] + '요일';
      rows += `<p class="day" data-ui-key="day-${t.date}">${d.getFullYear() !== new Date().getFullYear() ? d.getFullYear() + '년 ' : ''}${d.getMonth() + 1}.${d.getDate()}${rel}</p><div class="card list-card" data-ui-key="rows-${t.date}">`;
      lastDay = t.date;
    }
    rows += txRow(t, true);
  });
  if (rows) rows += '</div>';
  const pl = lf.period === 'all' ? ['전체 기간', ''] : lf.period === 'custom' && range ? ['지정 기간', md(range.start) + ' ~ ' + md(range.end)] : [offset === 0 ? '이번 주기' : r.year + '년', md(r.start) + ' ~ ' + md(r.end)];
  const kindName = KINDS.find(k => k[0] === lf.kind)[1];
  const chips = [['cats', lf.cats.length ? (lf.cats.length === 1 ? lf.cats[0] : '분류 ' + lf.cats.length) : '분류', lf.cats.length],
    ['payers', lf.payers.length ? (lf.payers.length === 1 ? lf.payers[0] + ' 결제' : '결제자 ' + lf.payers.length) : '결제자', lf.payers.length],
    ['amount', amtLabel(lf) || '금액', lf.min || lf.max], ['kind', lf.kind === 'all' ? '종류' : kindName, lf.kind !== 'all']]
    .map(([k, label, on]) => `<button class="chip" data-act="lfopen" data-v="${k}" aria-pressed="${!!on}"><span>${esc(label)}</span>${icon('down')}</button>`).join('');
  const [sumName, sumVal] = lf.kind === 'refund' ? ['환불 합계', s.refund] : lf.kind === 'transfer' ? ['지출 제외 합계', s.transfer] : ['순지출', s.net];
  return `
    <div class="page-title"><h1>내역</h1><button class="link with-icon" data-act="listmenu">가져오기${icon('upload')}</button></div>

    <div class="search-row" data-ui-key="search-row"><div class="search-box"><input class="in search" type="search" placeholder="거래처, 분류, 메모 검색" value="${esc(lf.q)}" data-input="q" aria-label="거래처, 분류, 메모 검색" enterkeyhint="search">
      ${lf.q ? `<button class="search-x" data-act="qclear" aria-label="검색어 지우기">${icon('x')}</button>` : ''}</div>
      <button class="icon-btn" data-act="lfopen" data-v="period" aria-label="기간·분류·결제자·금액 필터">${icon('filter')}</button>
      ${lf.period === 'cycle' ? `<button class="icon-btn" data-act="lmode" data-v="${cal ? 'rows' : 'cal'}" aria-pressed="${cal}" aria-label="${cal ? '목록으로 보기' : '달력으로 보기'}">${icon(cal ? 'ledger' : 'calendar')}</button>` : ''}</div>
    <div class="period-nav" data-ui-key="list-cycle">
      <button data-act="cyc" data-v="-1" aria-label="이전 주기" ${lf.period !== 'cycle' ? 'disabled' : ''}>${icon('left')}</button>
      <button class="period-lbl" data-act="lfopen" data-v="period" aria-label="기간 바꾸기"><b>${pl[0]}</b><span>${pl[1]}</span></button>
      <button data-act="cyc" data-v="1" aria-label="다음 주기" ${lf.period !== 'cycle' || offset >= 0 ? 'disabled' : ''}>${icon('right')}</button></div>
    <div class="filter-toolbar" data-ui-key="lf-toolbar"><div class="filters" role="group" aria-label="내역 필터">${chips}</div>${nAct ? '<button class="link lf-reset" data-act="lfclear">초기화</button>' : ''}</div>
    <div class="results-sticky" data-ui-key="lf-sum"><button class="rs-main" data-act="lfsum" aria-expanded="${lfOpenSum}" aria-label="결과 ${s.count}건, ${sumName} ${won(sumVal)}원. 눌러서 자세히">
      <span class="rs-n">결과 <b class="num">${s.count}</b>건 · ${sumName}</span><span class="rs-v"><b class="num">${won(sumVal)}원</b></span>${icon('down')}</button></div>
    <p class="sum-line" data-ui-key="sum-line">지출 ${won(s.expense)} · 환불 ${won(s.refund)}${s.transfer || lfOpenSum ? ` · 지출 제외 ${won(s.transfer)}` : ''}${lfOpenSum ? '<br>지출 제외(이체·카드대금)는 순지출에 넣지 않아요.' : ''}</p>
    <p class="status" id="status"></p>
    ${cal ? calendar(r, txs) : rows || `<div class="card empty-card"><div class="empty">${nAct ? '조건에 맞는 기록이 없어요.' : '이 기간의 기록이 없어요.'}</div>${nAct ? '<button class="btn ghost" data-act="lfclear">필터 초기화</button>' : ''}</div>`}
    ${!cal && all.length > lfLimit ? `<button class="btn ghost more-btn" data-act="lfmore">${all.length - lfLimit}건 더 보기</button>` : ''}`;
}
function listMenu() {
  showSheet(`<div class="sheet-wrap">${sheetHead('가져오기·내보내기')}
    <div class="sheet-b menu-list">
      <button type="button" class="menu-item" data-act="impopen" data-v="paste">${icon('paste')}<span><b>카드 알림 붙여넣기</b><span class="muted">문자·앱 알림 여러 건을 한 번에</span></span></button>
      <button type="button" class="menu-item" data-act="impopen" data-v="file">${icon('file')}<span><b>파일로 빠진 기록 찾기</b><span class="muted">카드 이용내역·다른 가계부 CSV·엑셀</span></span></button>
      <button type="button" class="menu-item" data-act="csv">${icon('ledger')}<span><b>CSV로 내보내기</b><span class="muted">전체 기록을 파일로</span></span></button>
    </div></div>`, true);
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
    ${calDay ? `<p class="day" data-ui-key="calsel">${md(calDay)} ${WEEK[parseDate(calDay).getDay()]}요일${sel ? ` · ${sel.length}건 · 순지출 ${won(sum(sel))}원` : ''}</p>${sel ? `<div class="card" data-ui-key="calrows">${sel.map(t => txRow(t, true)).join('')}</div>` : '<div class="card"><div class="empty">이날은 지출이 없어요.</div></div>'}`
      : '<p class="hint" style="text-align:center">날짜를 누르면 그날 기록을 보여줘요.</p>'}`;
}

function settingsView() {
  const st = S.settings, ss = store.status(), n = store.pendingCount(), r = cycleRange(0);
  const when = ss.lastSync ? new Date(ss.lastSync).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }) : '';
  const syncText = ss.syncing ? '공유하는 중…' : ss.error ? ss.error : navigator.onLine === false ? `오프라인${n ? ` · 공유 대기 ${n}건` : ''}` : n ? `공유 대기 ${n}건` : when ? `공유 완료 · 마지막 공유 ${when}` : '아직 공유 기록이 없어요';
  const theme = S.theme || 'system';
  const row = (act, title, sub, v) => `<button class="settings-row" data-act="${act}"${v ? ` data-v="${v}"` : ''}><span><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span>${icon('right')}</button>`;
  return `
    <div class="page-title"><h1>설정</h1></div>
    <h2 class="sec">우리 장부</h2>
    <div class="card list-card" data-ui-key="set-book">
      <div class="settings-row static"><span><b>이 기기 사용자</b><small>새 기록의 결제자 기본값과 기록자</small></span>
        <div class="seg seg2 me-seg" role="group" aria-label="이 기기 사용자">${USERS.map(u => `<button data-act="me" data-v="${u}" aria-pressed="${S.me === u}">${u}</button>`).join('')}</div></div>
      ${row('setcycle', '카드 집계 주기', `매월 ${st.cycle_start_day}일 시작 · 지금 ${md(r.start)} ~ ${md(r.end)}`)}
      <div class="settings-row static"><span><b>내 구글 시트</b><small class="${ss.error ? 'err-t' : ''}">${esc(syncText)}</small></span><button class="btn-sm" data-act="sync">지금 공유</button></div>
    </div>
    <h2 class="sec">화면 모드</h2>
    <div class="seg seg3 theme-seg" role="group" aria-label="화면 모드" data-ui-key="theme">${[['system', '기기 설정'], ['light', '라이트'], ['dark', '다크']].map(([k, l]) => `<button data-act="theme" data-v="${k}" aria-pressed="${theme === k}">${l}</button>`).join('')}</div>
    <p class="hint">이 기기에만 적용돼요.</p>
    <h2 class="sec">기록 관리</h2>
    <div class="card list-card" data-ui-key="set-records">
      ${row('setlists', '분류·결제수단·결제자', `분류 ${st.categories.length}개 · 결제수단 ${st.methods.length}개 · 결제자 ${payerList().length}명`)}
      ${row('budget', '예산', budgetOf().total ? `한 달 ${won(budgetOf().total)}원` : '정하지 않았어요')}
      ${row('favmanage', '즐겨찾기', store.prefs() ? `${favorites().length}개 · 두 사람이 같이 써요` : '서버 업데이트가 필요해요')}
      ${row('impopen', '카드 알림 붙여넣기', '문자·앱 알림 여러 건을 한 번에', 'paste')}
      ${row('impopen', '파일로 빠진 기록 찾기', '카드 이용내역·다른 가계부 CSV·엑셀', 'file')}
      ${row('csv', 'CSV로 내보내기', '전체 기록을 파일로')}
    </div>
    <h2 class="sec">앱</h2>
    <div class="card list-card" data-ui-key="set-app">
      <button class="settings-row" data-act="update"><span><b>최신 버전 받기</b><small id="ver">${esc(verText())}</small></span>${icon('right')}</button>
      <details class="settings-row det"><summary><span><b>홈 화면에 추가</b><small>Safari 공유 버튼 → 홈 화면에 추가</small></span>${icon('down')}</summary>
        <p class="hint">홈 화면 앱은 Safari와 저장공간이 따로라, 처음 열 때 설정 코드를 한 번 더 넣어야 해요. 기록은 업데이트해도 그대로 남아요.</p></details>
    </div>
    <h2 class="sec">연결</h2>
    <div class="card list-card danger-zone" data-ui-key="set-conn">
      ${row('setcode', '설정 코드 바꾸기', '키를 바꿨을 때. 이 기기의 기록과 공유 대기 건은 그대로 남아요')}
      <button class="settings-row danger-row" data-act="disconnect"><span><b>이 기기 연결 해제</b><small>공유 대기 중인 기록·설정이 있으면 먼저 공유돼야 해요</small></span></button>
    </div>
    <p class="fine-print">사이 · 광고 없는 둘만의 가계부 · 기록 원본은 내 구글 시트</p>`;
}
function openCycleSheet() {
  const st = S.settings;
  showSheet(`<form data-form="settings" class="sheet-wrap" novalidate>${sheetHead('카드 집계 주기')}
    <div class="sheet-b"><div class="field"><label for="sd">한 달 시작일 (카드 결제 주기)</label>
      <select id="sd" class="in" name="cycle_start_day">${Array.from({ length: 31 }, (_, i) => i + 1).map(d => `<option value="${d}" ${Number(st.cycle_start_day) === d ? 'selected' : ''}>매월 ${d}일</option>`).join('')}</select>
      <p class="hint">29~31일을 고르면 그날이 없는 달은 말일부터 시작해요. 두 사람에게 같이 적용돼요.</p></div></div>
    <div class="sheet-footer"><button class="btn save" type="submit">저장</button></div></form>`);
}
function openListsSheet() {
  const st = S.settings;
  showSheet(`<form data-form="settings" class="sheet-wrap" novalidate>${sheetHead('분류·결제수단·결제자')}
    <div class="sheet-b">
      <div class="field"><label for="cats-in">분류 (쉼표로 구분)</label><textarea id="cats-in" class="in" rows="3" name="categories">${esc(st.categories.join(', '))}</textarea></div>
      <div class="field"><label for="mts">결제수단</label><textarea id="mts" class="in" rows="2" name="methods">${esc(st.methods.join(', '))}</textarea></div>
      <div class="field"><label for="bns">결제자 (쉼표로 구분)</label><textarea id="bns" class="in" rows="2" name="beneficiaries">${esc(st.beneficiaries.join(', '))}</textarea>
        <p class="hint">아내·남편은 항상 있어요. 설정은 두 사람에게 같이 적용돼요.</p></div></div>
    <div class="sheet-footer"><button class="btn save" type="submit">저장</button></div></form>`);
}
function openCodeSheet() {
  showSheet(`<form data-form="setup" class="sheet-wrap" novalidate>${sheetHead('설정 코드 바꾸기')}
    <div class="sheet-b"><p class="hint" style="margin-top:12px">키를 바꿨을 때 새 코드를 넣어요. 이 기기의 기록과 공유 대기 건은 그대로 남아요.</p>
      <div class="field"><label for="code">새 설정 코드</label><textarea id="code" class="in" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
      <div class="err" id="setup-err"></div></div></div>
    <div class="sheet-footer"><button class="btn save" type="submit">새 코드로 연결</button></div></form>`);
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
    if (hit && !store.get('rec-' + r.id + '-' + s.replace(/-/g, ''))) return s; // 이미 기록된 날은 건너뜀
  }
  return '';
}
// 이번 주기(오늘부터 주기 끝까지) 아직 기록되지 않은 예정 건
function upcomingIn(r) {
  const out = [];
  (rules() || []).filter(x => x.active).forEach(rule => {
    for (let d = r.start > today() ? r.start : today(); d <= r.end; d = addDays(d, 1)) {
      if (rule.start && d < rule.start) continue;
      if (rule.end && d > rule.end) break;
      const dt = parseDate(d);
      const hit = rule.freq === 'week' ? dt.getDay() === rule.day : dt.getDate() === Math.min(rule.day, new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate());
      if (hit && !store.get('rec-' + rule.id + '-' + d.replace(/-/g, ''))) out.push({ rule, date: d });
    }
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
function recurView() {
  const list = rules();
  if (!list) return `<div class="page-title"><h1>정기 지출</h1></div>
    <div class="card"><div class="empty">서버 업데이트가 필요해요.<br>구글 시트의 Apps Script를 새 버전으로 바꾸면 쓸 수 있어요.</div></div>`;
  const r = cycleRange(0), up = upcomingIn(r);
  const monthly = list.filter(x => x.active && x.freq === 'month').reduce((a, x) => a + x.amount, 0);
  const sorted = list.slice().sort((a, b) => (a.active ? nextDate(a) || '9' : '99').localeCompare(b.active ? nextDate(b) || '9' : '99'));
  return `<div class="page-title"><h1>정기 지출</h1><button class="link with-icon" data-act="rule">추가${icon('plus')}</button></div>
    <section class="card rules-summary" data-ui-key="rules-sum"><p class="eyebrow">이번 주기에 더 나갈 돈 <span class="caption">${md(today())} ~ ${md(r.end)}</span></p>
      <div class="amt num">${won(up.reduce((a, u) => a + u.rule.amount, 0))}<small>원</small></div>
      <p class="meta">예정 ${up.length}건 · 아직 지출에 더하지 않았어요${monthly ? ` · 매월 고정 ${won(monthly)}원` : ''}</p></section>
    ${list.length ? `<div class="section-head"><h2>다가오는 순서</h2></div><div class="card list-card" data-ui-key="rules">${sorted.map(x => {
      const nx = x.active ? nextDate(x) : '';
      return `<div class="rule${x.active ? '' : ' off'}"><button class="tx" data-act="rule" data-v="${esc(x.id)}">
        <span class="ic" aria-hidden="true">${categoryIcon(x.category)}</span>
        <span class="mid"><span class="m">${esc(x.name)}</span>
          <span class="meta">${ruleWhen(x)} · ${esc(x.payer || '-')} 결제${x.active ? (nx ? ' · 다음 ' + Number(nx.slice(5, 7)) + '.' + Number(nx.slice(8)) : ' · 종료') : ' · <b class="off-t">자동 기록 꺼짐</b>'}</span></span>
        <span class="a num">${won(x.amount)}원</span></button>
        <label class="rule-sw"><input type="checkbox" data-act="rtoggle" data-v="${esc(x.id)}" ${x.active ? 'checked' : ''} aria-label="${esc(x.name)} 자동 기록"><span class="sw-t">${x.active ? '켜짐' : '꺼짐'}</span></label></div>`;
    }).join('')}</div>` : `<div class="card"><div class="empty">등록한 정기 지출이 없어요.</div><button class="btn" data-act="rule">정기 지출 추가</button></div>`}
    <p class="notice">대출·통신비·보험처럼 정해진 날 나가는 돈을 등록하면 그날 한 번 자동으로 기록돼요. 금액이 달라지면 그 기록만 고치면 되고, 지운 기록은 다시 만들지 않아요.</p>`;
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
  return `<form data-form="rule" class="sheet-wrap" novalidate>
    ${sheetHead(d.isNew ? '정기 지출 추가' : '정기 지출 수정')}
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
      <p class="hint">시작일을 과거로 잡으면 그때부터 빠진 달도 한 번에 기록돼요. 대출 만기처럼 끝나는 날이 있으면 종료일을 넣어요. 금액을 바꾸면 다음 기록부터 적용되고 지난 기록은 그대로예요.</p>
      ${d.isNew ? '' : `<div class="field"><button type="button" class="btn danger" data-act="rdelete">이 정기 지출 삭제</button><p class="hint">이미 기록된 지출은 남아요.</p></div>`}
    </div>
    <div class="sheet-footer"><button class="btn save" type="submit">저장</button></div></form>`;
}
function putRules(list, extra) {
  return store.saveSettings(Object.assign({}, extra || {}, { recurring: list }));
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
  if (!putRules(list, extra)) { d.isNew = isNew; return err('기기에 저장하지 못했어요. 입력은 그대로 두었어요'); }
  $('#sheet').close();
  toast(isNew ? '정기 지출을 등록했어요' : '정기 지출을 고쳤어요');
}
function toggleRule(id) {
  if (!putRules((rules() || []).map(r => r.id === id ? Object.assign({}, r, { active: !r.active }) : r))) { render(); toast('기기에 저장하지 못했어요'); }
}
function deleteRule() {
  if (!confirm('이 정기 지출을 삭제할까요? 이미 기록된 지출은 남아요.')) return;
  const id = ruleDraft.id;
  if (!putRules((rules() || []).filter(r => r.id !== id))) { $('#rule-err').textContent = '기기에 저장하지 못했어요'; return; }
  $('#sheet').close();
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
  const ex = id && store.get(id);
  editing = !!ex;
  const last = liveTxs().filter(t => t.created_by === S.me).sort((a, b) => b.created_at - a.created_at)[0];
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
  const top = Object.entries(stats).sort((a, b) => b[1].n - a[1].n).slice(0, 3).map(([k]) => k);
  const cats = st.categories.includes(d.category) || !d.category ? st.categories : st.categories.concat(d.category);
  const methods = st.methods.includes(d.method) || !d.method ? st.methods : st.methods.concat(d.method);
  return `<form data-form="entry" class="sheet-wrap" novalidate>
    ${sheetHead(isEdit ? '기록 수정' : '지출 기록')}
    <div class="sheet-b">
      <div class="field amount-field"><label for="amount">얼마를 썼나요?</label>
        <div class="amount-in"><input id="amount" name="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${d.amount ? won(d.amount) : ''}" class="num" aria-describedby="entry-err"><span>원</span></div>
        <div class="err" id="entry-err" role="alert"></div></div>
      ${isEdit ? '' : `<div class="chips tool-chips"><button type="button" class="chip" data-act="favlist">${icon('star')}<span>즐겨찾기</span></button><button type="button" class="chip paste-link" data-act="impopen" data-v="paste">${icon('paste')}<span>알림 붙여넣기</span></button></div>`}
      <div class="field"><label for="merchant">거래처 <span class="caption">선택</span></label>
        <input id="merchant" name="merchant" class="in" list="mlist" autocomplete="off" placeholder="어디에서 썼나요?" value="${esc(d.merchant)}">
        <datalist id="mlist">${Object.keys(stats).map(m => `<option value="${esc(m)}">`).join('')}</datalist>
        ${top.length ? `<div class="chips recent-chips">${top.map(m => `<button type="button" class="chip" data-act="merchant" data-v="${esc(m)}" aria-pressed="${d.merchant === m}">${esc(m)}</button>`).join('')}</div>` : ''}</div>
      <div class="cat-line"><span id="cat-label">${catLabel()}</span><button type="button" class="link" data-act="morecat">변경</button></div>
      <details class="more" ${isEdit || d.type !== 'expense' || d.refund_pending || d.note ? 'open' : ''}>
      <summary><span class="sum-wrap"><span class="sum-lab">날짜·결제자·결제수단·종류·메모</span><span class="sum">${esc(summaryLine())}</span></span>${icon('down')}</summary>
      <div class="field"><span class="lab">분류</span><div class="chips" id="cats">${cats.map(c => `<button type="button" class="chip" data-act="cat" data-v="${esc(c)}" aria-pressed="${d.category === c}">${esc(c)}</button>`).join('')}</div></div>
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
      ${isEdit && d.type === 'expense' && store.prefs() ? `<div class="field fav-field">${favButton()}<p class="hint" id="fav-msg" role="status"></p></div>` : ''}
      ${isEdit ? `<div class="field"><button type="button" class="btn danger" data-act="delete">이 기록 삭제</button></div>` : ''}
      ${isEdit ? `<p class="hint">기록: ${esc(d.created_by || '-')}</p>` : ''}
    </div>
    <div class="sheet-footer"><button class="btn save" type="submit">${isEdit ? '수정 저장' : '기록하기'}</button></div></form>`;
}
function catLabel() {
  const c = draft && draft.category;
  return `분류 <b>${esc(c || '미분류')}</b>${c && draft.catSug ? ' <span class="caption">추천</span>' : ''}`;
}
function refreshCatLabel() { const el = $('#cat-label'); if (el) el.innerHTML = catLabel(); }
function summaryLine() {
  const d = draft;
  return [d.date === today() ? '오늘' : d.date.slice(5).replace('-', '.'), d.payer + ' 결제', d.method, d.type !== 'expense' ? TYPE_LABEL[d.type] : '', d.refund_pending ? '환불 대기' : ''].filter(Boolean).join(' · ');
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
  setPressed($('.recent-chips') || document.createElement('div'), merchant);
  if (!s) return;
  const t = s.last;
  if (t.category) { draft.category = t.category; draft.catSug = true; setPressed($('#cats'), t.category); refreshCatLabel(); }
  if (t.method && S.settings.methods.includes(t.method)) { draft.method = t.method; $('#method').value = t.method; }
  refreshSummary();
}

/* ---------------- 시트 공통 ---------------- */
function sheetHead(title, back) {
  return `<div class="sheet-h"><div class="sh-l">${back ? `<button type="button" class="icon-btn ghost" data-act="${back}" aria-label="뒤로">${icon('left')}</button>` : ''}<h2 id="sheet-title" tabindex="-1" autofocus>${title}</h2></div><button type="button" class="icon-btn" data-act="close" aria-label="닫기">${icon('x')}</button></div>`;
}
function showSheet(html, compact) {
  const dlg = $('#sheet');
  dlg.classList.toggle('filter-sheet', !!compact);
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
}
// 시트 안 내용만 다시 그린다(본문 스크롤 위치 유지)
function repaintSheet(html) {
  const dlg = $('#sheet'), b = $('#sheet .sheet-b'), y = b ? b.scrollTop : 0;
  const a = document.activeElement, aid = a && dlg.contains(a) ? a.id || (a.dataset && (a.dataset.act ? 'act:' + a.dataset.act + ':' + (a.dataset.v || '') : a.dataset.map ? 'map:' + a.dataset.map : a.dataset.input ? 'input:' + a.dataset.input : '')) : '';
  const sel = a && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
  const open = [...dlg.querySelectorAll('details')].map((d, i) => d.open ? (d.dataset.k || i) : null).filter(x => x !== null);
  const t = dlg.querySelector('.toast.in-sheet');
  dlg.innerHTML = html;
  if (t) dlg.appendChild(t);
  [...dlg.querySelectorAll('details')].forEach((d, i) => { if (open.includes(d.dataset.k || i)) d.open = true; });
  const nb = $('#sheet .sheet-b'); if (nb) nb.scrollTop = y;
  if (aid) {
    const [kind, k1, k2] = aid.split(':');
    const el = kind === 'act' ? dlg.querySelector(`[data-act="${k1}"][data-v="${k2}"]`) || dlg.querySelector(`[data-act="${k1}"]`) : kind === 'map' ? dlg.querySelector(`[data-map="${k1}"]`) : kind === 'input' ? dlg.querySelector(`[data-input="${k1}"]`) : dlg.querySelector('#' + CSS.escape(aid));
    if (el) { el.focus({ preventScroll: true }); if (sel && typeof el.setSelectionRange === 'function') try { el.setSelectionRange(sel[0], sel[1]); } catch (e) {} }
  }
}
const lastMethod = () => {
  const last = liveTxs().filter(t => t.created_by === S.me).sort((a, b) => b.created_at - a.created_at)[0];
  return (last && last.method) || S.settings.methods[0] || '';
};

/* ---------------- 즐겨찾기 (공유 설정 prefs.favorites, 두 사람이 같이 씀) ---------------- */
const FAV_MAX = 30;
const favorites = () => { const p = store.prefs(); return p && Array.isArray(p.favorites) ? p.favorites : []; };
// 즐겨찾기 묶음 = 거래처·금액·분류·결제자 (추가·빼기·중복 판정이 같은 기준)
const favKey = f => [f.merchant, f.amount, f.category || '', f.payer || ''].join('|');
function favoriteOfDraft() {
  const f = $('[data-form=entry]'); if (f) readEntry(f);
  return { id: uid().replace(/[^A-Za-z0-9]/g, '').slice(0, 10), merchant: draft.merchant, amount: draft.amount, category: draft.category || '', payer: draft.payer || '', method: draft.method || '' };
}
function addFavorite() {
  const fav = favoriteOfDraft(), msg = $('#fav-msg');
  if (draft.type !== 'expense') { msg.textContent = '지출 기록만 즐겨찾기에 넣을 수 있어요'; return; }
  if (!fav.amount || !fav.merchant) { msg.textContent = '금액과 거래처가 있어야 즐겨찾기에 넣을 수 있어요'; return; }
  if (!payerList().includes(fav.payer)) { msg.textContent = '결제자를 골라 주세요'; return; }
  const list = favorites();
  if (list.some(f => favKey(f) === favKey(fav))) { msg.textContent = '이미 즐겨찾기에 있어요'; return; }
  if (list.length >= FAV_MAX) { msg.textContent = `즐겨찾기는 ${FAV_MAX}개까지예요. 설정에서 정리해 주세요`; return; }
  if (!store.setPrefs({ favorites: list.concat(fav) })) { msg.textContent = '즐겨찾기를 저장하지 못했어요'; return; }
  const b = $('[data-act=favadd]'); if (b) { b.outerHTML = favButton(); }
  $('#fav-msg').textContent = '즐겨찾기에 넣었어요. 홈·기록 화면의 즐겨찾기에서 바로 기록할 수 있어요';
}
function removeFavorite(id, silent) {
  const list = favorites(), gone = list.find(f => f.id === id);
  if (!gone || !store.setPrefs({ favorites: list.filter(f => f.id !== id) })) return false;
  if (!silent) toast('즐겨찾기만 삭제했어요(두 사람 모두에게서)', '되돌리기', () => { if (!favorites().some(f => f.id === id)) store.setPrefs({ favorites: favorites().concat(gone) }); });
  return true;
}
// 수정 화면에서 금액·거래처·분류·결제자·종류를 바꾸면 즐겨찾기 버튼도 지금 값 기준으로
function refreshFavButton() {
  const box = $('.fav-field'), f = $('[data-form=entry]');
  if (!box || !f || !draft) return;
  readEntry(f);
  const b = box.querySelector('.btn');
  if (draft.type !== 'expense') { box.hidden = true; return; }
  box.hidden = false; if (b) b.outerHTML = favButton();
}
function favButton() {
  const cur = draft && favorites().find(f => favKey(f) === favKey(draft));
  return cur ? `<button type="button" class="btn ghost" data-act="favdel" data-v="${esc(cur.id)}">${icon('starOn')}<span>즐겨찾기에서 빼기</span></button>`
    : `<button type="button" class="btn ghost" data-act="favadd">${icon('star')}<span>즐겨찾기에 추가</span></button>`;
}

/* 즐겨찾기로 기록: 누르면 오늘 날짜로 바로 저장, 8초 되돌리기 (Astra 디자인 방향) */
function openFavList() {
  if ($('[data-form=entry]')) stashDraft();
  const list = favorites();
  showSheet(`<div class="sheet-wrap">${sheetHead('즐겨찾기로 기록')}
    <div class="sheet-b">
      <p class="hint fav-lead">누르면 오늘 기록으로 바로 저장해요. 결제자와 금액을 먼저 확인해 주세요.</p>
      ${!store.prefs() ? '<div class="empty">서버 업데이트가 필요해요 (Apps Script 새 버전).</div>' : list.length ? `<div class="favorites">${list.map(f => { const r = favRecord(f); return `<button class="favorite" data-act="favsave" data-v="${esc(f.id)}" aria-label="${esc(f.merchant)} ${won(f.amount)}원 오늘 기록"><span><b>${esc(f.merchant)}</b><span class="meta">${esc(r.category || '미분류')} · ${esc(r.payer)} 결제 · ${esc(r.method)}${r.payer !== f.payer ? ' <span class="caption">(결제자 목록에 없어 ' + esc(r.payer) + ')</span>' : ''}</span></span><span class="fav-amt num">${won(f.amount)}원${icon('plus')}</span></button>`; }).join('')}</div>`
        : '<div class="empty"><b>즐겨찾기가 아직 없어요</b><br>자주 쓰는 기록을 열고 "즐겨찾기에 추가"를 눌러 보세요.</div>'}
    </div>
    <div class="sheet-footer two"><button type="button" class="btn ghost" data-act="favmanage">편집</button><button type="button" class="btn ghost" data-act="add">직접 금액 입력</button></div></div>`, true);
}
// 즐겨찾기로 실제 저장될 값(목록에 보이는 값과 같게)
function favRecord(f) {
  return {
    method: S.settings.methods.includes(f.method) ? f.method : lastMethod(),
    category: S.settings.categories.includes(f.category) ? f.category : (f.category || ''),
    payer: payerList().includes(f.payer) ? f.payer : S.me,
  };
}
function saveFavorite(id) {
  const f = favorites().find(x => x.id === id); if (!f) return;
  const fr = favRecord(f);
  const rec = {
    id: uid(), date: today(), merchant: f.merchant, amount: f.amount, type: 'expense',
    method: fr.method, category: fr.category, payer: fr.payer, beneficiary: defaultBene(), note: '', refund_pending: false,
    created_by: S.me, created_at: Date.now(), updated_at: 0, deleted: false,
  };
  if (!store.upsert(rec)) return;
  $('#sheet').close(); render();
  toast(`${f.merchant} ${won(f.amount)}원 기록했어요`, '되돌리기', () => { if (store.remove(rec.id)) { render(); toast('되돌렸어요'); } }, 8000);
}
// 즐겨찾기 관리(삭제) 시트
function openFavManage(msg) {
  const list = favorites();
  showSheet(`<div class="sheet-wrap">${sheetHead('즐겨찾기 관리', 'favlist')}
    <div class="sheet-b">
      <p class="hint fav-lead">두 사람이 같이 써요. 지워도 이미 남긴 기록은 그대로예요.</p>
      ${msg ? `<p class="resume-line">${msg}</p>` : ''}
      ${list.length ? `<div class="card list-card">${list.map(f => `<div class="favorite-row"><span class="fr-main"><b>${icon('starOn')}${esc(f.merchant)}</b><span class="muted">${esc(f.category || '미분류')} · ${esc(f.payer || '-')} 결제</span></span><b class="num">${won(f.amount)}원</b><button class="fr-del" data-act="favdel" data-v="${esc(f.id)}" aria-label="${esc(f.merchant)} 즐겨찾기 삭제">삭제</button></div>`).join('')}</div>`
        : '<div class="empty">즐겨찾기가 없어요. 기록을 열고 "즐겨찾기에 추가"를 눌러 보세요.</div>'}
    </div></div>`);
}
let favUndo = null;

/* ---------------- 가져오기: 카드 알림 붙여넣기 · 파일 (확인 목록은 공용) ---------------- */
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const XLSX_SRI = 'sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA==';
const IMP_PAGE = 100, IMP_MAX_ROWS = 5000, IMP_MAX_BYTES = 10 * 1024 * 1024;
let imp = null, impPrev = null, xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return xlsxLoading || (xlsxLoading = new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = XLSX_URL; s.integrity = XLSX_SRI; s.crossOrigin = 'anonymous';
    s.onload = () => window.XLSX ? ok(window.XLSX) : fail(new Error('load'));
    s.onerror = () => { xlsxLoading = null; s.remove(); fail(new Error('offline')); };
    document.head.appendChild(s);
  }));
}
function openImport(kind) {
  if ($('[data-form=entry]')) stashDraft();
  // 저장하지 않고 닫은 확인 목록은 앱을 끄기 전까지 이어서 볼 수 있다(원문·파일은 기기 저장소에 남기지 않음)
  if (impPrev && impPrev.kind === kind && impPrev.items.length) { imp = impPrev; imp.resumed = true; imp.saving = false; }
  else imp = { kind, step: kind, text: '', items: [], unread: [], editing: -1, shown: IMP_PAGE, file: null, err: '', saving: false };
  impPrev = null;
  showSheet(importHtml());
  if (imp.step === 'paste') { const t = $('#paste-text'); t.focus({ preventScroll: true }); }
}
// 시트가 닫힐 때 확인 중이던 목록을 잠시 보관
function parkImport() {
  if (imp && imp.step === 'review' && imp.items.length && !imp.done) { commitEdit(); impPrev = imp; }
  imp = null;
}
const renderImport = () => { if (imp) repaintSheet(importHtml()); };
const impHead = (title, back) => sheetHead(title, back ? 'impback' : '') + `<p class="step-label">${imp.kind === 'paste' ? (imp.step === 'paste' ? '1/2 · 알림 입력' : '2/2 · 확인 목록') : imp.step === 'file' ? '1/3 · 파일 선택' : imp.step === 'map' ? '2/3 · 항목 확인' : '3/3 · 확인 목록'}</p>`;
function importHtml() {
  const st = imp.step;
  if (st === 'paste') return `<form data-form="paste" class="sheet-wrap" novalidate>${impHead('알림 붙여넣기', false)}
    <div class="sheet-b">
      <p class="lead-hint">카드 문자나 카드 앱 알림을 <b>여러 개 한 번에</b> 붙여넣으세요. 확인한 기록만 장부에 넣어요.</p>
      <label class="lab-strong" for="paste-text">카드 알림 원문</label>
      <textarea id="paste-text" class="in paste-in" rows="9" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="예)\n가나카드 승인 12,300원\n10/18 12:34 스타벅스\n\n취소 문자도 함께 넣으면 환불로 기록해요">${esc(imp.text)}</textarea>
      <p class="hint">글은 이 기기 안에서만 읽고 어디에도 보내지 않아요.</p>
    </div>
    <div class="sheet-footer"><div class="err" id="imp-err" role="alert">${esc(imp.err)}</div><button class="btn" type="submit">확인 목록 보기</button></div></form>`;
  if (st === 'file') return `<div class="sheet-wrap">${impHead('빠진 기록 가져오기', false)}
    <div class="sheet-b">
      <p class="lead-hint">카드사 이용내역이나 다른 가계부에서 내려받은 <b>CSV·엑셀 파일</b>을 골라 주세요. 이미 적은 기록과 대조해 빠진 것만 골라 드려요.</p>
      <label class="btn file-btn${imp.loading ? ' is-busy' : ''}" for="imp-file" aria-disabled="${!!imp.loading}">${icon('file')}<span>${imp.loading ? '파일 읽는 중…' : '파일 고르기'}</span></label>
      <input type="file" id="imp-file" class="visually-hidden" ${imp.loading ? 'disabled' : ''} accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm,text/csv,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
      <div class="err" id="imp-err" role="alert">${esc(imp.err)}</div>
      <p class="hint">10MB·5,000줄까지. 더 크면 기간을 나눠 내려받아 주세요. 파일은 이 기기 안에서만 읽어요. 엑셀(xlsx·xls)은 읽기 도구를 내려받아야 해서 인터넷이 필요해요. CSV는 오프라인에서도 돼요.</p>
    </div></div>`;
  if (st === 'map') return mapHtml();
  return reviewHtml();
}

/* 파일 → 표. 읽는 사이 다른 파일을 고르거나 닫으면 늦게 끝난 결과는 버린다 */
async function loadImportFile(file) {
  const mine = imp, ticket = (mine.ticket = (mine.ticket || 0) + 1);
  const stale = () => imp !== mine || mine.ticket !== ticket;
  mine.err = ''; mine.loading = true; renderImport();
  try {
    if (file.size > IMP_MAX_BYTES) throw new Error('파일이 너무 커요(10MB까지). 기간을 나눠 내려받아 주세요');
    const buf = await file.arrayBuffer(); if (stale()) return;
    const u8 = new Uint8Array(buf);
    const zip = u8[0] === 0x50 && u8[1] === 0x4B, ole = u8[0] === 0xD0 && u8[1] === 0xCF;
    let sheets;
    if (zip || ole || /\.(xlsx|xls|xlsm)$/i.test(file.name)) {
      let X;
      try { X = await loadXlsx(); } catch (e) { throw new Error('엑셀 파일을 읽으려면 인터넷 연결이 필요해요. CSV 파일은 오프라인에서도 돼요'); }
      if (stale()) return;
      let wb;
      try { wb = X.read(u8, { type: 'array' }); } catch (e) { throw new Error(/password|encrypt/i.test(e.message) ? '암호가 걸린 파일이에요. 암호 없이 저장한 파일을 골라 주세요' : '이 파일을 읽지 못했어요. CSV나 XLSX로 저장해 다시 골라 주세요'); }
      sheets = wb.SheetNames.map(name => ({ name, rows: X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' })
        .map(r => r.map(v => typeof v === 'string' ? v.trim() : v)).filter(r => r.some(v => v !== '' && v != null)) }));
    } else {
      sheets = [{ name: file.name, rows: core.parseCsv(core.decodeText(u8)) }];
    }
    sheets = sheets.filter(s => s.rows.length);
    if (!sheets.length) throw new Error('파일에 읽을 내용이 없어요');
    const si = sheets.reduce((b, s, i) => s.rows.length > sheets[b].rows.length ? i : b, 0);
    mine.file = { name: file.name, u8, sheets, si, enc: '', negative: '' };
    setupMapping();
    mine.step = 'map';
  } catch (e) { if (stale()) return; mine.err = e.message || '파일을 읽지 못했어요'; }
  mine.loading = false; renderImport();
}
function setupMapping(keepHeader) {
  const f = imp.file, rows = f.sheets[f.si].rows;
  if (!keepHeader) f.h = core.detectHeaderRow(rows);
  f.data = rows.slice(f.h + 1);
  f.over = f.data.length > IMP_MAX_ROWS;
  f.header = f.h >= 0 ? rows[f.h] : null;
  f.mapping = core.guessColumns(f.header, f.data.slice(0, 200));
  f.negative = '';
}
const ROLES = [['date', '날짜', 1], ['amount', '금액(원)', 1], ['merchant', '가맹점·거래처', 1], ['time', '시각'], ['type', '종류(승인·취소·구분)'], ['currency', '통화'], ['category', '분류'], ['payer', '결제자'], ['method', '결제수단'], ['note', '메모'], ['months', '할부 개월']];
const convOpts = f => ({ negative: f.negative, header: f.header, today: today() });
function mapHtml() {
  const f = imp.file, rows = f.sheets[f.si].rows;
  const ncol = Math.max(0, ...f.data.slice(0, 50).map(r => r.length), f.header ? f.header.length : 0);
  const sampleOf = i => { const r = f.data.find(r => r[i] !== '' && r[i] != null); return r ? String(r[i]).slice(0, 16) : ''; };
  const colName = i => (f.header && String(f.header[i] || '').trim()) || `${i + 1}번째 열`;
  const opt = (role, i) => `<option value="${i}" ${f.mapping[role] === i ? 'selected' : ''}>${esc(colName(i))}${sampleOf(i) ? ' · 예: ' + esc(sampleOf(i)) : ''}</option>`;
  const sel = ([role, label, req]) => `<label class="map-row" for="map-${role}"><span>${label}${req ? '' : ' <span class="muted">선택</span>'}</span>
    <select id="map-${role}" class="in" data-map="${role}"><option value="-1">${req ? '골라 주세요' : '없음'}</option>${Array.from({ length: ncol }, (_, i) => opt(role, i)).join('')}</select></label>`;
  // 미리보기는 앞쪽 원본 3줄을 그대로 변환해 원본 → 결과(또는 못 읽는 이유)로 보여 준다
  const sample = f.data.slice(0, 3);
  const pv = sample.map(r => { const c = core.rowsToCandidates([r], f.mapping, Object.assign(convOpts(f), { negative: f.negative || 'refund' })); return { r, it: c.items[0], why: c.unread[0] && c.unread[0].why }; });
  const conv = f.over ? null : core.rowsToCandidates(f.data, f.mapping, convOpts(f));
  const needNeg = conv && conv.negatives && !f.negative;
  const ready = conv && f.mapping.date >= 0 && f.mapping.amount >= 0 && conv.items.length && !needNeg;
  const isCsv = f.sheets.length === 1 && !/\.(xlsx|xls|xlsm)$/i.test(f.name);
  return `<div class="sheet-wrap">${impHead('열 연결', true)}
    <div class="sheet-b">
      <div class="file-line"><span>${icon('file')}<b>${esc(f.name)}</b> <span class="muted">${f.data.length.toLocaleString('ko-KR')}줄</span></span><button type="button" class="link" data-act="impfile">다른 파일</button></div>
      ${f.over ? `<p class="err" role="alert">5,000줄이 넘어요(${f.data.length.toLocaleString('ko-KR')}줄). 카드사에서 기간을 나눠 내려받아 주세요.</p>` : ''}
      ${f.sheets.length > 1 ? `<label class="map-row" for="map-sheet"><span>시트</span><select id="map-sheet" class="in" data-map="sheet">${f.sheets.map((s, i) => `<option value="${i}" ${i === f.si ? 'selected' : ''}>${esc(s.name)} (${s.rows.length}줄)</option>`).join('')}</select></label>` : ''}
      <label class="map-row" for="map-head"><span>머리줄</span><select id="map-head" class="in" data-map="head"><option value="-1" ${f.h < 0 ? 'selected' : ''}>없음 (첫 줄부터 내용)</option>${rows.slice(0, 15).map((r, i) => `<option value="${i}" ${f.h === i ? 'selected' : ''}>${i + 1}번째 줄: ${esc(r.filter(v => v !== '').slice(0, 4).join(', ').slice(0, 40))}</option>`).join('')}</select></label>
      ${isCsv ? `<p class="hint enc-line">글자가 깨졌나요? <button type="button" class="link" data-act="impenc">${f.enc === 'euc-kr' ? '자동으로 다시 읽기' : '한국어(EUC-KR)로 다시 읽기'}</button></p>` : ''}
      <h2 class="map-h">어떤 열인지 확인해 주세요</h2>
      <div class="column-map">${ROLES.slice(0, 3).map(sel).join('')}</div>
      <h2 class="map-h">미리보기 <span class="h2sub">앞쪽 원본 3줄</span></h2>
      <div class="card file-preview">${pv.map(({ r, it, why }) => `<div class="pv-row"><span class="pv-src">${esc(r.filter(v => v !== '' && v != null).join(' · ').slice(0, 70))}</span>
        ${it ? `<span class="pv-out"><span>→ ${it.date.slice(0, 4) !== String(new Date().getFullYear()) ? it.date.slice(0, 4) + '.' : ''}${md(it.date)}${it.time ? ' ' + it.time : ''} · ${esc(it.merchant || '거래처 없음')}</span><b class="num${it.type === 'refund' ? ' ref' : ''}">${it.type === 'refund' ? '환불 ' : it.type === 'transfer' ? '제외 ' : ''}${it.amount ? won(it.amount) + '원' : esc(it.foreign || '금액 없음')}</b></span>` : `<span class="pv-out pv-bad">→ ${esc(why || (f.mapping.date < 0 ? '날짜 열을 골라 주세요' : f.mapping.amount < 0 ? '금액 열을 골라 주세요' : '이 줄은 건너뛰어요'))}</span>`}</div>`).join('') || '<div class="empty">내용이 없어요</div>'}</div>
      ${conv ? `<p class="hint">${conv.items.length}건 읽음${conv.unread.length ? ` · ${conv.unread.length}줄은 가져올 수 없어요(다음 화면에서 이유 확인)` : ''}</p>` : ''}
      <details class="more map-more" data-k="map-more"><summary><span class="sum-wrap"><span class="sum-lab">더 연결하기</span><span class="sum">시각·종류·통화·분류·결제자·결제수단·메모·할부</span></span>${icon('down')}</summary><div class="column-map">${ROLES.slice(3).map(sel).join('')}</div></details>
      ${conv && conv.negatives ? `<div class="field neg-field${needNeg ? ' need' : ''}"><span class="lab">음수 금액이 ${conv.negatives}줄 있어요. 어떻게 가져올까요?</span><div class="seg">${[['refund', '환불'], ['expense', '지출'], ['skip', '건너뛰기']].map(([k, l]) => `<button type="button" data-act="impneg" data-v="${k}" aria-pressed="${f.negative === k}">${l}${conv.negSuggested === k ? ' <small>추천</small>' : ''}</button>`).join('')}</div>
        <p class="hint">카드 이용내역의 음수는 보통 취소(환불), 다른 가계부는 보통 지출이에요.</p></div>` : ''}
    </div>
    <div class="sheet-footer">${needNeg && !imp.err ? '<p class="foot-hint">위에서 음수 금액 처리 방식을 골라 주세요</p>' : ''}<div class="err" id="imp-err" role="alert">${esc(imp.err)}</div>
      <button type="button" class="btn" data-act="impfind" ${ready ? '' : 'disabled'}>빠진 기록 찾기</button></div></div>`;
}

/* 후보 → 확인 목록 */
// 저장을 막는 조건(선택·저장 두 곳에서 같은 검사)
function impValidate(it) {
  const e = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || '') || core.toDate(it.date) !== it.date) e.push('날짜를 확인해 주세요');
  else if (it.date > today()) e.push('미래 날짜예요. 확인해 주세요');
  if (!(Number.isInteger(it.amount) && it.amount > 0)) e.push(it.foreign ? '원화 금액을 넣어 주세요' : '금액을 넣어 주세요');
  if (!it.merchant) e.push('거래처를 넣어 주세요');
  if (!payerList().includes(it.payer)) e.push('결제자를 골라 주세요');
  return e;
}
const impBlocked = it => it.issues.length > 0 || impValidate(it).length > 0;
const impDefaultOn = it => !it.dup && !impBlocked(it);
function prepareItems(items, rawFor) {
  const hist = liveTxs(), defMethod = lastMethod(), sg = core.makeSuggester(hist, S.settings);
  items.forEach(it => {
    it.uid = uid();
    const s = sg(it.merchant, rawFor ? it.raw : '');
    if (!it.category || !S.settings.categories.includes(it.category)) { const fc = it.category; it.category = s.category || fc || ''; it.sug = !!s.category && !fc; }
    if (it.payer && !payerList().includes(it.payer)) { it.payerRaw = it.payer; it.payer = ''; }
    if (!it.payer && !it.payerRaw) it.payer = S.me;
    if (!it.method || !S.settings.methods.includes(it.method)) it.method = s.method || defMethod;
    it.issues = [...new Set([...it.issues, ...impValidate(it).filter(x => !it.issues.includes(x))])];
  });
  core.markDuplicates(items, hist, { batchNoTime: !!rawFor });
  items.forEach(it => { it.on = impDefaultOn(it); });
  return items;
}
const impCount = () => {
  const c = { fresh: 0, dup: 0, check: 0 };
  imp.items.forEach(it => { if (it.dup === 'same' || it.dup === 'batch') c.dup++; else if (impBlocked(it) || it.dup === 'similar') c.check++; else c.fresh++; });
  return c;
};
function impTags(it) {
  const t = [];
  if (it.type === 'refund') t.push('<span class="tag inflow">환불</span>');
  if (it.type === 'transfer') t.push('<span class="tag q">지출 제외</span>');
  if (it.dup === 'same') t.push(`<span class="tag dup">이미 있음</span>`);
  if (it.dup === 'similar') t.push(`<span class="tag warn">비슷한 기록 있음</span>`);
  if (it.dup === 'batch') t.push('<span class="tag dup">목록 안에서 반복</span>');
  it.issues.forEach(s => t.push(`<span class="tag warn">${esc(s)}</span>`));
  if (it.payerRaw && !it.payer) t.push(`<span class="tag q">원본 결제자: ${esc(it.payerRaw)}</span>`);
  if (it.months) t.push(`<span class="tag q">${it.months}개월 할부</span>`);
  if (it.foreign) t.push(`<span class="tag q">${esc(it.foreign)}</span>`);
  return t.join('');
}
// 올해가 아니거나 연도를 추정해 확인이 필요하면 연도까지 보여 준다
function impDate(it) {
  const d = parseDate(it.date), y = d.getFullYear();
  // 연도를 추정한 날짜(연도 없는 카드 문자)는 항상 연도까지 보여 준다
  const showY = y !== new Date().getFullYear() || it.yearGuessed;
  return `${showY ? y + '.' : ''}${d.getMonth() + 1}.${d.getDate()}(${WEEK[d.getDay()]})${it.yearGuessed ? ' <span class="muted">연도 추정</span>' : ''}`;
}
function impRow(it, i) {
  const m = it.match;
  const match = m ? `<span class="imp-match">기록: ${parseDate(m.date).getFullYear() !== new Date().getFullYear() ? m.date.slice(0, 4) + '.' : ''}${md(m.date)} ${esc(m.merchant || '거래처 없음')} ${won(m.amount)}원</span>` : '';
  const editing = imp.editing === i;
  return `<div class="import-row${it.on ? ' on' : ''}${it.dup ? ' is-dup' : ''}${editing ? ' is-editing' : ''}" data-i="${i}">
    <label class="imp-main imp-sel"><input type="checkbox" data-act="impchk" data-v="${i}" ${it.on ? 'checked' : ''} aria-label="${esc(it.merchant || '거래처 없음')} ${won(it.amount)}원 저장"><span class="imp-body">
      <span class="imp-top"><span class="imp-m">${esc(it.merchant || '거래처 없음')}</span><span class="imp-a num${it.type === 'refund' ? ' ref' : it.type === 'transfer' ? ' ex' : ''}">${it.type === 'refund' ? '+' : ''}${it.amount ? won(it.amount) + '원' : '금액 없음'}</span></span>
      <span class="imp-meta">${impDate(it)}${it.time ? ' ' + it.time : ''} · ${esc(it.category || '미분류')}${it.sug ? ' <span class="muted">(추천)</span>' : ''} · ${it.payer ? esc(it.payer) + ' 결제' : '결제자 미정'}</span>
      ${impTags(it) ? `<span class="imp-tags">${impTags(it)}</span>` : ''}${match}
      ${impBlocked(it) ? '<span class="imp-edit-hint">고쳐야 선택할 수 있어요</span>' : ''}</span></label>
    <button type="button" class="imp-edit-btn" data-act="impedit" data-v="${i}" aria-expanded="${editing}" aria-label="${esc(it.merchant || '거래처 없음')} 수정">${editing ? '닫기' : '수정'}</button></div>${editing ? impEditor(it, i) : ''}`;
}
function impEditor(it, i) {
  const cats = [...new Set([...S.settings.categories, ...(it.category ? [it.category] : [])])];
  const methods = [...new Set([...S.settings.methods, ...(it.method ? [it.method] : [])])];
  return `<div class="imp-edit" data-ui-key="imp-edit" id="imp-edit">
    <div class="row2"><div class="field"><label for="ie-amount">금액(원)</label><input id="ie-amount" class="in num" data-money inputmode="numeric" value="${it.amount ? won(it.amount) : ''}" autocomplete="off"></div>
      <div class="field"><label for="ie-date">날짜</label><input id="ie-date" type="date" class="in" value="${esc(it.date)}" max="${today()}"></div></div>
    <div class="field"><label for="ie-merchant">거래처</label><input id="ie-merchant" class="in" value="${esc(it.merchant)}" autocomplete="off"></div>
    <div class="row2"><div class="field"><label for="ie-cat">분류</label><select id="ie-cat" class="in"><option value="">미분류</option>${cats.map(c => `<option ${c === it.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="field"><label for="ie-payer">결제자</label><select id="ie-payer" class="in">${it.payer ? '' : '<option value="" selected>골라 주세요</option>'}${payerList().map(p => `<option ${p === it.payer ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div></div>
    <div class="field"><span class="lab">종류</span><div class="seg" id="ie-type">${Object.entries(TYPE_LABEL).map(([k, l]) => `<button type="button" data-act="ietype" data-v="${k}" aria-pressed="${it.type === k}">${l}</button>`).join('')}</div></div>
    <details class="more" data-k="ie-more"><summary><span class="sum-wrap"><span class="sum-lab">더 수정하기</span><span class="sum">시각·결제수단·메모</span></span>${icon('down')}</summary>
      <div class="row2"><div class="field"><label for="ie-time">시각</label><input id="ie-time" type="time" class="in" value="${esc(it.time || '')}"></div>
        <div class="field"><label for="ie-method">결제수단</label><select id="ie-method" class="in">${methods.map(m => `<option ${m === it.method ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></div></div>
      <div class="field"><label for="ie-note">메모</label><input id="ie-note" class="in" value="${esc(it.note || '')}" autocomplete="off" maxlength="200"></div></details>
    ${it.raw ? `<details class="source-detail"><summary>원문 보기</summary><pre>${esc(it.raw)}</pre></details>` : ''}
    <div class="err" id="ie-err" role="alert"></div>
    <div class="imp-edit-btns"><button type="button" class="btn ghost" data-act="impcancel">취소</button><button type="button" class="btn" data-act="impapply" data-v="${i}">목록에 반영</button></div>
  </div>`;
}
function impFooter() {
  const sel = imp.items.filter(it => it.on), s = core.summarize(sel);
  const parts = [s.expense ? `지출 <b class="num">${won(s.expense)}원</b>` : '', s.refund ? `환불 <b class="num">${won(s.refund)}원</b>` : '', s.transfer ? `지출 제외 <b class="num">${won(s.transfer)}원</b>` : ''].filter(Boolean).join(' · ');
  const label = imp.saving ? '저장 중…' : imp.editing >= 0 ? '수정 반영하고 ' + (sel.length || '') + (sel.length ? '건 ' : '') + '저장' : sel.length ? sel.length + '건 저장' : '저장';
  return `<div class="sheet-footer" id="imp-foot">
    <p class="foot-sum">${sel.length ? `<b>${sel.length}건</b> 선택 · ${parts}` : '추가할 내역을 골라 주세요'}</p>
    <div class="err" id="imp-err" role="alert">${esc(imp.err)}</div>
    <button type="button" class="btn" data-act="impsave" ${(sel.length || imp.editing >= 0) && !imp.saving ? '' : 'disabled'}>${label}</button></div>`;
}
function reviewHtml() {
  const c = impCount(), file = imp.kind === 'file', st = store.status();
  const rows = imp.items.slice(0, imp.shown).map(impRow).join('');
  const more = imp.items.length - imp.shown;
  const when = st.lastSync ? new Date(st.lastSync).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }) : '';
  return `<div class="sheet-wrap">${impHead(file ? '빠진 기록 확인' : '알림 확인', true)}
    <div class="sheet-b">
      ${imp.resumed ? `<p class="resume-line">아까 확인하던 목록이에요. <button type="button" class="link" data-act="impfresh">새로 시작</button></p>` : ''}
      <div class="import-summary" role="status"><span><b class="num">${c.fresh}</b> ${file ? '빠진 기록' : '새 기록'}</span><span><b class="num">${c.dup}</b> 이미 있음</span><span${c.check ? ' class="warn"' : ''}><b class="num">${c.check}</b> 확인 필요</span></div>
      <p class="hint basis">이 기기에 있는 기록과 비교했어요${when ? ` · 마지막 공유 ${when}` : ''}${navigator.onLine === false ? ' · 오프라인이라 다른 기기의 새 기록은 빠져 있을 수 있어요' : ''}</p>
      <div class="imp-tools"><button type="button" class="link" data-act="impsel" data-v="new">추가할 것만 선택</button><button type="button" class="link" data-act="impsel" data-v="none">선택 해제</button>
        <label class="imp-bulk">결제자 모두 <select class="in" data-input="impbulk" aria-label="모든 건의 결제자 한꺼번에 바꾸기"><option value="">그대로</option>${payerList().map(p => `<option>${esc(p)}</option>`).join('')}</select></label></div>
      ${imp.items.length ? `<div class="card import-list">${rows}</div>` : '<div class="card"><div class="empty">가져올 내역이 없어요.</div></div>'}
      ${more > 0 ? `<button type="button" class="btn ghost" data-act="impmore">${more}건 더 보기</button>` : ''}
      ${imp.unread.length ? `<details class="source-detail unread"><summary>가져오지 못한 내용 ${imp.unread.length}개</summary>${imp.unread.slice(0, 200).map(u => `<div class="unread-row"><b>${u.line ? u.line + '번째 줄 · ' : ''}${esc(u.why)}</b><pre>${esc(u.raw)}</pre></div>`).join('')}
        ${imp.unread.length > 200 ? `<p class="hint">외 ${imp.unread.length - 200}개는 파일에서 직접 확인해 주세요.</p>` : ''}
        <p class="hint">필요하면 기록 화면에서 직접 입력해 주세요.</p></details>` : ''}
    </div>${impFooter()}</div>`;
}
const refreshImpFooter = () => { const f = $('#imp-foot'); if (f) f.outerHTML = impFooter(); };
// 열린 수정 칸의 값을 후보에 반영한다. 반영 못 하면(검사 실패) false
function commitEdit() {
  if (!imp || imp.editing < 0 || !$('#ie-amount')) return true;
  const it = imp.items[imp.editing];
  const next = Object.assign({}, it, {
    amount: Number(String($('#ie-amount').value).replace(/[^\d]/g, '')) || 0,
    date: $('#ie-date').value || '',
    merchant: $('#ie-merchant').value.trim().slice(0, 60),
    category: $('#ie-cat').value, payer: $('#ie-payer').value,
    time: $('#ie-time') ? $('#ie-time').value : it.time, method: $('#ie-method') ? $('#ie-method').value : it.method,
    note: $('#ie-note') ? $('#ie-note').value.trim().slice(0, 200) : it.note,
  });
  const ty = $('#ie-type [aria-pressed=true]'); if (ty) next.type = ty.dataset.v;
  const errs = impValidate(next);
  if (errs.length) { $('#ie-err').textContent = errs.join(' · '); return false; }
  Object.assign(it, next, { issues: [], sug: false, edited: true });
  if (it.payer) it.payerRaw = '';
  const keep = imp.items.map(x => x.on);
  core.markDuplicates(imp.items, liveTxs(), { batchNoTime: imp.kind === 'paste' });
  imp.items.forEach((x, k) => { x.on = keep[k]; });
  it.on = it.dup !== 'same' && it.dup !== 'batch';
  imp.editing = -1;
  return true;
}
function openEditor(i) {
  if (!commitEdit()) return;
  if (imp.editing === i) { renderImport(); return; } // commitEdit가 닫았다
  imp.editing = i; renderImport();
  const ed = $('#imp-edit'); if (ed) ed.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}
function impSave() {
  if (imp.saving) return;
  if (!commitEdit()) { const ed = $('#imp-edit'); if (ed) ed.scrollIntoView({ block: 'nearest' }); return; }
  const blocked = imp.items.filter(it => it.on && impBlocked(it));
  if (blocked.length) { blocked.forEach(it => { it.on = false; }); imp.err = `${blocked.length}건은 확인이 필요해 선택을 풀었어요. 눌러서 고친 뒤 저장해 주세요`; renderImport(); return; }
  const sel = imp.items.filter(it => it.on);
  if (!sel.length) { renderImport(); return; }
  imp.saving = true; imp.err = ''; refreshImpFooter();
  // '저장 중'을 먼저 그린 뒤 처리한다
  setTimeout(() => {
    if (!imp || !imp.saving) return;
    // 저장 직전 다시 대조: 그사이 다른 기기에서 같은 기록이 들어왔으면 선택을 푼다
    const fresh = core.markDuplicates(sel.map(it => Object.assign({}, it)), liveTxs());
    const late = sel.filter((it, k) => fresh[k].dup === 'same' && it.dup !== 'same');
    if (late.length) {
      late.forEach(it => { it.on = false; it.dup = 'same'; });
      imp.saving = false; imp.err = `${late.length}건이 방금 기록돼 있어 선택을 풀었어요. 확인 후 다시 저장해 주세요`; renderImport(); return;
    }
    const now = Date.now(), bene = defaultBene();
    const recs = sel.map((it, k) => ({
      id: it.uid, date: it.date, merchant: it.merchant, amount: it.amount, type: it.type,
      method: it.method, category: it.category, payer: it.payer, beneficiary: bene,
      note: [it.note, it.time, it.months ? it.months + '개월 할부' : '', it.foreign ? '해외 ' + it.foreign : ''].filter(Boolean).join(' · ').slice(0, 200),
      refund_pending: false, created_by: S.me, created_at: now + k, updated_at: 0, deleted: false,
    }));
    if (!store.upsertMany(recs)) { imp.saving = false; imp.err = '기기 저장공간이 부족해 저장하지 못했어요'; refreshImpFooter(); return; }
    const n = recs.length, ids = recs.map(r => r.id), dates = recs.map(r => r.date).sort();
    imp.done = true; imp = null; impPrev = null;
    $('#sheet').close();
    resetListFilter(); lf.period = 'custom'; lf.from = dates[0]; lf.to = dates[dates.length - 1]; tab = 'list'; render(); scrollTo(0, 0);
    toast(`${n}건 저장했어요 · 저장한 기간을 보여드려요`, '되돌리기', () => {
      const back = ids.map(id => store.get(id)).filter(Boolean).map(t => Object.assign({}, t, { deleted: true }));
      if (store.upsertMany(back)) { render(); toast(`${back.length}건을 되돌렸어요`); }
    });
  }, 30);
}

/* ---------------- 내역 필터 ---------------- */
const LF0 = () => ({ period: 'cycle', from: '', to: '', cats: [], payers: [], min: 0, max: 0, kind: 'all', q: '' });
let lf = LF0(), lfDraft = null, lfLimit = 200, lfOpenSum = false;
const KINDS = [['all', '전체'], ['expense', '지출'], ['refund', '환불'], ['refund_pending', '환불 대기'], ['transfer', '지출 제외']];
function listRange() {
  if (lf.period === 'all') return null;
  if (lf.period === 'custom' && lf.from && lf.to) return lf.from <= lf.to ? { start: lf.from, end: lf.to } : { start: lf.to, end: lf.from };
  return cycleRange(offset);
}
const lfActive = f => f.cats.length + f.payers.length + (f.min || f.max ? 1 : 0) + (f.kind !== 'all' ? 1 : 0) + (f.period !== 'cycle' || offset !== 0 ? 1 : 0) + (f.q.trim() ? 1 : 0);
const amtLabel = f => f.min && f.max ? `${man(f.min)}~${man(f.max)}` : f.min ? `${man(f.min)} 이상` : f.max ? `${man(f.max)} 이하` : '';
function openListFilter(section) {
  lfDraft = JSON.parse(JSON.stringify(lf));
  lfDraft.offset = offset;
  showSheet(lfSheetHtml(), true);
  const el = section && $('#lf-' + section); if (el) el.scrollIntoView({ block: 'start' });
}
function lfSheetHtml() {
  const f = lfDraft, cats = [...new Set([...S.settings.categories, ...liveTxs().map(t => t.category || '미분류')])];
  const r = f.period === 'cycle' ? cycleRange(f.offset) : null;
  const range = f.period === 'all' ? null : f.period === 'custom' ? (f.from && f.to ? { start: f.from, end: f.to } : cycleRange(0)) : r;
  const n = core.filterTxs(liveTxs(), f, range).length;
  const badAmt = !!(f.min && f.max && f.min > f.max), badDate = f.period === 'custom' && f.from && f.to && f.from > f.to, bad = badAmt || badDate;
  const chip = (act, v, on, label) => `<button type="button" class="chip" data-act="${act}" data-v="${esc(v)}" aria-pressed="${on}">${esc(label)}</button>`;
  return `<div class="sheet-wrap">
    ${sheetHead('내역 필터')}
    <div class="sheet-b lf-body">
      <section class="filter-section" id="lf-period"><h3>기간</h3>
        <div class="seg">${[['cycle', '결제 주기'], ['all', '전체 기간'], ['custom', '직접 지정']].map(([k, l]) => `<button type="button" data-act="lfperiod" data-v="${k}" aria-pressed="${f.period === k}">${l}</button>`).join('')}</div>
        ${f.period === 'cycle' ? `<div class="cyc lf-cyc"><button type="button" data-act="lfcyc" data-v="-1" aria-label="이전 주기">${icon('left')}</button><div class="lbl"><b>${f.offset === 0 ? '이번 주기' : r.year + '년'}</b>${r.label}</div><button type="button" data-act="lfcyc" data-v="1" aria-label="다음 주기" ${f.offset >= 0 ? 'disabled' : ''}>${icon('right')}</button></div>` : ''}
        ${f.period === 'custom' ? `<div class="row2 custom-dates"><label>시작일<input type="date" class="in" data-input="lffrom" value="${esc(f.from || cycleRange(0).start)}" max="${today()}"></label><label>끝일<input type="date" class="in" data-input="lfto" value="${esc(f.to || today())}" max="${today()}"></label></div>` : ''}
        <div class="err">${badDate ? '시작일이 끝일보다 늦어요' : ''}</div>
      </section>
      <section class="filter-section" id="lf-cats"><h3>분류 <span class="h2sub">여러 개 고를 수 있어요</span></h3><div class="chips">${cats.map(c => chip('lfcat', c, f.cats.includes(c), c)).join('')}</div></section>
      <section class="filter-section" id="lf-payers"><h3>결제자</h3><div class="chips">${payerList().map(p => chip('lfpayer', p, f.payers.includes(p), p)).join('')}</div></section>
      <section class="filter-section" id="lf-amount"><h3>금액</h3><div class="row2 amt-range">
        <label>최소<span class="budget-in"><input data-money data-input="lfmin" inputmode="numeric" autocomplete="off" class="num" placeholder="제한 없음" value="${f.min ? won(f.min) : ''}"><span>원</span></span></label>
        <label>최대<span class="budget-in"><input data-money data-input="lfmax" inputmode="numeric" autocomplete="off" class="num" placeholder="제한 없음" value="${f.max ? won(f.max) : ''}"><span>원</span></span></label></div>
        <div class="err">${badAmt ? '최소 금액이 최대 금액보다 커요' : ''}</div></section>
      <section class="filter-section" id="lf-kind"><h3>종류</h3><div class="chips">${KINDS.map(([k, l]) => chip('lfkind', k, f.kind === k, l)).join('')}</div></section>
    </div>
    <div class="sheet-footer lf-foot"><button type="button" class="btn ghost" data-act="lfreset">조건 초기화</button><button type="button" class="btn" data-act="lfapply" ${bad ? 'disabled' : ''}>결과 ${n}건 보기</button></div></div>`;
}
const repaintLf = () => repaintSheet(lfSheetHtml());
function applyListFilter() {
  offset = lfDraft.offset; delete lfDraft.offset;
  lf = lfDraft; lfDraft = null; lfLimit = 200; calDay = '';
  if (lf.period !== 'cycle' && view.list === 'cal') view.list = 'rows';
  $('#sheet').close(); render(); scrollTo(0, 0);
}
function resetListFilter() { lf = LF0(); offset = 0; lfLimit = 200; calDay = ''; }
let qTimer;

/* ---------------- 이벤트 ---------------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const v = b.dataset.v;
  switch (b.dataset.act) {
    case 'tab': tab = v; render(); scrollTo(0, 0); break;
    case 'add': if ($('#sheet').open) { parkImport(); } openEntry(); break;
    /* 홈 */
    case 'hoff': homeOff = Math.min(0, homeOff + Number(v)); render(); break;
    case 'hperiod': openPeriodSheet(); break;
    case 'hpick': homeOff = Number(v); $('#sheet').close(); render(); break;
    case 'homelist': resetListFilter(); offset = homeOff; tab = 'list'; render(); scrollTo(0, 0); break;
    case 'homecat': resetListFilter(); offset = homeOff; lf.cats = [v]; tab = 'list'; render(); scrollTo(0, 0); break;
    case 'analysis': view.analysis = !view.analysis; if (view.analysis && view.mode === 'month') hOff = homeOff; saveView(); render(); break;
    case 'favlist': openFavList(); break;
    case 'favsave': saveFavorite(v); break;
    case 'morecat': { const det = $('#sheet details.more'); if (det) { det.open = true; const c = $('#cats'); if (c) c.scrollIntoView({ block: 'center' }); } break; }
    /* 설정 */
    case 'theme': store.setLocal('theme', v === 'system' ? null : v); applyTheme(S.theme); render(); break;
    case 'setcycle': openCycleSheet(); break;
    case 'setlists': openListsSheet(); break;
    case 'setcode': openCodeSheet(); break;
    case 'edit': {
      const row = b.closest('.swipe');
      if (Date.now() - swipedAt < 350) break;
      if (row && row.classList.contains('open')) { closeSwipes(); break; }
      openEntry(v); break;
    }
    case 'askdel': askDelete(v); break;
    case 'close': stashDraft(); parkImport(); $('#sheet').close(); break;
    case 'cyc': offset = Math.min(0, offset + Number(v)); calDay = ''; render(); break;
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
    case 'refunds': tab = 'list'; resetListFilter(); lf.kind = 'refund_pending'; lf.period = 'all'; render(); break;
    /* 내역 필터 */
    case 'lfopen': openListFilter(v); break;
    case 'lfclear': resetListFilter(); render(); break;
    case 'lfsum': lfOpenSum = !lfOpenSum; render(); break;
    case 'lfmore': lfLimit += 200; render(); break;
    case 'qclear': lf.q = ''; render(); { const q = $('[data-input=q]'); if (q) { q.value = ''; q.focus(); } } break;
    case 'lfperiod': lfDraft.period = v; if (v === 'custom' && !lfDraft.from) { lfDraft.from = cycleRange(lfDraft.offset).start; lfDraft.to = today(); } repaintLf(); break;
    case 'lfcyc': lfDraft.offset = Math.min(0, lfDraft.offset + Number(v)); repaintLf(); break;
    case 'lfcat': case 'lfpayer': { const k = b.dataset.act === 'lfcat' ? 'cats' : 'payers'; lfDraft[k] = lfDraft[k].includes(v) ? lfDraft[k].filter(x => x !== v) : [...lfDraft[k], v]; repaintLf(); break; }
    case 'lfkind': lfDraft.kind = v; repaintLf(); break;
    case 'lfreset': lfDraft = Object.assign(LF0(), { offset: 0 }); repaintLf(); break;
    case 'lfapply': applyListFilter(); break;
    case 'listmenu': listMenu(); break;
    /* 가져오기 */
    case 'impopen': openImport(v); break;
    case 'impfile': imp.step = 'file'; imp.err = ''; renderImport(); break;
    case 'impback': imp.err = ''; imp.editing = -1; imp.resumed = false; imp.step = imp.step === 'review' ? (imp.kind === 'paste' ? 'paste' : 'map') : 'file'; renderImport(); break;
    case 'impfresh': { const k = imp.kind; imp = null; impPrev = null; openImport(k); break; }
    case 'impenc': { const f = imp.file; f.enc = f.enc === 'euc-kr' ? '' : 'euc-kr'; f.sheets = [{ name: f.name, rows: core.parseCsv(core.decodeText(f.u8, f.enc || undefined)) }]; f.si = 0; setupMapping(); renderImport(); break; }
    case 'impneg': imp.file.negative = v; renderImport(); break;
    case 'impfind': {
      const f = imp.file;
      if (f.mapping.date < 0 || f.mapping.amount < 0) { imp.err = '날짜와 금액 열을 골라 주세요'; renderImport(); break; }
      if (imp.items.some(it => it.edited) && !confirm('확인 목록에서 고친 내용이 사라져요. 다시 찾을까요?')) break;
      const conv = core.rowsToCandidates(f.data, f.mapping, convOpts(f));
      if (conv.negatives && !f.negative) { imp.err = '음수 금액을 어떻게 가져올지 골라 주세요'; renderImport(); break; }
      imp.items = prepareItems(conv.items, false); imp.unread = conv.unread; imp.step = 'review'; imp.shown = IMP_PAGE; imp.editing = -1; imp.err = '';
      renderImport(); $('#sheet .sheet-b').scrollTop = 0; break;
    }
    case 'impchk': {
      const it = imp.items[Number(v)];
      if (b.checked && impBlocked(it)) { b.checked = false; openEditor(Number(v)); break; }
      it.on = b.checked; b.closest('.import-row').classList.toggle('on', it.on); refreshImpFooter(); break;
    }
    case 'impsel': if (!commitEdit()) break; imp.items.forEach(it => { it.on = v === 'new' ? impDefaultOn(it) : false; }); imp.err = ''; renderImport(); break;
    case 'impedit': openEditor(Number(v)); break;
    case 'impcancel': imp.editing = -1; renderImport(); break;
    case 'impapply': if (commitEdit()) renderImport(); break;
    case 'ietype': setPressed(b.parentElement, v); break;
    case 'impmore': if (!commitEdit()) break; imp.shown += IMP_PAGE; renderImport(); break;
    case 'impsave': impSave(); break;
    /* 즐겨찾기 */
    case 'favadd': addFavorite(); break;
    case 'favdel':
      if ($('[data-form=entry]')) { const ok = removeFavorite(v, true); const x = $('[data-act=favdel]'); if (x) x.outerHTML = favButton(); $('#fav-msg').textContent = ok ? '즐겨찾기에서 뺐어요(두 사람 모두에게서)' : '즐겨찾기를 지우지 못했어요'; }
      else { const gone = favorites().find(f => f.id === v); const ok = removeFavorite(v, true); favUndo = ok ? gone : null; openFavManage(ok ? `${esc(gone.merchant)} 즐겨찾기를 지웠어요. <button type="button" class="link" data-act="favundo">되돌리기</button>` : '즐겨찾기를 지우지 못했어요'); }
      break;
    case 'favundo': if (favUndo && !favorites().some(f => f.id === favUndo.id)) store.setPrefs({ favorites: favorites().concat(favUndo) }); favUndo = null; openFavManage('되돌렸어요'); break;
    case 'favmanage': stashDraft(); openFavManage(); break;
    case 'me': store.setLocal('me', v); render(); break;
    case 'sync': sync(); break;
    case 'merchant': $('#merchant').value = v; draft.merchant = v; suggestFor(v); break;
    case 'cat': draft.category = draft.category === v ? '' : v; draft.catSug = false; setPressed(b.parentElement, draft.category); refreshCatLabel(); refreshFavButton(); break;
    case 'type': draft.type = v; setPressed(b.parentElement, v); refreshSummary(); refreshFavButton(); break;
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
      if (store.pendingCount() || S.pendingSettings) { toast('공유 대기 기록·설정이 있어요. 먼저 동기화해 주세요'); break; }
      if (confirm('이 기기 연결을 해제할까요? 기록은 구글 시트에 남아 있어요.')) store.disconnect();
      break;
  }
});
document.addEventListener('input', e => {
  const k = e.target.dataset && e.target.dataset.input;
  if (e.target.matches('[data-form=settings] input,[data-form=settings] select,[data-form=settings] textarea,[data-form=setup] input,[data-form=setup] textarea')) dirtyControls.add(e.target);
  if (k === 'q') { lf.q = e.target.value; lfLimit = 200; clearTimeout(qTimer); if (!e.isComposing) qTimer = setTimeout(render, 150); }
  if (k === 'lfmin' || k === 'lfmax' || k === 'lffrom' || k === 'lfto') {
    if (k === 'lfmin' || k === 'lfmax') { lfDraft[k === 'lfmin' ? 'min' : 'max'] = Number(e.target.value.replace(/[^\d]/g, '')) || 0; }
    else if (e.target.value) lfDraft[k === 'lffrom' ? 'from' : 'to'] = e.target.value;
    const tmp = document.createElement('div'); tmp.innerHTML = lfSheetHtml();
    ['.lf-foot', '#lf-amount .err', '#lf-period .err'].forEach(sel => { const a = $('#sheet ' + sel), b2 = tmp.querySelector(sel); if (a && b2) a.outerHTML = b2.outerHTML; });
    const sv = $('#sheet .sheet-h .save'); if (sv) sv.disabled = !!(lfDraft.min && lfDraft.max && lfDraft.min > lfDraft.max) || !!(lfDraft.period === 'custom' && lfDraft.from && lfDraft.to && lfDraft.from > lfDraft.to);
    return;
  }
  if (k === 'impbulk') {
    if (e.target.value && commitEdit()) {
      const p = e.target.value;
      imp.items.forEach(it => {
        const was = impBlocked(it);
        it.payer = p; it.payerRaw = ''; it.issues = it.issues.filter(x => !/결제자/.test(x));
        if (was && !impBlocked(it)) it.on = impDefaultOn(it);
      });
      renderImport();
    }
    return;
  }
  if (k === 'vfrom' || k === 'vto') { if (e.target.value) { view[k === 'vfrom' ? 'from' : 'to'] = e.target.value; saveView(); render(); } }
  if (e.target.id === 'amount' || e.target.id === 'r-amount' || e.target.dataset.money !== undefined) {
    const raw = e.target.value.replace(/[^\d]/g, ''), over = raw.length > 10, n = raw.slice(0, 10);
    e.target.value = n ? won(Number(n)) : '';
    e.target.setAttribute('aria-invalid', String(over));
    const err = $(e.target.id === 'amount' ? '#entry-err' : e.target.id === 'r-amount' ? '#rule-err' : e.target.id === 'ie-amount' ? '#ie-err' : '#none');
    if (err) err.textContent = over ? '금액은 10자리(99억 원)까지 넣을 수 있어요. 마지막 자리는 넣지 않았어요' : '';
    else if (over) toast('금액은 10자리(99억 원)까지 넣을 수 있어요');
  }
});
document.addEventListener('compositionend', e => { if (e.target.dataset.input === 'q') { lf.q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(render, 150); } });
document.addEventListener('change', e => {
  if (e.target.id === 'merchant') { draft.merchant = e.target.value.trim(); suggestFor(draft.merchant); }
  if (e.target.closest && e.target.closest('[data-form=entry]')) refreshFavButton();
  if (e.target.id === 'imp-file' && e.target.files && e.target.files[0]) loadImportFile(e.target.files[0]);
  const mk = e.target.dataset && e.target.dataset.map;
  if (mk && imp && imp.file) {
    const f = imp.file, val = Number(e.target.value);
    if (mk === 'sheet') { f.si = val; setupMapping(); }
    else if (mk === 'head') { f.h = val; setupMapping(true); }
    else f.mapping[mk] = val;
    renderImport();
  }
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-form]'); if (!f) return;
  e.preventDefault();
  const kind = f.dataset.form;
  if (kind === 'entry') {
    readEntry(f);
    if (!draft.amount) { $('#entry-err').textContent = '금액을 입력해 주세요'; $('#amount').focus(); return; }
    if (draft.date > today()) { $('#entry-err').textContent = '미래 날짜는 기록할 수 없어요'; return; }
    if (upsert(draft)) { saved = true; store.setLocal('draft', null); $('#sheet').close(); toast('기록했어요'); render(); }
  }
  if (kind === 'rule') { saveRule(f); return; }
  if (kind === 'paste') {
    const text = $('#paste-text').value; imp.text = text;
    if (document.activeElement) document.activeElement.blur();
    const r = core.parseNotices(text, { today: today() });
    if (!r.items.length) { imp.err = text.trim() ? '카드 알림을 찾지 못했어요. 금액(원)이 들어 있는 알림인지 확인해 주세요' : '붙여넣은 내용이 없어요'; renderImport(); return; }
    imp.err = ''; imp.resumed = false; imp.items = prepareItems(r.items, true); imp.unread = r.unread; imp.step = 'review'; imp.editing = -1; imp.shown = IMP_PAGE;
    renderImport(); $('#sheet .sheet-b').scrollTop = 0; return;
  }
  if (kind === 'budget') { saveBudget(f); return; }
  if (kind === 'setup') {
    const cfg = store.parseCode($('#code').value);
    if (!cfg) { $('#setup-err').textContent = '설정 코드를 확인해 주세요'; return; }
    // 편집기에서 만든 코드는 주소가 테스트용(/dev)일 수 있다 → 배포 주소(/exec)를 따로 받는다
    const execEl = $('#exec-url');
    const execUrl = execEl ? execEl.value.trim() : '';
    if (execUrl) {
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(execUrl)) { $('#setup-err').textContent = '…/exec 로 끝나는 배포 주소를 넣어 주세요'; return; }
      cfg.url = execUrl;
    }
    if (!store.validUrl(cfg.url)) {
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
    store.connect(cfg); if ($('#sheet').open) $('#sheet').close(); toast('연결했어요');
  }
  if (kind === 'settings') {
    // 시트마다 일부 항목만 있다: 있는 항목만 저장
    const fd = new FormData(f), patch = {};
    const list = k => String(fd.get(k) || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    if (fd.has('cycle_start_day')) patch.cycle_start_day = Number(fd.get('cycle_start_day'));
    ['categories', 'methods', 'beneficiaries'].forEach(k => { if (fd.has(k)) patch[k] = list(k); });
    if (!store.saveSettings(patch)) return;
    if ($('#sheet').open) $('#sheet').close();
    toast('설정을 저장했어요');
  }
});
// 저장하지 않고 닫은 새 기록은 초안으로 보관 (다음에 + 누르면 이어서)
function stashDraft() {
  const f = $('[data-form=entry]');
  if (!saved && !editing && draft && f) {
    readEntry(f);
    store.setLocal('draft', (draft.amount || draft.merchant || draft.note) ? draft : null);
  }
  draft = null;
}
$('#sheet').addEventListener('cancel', () => { stashDraft(); parkImport(); });
$('#sheet').addEventListener('close', () => { if (!$('#sheet').open) { stashDraft(); parkImport(); } }); // 늦게 온 close가 다시 연 창을 비우지 않게

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
