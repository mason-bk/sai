'use strict';

/* ---------------- 데이터 층 연결 ----------------
 * 저장·동기화·연결은 store.js(store.*)만 거친다. 여기서는 S를 읽기만 한다. */
const USERS = ['아내', '남편'];
// 결제자 목록 = 두 사람 + 공유 설정의 목록(시트 Settings의 beneficiaries 키를 결제자 목록으로 재사용, v16)
const payerList = () => [...new Set([...USERS, ...(S.settings.beneficiaries || [])])];
const TYPE_LABEL = { expense: '지출', refund: '환불', transfer: '지출 제외' };
const upsert = rec => store.upsert(rec);
const sync = () => store.sync();
store.on('change', () => { render(); refreshBudHelp(); });
store.on('status', () => renderStatus());
store.on('notice', msg => toast(msg));
// 공유 예산 충돌(v25 2차·3차): 다른 기기가 같은 달 예산을 먼저 고침 → 내 값은 보관하고 고르게 한다.
// 열린 시트(기록·예산 수정·다른 설정)를 대신하지 않는다(Fable v25 P2-8): 알림 + 상태 줄 + 예산 보기 알림줄. 열린 시트가 없을 때만 바로 비교 시트
store.on('conflict', keys => {
  if (!$('#sheet').open) { openConflict(keys[0]); return; }
  if ($('#sheet .bud-nav') && !$('#sheet [data-form]')) openBudget(); // 예산 보기가 열려 있으면 알림줄이 보이게 다시 그림
  refreshBudHelp(); // 예산 수정 중이면 참고값만 갱신
  toast('상대가 먼저 예산을 고쳤어요 · 내 값은 보관했어요', '비교하기', () => openConflictSafe(keys[0]));
});
// 작성 중인 기록은 초안으로 남기고(stashDraft) 비교 시트를 연다. 예산 수정 중이면 그 입력을 버리지 않게 묻지 않고 알림만 남긴다
function openConflictSafe(k) {
  if ($('#sheet').open && $('#sheet [data-form=budget]')) { toast('예산 수정을 마치거나 취소한 뒤 상태 줄에서 골라 주세요'); return; }
  if ($('#sheet').open && $('[data-form=entry]') && !closeSheet()) return;
  openConflict(k);
}

/* ---------------- 유틸 ---------------- */
const $ = s => document.querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = n => Math.round(n).toLocaleString('ko-KR');
const { pad, ymd, parseDate, addDays, dayDiff, signed } = core; // 순수 로직은 core.js
const today = () => ymd(new Date());
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

/* 알림: 일반 4초, 되돌리기 8초. 손가락·포커스가 올라가 있거나 앱이 뒤로 가 있으면 시간을 멈추고 남은 시간만 이어 간다.
 * 되돌리기 알림이 떠 있는 동안 온 일반 알림은 덮어쓰지 않고 그 뒤에 보여 준다(Astra F01). */
// 멈춤 이유(손가락·포인터, 포커스, 앱 숨김)를 따로 세고, 첫 멈춤에서만 남은 시간을 줄이며, 이유가 모두 없어져야 다시 센다(Astra V22-11)
let toastTimer, toastLeft = 0, toastStarted = 0, toastEl = null, toastQueue = [];
const toastHold = new Set();
function toastArm(ms) { clearTimeout(toastTimer); toastLeft = ms; toastStarted = Date.now(); if (!toastHold.size) toastTimer = setTimeout(toastHide, ms); else toastStarted = 0; }
function toastPause(why) {
  if (!toastEl || !toastEl.classList.contains('on')) return;
  if (!toastHold.size && toastStarted) { clearTimeout(toastTimer); toastLeft = Math.max(1200, toastLeft - (Date.now() - toastStarted)); toastStarted = 0; }
  toastHold.add(why);
}
function toastResume(why) {
  toastHold.delete(why);
  if (!toastHold.size && toastEl && toastEl.classList.contains('on') && !toastStarted) { toastStarted = Date.now(); clearTimeout(toastTimer); toastTimer = setTimeout(toastHide, toastLeft); }
}
function toastHide() {
  if (toastEl) toastEl.classList.remove('on');
  const next = toastQueue.shift(); if (next) setTimeout(() => toast(...next), 200);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') toastPause('hidden'); else toastResume('hidden'); });
function toast(msg, action, onAction, ms) {
  // 시트(모달)가 열려 있으면 시트 안의 알림 칸에 띄운다: 모달 뒤에 가려지지 않게. 시트를 다시 그려도 새로 만든다
  const dlg = $('#sheet');
  const busy = toastEl && toastEl.isConnected && toastEl.classList.contains('on') && toastEl.classList.contains('act');
  if (busy && !action) { if (!toastQueue.some(q => q[0] === msg)) toastQueue.push([msg]); return; }
  let t = $('#toast');
  if (dlg.open) {
    t = dlg.querySelector('.toast.in-sheet');
    if (!t) { t = document.createElement('div'); t.className = 'toast in-sheet'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); dlg.appendChild(t); }
    // 시트 아래 버튼 바로 위(실제 높이 기준)
    const foot = dlg.querySelector('.sheet-footer');
    t.style.bottom = (foot ? foot.getBoundingClientRect().height : 0) + 12 + 'px';
  }
  if (toastEl && toastEl !== t) toastEl.classList.remove('on');
  toastEl = t;
  t.textContent = msg;
  t.classList.toggle('act', !!action);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = action;
    b.onclick = () => { clearTimeout(toastTimer); t.classList.remove('on'); onAction(); if (!(toastEl && toastEl.classList.contains('on'))) toastHide(); };
    t.appendChild(b);
  }
  t.classList.add('on');
  // 시트 안 알림이 본문 보이는 높이의 25% 이상을 가리면 떠 있지 않고 아래 버튼 바로 위 줄로 들어간다(Astra 토스트 규격)
  if (t.classList.contains('in-sheet')) {
    t.classList.remove('in-flow');
    const body = dlg.querySelector('.sheet-b'), foot = dlg.querySelector('.sheet-footer');
    if (body && foot && t.getBoundingClientRect().height > body.clientHeight * .25) { t.classList.add('in-flow'); foot.parentElement.insertBefore(t, foot); }
    else if (t.parentElement !== dlg) dlg.appendChild(t);
  }
  toastHold.delete('hover'); toastHold.delete('focus');
  toastArm((ms || (action ? 8000 : 4000)) + 160); // 나타나는 시간(160ms) 뒤부터 센다
  t.onpointerenter = () => toastPause('hover'); t.onpointerleave = () => toastResume('hover');
  t.onfocusin = () => toastPause('focus'); t.onfocusout = () => toastResume('focus');
}

/* ---------------- 삭제: 확인 창 + 되돌리기 ---------------- */
function askDelete(id, after) {
  const t = store.get(id); if (!t) return;
  const dlg = $('#confirm');
  dlg.setAttribute('aria-labelledby', 'confirm-title');
  dlg.innerHTML = `<div class="confirm-box" tabindex="-1" autofocus>
    <b id="confirm-title">이 기록을 삭제할까요?</b>
    <p>${esc(t.merchant || t.category || '기록한 지출')} · ${won(t.amount)}원<br><span class="muted">${md(t.date)} · 두 사람의 장부에서 삭제돼요</span></p>
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
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    sw.mode = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'h' : 'v'; // 가로 확정은 8px·1.3배 넘을 때만(세로 스크롤과 덜 겹치게)
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

/* 달력 좌우 밀기 = 주기 이동(Astra calendar-spec-v23 3절). 날짜 격자에서 손가락 하나로 가로 48px 이상·세로의 1.5배 이상·700ms 안.
   세로 16px 이상 움직이며 가로 우세가 아니면 스크롤에 넘김. 화면 좌우 끝 24px에서 시작하면 브라우저 뒤로 가기 몸짓에 맡김 */
let cs = null, calEatClick = 0;
function calStart(el, x, y, t) {
  if (x < 24 || x > innerWidth - 24) { cs = null; return; }
  cs = { el, x, y, t, mode: '', dx: 0, dy: 0 };
}
function calRelease() { if (cs) { cs.el.style.transition = ''; cs.el.style.transform = ''; } cs = null; }
function calMove(x, y, ev) {
  if (!cs) return;
  const dx = x - cs.x, dy = y - cs.y;
  cs.dx = dx; cs.dy = dy;
  if (!cs.mode) {
    // 가로 확정은 16px 이상·세로의 1.5배 이상일 때만(세로 스크롤과 덜 겹치게)
    if (Math.abs(dx) >= 16 && Math.abs(dx) >= Math.abs(dy) * 1.5) cs.mode = 'h';
    else if (Math.abs(dy) >= 10 && Math.abs(dy) > Math.abs(dx)) { calRelease(); return; }
    else return;
  }
  if (Math.abs(dy) > Math.abs(dx)) { calRelease(); return; } // 가로로 시작했다가 세로로 꺾으면 놓아 줌(이후 이동은 막지 않음)
  if (ev && ev.cancelable) ev.preventDefault();      // 가로로 미는 동안만 세로 스크롤 멈춤
  const atEnd = dx < 0 && offset >= 0;               // 다음 주기가 없으면 조금만 따라옴
  cs.el.style.transition = 'none';
  cs.el.style.transform = `translate3d(${Math.max(-40, Math.min(40, atEnd ? dx / 5 : dx / 3))}px,0,0)`;
}
function calEnd(t) {
  if (!cs) return;
  const c = cs; calRelease();
  if (c.mode !== 'h') return;
  if (Math.abs(c.dx) < 48 || Math.abs(c.dx) < Math.abs(c.dy) * 1.5 || t - c.t > 700) return;
  calEatClick = Date.now();                          // 이동이 확정된 밀기 뒤에 따라오는 클릭 한 번만 먹음
  changeCalendarCycle(c.dx < 0 ? 1 : -1);
}
function calCancel() { calRelease(); }
document.addEventListener('touchstart', e => {
  const el = e.target.closest('.cal-swipe');
  if (el && e.touches.length === 1) { const p = e.touches[0]; calStart(el, p.clientX, p.clientY, e.timeStamp); } else calCancel(); // 두 손가락(확대)은 취소
}, { passive: true });
document.addEventListener('touchmove', e => { if (!cs) return; if (e.touches.length !== 1) { calCancel(); return; } const p = e.touches[0]; calMove(p.clientX, p.clientY, e); }, { passive: false });
document.addEventListener('touchend', e => calEnd(e.timeStamp));
document.addEventListener('touchcancel', calCancel);
document.addEventListener('pointerdown', e => { if (e.pointerType === 'touch' || !e.isPrimary || e.button !== 0) return; const el = e.target.closest('.cal-swipe'); if (el) calStart(el, e.clientX, e.clientY, e.timeStamp); });
document.addEventListener('pointermove', e => { if (e.pointerType !== 'touch' && cs) calMove(e.clientX, e.clientY, null); });
document.addEventListener('pointerup', e => { if (e.pointerType !== 'touch') calEnd(e.timeStamp); });
document.addEventListener('pointercancel', e => { if (e.pointerType !== 'touch') calCancel(); });
window.addEventListener('blur', calCancel);

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
  if (store.connected() && S.me && !['home', 'list', 'analysis', 'recur', 'settings'].includes(tab)) tab = 'home';
  const markup = !store.connected() ? setupView() : !S.me ? whoView() : `<div class="wrap screen-${tab}">
    <header class="top"><div class="brand">${icon('card')}<span>사이</span><span class="brand-sub">PAYDAY</span></div>
      <div class="top-r"><button class="top-budget" data-act="budget" aria-haspopup="dialog" aria-label="생활 예산 보기·수정">예산</button><button class="icon-btn theme-btn" data-act="themetoggle" aria-label="${isDark() ? '라이트' : '다크'} 화면으로 바꾸기">${icon(isDark() ? 'sun' : 'moon')}</button>
      </div></header>
    ${statusRow()}
    <main id="view">${tab === 'home' ? homeView() : tab === 'list' ? listView() : tab === 'analysis' ? analysisView() : tab === 'recur' ? recurView() : settingsView()}</main>
  </div>
  <nav class="tabs" aria-label="메뉴">
    ${navBtn('home', '홈', 'home')}${navBtn('list', '내역', 'ledger', tab === 'analysis')}
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
  refreshStmt();
  renderStatus();
  fitSticky();
  fitRows();
  alignCalSel();
  if (nextScreen === 'home') countUp();
}
// 홈 카드값 숫자: 앱을 연 뒤 처음 보이는 1천 원 이상 금액만 0에서 올린다(550ms, 끝은 천천히). 동작 줄이기 설정이면 바로 최종 값.
// 도중에 값이 바뀌면(동기화·저장) 멈추고 화면 갱신이 그린 최종 값을 둔다. 화면 낭독은 처음부터 aria-label의 최종 값
let countedOnce = false;
function countUp() {
  const el = document.querySelector('.home-hero .amt'); if (countedOnce || !el) return;
  const label = el.getAttribute('aria-label') || '', target = Number(label.replace(/[^\d]/g, '')) * (/^[-−]/.test(label) ? -1 : 1);
  if (!target || Math.abs(target) < 1000) return;
  countedOnce = true;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const final = el.innerHTML, t0 = performance.now(), D = 550;
  const step = now => {
    if (!el.isConnected || el.getAttribute('aria-label') !== label) return;
    const k = Math.min(1, (now - t0) / D);
    if (k < 1) { el.innerHTML = amtInner(Math.round(target * (1 - Math.pow(1 - k, 3)))); requestAnimationFrame(step); } else el.innerHTML = final;
  };
  requestAnimationFrame(step);
}
// 두 칸 달력: 오른쪽 선택일 제목을 왼쪽 달력 머리 높이에 맞춤(측정값, 고정 숫자 없음)
function alignCalSel() {
  const main = $('.list-main'), head = $('.list-side.cal-mode .cal-head');
  if (!main) return;
  main.style.paddingTop = '';
  if (!head || getComputedStyle(main).display === 'contents' || head.getBoundingClientRect().left >= main.getBoundingClientRect().left) return;
  const gap = head.getBoundingClientRect().top - main.getBoundingClientRect().top;
  if (gap > 0) main.style.paddingTop = Math.round(gap) + 'px';
}
addEventListener('resize', () => alignCalSel());
// 머리글 두 사람: 이 기기 사용자 먼저, 다음은 결제자 설정의 다른 한 사람(이니셜만)
const pairNames = () => { const ps = payerList().filter(p => p !== S.me && p !== '공동'); return [S.me, ps[0] || ''].filter(Boolean); };
const isDark = () => S.theme === 'dark' || (S.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
const navBtn = (k, label, ic, also) => `<button data-act="tab" data-v="${k}" ${tab === k || also ? 'aria-current="page"' : ''}><span class="nav-icon">${icon(ic)}</span><span>${label}</span></button>`;
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
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2m0 15v2M2.5 12h2m15 0h2M5.3 5.3l1.4 1.4m10.6 10.6 1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  backspace: '<path d="M8.5 5H20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8.5L3 12Z"/><path d="m11.5 9.5 5 5m0-5-5 5"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="3"/><path d="M3 10h18M7 15h4"/>',
  chart: '<path d="M5 20V11h3.5v9M10.25 20V5h3.5v15M15.5 20v-6H19v6"/>',
  uncategorized: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/>',
};
function icon(name) {
  return `<svg class="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.other}</svg>`;
}
const CATEGORY_ICONS = { '의료': 'health', '여가·경조': 'gift', '식비': 'food', '카페': 'cafe', '쿠팡': 'parcel', '쇼핑': 'shopping', '생활': 'living', '병원': 'health', '교통': 'transit', '차량유지': 'car', '경조사': 'gift', '고정지출': 'recurring', '대출': 'recurring', '통신비': 'recurring', '보험': 'health', '구독': 'recurring', '기타': 'other', '미분류': 'uncategorized' };
function categoryIcon(category) {
  const key = category || '미분류';
  return Object.prototype.hasOwnProperty.call(CATEGORY_ICONS, key) ? icon(CATEGORY_ICONS[key]) : esc(Array.from(key)[0]);
}

// 공통 상태 줄(spec 12절): 모든 화면 머리글 아래 한 곳. 대기 N = 기록(고유 id) + 설정 변경(1건). 대기·실패면 누르면 바로 다시 보내고, 아니면 공유 상태
function statusInner() {
  const s = syncSummary(), act = (s.n.total || s.err) && !s.off;
  return { cls: 'status-row' + (s.warn ? ' warn' : '') + (s.err ? ' err' : ''), label: s.txt + (act ? '. 눌러서 지금 다시 보내기' : '. 눌러서 공유 상태 보기'),
    html: `<span class="sr-dot" aria-hidden="true"></span><span class="sr-t">${esc(s.err && s.st.error && /설정 코드/.test(s.st.error) ? s.st.error : s.txt)}</span>${act ? '<span class="sr-act">다시 보내기</span>' : ''}` };
}
const statusRow = () => { const x = statusInner(); return `<button class="${x.cls}" id="status" data-act="statusrow" aria-label="${esc(x.label)}" aria-live="polite">${x.html}</button>`; };
function renderStatus() {
  const el = $('#status'); if (!el) return;
  const x = statusInner();
  if (el.className !== x.cls) el.className = x.cls;
  el.setAttribute('aria-label', x.label);
  if (el.innerHTML !== x.html) el.innerHTML = x.html;
  const sync = $('#sheet[open] [data-ui-key=sync-box]'); if (sync) openSyncSheet();
}
function setupView() {
  return `<div class="wrap center">
    <div class="brand" style="font-size:1.75rem">${logo()}사이</div>
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
  document.querySelectorAll('meta[name=theme-color]').forEach(m => { m.setAttribute('content', dark ? '#101613' : '#EFF1ED'); m.removeAttribute('media'); });
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

/* ---------------- v25 보기 상태: 월별 / 카드 청구 (spec 3절) ----------------
 * 홈·내역·분석이 같은 보기·기간·카드·대분류를 쓴다. 이 기기에 기억하는 것(store.local): 보기(pv)·보기별 대분류 1개·카드(v25),
 * 내역 표현 방식·분석 탭(view). 세션에만: 기간(절대 날짜로 붙잡음)·검색어·쪽·달력 선택일. 앱을 다시 열면 월별은 이번 달, 카드 청구는 가장 가까운 결제 */
let view = Object.assign({ list: 'rows', anSub: {} }, S.view || {});
if (!['rows', 'cal', 'payer'].includes(view.list)) view.list = 'rows';
if (!view.anSub || typeof view.anSub !== 'object') view.anSub = {};
function saveView() { store.setLocal('view', view); }
const V25_0 = { pv: 'bill', cat: { bill: 'all', month: 'all' }, card: '' };
let v25 = Object.assign({}, V25_0, S.v25 || {});
v25.cat = Object.assign({}, V25_0.cat, (S.v25 && S.v25.cat) || {});
if (!['bill', 'month'].includes(v25.pv)) v25.pv = 'bill';
function saveV25() { store.setLocal('v25', v25); }
let moff = 0, mShown = '', mShownOff = 0;      // 월별: 0 = 이번 달. 보던 달은 'YYYY-MM'으로 붙잡는다(자정에 달이 바뀌어도 그대로)
let offsetTouched = false, autoSig = '';       // 카드 청구: 손대기 전(또는 '다가오는 결제로')에는 가장 가까운 미도래 결제
/* v26(실사용 피드백 2026-10-22 '한 화면에 다 맞추려니 더 어색하다'): 쪽 넘김·같은 성격 탭을 없애고 이어서 읽는다.
 * 목록은 처음 N건 + '더 보기'(같은 목록 뒤에 이어 붙임, 쪽 교체 없음). 기간·카드·필터가 바뀌면 처음 건수로 되돌린다(spec v26 4절) */
const LIST_STEP = 8, PAYER_STEP = 4, PERIOD_STEP = 6, DAY_STEP = 8, AN_STEP = 8, REVIEW_STEP = 6, CF_STEP = 4, MGR_STEP = 8, RECUR_ALL_STEP = 8;
let listShown = LIST_STEP, anShown = AN_STEP, payerShown = PAYER_STEP, periodShown = PERIOD_STEP, dayShown = DAY_STEP;
let anDetail = ''; // 분석 상세('cat' 세부 분류·거래처 / 'trend' 단위별 추이). 개요는 ''
const resetShown = () => { listShown = LIST_STEP; anShown = AN_STEP; payerShown = PAYER_STEP; };

/* 금액 입력 계약(v22 P0): 원문을 지우거나 자르지 않는다. 올바른 숫자일 때만 쉼표를 넣고(커서 위치 유지), 아니면 원문+오류 */
const WON_ERR = { over: '10자리까지 넣을 수 있어요(최대 9,999,999,999원까지). 금액을 줄여 주세요', negative: '음수는 넣을 수 없어요. 환불은 종류에서 골라 주세요', decimal: '원 단위 정수로 넣어 주세요', format: '숫자만 넣어 주세요', zero: '1원 이상 넣어 주세요', empty: '금액을 입력해 주세요' };
const groupDigits = d => d.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
// 쉼표를 다시 넣는 것은 (1) 숫자 키를 치거나 지운 경우(앱이 넣은 쉼표 사이에서 고친 것) (2) 이미 올바른 금액인 경우만.
// 사용자가 직접 친 쉼표·붙여넣기·끌어넣기는 틀려도 그대로 둔다(1,23을 123으로 바꾸지 않음, Astra V22-01)
function moneyInput(el, ev) {
  const v = el.value, it = ev && ev.inputType || '', data = ev && ev.data;
  let r = core.parseWon(v);
  // 사용자가 숫자 아닌 글자(쉼표 등)를 치거나 붙여넣으면 그 칸은 '원문 모드': 비우거나 올바른 금액이 될 때까지 쉼표를 고치지 않는다
  if (!v) delete el.dataset.raw;
  else if ((it === 'insertText' && !/^\d+$/.test(data || '')) || /^insertFrom|^insertReplacement/.test(it)) el.dataset.raw = '1';
  // 직전 값(처음엔 그려질 때의 값)이 올바른 쉼표 모양이었을 때만 숫자 입력을 다시 묶는다: 다시 연 초안의 '1,23'에 숫자를 더해도 고치지 않음
  const prev = el.dataset.prev != null ? el.dataset.prev : el.defaultValue;
  const prevOk = !prev || /^\d{1,3}(,\d{3})*$/.test(prev);
  const typedDigits = !el.dataset.raw && prevOk && (/^delete/.test(it) || (it === 'insertText' && /^\d+$/.test(data || '')) || (!it && /^\d+$/.test(v)));
  const digitsOnly = v.replace(/,/g, '');
  if (v && /^[\d,]+$/.test(v) && digitsOnly.length <= 10 && (r.ok || r.error === 'zero' || typedDigits)) {
    const caret = el.selectionStart == null ? v.length : el.selectionStart;
    const before = v.slice(0, caret).replace(/\D/g, '').length;
    const digits = v.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    const nv = groupDigits(digits);
    if (nv !== v) {
      el.value = nv;
      let pos = 0, seen = 0; while (pos < nv.length && seen < before) { if (/\d/.test(nv[pos])) seen++; pos++; }
      if (document.activeElement === el) try { el.setSelectionRange(pos, pos); } catch (e) {}
    }
  }
  // 판정은 다시 묶은 뒤의 값으로(Fable v24 P1-2: '1,2345'처럼 묶기 전 값으로 판정해 5자리부터 매번 '숫자만'이 뜨던 결함, v22부터)
  if (el.value !== v) r = core.parseWon(el.value);
  el.style.setProperty('--len', Math.max(6, el.value.length));
  el.dataset.prev = el.value;
  const bad = !r.ok && r.error !== 'empty';
  el.setAttribute('aria-invalid', String(bad));
  const echo = el.closest('.field') && el.closest('.field').querySelector('.amount-echo');
  // 칸보다 길어 잘리면 원 단위 전체 금액도 함께(가로 커서 이동은 허용)
  if (echo) echo.textContent = r.ok && r.value >= 10000 ? (el.scrollWidth > el.clientWidth + 1 ? won(r.value) + '원 · ' : '') + koWon(r.value) : '';
  return bad ? WON_ERR[r.error] : '';
}
// 큰 금액을 읽기 쉽게: 123,456,789 → 1억 2,345만 6,789원 (입력 칸 아래 확인 줄)
function koWon(n) {
  const eok = Math.floor(n / 1e8), man = Math.floor(n % 1e8 / 1e4), rest = n % 1e4;
  return [eok ? won(eok) + '억' : '', man ? won(man) + '만' : '', rest ? won(rest) : ''].filter(Boolean).join(' ') + '원';
}
// 큰 금액: 글자를 줄이지 않고, 넘치면 천 단위 쉼표 뒤에서만 줄을 바꾼다. 마지막 묶음과 '원'은 붙인다(Astra 금액 규칙)
// 행 금액: 넘칠 때만 천 단위 쉼표 뒤에서 줄바꿈(마지막 묶음과 '원'은 붙임)
const wonWbr = n => { const g = won(n).split(','); return g.slice(0, -1).map(x => x + ',<wbr>').join('') + `<span class="won-tail">${g[g.length - 1]}<span class="won">원</span></span>`; };
const amtInner = n => { const g = won(n).split(','); return `${g.slice(0, -1).map(x => `<span>${x},</span><wbr>`).join('')}<span class="amt-tail">${g[g.length - 1]}<small>원</small></span>`; };
const amt = n => `<div class="amt num" aria-label="${won(n)}원">${amtInner(n)}</div>`;
const md = s => { const d = parseDate(s); return (d.getMonth() + 1) + '.' + d.getDate(); };
const man = n => {
  const a = Math.abs(n);
  const s = a >= 1e8 ? (a / 1e8).toFixed(a >= 1e9 ? 0 : 1).replace(/\.0$/, '') + '억'
    : a >= 1e5 ? (Math.round(a / 1e3) / 10).toLocaleString('ko-KR', { maximumFractionDigits: a >= 1e6 ? 0 : 1 }) + '만'
    : a >= 1e4 ? (a / 1e4).toFixed(1).replace(/\.0$/, '') + '만' : won(a);
  return (n < 0 ? '−' : '') + s;
};
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


// 카드 설정 = 공유 설정 prefs.card { pay_day: 1~31, methods: [카드값에 넣을 결제수단] | 없음(자동) }. 서버·시트 구조는 그대로(prefs 칸 재사용)
// v24 수정(Fable P2-2): 키를 card_pay_day(0 = 정하지 않음)·card_methods(null = 자동)로 나눠, 두 사람이 결제일과 결제수단을 따로 고쳐도 서로 덮지 않게 한다.
// 예전 키 prefs.card { pay_day, methods }도 새 키가 없을 때 읽는다(하위호환)
const cardPrefs = () => {
  const p = store.prefs() || {}, old = p.card && typeof p.card === 'object' ? p.card : {};
  const pd = 'card_pay_day' in p ? p.card_pay_day : old.pay_day, ms = 'card_methods' in p ? p.card_methods : old.methods;
  return { payDay: core.validPayDay(pd), methods: Array.isArray(ms) ? ms : null };
};
const allMethods = () => [...new Set([...S.settings.methods, ...liveTxs().map(t => t.method).filter(Boolean)])];
const cardMethods = () => core.cardMethodsOf(allMethods(), cardPrefs().methods);
const longDate = s => { const d = parseDate(s); return (d.getFullYear() !== new Date().getFullYear() ? d.getFullYear() + '년 ' : '') + (d.getMonth() + 1) + '월 ' + d.getDate() + '일'; };

/* ---------------- v25 기간·범위 공통 (spec 4절 계산 계약) ----------------
 * 월별: 로컬 달력 1일~말일, 모든 결제수단 순지출. 카드 청구: 선택 카드(또는 카드 전체)의 이용 기간, 장부 기준 순지출.
 * 한 화면의 합계·분류·기록은 같은 범위(scopeTxs)에서 나온다. 명세서 비교·예산 요약은 분류 필터로 줄이지 않는다 */
const pv = () => v25.pv;
const curMajor = () => core.MAJOR_IDS.includes(v25.cat[pv()]) ? v25.cat[pv()] : 'all';
const catMap = () => { const p = store.prefs(); return p && p.cat_map && typeof p.cat_map === 'object' ? p.cat_map : {}; };
const majorOfTx = t => core.majorOf(t, catMap()).id;
const mjLabel = id => id === 'all' ? '전체' : core.majorLabel(id) || '전체';
const netOf = list => list.reduce((s, t) => s + signed(t), 0);
const selCard = () => v25.card && cardMethods().includes(v25.card) ? v25.card : '';
const billMethods = () => selCard() ? [selCard()] : cardMethods();
// 카드: 모든 카드가 공통 이용 기간·결제일을 쓰는 '기존 카드 묶음'. 결제수단 하나를 고르면 그 '결제수단 필터'(카드별 결제일은 다음 단계, Astra P1-02)
const cardLabel = () => selCard() ? selCard() + ' 결제수단만' : '기존 카드 묶음';
// 홈·기간에서도 제한 모드를 밝힌다(Astra v25 P1-02): 묶음 = 모든 카드가 공통 이용 기간·결제일, 하나를 고르면 '결제수단 필터'(카드별 결제일은 다음 단계)
const cardScope = () => selCard() ? '결제수단 필터 · ' + selCard() : '기존 카드 묶음 · 공통 이용 기간·결제일';
const fd = core.fullDate;
function autoOffset() { const pd = cardPrefs().payDay; return pd ? core.billCycle(S.settings.cycle_start_day, pd, new Date()).offset : 0; }
// 손대지 않은 카드 청구 기간은 결제일 설정이 바뀌거나 앱으로 돌아올 때 다시 '가장 가까운 결제'로
function syncAutoOffset(force) {
  const sig = cardPrefs().payDay + '|' + S.settings.cycle_start_day;
  if (offsetTouched || (!force && sig === autoSig)) return;
  autoSig = sig; offset = autoOffset(); shownCycle = null;
}
function anchorMonth() {
  if (mShown && mShownOff === moff && core.monthRange(moff).ym !== mShown) moff = Math.min(0, core.monthOffsetOf(mShown));
  mShown = core.monthRange(moff).ym; mShownOff = moff;
}
function billPeriod(off) {
  const b = core.billOf(S.settings.cycle_start_day, cardPrefs().payDay, off, new Date());
  return { kind: 'bill', off, start: b.range.start, end: b.range.end, year: b.range.year, pay: b.payDate, days: b.days, closed: b.closed, hasPay: b.hasPayDay };
}
function monthPeriod(off) { const r = core.monthRange(off, new Date()); return { kind: 'month', off, start: r.start, end: r.end, ym: r.ym, year: r.year, month: r.month }; }
const curPeriod = () => pv() === 'month' ? monthPeriod(moff) : billPeriod(offset);
const curOff = () => pv() === 'month' ? moff : offset;
// 기간 제목: 연도를 숨기지 않는다(spec 9절). 결제일이 없으면 결제일을 추정하지 않고 이용 기간만
function periodTitle(p) {
  const range = fd(p.start) + ' ~ ' + fd(p.end);
  if (p.kind === 'month') { const title = p.year + '년 ' + p.month + '월'; return { title, sub: p.off === 0 ? '매월 1일~말일' : range, aria: title + ', ' + range }; }
  if (p.pay) { const d = parseDate(p.pay), title = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 결제`; return { title, sub: range + ' 이용', aria: title + ', ' + range + ' 이용분' }; }
  return { title: range, sub: '이용 기간 · 결제일 미설정', aria: range + ' 이용 기간, 결제일 미설정' };
}
const viewTxs = (p, major) => core.scopeTxs(liveTxs(), { range: p, methods: p.kind === 'bill' ? billMethods() : null, major: major || 'all', map: catMap() });
function movePeriod(d) {
  if (pv() === 'month') moff = Math.min(0, moff + d);
  else { offset = Math.min(0, offset + d); offsetTouched = true; }
  resetShown(); calDay = '';
}
function setPeriodOff(off) { if (pv() === 'month') moff = Math.min(0, off); else { offset = Math.min(0, off); offsetTouched = true; } resetShown(); calDay = ''; }
// 내역·분석 공통: 보던 기간(또는 필터의 전체·지정 기간) · 보기(카드 청구 = 카드 결제수단만) · 대분류 · 필터 조건
function listRange() {
  if (lf.period === 'all') return null;
  if (lf.period === 'custom' && lf.from && lf.to) return lf.from <= lf.to ? { start: lf.from, end: lf.to } : { start: lf.to, end: lf.from };
  return curPeriod();
}
function listData() {
  const range = listRange();
  const base = core.scopeTxs(liveTxs(), { range, methods: pv() === 'bill' ? billMethods() : null, major: curMajor(), map: catMap() });
  return { range, txs: core.filterTxs(base, lf, null).sort(byNewest) };
}

/* ---------------- 공통 조각: 보기 전환 · 기간 · 대분류 칩 · 밑줄 탭 · 쪽 ---------------- */
const viewSeg = () => `<div class="seg seg2 view-seg" role="group" aria-label="집계 기준" data-ui-key="view-seg">${[['month', '월별'], ['bill', '카드 청구']].map(([k, l]) => `<button data-act="pview" data-v="${k}" aria-pressed="${pv() === k}">${l}</button>`).join('')}</div>`;
function periodNav(o) {
  o = o || {};
  const p = curPeriod(), t = periodTitle(p), off = curOff(), unit = p.kind === 'month' ? '달' : '청구';
  const locked = !!o.locked, cal = !!o.cal;
  const lbl = locked ? (lf.period === 'all' ? ['전체 기간', '모든 기록'] : ['지정 기간', listRange() ? fd(listRange().start) + ' ~ ' + fd(listRange().end) : '']) : [t.title, t.sub];
  return `<div class="${cal ? 'cal-head' : 'period-nav'}" data-ui-key="${o.key || (cal ? 'cal-cycle' : 'pnav')}">
    <button class="${cal ? 'cal-nav' : 'pn-btn'}" data-act="${cal ? 'calcyc' : 'cyc'}" data-v="-1" aria-label="이전 ${unit}" ${locked ? 'disabled' : ''}>${icon('left')}</button>
    <button class="${cal ? 'cal-lbl' : 'period-lbl'}" data-act="${cal ? 'lperiod' : 'psheet'}" aria-haspopup="dialog" aria-label="${esc(locked ? lbl.join(' ') + '. 기간 바꾸기' : t.aria + '. 다른 ' + unit + ' 고르기')}"><b><span>${esc(lbl[0])}</span>${icon('down')}</b><small>${esc(lbl[1])}</small></button>
    <button class="${cal ? 'cal-nav' : 'pn-btn'}" data-act="${cal ? 'calcyc' : 'cyc'}" data-v="1" aria-label="${off >= 0 ? '다음 ' + unit + ', 지금이 마지막이에요' : '다음 ' + unit}" ${locked || off >= 0 ? 'disabled' : ''}>${icon('right')}</button></div>`;
}
// 대분류: 전체·식비·생활 + 분류 전체(시트). 다른 대분류를 고르면 세 번째 칩이 그 이름이 된다(숨은 필터 없음, spec 4.2)
function catChips() {
  const cur = curMajor(), quick = ['all', 'food', 'living'];
  if (!quick.includes(cur)) quick[2] = cur;
  return `<div class="mchips" role="group" aria-label="대분류" data-ui-key="mchips">${quick.map(id => `<button class="mchip" data-act="pcat" data-v="${id}" aria-pressed="${cur === id}">${mjLabel(id)}</button>`).join('')}<button class="mchip mchip-all" data-act="pcatsheet" aria-haspopup="dialog" aria-label="분류 전체 보기, 지금 ${mjLabel(cur)}"><span>분류 전체</span>${icon('down')}</button></div>`;
}
const tabsU = (act, items, cur, label, key) => `<div class="utabs" role="group" aria-label="${label}" data-ui-key="${key || act}">${items.map(([k, l, n]) => `<button data-act="${act}" data-v="${k}" aria-pressed="${cur === k}">${l}${n != null ? ` <span class="ut-n num">${n}</span>` : ''}</button>`).join('')}</div>`;
/* v26 '더 보기'(spec v26 4절): 쪽 교체 없이 같은 목록 뒤에 이어 붙인다. 버튼 52px · '더 보기 · 8 / 43건'.
 * 끝까지 펼쳤으면 '43건을 모두 보았어요'(처음부터 다 보이는 짧은 목록은 아무것도 붙이지 않음). 합계·건수는 늘 전체 데이터 기준 */
function moreBtn(act, shown, total, unit, step, label) {
  if (total <= step) return '';
  if (shown >= total) return `<p class="list-end" data-ui-key="end-${act}">${total}${unit}${/[가-힣]$/.test(unit) && (unit.charCodeAt(unit.length - 1) - 0xAC00) % 28 ? '을' : '를'} 모두 보았어요</p>`;
  const add = Math.min(step, total - shown);
  return `<button type="button" class="list-more" data-act="${act}" data-ui-key="more-${act}" aria-label="${label || '더 보기'}, ${total}${unit} 중 ${shown}${unit} 보는 중. ${add}${unit} 더 불러오기"><span>${label || '더 보기'}</span><span class="num lm-n">${shown} / ${total}${unit}</span>${icon('down')}</button>`;
}
// 더 불러온 뒤: 스크롤은 그대로 두고 첫 추가 행으로 포커스, 화면 낭독기에 몇 건을 더 불러왔는지 알린다
function afterMore(sel, from, n, unit) {
  const rows = [...document.querySelectorAll(sel)], el = rows[from];
  if (el) { const f = el.matches('button:not([tabindex="-1"]),[tabindex="0"],input') ? el : el.querySelector('.tx, .settings-row, button:not([tabindex="-1"]), input:not([disabled])') || el; f.focus({ preventScroll: true }); }
  calLive(`${n}${unit}을 더 불러왔어요`);
}

/* ---------------- 홈 (v25: 월별 / 카드 청구 두 보기, spec 4절) ----------------
 * 순서: 보기 → 기간 → 대분류 → 합계(카드 청구: 장부 기준 카드값·D-day·명세서 맞추기 / 월별: 지난달 같은 날까지 비교) → 생활 예산 → 기록 / 분류 비중·청구 안내.
 * 결제자별 합계는 홈에 두지 않고 내역 → 결제자, 분석 → 결제자로 옮겼다(spec 5절) */
function homeView() {
  anchorOffset(); anchorMonth();
  const p = curPeriod(), bill = p.kind === 'bill', mj = curMajor(), cp = cardPrefs(), ms = billMethods();
  const all = viewTxs(p, 'all'), list = mj === 'all' ? all : all.filter(t => majorOfTx(t) === mj);
  const net = netOf(list), allNet = netOf(all), anyTx = liveTxs().length > 0;
  let hero;
  if (bill && !cp.payDay) {
    hero = `<section class="card hero home-hero h25 bill unset" data-ui-key="hero" aria-label="카드 청구 준비">
      <p class="eyebrow">카드 청구를 준비해요</p><p class="hero-h">결제일을 알려 주세요</p>
      <p class="hero-meta-t">이용 기간은 매월 ${S.settings.cycle_start_day}일 시작으로 보고 있어요. 결제일을 정하기 전에는 결제일과 남은 날을 추정해 보여 드리지 않아요.</p>
      <div class="hero-btns"><button class="hero-cta" data-act="setpay"><span>카드 결제일 설정</span>${icon('right')}</button><button class="hero-link" data-act="pview" data-v="month">월별로 보기</button></div></section>`;
  } else if (bill && !ms.length) {
    hero = `<section class="card hero home-hero h25 bill unset" data-ui-key="hero" aria-label="청구할 카드 없음">
      <p class="eyebrow">청구할 카드를 골라 주세요</p><p class="hero-meta-t">카드값에 넣을 결제수단이 없어요. 현금 기록은 카드값에 넣지 않아요.</p>
      <div class="hero-btns"><button class="hero-cta" data-act="setpay"><span>카드 결제수단 고르기</span>${icon('right')}</button></div></section>`;
  } else if (bill) {
    const dd = p.days === 0 ? '오늘' : p.days > 0 ? 'D-' + p.days : -p.days + '일 지남';
    hero = `<section class="card hero home-hero h25 bill" data-ui-key="hero" aria-label="장부 기준 카드값${mj === 'all' ? '' : ', ' + mjLabel(mj) + '만'}">
      <div class="hero-top"><p class="eyebrow">${mj === 'all' ? '장부 기준 카드값' : esc(mjLabel(mj)) + ' · 청구 중 일부'}</p><span class="dday num" aria-label="${p.days < 0 ? -p.days + '일 지났어요' : p.days === 0 ? '결제일이 오늘이에요' : '결제일까지 ' + p.days + '일'}">${dd}</span></div>
      ${amt(net)}
      <div class="hero-meta"><span class="hm-t">${mj === 'all' ? `${esc(cardScope())} · ${list.length}건` : `${esc(cardLabel())} 전체 <span class="num">${won(allNet)}원</span> · ${selCard() ? '결제수단 필터' : '공통 이용 기간·결제일'}`}</span><button class="hero-link" data-act="cardpick" aria-haspopup="dialog">카드 변경</button></div>
      <button class="hero-cta" data-act="stmt" aria-haspopup="dialog"><span>명세서 맞추기</span>${icon('right')}</button></section>`;
  } else {
    const cmp = core.monthCompare(moff, new Date()), c = core.compareNet(core.scopeTxs(liveTxs(), { range: null, methods: null, major: mj, map: catMap() }), cmp);
    const ahead = cmp.partial ? net - c.cur : 0; // 오늘 뒤 날짜로 적은 기록(큰 숫자에는 들어가고 비교에서는 빠짐, Fable P2-6)
    const line = cmp.future ? '아직 오지 않은 달이에요' : !c.hasPrev ? '지난달 비교 기록이 없어요'
      : `지난달${cmp.partial ? ' 같은 날까지' : ''}보다 <b class="num">${won(Math.abs(c.diff))}원</b> ${c.diff > 0 ? '더 썼어요' : c.diff < 0 ? '덜 썼어요' : '같아요'}${ahead ? ` <span class="hero-ahead">(오늘 뒤 날짜 ${won(ahead)}원 제외)</span>` : ''}`;
    const rng = cmp.partial ? `${md(cmp.cur.start)}~${md(cmp.cur.end)} ↔ ${md(cmp.prev.start)}~${md(cmp.prev.end)}` : `${p.month}월 전체 ↔ ${parseDate(cmp.prev.start).getMonth() + 1}월 전체`;
    hero = `<section class="card hero home-hero h25 month" data-ui-key="hero" aria-label="${p.month}월 쓴 돈${mj === 'all' ? '' : ', ' + mjLabel(mj) + '만'}">
      <div class="hero-top"><p class="eyebrow">${mj === 'all' ? (p.off === 0 ? '이 달 쓴 돈' : p.month + '월 쓴 돈') : esc(mjLabel(mj)) + '에 쓴 돈'}</p><span class="hero-sub">모든 결제수단</span></div>
      ${amt(net)}
      <p class="hero-cmp">${line}</p>
      <p class="hero-range num">${cmp.future ? fd(p.start) + ' ~ ' + fd(p.end) : rng} · ${esc(mjLabel(mj))}</p></section>`;
  }
  // v26: 아래 내용 탭(기록 / 청구 안내·분류 비중) 없이 이어서: 기록 4건 → 기록 더 보기 → 청구 안내(카드) 또는 상위 3개 분류(월별)
  const recTitle = bill ? (cp.payDay ? '이 청구 기록' : '이 주기 기록') : (p.off === 0 ? '이 달 기록' : p.month + '월 기록');
  const recent = list.slice().sort(byNewest).slice(0, 4);
  const records = `<section class="home-sec home-recent" data-ui-key="home-recent" aria-labelledby="hs-rec"><div class="section-head"><h2 id="hs-rec">${esc(recTitle)}</h2><button class="link" data-act="analysis">분석${icon('chart')}</button></div>
    <div class="card list-card recent" data-ui-key="recent">${recent.length ? recent.map(t => txRow(t)).join('')
      : !anyTx ? '<div class="empty"><b>우리의 첫 기록을 남겨요</b><br>금액만 입력해도 괜찮아요.</div><button class="btn" data-act="add">기록하기</button>'
      : mj !== 'all' ? `<div class="empty">이 조건의 기록이 없어요.</div><button class="btn ghost" data-act="pcat" data-v="all">필터 초기화</button>` : '<div class="empty">이 기간에는 기록이 없어요.</div>'}</div>
    ${list.length ? `<button class="list-more" data-act="homelist" data-ui-key="home-more" aria-label="기록 더 보기, 전체 ${list.length}건. 내역에서 같은 조건으로"><span>기록 더 보기</span><span class="num lm-n">전체 ${list.length}건</span>${icon('right')}</button>` : ''}</section>`;
  let extra;
  if (bill) {
    const after = !p.closed ? 0 : core.scopeTxs(liveTxs(), { range: billPeriod(0), methods: ms }).length, refunds = liveTxs().filter(t => t.refund_pending).length;
    extra = `<section class="home-sec home-info-section" data-ui-key="home-info" aria-labelledby="hs-info"><div class="section-head"><h2 id="hs-info">청구 안내</h2></div>
      <div class="home-info"><p class="hi-box">${fd(p.start)} ~ ${fd(p.end)} 이용분${p.pay ? ' · ' + longDate(p.pay) + ' 결제' : ''}<br><span class="muted">카드 결제수단만 더해요(현금·계좌이체 제외). 할부·취소·수수료·늦은 매입은 명세서와 다를 수 있어요.</span></p>
      <button class="link" data-act="cardpick">${esc(cardScope())} · 카드 바꾸기${icon('right')}</button>
      ${after && p.off === offset && offset === -1 ? `<button class="link after-close" data-act="nextbill" data-ui-key="after-close">마감 뒤 기록 ${after}건 · 다음 청구${icon('right')}</button>` : ''}
      ${refunds ? `<button class="link" data-act="refunds">환불 대기 ${refunds}건 · 전체 기간${icon('right')}</button>` : ''}</div></section>`;
  } else {
    const g = groupSum(list.filter(t => t.type !== 'transfer'), t => majorOfTx(t)), denom = g.filter(e => e[1] > 0).reduce((a, e) => a + e[1], 0);
    extra = `<section class="home-sec home-category-section" data-ui-key="home-cats" aria-labelledby="hs-cats"><div class="section-head"><h2 id="hs-cats">분류 비중 <span class="h2sub">상위 3개</span></h2></div>
      <div class="home-cats">${g.length ? g.slice(0, 3).map(([k, v]) => barLine('pcatlist', k, core.majorLabel(k), v, denom)).join('') : '<p class="empty">이 기간에는 분류할 지출이 없어요.</p>'}
      <button class="link" data-act="analysis">모든 분류·분석 보기${g.length > 3 ? ' · ' + g.length + '개' : ''}${icon('right')}</button></div></section>`;
  }
  return `<div class="home-top" data-ui-key="home-top">${viewSeg()}${periodNav()}${catChips()}${hero}${budgetRow()}</div>${records}${extra}`;
}
// 가로 막대 한 줄(금액·비중을 함께, 음수 면적 없음). denom = 양의 순지출 합계(0 이하이면 막대 없이 금액만)
function barLine(act, k, label, v, denom) {
  const pct = denom > 0 && v > 0 ? Math.round(v / denom * 1000) / 10 : null;
  return `<button class="bar-line" data-act="${act}" data-v="${esc(k)}" aria-label="${esc(label)} ${v < 0 ? '순환불 ' + won(-v) : won(v)}원${pct != null ? ', ' + pct + '%' : ''}. 이 내역 보기"><span class="bl-k">${esc(label)}</span><span class="bl-track" aria-hidden="true">${denom > 0 ? `<i style="width:${pct != null ? Math.max(2, pct) : 0}%"></i>` : ''}</span><span class="bl-v"><b class="num">${v < 0 ? '순환불 ' + won(-v) : won(v)}원</b>${pct != null ? `<small class="num">${pct}%</small>` : ''}</span></button>`;
}

/* ---------------- 생활 예산 줄(홈): 달력 월 기준, 분류 필터로 줄이지 않음 ---------------- */
function budgetState() {
  const p = store.prefs() || {}, L = p.budget && typeof p.budget === 'object' ? p.budget : null;
  const legacy = L && (L.total > 0 || Object.values(L.cats || {}).some(v => v > 0)) ? L : null;
  const basis = p.budget_basis === 'legacy' && legacy ? 'legacy' : p.budget_basis === 'month' || core.hasMonthBudget(p) || !legacy ? 'month' : 'choose';
  return { p, legacy, basis };
}
const monthSpent = (r, major) => netOf(core.scopeTxs(liveTxs(), { range: r, methods: null, major: major || 'all', map: catMap() }));
function budgetRow() {
  const bs = budgetState();
  if (bs.basis !== 'month') {
    const c = cycleRange(0), spent = netOf(core.scopeTxs(liveTxs(), { range: c })), t = bs.legacy.total || 0, rest = t - spent;
    return `<button class="budget-row" data-act="budget" data-ui-key="budget-row"><span class="br-t"><b>기존 주기 예산 · ${md(c.start)}~${md(c.end)}</b><small>${t ? (rest < 0 ? `<span class="over-t">${wonWbr(-rest)} 초과</span>` : `${wonWbr(rest)} 남음`) : '분류 예산만 있어요'}${bs.basis === 'choose' ? ' · 월 예산으로 바꿀 수 있어요' : ''}</small></span><span class="br-act">보기·수정${icon('right')}</span></button>`;
  }
  const r = pv() === 'month' ? monthPeriod(moff) : monthPeriod(0), b = core.budgetFor(bs.p, r.ym), spent = monthSpent(r), rest = b.total - spent;
  const sub = b.total ? (rest < 0 ? `<span class="over-t">${wonWbr(-rest)} 초과</span>` : `${wonWbr(rest)} 남음`) : Object.keys(b.cats).length ? '전체 한도 미설정 · 대분류 예산만' : '예산을 정해 보세요';
  return `<button class="budget-row" data-act="budget" data-ui-key="budget-row" aria-label="${r.month}월 생활 예산, 1일부터 말일, ${b.total ? (rest < 0 ? won(-rest) + '원 초과' : won(rest) + '원 남음') : '미설정'}. 보기·수정"><span class="br-t"><b>${r.month}월 ${curMajor() !== 'all' ? '전체 ' : ''}생활 예산 · 1일~말일</b><small>${sub}</small></span><span class="br-act">보기·수정${icon('right')}</span></button>`;
}

/* ---------------- 기간 고르기 시트(v26): 최근 6개 + '이전 기간 더 보기'(6개씩 이어 붙임), 연·월 직접 찾기는 늘 보임 ----------------
 * 더 보기만 눌러서는 보던 기간이 바뀌지 않는다(고를 때만 바뀜) */
function openPeriodSheet(keep) {
  const month = pv() === 'month', cur = curOff();
  if (!keep) periodShown = Math.max(PERIOD_STEP, Math.ceil((1 - cur) / PERIOD_STEP) * PERIOD_STEP);
  periodShown = Math.min(120, periodShown);
  const items = Array.from({ length: periodShown }, (_, i) => -i).map(off => {
    const p = month ? monthPeriod(off) : billPeriod(off), t = periodTitle(p);
    return { off, p, t, net: netOf(core.scopeTxs(liveTxs(), { range: p, methods: month ? null : billMethods() })) };
  });
  const auto = month ? 0 : autoOffset();
  sheetPaint(`<div class="sheet-wrap">${sheetHead(month ? '달 고르기' : '청구 고르기')}
    <div class="sheet-b"><p class="hint">${month ? '매월 1일~말일 · 모든 결제수단 순지출이에요.' : `결제일과 이용 기간을 함께 보여 드려요 · ${esc(cardScope())} · 장부 기준 카드값`}${curMajor() !== 'all' ? ' 고른 분류(' + esc(mjLabel(curMajor())) + ')는 기간을 바꿔도 그대로예요.' : ''}</p>
      <div class="period-opts" data-ui-key="period-opts">${items.map(x => `<button class="period-opt" data-act="ppick" data-v="${x.off}" aria-pressed="${x.off === cur}" aria-label="${esc(x.t.aria)}, ${won(x.net)}원${x.off === cur ? ', 보는 중' : ''}"><span class="po-t"><b>${esc(x.t.title)}${x.off === auto ? ` <span class="po-tag">${month ? '이번 달' : '다가오는 결제'}</span>` : ''}</b><small class="num">${month ? fd(x.p.start) + ' ~ ' + fd(x.p.end) : esc(x.t.sub)}</small><span class="po-a"><b class="num">${won(x.net)}원</b> <small>${month ? '전체 순지출' : '장부 기준 카드값'}</small></span></span><span class="po-c" aria-hidden="true">${x.off === cur ? icon('check') : ''}</span></button>`).join('')}</div>
      ${periodShown < 120 ? `<button type="button" class="list-more" data-act="pmore" data-ui-key="more-pmore"><span>이전 ${month ? '달' : '청구'} 더 보기</span><span class="num lm-n">${periodShown}개 보는 중</span>${icon('down')}</button>` : ''}
      <section class="pfind" data-ui-key="pfind" aria-labelledby="pfind-h"><h3 class="sub-h" id="pfind-h">연·월로 찾기</h3><div class="field"><label for="pfind-m">${month ? '보고 싶은 달' : '결제한 달'}</label><input type="month" id="pfind-m" class="in" value="${core.addMonths(today().slice(0, 7), -12)}" max="${today().slice(0, 7)}"><p class="hint">연도를 포함해 골라요. 오래된 기록도 볼 수 있어요.</p><button type="button" class="btn ghost" data-act="pfindgo">이 기간 보기</button><div class="err" id="pfind-err" role="alert"></div></div></section>
    </div>
    <div class="sheet-footer"><button type="button" class="btn ghost" data-act="hauto">${month ? '이번 달로' : '다가오는 결제로'}</button></div></div>`, keep, true);
}
function findPeriod(ym) {
  if (!core.validYm(ym)) return null;
  if (pv() === 'month') { const off = core.monthOffsetOf(ym, new Date()); return off <= 0 ? off : null; }
  for (let k = 0; k >= -240; k--) { const p = billPeriod(k); if ((p.pay || p.start).slice(0, 7) === ym) return k; }
  return null;
}
// 카드 변경: 카드 전체(기존 카드 묶음) 또는 결제수단 하나. 모든 카드가 같은 이용 기간·결제일을 쓴다(카드별 결제일은 다음 단계)
function openCardSheet() {
  const ms = cardMethods(), cur = selCard();
  showSheet(`<div class="sheet-wrap">${sheetHead('청구 카드·결제수단')}
    <div class="sheet-b"><p class="hint">모든 카드가 공통 이용 기간(매월 ${S.settings.cycle_start_day}일 시작)${cardPrefs().payDay ? `과 결제일(매월 ${cardPrefs().payDay}일)` : ''}을 쓰는 기존 카드 묶음이에요. 카드마다 다른 결제일은 아직 지원하지 않아요.</p><div class="period-opts">${[['', '기존 카드 묶음', `카드 결제수단 ${ms.length}개${ms.length ? ' · ' + esc(ms.join(', ')) : ''} · 공통 이용 기간·결제일`], ...ms.map(m => [m, '결제수단 필터 · ' + m, '이 결제수단의 기록만, 같은 이용 기간·결제일'])].map(([v, t, s]) => `<button class="period-opt" data-act="cardset" data-v="${esc(v)}" aria-pressed="${v === cur}"><span class="po-t"><b>${esc(t)}</b><small>${s}</small></span><span class="po-c" aria-hidden="true">${v === cur ? icon('check') : ''}</span></button>`).join('')}</div>
      <p class="hint">고른 것은 이 기기에만 기억해요.</p></div>
    <div class="sheet-footer"><button type="button" class="btn ghost" data-act="setpay">카드 결제일·결제수단 설정</button></div></div>`, true);
}
function openCatSheet() {
  const cur = curMajor(), review = core.majorTotals(liveTxs(), catMap()).review;
  showSheet(`<div class="sheet-wrap">${sheetHead('분류 고르기')}
    <div class="sheet-b"><p class="hint">${pv() === 'month' ? '월별' : '카드 청구'}의 선택을 따로 기억해요. 명세서 비교·예산 요약은 분류와 관계없이 전체로 계산해요.</p>
      <div class="cat-sheet" role="group" aria-label="대분류">${['all', ...core.MAJOR_IDS].map(id => `<button class="mchip" data-act="pcat" data-v="${id}" aria-pressed="${cur === id}">${mjLabel(id)}</button>`).join('')}</div>
      ${review ? `<button class="link" data-act="mapping">확인이 필요한 기록 ${review}건 · 대분류 연결${icon('right')}</button>` : ''}</div></div>`, true);
}

/* ---------------- 분석 (v26): 탭 없이 이어서: 총액 → 대분류 8개 → 최근 3개 기간 추이 → 결제자 합계(내역 결제자로) ----------------
 * 상세 분석(세부 분류·거래처 / 기간별·누적·주별·일별)은 따로 들어가는 화면이고, 단위 전환은 의미가 달라 그 안에서만 유지(spec v26 2절) */
function analysisView() {
  anchorOffset(); anchorMonth();
  const d = listData(), s = core.summarize(d.txs), det = anDetail;
  const title = det === 'cat' ? '분류 자세히' : det === 'trend' ? '추이 자세히' : '분석';
  const head = `<div class="page-title an-title"><div class="pt-l">${det ? `<button class="icon-btn ghost" data-act="anback" aria-label="분석으로 돌아가기">${icon('left')}</button>` : ''}<h1>${title}</h1></div><div class="pt-actions"><button class="link" data-act="tab" data-v="list">내역으로${icon('right')}</button></div></div>
    ${viewSeg()}${periodNav({ locked: lf.period !== 'cycle', key: 'an-pnav' })}${catChips()}${lfToolbar()}`;
  const total = `<div class="total-row" data-ui-key="an-total"><span>${esc(mjLabel(curMajor()))} · <span class="num">${s.count}</span>건</span><b class="num">${won(s.net)}원</b></div>`;
  if (det === 'cat') return head + `<div class="an-body" data-ui-key="an-body">${total}${anCat(d, s)}</div>`;
  if (det === 'trend') return head + `<div class="an-body" data-ui-key="an-body">${total}${anTrend()}</div>`;
  // 결제자 합계는 분석에 다시 두지 않고 내역의 결제자 보기로 잇는다(같은 기간·카드·분류, 정산액이 아님)
  return head + `<div class="an-body" data-ui-key="an-body">${total}${anCatOverview(d)}${anTrendOverview()}
    <button class="list-more an-payer" data-act="lmode" data-v="payer" data-ui-key="an-payer" aria-label="결제자별 합계 보기, 같은 기간·카드·분류로 내역의 결제자 보기. 정산액이 아니라 실제 결제한 금액"><span>결제자별 합계 보기</span>${icon('right')}</button></div>`;
}
// 개요의 분류: 전체면 대분류 8개를 모두(0원 포함, 유한한 8개를 자르지 않음), 대분류를 골랐으면 그 안의 세부 분류(8개 + 더 보기)
function anCatOverview(d) {
  const mj = curMajor(), spend = d.txs.filter(t => t.type !== 'transfer');
  let g, sub;
  if (mj === 'all') { const m = Object.fromEntries(groupSum(spend, t => majorOfTx(t))); g = core.MAJOR_IDS.map(id => [id, m[id] || 0, core.majorLabel(id)]).sort((a, b) => b[1] - a[1]); sub = 'major'; }
  else { g = groupSum(spend, t => t.category || '미분류').map(([k, v]) => [k, v, k]); sub = 'detail'; }
  const denom = g.filter(e => e[1] > 0).reduce((a, e) => a + e[1], 0), shown = sub === 'major' ? g.length : Math.min(g.length, anShown);
  return `<section class="an-sec" data-ui-key="an-cats" aria-labelledby="an-ch"><div class="section-head"><h2 id="an-ch">${sub === 'major' ? '대분류 8개' : esc(mjLabel(mj)) + ' 세부 분류'}</h2><button class="link" data-act="andetail" data-v="cat">세부 분류·거래처${icon('right')}</button></div>
    <div class="card bars" data-ui-key="an-bars">${g.length ? g.slice(0, shown).map(([k, v, l]) => barLine('anpick', sub + ':' + k, l, v, denom)).join('') : '<p class="empty">이 조건에는 나눠 볼 지출이 없어요.</p>'}</div>
    ${sub === 'major' ? '' : moreBtn('anmore', shown, g.length, '개', AN_STEP)}
    <p class="hint">${denom > 0 ? '선택한 지출 안에서의 비중이에요(순환불은 비중에서 빼요). 누르면 그 내역으로 가요.' : '합계가 0원 이하라 비중 대신 금액만 보여 드려요.'}</p></section>`;
}
// 개요의 짧은 추이: 최근 3달(월별) 또는 3회 청구(카드 청구), 보던 기간까지. 자세한 단위 전환은 상세에서
function anTrendOverview() {
  const month = pv() === 'month', td = today();
  const pick = r => core.filterTxs(core.scopeTxs(liveTxs(), { range: r, methods: month ? null : billMethods(), major: curMajor(), map: catMap() }), lf, null);
  const ps = [2, 1, 0].map(k => { const off = curOff() - k, p = month ? monthPeriod(off) : billPeriod(off), t = periodTitle(p); return { p, t, v: netOf(pick(p)), run: td >= p.start && td <= p.end }; });
  const max = Math.max(1, ...ps.map(x => x.v));
  return `<section class="an-sec" data-ui-key="an-trend" aria-labelledby="an-th"><div class="section-head"><h2 id="an-th">최근 3${month ? '달' : '회 청구'} 추이</h2><button class="link" data-act="andetail" data-v="trend">자세히${icon('right')}</button></div>
    <div class="card bars trend-mini">${ps.map(x => `<div class="bar-line static" role="group" aria-label="${esc(x.t.title)}, ${x.v < 0 ? '순환불 ' + won(-x.v) : won(x.v)}원${x.run ? ', 진행 중' : ''}"><span class="bl-k">${esc(month ? x.p.year + '년 ' + x.p.month + '월' : x.t.title)}${x.run ? ' <small class="run-t">진행 중</small>' : ''}</span><span class="bl-track" aria-hidden="true"><i style="width:${x.v > 0 ? Math.max(2, Math.round(x.v / max * 100)) : 0}%"></i></span><span class="bl-v"><b class="num">${x.v < 0 ? '순환불 ' + won(-x.v) : won(x.v)}원</b></span></div>`).join('')}</div>
</section>`;
}
function anCat(d, s) {
  const sub = view.anSub.cat === 'merchant' ? 'merchant' : 'detail'; // 대분류는 개요에서 8개 전부
  const spend = d.txs.filter(t => t.type !== 'transfer');
  const g = sub === 'detail' ? groupSum(spend, t => t.category || '미분류').map(([k, v]) => [k, v, k]) : groupSum(spend.filter(t => t.merchant), t => t.merchant).map(([k, v]) => [k, v, k]);
  const denom = g.filter(e => e[1] > 0).reduce((a, e) => a + e[1], 0), shown = Math.min(g.length, anShown);
  return `<div class="seg seg2 an-sub" role="group" aria-label="나눠 볼 기준">${[['detail', '세부 분류'], ['merchant', '거래처']].map(([k, l]) => `<button data-act="ansub" data-v="cat:${k}" aria-pressed="${sub === k}">${l}</button>`).join('')}</div>
    <div class="card bars" data-ui-key="an-bars">${g.length ? g.slice(0, shown).map(([k, v, l]) => barLine('anpick', sub + ':' + k, l, v, denom)).join('') : '<p class="empty">이 조건에는 나눠 볼 지출이 없어요.</p>'}</div>
    ${moreBtn('anmore', shown, g.length, '개', AN_STEP)}
    <p class="hint">${denom > 0 ? '선택한 지출 안에서의 비중이에요(순환불은 비중에서 빼요). 누르면 그 내역으로 가요.' : '합계가 0원 이하라 비중 대신 금액만 보여 드려요.'}</p>`;
}
// 추이: 기간별(월별·청구별 6개) · 누적 흐름(이번 ↔ 지난) · 주별 8주 · 일별 14일
function anTrend() {
  const sub = view.anSub.trend || 'period', month = pv() === 'month';
  const opts = [['period', month ? '월별' : '청구별'], ['pace', '누적'], ['week', '주별'], ['day', '일별']];
  const seg = `<div class="seg seg4 an-sub" role="group" aria-label="추이 단위">${opts.map(([k, l]) => `<button data-act="ansub" data-v="trend:${k}" aria-pressed="${sub === k}">${l}</button>`).join('')}</div>`;
  const pick = r => core.filterTxs(core.scopeTxs(liveTxs(), { range: r, methods: month ? null : billMethods(), major: curMajor(), map: catMap() }), lf, null);
  const td = today(), anchor = (() => { const r = listRange(); return r && r.end < td ? r.end : td; })(); // 주별·일별은 보던 기간의 끝(오늘보다 앞이면 그날) 기준(Astra P1-05)
  if (sub === 'pace') {
    const p = curPeriod(), pp = month ? monthPeriod(moff - 1) : billPeriod(offset - 1), running = td >= p.start && td <= p.end;
    return seg + paceChart(p, pp, pick(p), pick(pp), running ? dayDiff(p.start, td) + 1 : dayDiff(p.start, p.end) + 1, month ? ['이 달', '지난달'] : ['이 청구', '지난 청구']);
  }
  let periods;
  if (sub === 'period') periods = Array.from({ length: 6 }, (_, i) => { const off = curOff() - 5 + i, p = month ? monthPeriod(off) : billPeriod(off), t = periodTitle(p); return { start: p.start, end: p.end, x: month ? p.month + '월' : md(p.start), title: t.title + ' (' + fd(p.start) + ' ~ ' + fd(p.end) + ')' }; });
  // 주별 마지막 구간은 기준일(보던 기간의 끝 또는 오늘)에서 자른다: 그 뒤 날짜의 기록을 더하지 않음(Astra v25 P1-05)
  else if (sub === 'week') { const mon = addDays(anchor, -((parseDate(anchor).getDay() + 6) % 7)); periods = Array.from({ length: 8 }, (_, i) => { const s = addDays(mon, -7 * (7 - i)), e = addDays(s, 6) > anchor ? anchor : addDays(s, 6); return { start: s, end: e, x: md(s), title: fd(s) + ' ~ ' + fd(e) }; }); }
  else periods = Array.from({ length: 14 }, (_, i) => { const d = addDays(anchor, i - 13); return { start: d, end: d, x: md(d), title: fd(d) + ' ' + WEEK[parseDate(d).getDay()] }; });
  periods.forEach(p => { p.v = netOf(pick(p)); p.run = td >= p.start && td <= p.end && p.start !== p.end; p.sel = sub === 'period' && p.start === curPeriod().start; });
  const until = anchor === td ? '오늘' : fd(anchor), ad = parseDate(anchor), cut = sub === 'week' && parseDate(anchor).getDay() !== 0;
  const lastWeek = cut ? ` · 마지막 주는 ${anchor === td ? '오늘' : (ad.getMonth() + 1) + '월 ' + ad.getDate() + '일'}까지` : '';
  return seg + barChart(periods, sub === 'period' ? (month ? '월별 순지출' : cardPrefs().payDay ? '청구별 장부 기준 카드값' : '이용 주기별 카드 기록') : sub === 'week' ? `주별 순지출 · ${until}까지 8주${lastWeek}` : `일별 순지출 · ${until}까지 14일`);
}

/* ---------------- 결제자별 합계(내역 → 결제자, 분석 → 결제자): 정산액이 아니다 (spec 5절) ---------------- */
function payerBlock(txs) {
  const by = {}, cnt = {};
  txs.forEach(t => { if (t.type === 'transfer') return; const p = t.payer || '미지정'; by[p] = (by[p] || 0) + signed(t); cnt[p] = (cnt[p] || 0) + 1; });
  const order = [...payerList(), ...Object.keys(by)].filter((p, i, a) => a.indexOf(p) === i && p in by);
  const shares = core.payerShares(order.map(p => [p, by[p]])), total = shares.reduce((a, x) => a + x.amount, 0);
  const shown = Math.min(shares.length, payerShown);
  const p = curPeriod(), t = periodTitle(p), rangeName = lf.period === 'cycle' ? t.title : lf.period === 'all' ? '전체 기간' : '지정 기간';
  return `<div class="payer-block" data-ui-key="payer-block"><h2 class="payer-h">결제자별 합계</h2>
    <p class="hint payer-note">${esc(rangeName)} · ${esc(mjLabel(curMajor()))}${pv() === 'bill' ? ' · ' + esc(cardLabel()) : ''}<br>실제로 결제한 금액이에요. 서로 갚을 정산액은 아니에요.</p>
    ${shares.length ? `<div class="people" data-ui-key="people">${shares.slice(0, shown).map(x => `<section class="person card" aria-label="${esc(x.name)} 결제 ${x.amount < 0 ? '순환불 ' + won(-x.amount) : won(x.amount)}원${total > 0 && x.amount > 0 ? ', ' + x.pct + '%' : ''}">
      <div class="person-top"><b>${esc(x.name)}</b>${total > 0 && x.amount > 0 ? `<span class="badge num">${x.pct}%</span>` : ''}</div>
      <p class="person-amt num">${x.amount < 0 ? '순환불 ' + won(-x.amount) : won(x.amount)}원</p>
      <div class="person-foot"><span>${cnt[x.name] || 0}건 결제</span><button class="link" data-act="payerlist" data-v="${esc(x.name)}">기록 보기${icon('right')}</button></div></section>`).join('')}</div>${moreBtn('payermore', shown, shares.length, '명', PAYER_STEP, '결제자 더 보기')}`
      : '<p class="empty">이 조건의 결제 기록이 없어요.</p>'}</div>`;
}

/* ---------------- 명세서 맞추기: 카드·결제일·이용 기간 → 장부 전체 카드값 → 명세서 금액 → 차액 (spec 4.4) ----------------
 * 분류 필터와 관계없이 카드 전체로 비교한다. 입력 금액은 카드+결제일+이용 기간 키로 이 기기에만 기억(v24는 열 때마다 비웠다).
 * 거래가 바뀌면 다시 계산하고 '장부가 바뀌었어요'를 알린다. 공유 대기 중이면 맞아도 '확정 전' */
let stmtText = '', stmtKey = '';
function stmtLedger() { return netOf(viewTxs(billPeriod(offset), 'all')); }
function openStatement() {
  const p = billPeriod(offset), t = periodTitle(p), ledger = stmtLedger(), n = viewTxs(p, 'all').length;
  stmtKey = core.billKey(selCard(), p, p.pay);
  const memo = (S.stmt || {})[stmtKey]; stmtText = memo && Number.isSafeInteger(memo.v) ? won(memo.v) : '';
  showSheet(`<div class="sheet-wrap">${sheetHead('명세서 맞추기')}
    <div class="sheet-b">
      <div class="stmt-ctx"><span class="sc-card">${esc(cardLabel())} · 공통 이용 기간·결제일</span><span>${esc(p.pay ? t.title : '결제일 미설정')}</span><span class="num">${fd(p.start)} ~ ${fd(p.end)} 이용분</span><b class="num">장부 기준 ${won(ledger)}원</b><small>${n}건 · 분류 필터와 관계없이 카드 전체</small></div>
      <div class="field"><label for="stmt-amount">명세서 청구 금액 (원)</label>
        <div class="amount-in"><input id="stmt-amount" data-money data-input="stmt" inputmode="numeric" autocomplete="off" placeholder="예: ${won(ledger || 765000)}" value="${esc(stmtText)}" class="num" aria-describedby="stmt-err stmt-res"><span>원</span></div>
        <p class="amount-echo num" aria-live="polite"></p>
        <div class="err" id="stmt-err" role="alert"></div>
        <p class="stmt-res" id="stmt-res" role="status">${stmtResult(ledger)}</p></div>
      <div class="utabs stmt-tools" role="group" aria-label="다음 행동"><button type="button" data-act="billlist">청구 기록</button><button type="button" data-act="impopen" data-v="file">파일 대조</button><button type="button" data-act="impopen" data-v="paste">알림 입력</button></div>
      <p class="hint">할부·취소·수수료·매입 시점은 명세서와 다를 수 있어요. 입력 금액은 이 카드·이 청구에만, 이 기기에만 기억해요.</p>
    </div></div>`, true);
}
function stmtResult(ledger) {
  const r = core.parseClaimWon(stmtText);
  if (!r.ok) return '';
  const d = core.statementDiff(ledger, r.value), memo = (S.stmt || {})[stmtKey], pend = store.pendingDetail().total;
  const changed = memo && memo.ledger !== ledger && memo.v === r.value ? `<span class="stmt-chg">장부가 바뀌었어요 · 다시 확인해 주세요 (입력 당시 장부 ${won(memo.ledger)}원)</span>` : '';
  const tail = `<small>명세서 ${won(r.value)}원 · 장부 ${won(ledger)}원</small>`;
  return d.kind === 'match' ? `${icon('check')}<span><b>명세서와 딱 맞아요.</b> ${pend ? '공유 대기 중인 기록이 있어 아직 확정 전이에요.' : '입력한 청구 금액과 장부 금액이 같아요.'}${changed}${tail}</span>`
    : d.kind === 'missing' ? `${icon('alert')}<span><b>장부가 ${won(d.abs)}원 적어요.</b> 빠진 기록이나 수수료가 있을 수 있어요. 아래에서 이용내역과 대조해 보세요.${changed}${tail}</span>`
    : `${icon('alert')}<span><b>장부가 ${won(d.abs)}원 많아요.</b> 취소·중복 기록이나 다른 청구에 들어갈 기록이 섞였을 수 있어요.${changed}${tail}</span>`;
}
// 명세서 시트가 열린 동안 장부가 바뀌면(동기화·다른 기기) 장부 금액·결과를 다시 계산(Fable P2-3)
function refreshStmt() {
  const b = $('#sheet[open] .stmt-ctx b'); if (!b) return;
  const ledger = stmtLedger(), t = '장부 기준 ' + won(ledger) + '원';
  if (b.textContent !== t) { b.textContent = t; const r = $('#stmt-res'); if (r) r.innerHTML = stmtResult(ledger); }
}
function saveStmtMemo(ledger) {
  const r = core.parseClaimWon(stmtText), all = Object.assign({}, S.stmt || {});
  if (r.ok) all[stmtKey] = { v: r.value, ledger, at: Date.now() }; else if (!stmtText.trim()) delete all[stmtKey]; else return;
  const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at); keys.slice(36).forEach(k => delete all[k]); // 최근 36개 청구만
  store.setLocal('stmt', all);
}

/* 카드값 설정: 결제일(매월 N일)과 카드값에 넣을 결제수단. 집계 시작일(카드 집계 주기)과는 다른 값 */
function openPaySheet() {
  if (!store.prefs()) { toast('서버 업데이트가 필요해요 (Apps Script 새 버전)'); return; }
  const cp = cardPrefs(), cm = cardMethods(), r = cycleRange(0), ms = allMethods();
  showSheet(`<form data-form="pay" class="sheet-wrap" novalidate>${sheetHead('카드 결제일')}
    <div class="sheet-b">
      <div class="field"><label for="payday">카드값이 빠져나가는 날</label>
        <select id="payday" class="in" name="pay_day"><option value="0" ${cp.payDay ? '' : 'selected'}>정하지 않음</option>${Array.from({ length: 31 }, (_, i) => i + 1).map(d => `<option value="${d}" ${cp.payDay === d ? 'selected' : ''}>매월 ${d}일</option>`).join('')}</select>
        <p class="hint">이용 기간과 실제 결제일은 달라요.</p>
        <p class="hint" id="pay-preview">${payPreview(cp.payDay)}</p>
        <div class="pay-more"><span class="lab">계산 기준</span>
        <p class="hint">집계 시작일(매월 ${S.settings.cycle_start_day}일)과는 달라요. 시작일은 이용 기간의 첫날, 결제일은 그 기간의 카드값이 나가는 날이에요. 이용 기간이 시작한 달의 다음 달 그날(결제일이 시작일보다 앞이면 다다음 달)로 계산해요. 29~31일은 그날이 없는 달엔 말일이에요.</p></div></div>
      <div class="field"><span class="lab" id="pm-lab">카드값에 넣을 결제수단</span>
        <div class="chips" id="pay-methods" role="group" aria-labelledby="pm-lab">${ms.map(m => `<button type="button" class="chip" data-act="paymethod" data-v="${esc(m)}" aria-pressed="${cm.includes(m)}">${esc(m)}</button>`).join('') || '<p class="hint">결제수단이 없어요. 설정 → 분류·결제수단·결제자에서 추가해 주세요.</p>'}</div>
        <p class="hint">${cp.methods ? '직접 고른 결제수단이에요.' : '지금은 이름에 ‘카드’가 든 결제수단을 자동으로 넣고 있어요.'} 현금·계좌이체는 보통 빼요. 두 사람에게 같이 적용돼요.</p></div>
      <div class="err" id="pay-err" role="alert"></div>
    </div>
    <div class="sheet-footer"><button class="btn save" type="submit">저장</button></div></form>`);
}
function payPreview(pd) {
  if (!pd) return '정하지 않으면 홈은 주기 끝(마감일)까지 남은 날로 안내해요.';
  const a = cycleRange(-1), pa = core.payDate(a, pd, S.settings.cycle_start_day);
  return `예: ${md(a.start)} ~ ${md(a.end)} 이용분 → ${longDate(pa)}`;
}
function savePay(f) {
  const pd = core.validPayDay(new FormData(f).get('pay_day'));
  const chosen = [...f.querySelectorAll('#pay-methods [aria-pressed=true]')].map(b => b.dataset.v);
  const auto = core.cardMethodsOf(allMethods(), null), cp = cardPrefs();
  // 자동으로 고른 것과 같으면 '자동'으로 둔다(나중에 카드 이름이 늘면 따라감). 직접 바꿨으면 그 목록
  const same = !cp.methods && chosen.length === auto.length && chosen.every(m => auto.includes(m));
  const patch = { card_pay_day: pd, card_methods: same ? null : chosen };
  if ((store.prefs() || {}).card) patch.card = null; // 예전 키는 비워 둔다(새 키가 우선이지만 헷갈리지 않게)
  if (!store.setPrefs(patch)) { $('#pay-err').textContent = '저장하지 못했어요. 다시 눌러 주세요'; return; }
  $('#sheet').close(); savedToast(pd ? `카드 결제일을 매월 ${pd}일로 저장했어요` : '카드 설정을 저장했어요');
}
// 공유 설정 저장 알림(Fable P2-4): 오프라인이거나 공유가 실패하면 '이 기기에 저장 · 공유 대기 N건'으로 알린다.
// 저장 직후 전송이 끝날 때까지(최대 35초) 지켜보고, 끝났는데 아직 보낼 설정이 남아 있으면 그때 다시 알린다
function savedToast(msg) {
  const pending = () => `이 기기에 저장했어요 · 공유 대기 ${store.pendingDetail().total}건(연결되면 두 사람에게 공유돼요)`;
  if (navigator.onLine === false) { toast(pending()); return; }
  toast(msg);
  const t0 = Date.now(), iv = setInterval(() => {
    const st = store.status();
    if (st.syncing && Date.now() - t0 < 35000) return;
    clearInterval(iv);
    if (S.pendingSettings) toast(pending());
  }, 300);
}

/* ---------------- 생활 예산 (v25, spec 6절): 달력 월 · 전체/대분류 · 이 달만/이후 달에도 ----------------
 * 진입: 머리글 '예산', 홈 예산 줄, 설정 '우리 장부' 첫 줄 → 모두 같은 예산 보기. 수정은 항목 하나씩(전체 또는 대분류 1개) + 적용 범위.
 * 저장 = 공유 설정 prefs 'bm:YYYY-MM'(그 달만)·'bt:YYYY-MM'(그 달부터). 기존 주기 예산(prefs.budget)은 지우지 않고 보관 */
let bud = { ym: '', field: '' };
const budgetPrefs = () => store.prefs() || {};
function openBudget(fresh) {
  if (!store.prefs()) { toast('서버 업데이트가 필요해요 (Apps Script 새 버전)'); return; }
  if (fresh || !bud.ym) bud = { ym: pv() === 'month' ? monthPeriod(moff).ym : core.monthRange(0).ym, field: '' };
  const bs = budgetState();
  if (bs.basis === 'choose') return showSheet(budgetChooseHtml(bs), true);
  if (bs.basis === 'legacy') return showSheet(budgetLegacyHtml(bs), true);
  const r = core.monthOf(bud.ym), b = core.budgetFor(bs.p, bud.ym), spent = monthSpent(r), chk = core.budgetCheck(b), now = core.monthRange(0).ym;
  const nav = `<div class="period-nav bud-nav" data-ui-key="bud-nav"><button class="pn-btn" data-act="bmon" data-v="-1" aria-label="이전 달 예산">${icon('left')}</button>
    <div class="period-lbl static"><b><span>${r.year}년 ${r.month}월</span></b><small class="num">${fd(r.start)} ~ ${fd(r.end)}</small></div>
    <button class="pn-btn" data-act="bmon" data-v="1" aria-label="다음 달 예산" ${bud.ym >= core.addMonths(now, 12) ? 'disabled' : ''}>${icon('right')}</button></div>`;
  const src = b.source === 'month' ? `${r.month}월만 따로 정한 예산이에요` : b.source === 'template' ? `${b.from.replace('-', '년 ').replace(/^(\d+년 )0?/, '$1')}월부터 적용 중인 예산이에요` : '아직 정하지 않았어요';
  // v26: 전체 / 대분류 탭 없이 이어서: 전체 예산(수정 버튼은 요약 안) → 배정 합계·미배정 → 대분류 8개 전부 → 연결·정리·이전 주기 진입
  const rest = b.total - spent, pct = b.total ? Math.min(100, Math.max(0, spent) / b.total * 100) : 0;
  const total = `<section class="card bud-total" data-ui-key="bud-total"><p class="bt-lab">이 달 전체 예산</p><p class="bt-amt num" aria-label="${b.total ? won(b.total) + '원' : '미설정'}">${b.total ? wonWbr(b.total) : '미설정'}</p>
      ${b.total ? `<div class="budget-track${rest < 0 ? ' over' : ''}" aria-hidden="true"><i style="width:${pct}%"></i></div><div class="bt-foot"><span>쓴 돈 <span class="num">${won(spent)}원</span></span><b class="num${rest < 0 ? ' over-t' : ''}">${rest < 0 ? icon('alert') + won(-rest) + '원 초과' : won(rest) + '원 남음'}</b></div>`
        : `<div class="bt-foot"><span>쓴 돈 <span class="num">${won(spent)}원</span></span><span class="muted">예산 정하기를 눌러 시작해요</span></div>`}
      <p class="bt-src">${src} · 모든 결제수단의 이용일 기준, 카드 청구 주기와 별도</p>
      <button type="button" class="btn bt-cta" data-act="bedit" data-v="total">${b.total ? '전체 예산 수정' : '전체 예산 정하기'}</button></section>`;
  const cats = `<section class="bud-sec" data-ui-key="bud-cats-sec" aria-labelledby="bud-ch"><div class="section-head"><h2 id="bud-ch">대분류 예산 <span class="h2sub">8개</span></h2></div>
      <p class="hint bud-sum">${b.total ? `배정 합계 <b class="num">${won(chk.allocated)}원</b> · 미배정 <span class="num">${won(chk.unassigned)}원</span> · 미설정은 제한 없음 · 쿠팡 같은 거래처는 예산 항목이 아니에요.` : `전체 한도 미설정 · 대분류 합계 <b class="num">${won(chk.allocated)}원</b> · 대분류는 8개로 고정이에요.`}</p>
      <div class="card list-card bud-cats" data-ui-key="bud-cats">${core.MAJORS.map(m => { const lim = b.cats[m.id] || 0, sp = monthSpent(r, m.id), over = lim && sp > lim;
        return `<button class="settings-row bud-cat" data-act="bedit" data-v="${m.id}" aria-label="${m.label} 예산 ${lim ? won(lim) + '원' : '미설정'}, 쓴 돈 ${won(sp)}원${over ? ', ' + won(sp - lim) + '원 초과' : ''}. 고치기"><span><span class="bc-top"><b>${m.label}</b><span class="bc-lim">한도 ${lim ? `<span class="num">${won(lim)}원</span>` : '미설정'}</span></span><small class="bc-used">쓴 돈 <span class="num">${won(sp)}원</span>${over ? ` · <span class="over-t">${icon('alert')}${won(sp - lim)}원 초과</span>` : ''}</small></span>${icon('right')}</button>`; }).join('')}</div>
</section>`;
  const links = `<div class="card list-card bud-links"><button class="settings-row" data-act="mapping"><span><b>거래처·세부 분류 연결</b><small>기록을 8개 대분류로 묶어요</small></span>${icon('right')}</button>
      ${oldMonthKeys().length ? `<button class="settings-row" data-act="bcleanup"><span><b>오래된 월 예산 ${oldMonthKeys().length}개 정리</b><small>24개월 지난 '그 달만' 예산을 지워 공유 설정 공간을 비워요</small></span>${icon('right')}</button>` : ''}
      ${bs.legacy ? `<button class="settings-row" data-act="blegacy"><span><b>이전 주기 예산</b><small>전환 시점에 보관한 기존 설정 · 매월 ${S.settings.cycle_start_day}일 시작</small></span>${icon('right')}</button>` : ''}</div>`;
  const cf = Object.keys(store.conflicts());
  const banner = (cf.length ? `<button class="notice-soft warn cf-banner" data-act="cfopen" data-v="${esc(cf[0])}">${icon('alert')}<span>선택이 필요한 예산 ${cf.length}건 · 내 값과 상대 값을 비교해 골라 주세요</span></button>` : '') + budgetServerNote();
  showSheet(`<div class="sheet-wrap">${sheetHead('생활 예산')}
    <div class="sheet-b">${banner}${nav}${total}${cats}${links}</div></div>`, true);
  // 수정·취소 뒤 돌아오면 고치던 항목이 보이게(탭이 없어져 위치로 이어 준다)
  if (bud.field && bud.field !== 'total') { const row = $(`#sheet [data-act=bedit][data-v="${bud.field}"]`); if (row) { row.scrollIntoView({ block: 'nearest' }); row.focus({ preventScroll: true }); } }
}
// 한 항목 수정: 금액 하나 + 적용 범위(이 달만 / 이후 달에도) + 취소·저장. 참고 금액(지난달 쓴 돈)은 입력 아래 본문으로(spec 9절)
// 수정 화면의 참고값(배정 합계·전체·다른 대분류 합계): 동기화·충돌로 공유 값이 바뀌면 입력은 두고 이 줄만 다시 씀(Fable P2-8)
function budHelp(field) {
  const b = core.budgetFor(budgetPrefs(), bud.ym), chk = core.budgetCheck(b), total = field === 'total', cur = total ? b.total : b.cats[field] || 0, others = chk.allocated - (total ? 0 : cur);
  return `${total ? `대분류 배정 합계 <span class="num">${won(chk.allocated)}원</span>` : `이 달 전체 예산 <span class="num">${b.total ? won(b.total) + '원' : '미설정'}</span> · 다른 대분류 합계 <span class="num">${won(others)}원</span>`}<br>빈칸이나 0은 이 항목의 예산 제한을 해제해요.`;
}
const refreshBudHelp = () => { const h = $('#sheet [data-form=budget] #bud-help'); if (h && bud.field) { const x = budHelp(bud.field); if (h.innerHTML !== x) h.innerHTML = x; } };
function budgetEditHtml(field, err, text, scope) {
  const r = core.monthOf(bud.ym), b = core.budgetFor(budgetPrefs(), bud.ym), chk = core.budgetCheck(b), total = field === 'total';
  const name = total ? '전체' : core.majorLabel(field), cur = total ? b.total : b.cats[field] || 0;
  const last = monthSpent(core.monthOf(core.addMonths(bud.ym, -1)), total ? 'all' : field), others = chk.allocated - (total ? 0 : cur);
  const v = text != null ? text : cur ? won(cur) : '', ml = `${r.year}년 ${r.month}월`;
  return `<form data-form="budget" class="sheet-wrap" novalidate>${sheetHead(name + ' 예산 수정', 'budget')}
    <div class="sheet-b"><p class="hint bud-meta num">${ml} · ${fd(r.start)} ~ ${fd(r.end)}</p>
      <div class="field"><label for="${total ? 'b-total' : 'b-cat'}">${name} 예산 (원)</label>
        <div class="amount-in"><input id="${total ? 'b-total' : 'b-cat'}" name="amount" data-money inputmode="numeric" autocomplete="off" placeholder="미설정" value="${esc(v)}" class="num" aria-describedby="budget-err bud-help" style="--len:${Math.max(6, v.length)}"></div>
        <p class="amount-echo num" aria-live="polite">${cur >= 10000 && text == null ? koWon(cur) : ''}</p>
        <p class="hint" id="bud-help">${budHelp(field)}</p>
        ${store.serverState() !== 'new' ? '' : `<p class="hint bud-ref">참고: 지난달(${parseDate(core.monthOf(core.addMonths(bud.ym, -1)).start).getMonth() + 1}월) ${name === '전체' ? '' : name + '에 '}쓴 돈 <span class="num">${won(last)}원</span></p>`}</div>
      <fieldset class="field bud-scope"><legend class="lab">적용 범위</legend>
        <label class="radio-row"><input type="radio" name="scope" value="month" ${scope !== 'future' ? 'checked' : ''}><span>${ml}만</span></label>
        <label class="radio-row"><input type="radio" name="scope" value="future" ${scope === 'future' ? 'checked' : ''}><span>${ml}부터 이후 달에도 적용</span></label>
        <p class="hint">이전 달 예산은 바뀌지 않아요. 이후 달에 따로 정한 예산도 그대로예요.</p>
        ${store.serverState() !== 'new' ? '' : `<p class="hint bud-future" id="bud-future">${futureBaseText(field)}</p>`}</fieldset>
      <div class="err" id="budget-err" role="alert">${esc(err || '')}</div>${budgetServerNote(true)}
    </div>
    <div class="sheet-footer two"><button type="button" class="btn ghost" data-act="budget">취소</button><button class="btn save" type="submit">예산 저장</button></div></form>`;
}
// '이후 달에도'의 바탕 미리보기(Fable P2-1): 그 달에 적용되던 기본값(그 달만 정한 값은 바탕이 아님)에서 이 항목만 바뀐다
function futureBaseText(field) {
  const p = budgetPrefs(), tk = Object.keys(p).filter(k => k.startsWith('bt:') && core.validYm(k.slice(3)) && k.slice(3) <= bud.ym && p[k]).sort().pop();
  const name = field === 'total' ? '전체' : core.majorLabel(field);
  if (!tk) return `이후 달에도를 고르면: 기본값이 아직 없어 ${name} 예산만 이후 달에 적용돼요(다른 항목은 미설정).`;
  const b = core.budgetFor({ [tk]: p[tk] }, bud.ym), from = core.monthOf(tk.slice(3)), cur = field === 'total' ? b.total : b.cats[field] || 0;
  return `이후 달에도를 고르면: ${from.year}년 ${from.month}월부터 쓰던 기본값(전체 ${b.total ? man(b.total) + '원' : '미설정'} · ${name} ${cur ? man(cur) + '원' : '미설정'})에서 ${name}만 바뀌어요. 그 달만 따로 정한 값은 바탕이 아니에요.`;
}
const oldMonthKeys = () => { const cut = core.addMonths(core.monthRange(0).ym, -24); return Object.keys(budgetPrefs()).filter(k => k.startsWith('bm:') && core.validYm(k.slice(3)) && k.slice(3) < cut); };
/* 월 예산 저장 계약(v25 3차, Astra P0-02): 수정 번호를 비교하는 서버(features prefsRev)에서만 저장한다.
 * 옛 서버 = 보기만, 수정 화면은 열리지만 저장하면 '서버 업데이트가 필요해요'와 함께 입력을 그대로 둔다. 서버 응답 전(오프라인 첫 실행) = '확인 중'.
 * 편집을 시작할 때의 예산 값(수정 번호 포함)을 기준으로 고정해, 고치는 사이 상대 수정이 들어와도 내 저장과 비교한다 */
function budgetServerNote(inEdit) {
  const st = store.serverState(); if (st === 'new') return '';
  if (st === 'unknown') return `<p class="notice-soft warn srv-budget">서버를 확인하는 중이에요. 연결되면 월 예산을 저장할 수 있어요${inEdit ? ' · 입력은 그대로 둬요' : ''}.</p>`;
  return `<div class="notice-soft warn srv-budget"><p>${inEdit ? '서버 업데이트 전이라 이 화면에서 저장할 수 없어요 · 입력은 그대로 둬요' : '공유 예산을 저장하려면 서버 업데이트가 필요해요. 지금은 보기만 할 수 있어요'}.</p>${srvGuide()}</div>`;
}
// 서버 업데이트 방법(시트 주인이 한 번): 이 화면을 떠나지 않게 접어 둔다
const srvGuide = () => `<details class="srv-guide"><summary>서버 업데이트 방법</summary><ol><li>구글 시트 → 확장 프로그램 → Apps Script</li><li>새 Code.gs 전체를 붙여넣고 저장</li><li>배포 → 배포 관리 → 기존 배포 편집 → 새 버전 → 배포(주소는 그대로)</li></ol><p>앱을 다시 열면 바로 쓸 수 있어요. 기록은 업데이트해도 그대로예요.</p></details>`;
function budgetSnap() { const p = budgetPrefs(), o = {}; Object.keys(p).forEach(k => { if (/^b[mt]:\d{4}-\d{2}$/.test(k)) o[k] = JSON.parse(JSON.stringify(p[k])); }); return o; }
function openBudgetEdit(field) { bud.field = field; bud.snap = budgetSnap(); showSheet(budgetEditHtml(field), true); const a = $('#sheet [name=amount]'); if (a) a.focus({ preventScroll: true }); }
function saveBudget(f) {
  const fd2 = new FormData(f), text = String(fd2.get('amount') || ''), scope = fd2.get('scope') === 'future' ? 'future' : 'month';
  const r = core.parseBudgetWon(text), field = bud.field;
  const fail = m => { const e = $('#budget-err'); if (e) e.textContent = m; const a = $('#sheet [name=amount]'); if (a) { a.setAttribute('aria-invalid', 'true'); a.focus({ preventScroll: true }); } };
  if (!r.ok) return fail(`${field === 'total' ? '전체' : core.majorLabel(field)} 예산: ${WON_ERR[r.error]}`);
  const res = core.budgetApply(budgetPrefs(), bud.ym, field, r.value, scope, { by: S.me || '', at: Date.now() });
  if (!res.ok) {
    const where = res.where && res.where !== bud.ym ? `${res.where.replace('-', '년 ').replace(/^(\d+년 )0?/, '$1')}월부터 정한 예산과 맞지 않아요. ` : '';
    return fail(res.check ? `${where}대분류 합계가 전체 예산보다 ${won(res.check.short)}원 커요. 전체 예산을 늘리거나 분류 금액을 줄여 주세요` : '저장할 수 없는 항목이에요');
  }
  const patch = Object.assign({}, res.patch); if ((store.prefs() || {}).budget_basis !== 'month') patch.budget_basis = 'month';
  const ss = store.serverState();
  if (ss !== 'new') return fail(ss === 'old' ? '공유 예산을 저장하려면 서버 업데이트가 필요해요' : '서버를 확인하는 중이에요. 연결된 뒤 다시 저장해 주세요');
  // 기준 = 편집을 시작할 때 본 값(그 사이 상대 수정이 들어왔으면 보낼 때 내 값·상대 값·처음 값을 비교)
  // v25 4차(Astra P0-02 B): 내 변경 = 편집 시작 값에 내 수정만 적용한 값(edit). 편집 중 받은 상대 값은 내 변경으로 치지 않는다.
  // 새로 만드는 키(그 달만·이후 달)는 그때 물려받던 기본값을 dep로 남겨, 보내기 전 기본값이 바뀌었으면 비교한다
  const snap = bud.snap || {}, base = {}, edit = {}, dep = {};
  const fromSnap = core.budgetApply(snap, bud.ym, field, r.value, scope, { by: S.me || '', at: Date.now() });
  const tplBefore = lim => Object.keys(snap).filter(k => k.startsWith('bt:') && core.validYm(k.slice(3)) && k.slice(3) <= lim && snap[k]).sort().pop();
  Object.keys(patch).forEach(k => {
    if (!/^b[mt]:/.test(k)) return;
    base[k] = k in snap ? snap[k] : null;
    if (fromSnap.ok && k in fromSnap.patch) edit[k] = { from: k in snap ? snap[k] : null, to: fromSnap.patch[k] };
    if (!(k in snap)) { const src = k.startsWith('bm:') ? tplBefore(k.slice(3)) : tplBefore(core.addMonths(k.slice(3), -1)); if (src) dep[k] = { key: src, value: snap[src] }; }
  });
  if (!store.setPrefs(patch, { base, edit, dep })) return fail('저장하지 못했어요. 입력은 그대로 두었어요');
  openBudget(); savedToast('예산을 저장했어요');
}
// 처음 한 번: 기존 주기 예산을 조용히 월 예산으로 바꾸지 않는다(spec 6.2). 비교를 보여 주고 고르게 한다
function budgetChooseHtml(bs) {
  const lp = core.legacyProposal(bs.legacy, catMap()), c = cycleRange(0), now = core.monthRange(0);
  return `<div class="sheet-wrap">${sheetHead('생활 예산')}
    <div class="sheet-b"><p class="lead-hint">예산 기준을 달력 월(1일~말일)로 바꿀 수 있어요. 어떻게 할까요?</p>${budgetServerNote()}
      <section class="card bud-opt"><b>기존 주기 예산 유지</b><small class="num">매월 ${S.settings.cycle_start_day}일 ~ 다음 달 ${S.settings.cycle_start_day - 1 || '말'}일 · 지금 ${md(c.start)} ~ ${md(c.end)}</small><p class="num">${lp.total ? won(lp.total) + '원' : '전체 미설정'} · 분류 ${Object.keys(bs.legacy.cats || {}).length}개</p></section>
      <section class="card bud-opt"><b>월 예산 시작 (제안)</b><small class="num">${now.year}년 ${now.month}월부터 · 1일~말일 · 대분류 8개</small>
        <p class="num">${lp.total ? won(lp.total) + '원' : '전체 미설정'}${Object.keys(lp.cats).length ? ' · ' + Object.entries(lp.cats).slice(0, 3).map(([id, n]) => core.majorLabel(id) + ' ' + man(n)).join(' · ') + (Object.keys(lp.cats).length > 3 ? ' 외' : '') : ''}</p>
        ${lp.unassigned.length ? `<small>연결이 확정되지 않은 ${lp.unassigned.map(u => esc(u.name)).join('·')}는 미배정으로 남겨요</small>` : ''}${lp.over ? '<small class="over-t">분류 합계가 전체보다 커서 대분류는 옮기지 않아요(전체 금액을 자동으로 늘리지 않음)</small>' : ''}</section>
      <p class="hint">어느 쪽을 골라도 기존 예산 원본은 그대로 보관해요. 같은 기간에 두 예산을 더하지 않아요.</p></div>
    <div class="sheet-footer two"><button type="button" class="btn ghost" data-act="blegacykeep">기존 주기 예산 유지</button><button type="button" class="btn" data-act="bmonthstart">월 예산 시작</button></div></div>`;
}
function budgetLegacyHtml(bs, archived) {
  const L = bs.legacy, c = cycleRange(0), spent = netOf(core.scopeTxs(liveTxs(), { range: c })), rest = (L.total || 0) - spent;
  const cats = Object.entries(L.cats || {}).filter(([, v]) => v > 0);
  return `<div class="sheet-wrap">${sheetHead(archived ? '이전 주기 예산' : '생활 예산 (기존 주기)', archived ? 'budget' : '')}
    <div class="sheet-b"><p class="hint">${archived ? '전환 시점에 보관한 기존 설정이에요. 예산 변경 이력이 서버에 없어 지난 주기마다 실제로 쓰던 금액과 다를 수 있어요.' : `카드 집계 주기 기준(매월 ${S.settings.cycle_start_day}일 시작)이에요. 지금 주기 ${fd(c.start)} ~ ${fd(c.end)}.`}</p>
      <section class="card bud-total"><p class="bt-lab">한 주기 전체 예산</p><p class="bt-amt num">${L.total ? won(L.total) + '원' : '미설정'}</p>
        ${archived || !L.total ? '' : `<div class="bt-foot"><span>쓴 돈 <span class="num">${won(spent)}원</span></span><b class="num${rest < 0 ? ' over-t' : ''}">${rest < 0 ? won(-rest) + '원 초과' : won(rest) + '원 남음'}</b></div>`}
        ${cats.length ? `<p class="bt-src">분류 예산 ${cats.slice(0, 4).map(([k, v]) => esc(k) + ' ' + man(v)).join(' · ')}${cats.length > 4 ? ' 외 ' + (cats.length - 4) + '개' : ''}</p>` : ''}</section>
      ${archived ? '<p class="notice-soft">월 예산으로 금액을 나눠 옮기지 않아요. 달마다 예산을 따로 정하고, 기존 주기 예산은 그대로 보관해요.</p>' : ''}</div>
    <div class="sheet-footer${archived ? '' : ' two'}">${archived ? '<button type="button" class="btn" data-act="budget">월 예산으로 돌아가기</button>' : '<button type="button" class="btn ghost" data-act="blegacyedit">기존 예산 수정</button><button type="button" class="btn" data-act="bmonthstart">월 예산 시작</button>'}</div></div>`;
}
function startMonthBudget() {
  if (store.serverState() !== 'new') { toast(store.serverState() === 'old' ? '월 예산은 서버 업데이트 뒤에 시작할 수 있어요 · 설정 → 앱·연결' : '서버를 확인하는 중이에요. 연결된 뒤 다시 눌러 주세요'); return; }
  const bs = budgetState(), lp = bs.legacy ? core.legacyProposal(bs.legacy, catMap()) : { total: 0, cats: {}, over: false }, ym = core.monthRange(0).ym;
  const patch = { budget_basis: 'month' };
  if (!core.hasMonthBudget(bs.p) && (lp.total || Object.keys(lp.cats).length)) patch['bt:' + ym] = { total: lp.total, cats: lp.over ? {} : lp.cats, rev: 1, by: S.me || '', at: Date.now(), origin: 'legacy' };
  if (!store.setPrefs(patch)) { toast('저장하지 못했어요. 다시 눌러 주세요'); return; }
  bud = { ym, field: '' }; openBudget(); savedToast('월 예산을 시작했어요 · 기존 주기 예산은 보관했어요');
}
// 기존 주기 예산 유지를 고른 경우의 수정(v24 형식: 한 주기 전체 + 분류별). 값은 prefs.budget 그대로
function openLegacyBudgetForm() {
  const b = (store.prefs() || {}).budget || { total: 0, cats: {} }, cats = S.settings.categories;
  showSheet(`<form data-form="budget-legacy" class="sheet-wrap" novalidate>${sheetHead('기존 주기 예산 수정', 'budget')}
    <div class="sheet-b"><p class="hint">한 주기(매월 ${S.settings.cycle_start_day}일 시작) 기준이에요. 비워 두면 그 예산은 쓰지 않아요.</p>
      <div class="field"><label for="b-total">한 주기 전체 예산</label><div class="amount-in"><input id="b-total" name="total" data-money inputmode="numeric" autocomplete="off" placeholder="미설정" value="${b.total ? won(b.total) : ''}" class="num"><span>원</span></div><p class="amount-echo num" aria-live="polite"></p></div>
      <div class="card">${cats.map((c, i) => `<label class="budget-cat" for="bc${i}"><span>${categoryIcon(c)}${esc(c)}</span><span class="budget-in"><input id="bc${i}" name="cat:${esc(c)}" data-money inputmode="numeric" autocomplete="off" placeholder="-" value="${b.cats && b.cats[c] ? won(b.cats[c]) : ''}" class="num"><span>원</span></span></label>`).join('')}</div>
    </div>
    <div class="sheet-footer"><div class="err" id="budget-err" role="alert"></div><button class="btn save" type="submit">저장</button></div></form>`, true);
}
function saveLegacyBudget(f) {
  const fd2 = new FormData(f); let bad = '';
  const num = (v, label) => { const r = core.parseBudgetWon(v); if (r.ok) return r.value; bad = bad || `${label}: ${WON_ERR[r.error]}`; return 0; };
  const cats = {}, total = num(fd2.get('total'), '한 주기 전체 예산');
  for (const [k, v] of fd2.entries()) if (k.startsWith('cat:')) { const n = num(v, k.slice(4)); if (n > 0) cats[k.slice(4)] = n; }
  if (bad) { $('#budget-err').textContent = bad; return; }
  if (!store.setPrefs({ budget: { total, cats } })) { $('#budget-err').textContent = '저장하지 못했어요. 다시 눌러 주세요'; return; }
  openBudget(); savedToast('예산을 저장했어요');
}

/* ---------------- 예산 충돌: 상대가 먼저 고쳤어요 (spec 6.3, Astra P0-02) ----------------
 * 내 값은 충돌 기록(store.conflicts)에 그대로 남아 있다(초안 보존). 항목마다 내 값/상대 값을 고르면 상대 값을 기준으로 다시 저장 */
// 항목마다 '내가 고친 값'과 '상대가 바꾼 값' 중 하나를 직접 고른다(기본 선택 없음). 고치기 전 값도 함께. 여러 항목이면 2개/쪽(Astra v25 P0-02)
let cfState = { key: '', shown: CF_STEP, picks: {} };
const cfAmt = n => n ? won(n) + '원' : '미설정';
function openConflict(key, keep) {
  const all = store.conflicts();
  const c = all[key]; if (!c) { const k = Object.keys(all)[0]; if (k) return openConflict(k); if ($('#sheet [data-conflict]')) $('#sheet').close(); return; }
  if (!keep || cfState.key !== key) cfState = { key, shown: CF_STEP, picks: {} };
  const ym = key.slice(3), r = core.monthOf(ym), what = key.startsWith('bt:') ? `${r.year}년 ${r.month}월부터 이후 기본값` : `${r.year}년 ${r.month}월 예산`;
  const others = Object.keys(all).length - 1, who = c.theirs && c.theirs.by ? '(' + esc(c.theirs.by) + ')' : '';
  const merged = store.merge3(c.base, c.mine, c.theirs).value, sum = Object.values(merged.cats || {}).reduce((a, n) => a + (Number(n) || 0), 0);
  const tOver = store.overBy(c.theirs), srvOld = store.serverState() !== 'new';
  const depNote = c.dep ? (() => { const d = core.monthOf(c.dep.slice(3)); return `<p class="hint">이 달 예산을 새로 정하는 사이 ${d.year}년 ${d.month}월부터 쓰던 기본값이 바뀌었어요. '상대가 바꾼 값'은 바뀐 기본값이에요.</p>`; })() : '';
  // 상대 값 자체가 합계를 넘는 경우(Fable P2-3), 서버가 다시 옛 버전이 된 경우(Fable P2-5)도 알린다
  const extra = depNote + (tOver ? `<p class="hint over-t">상대가 저장한 값도 대분류 합계가 전체 예산보다 ${won(tOver)}원 커요. 고른 뒤 합계를 다시 확인해요.</p>` : '')
    + (srvOld ? `<p class="notice-soft warn">서버가 옛 버전이라 지금은 고른 값을 저장할 수 없어요. 내 값은 이 기기에 남아 있어요.</p>` : '');
  const lead0 = c.reason === 'race'
    ? `<p class="hint cf-lead">${esc(what)}을 두 기기가 거의 동시에 여러 번 저장했어요${who}. 항목마다 하나를 골라 주세요.</p>`
    : c.reason === 'over'
    ? `<p class="hint cf-lead">${esc(what)}의 다른 항목을 다른 기기에서 먼저 바꿨어요${who}. 두 사람 것을 합치면 대분류 합계 <b class="num">${won(sum)}원</b> / 전체 <b class="num">${cfAmt(Number(merged.total) || 0)}</b> · <b class="num">${won(c.over || Math.max(0, sum - (Number(merged.total) || 0)))}원 초과</b>라 자동으로 합치지 않았어요. 항목마다 하나를 골라 주세요.</p>`
    : `<p class="hint cf-lead">${esc(what)}의 같은 항목을 다른 기기에서 먼저 바꿨어요${who}. 항목마다 하나를 골라 주세요. 다른 항목은 두 사람 것을 합쳤어요.</p>`;
  const lead = lead0 + extra;
  const shown = Math.min(c.fields.length, cfState.shown);
  const done = c.fields.filter(f => cfState.picks[f]).length;
  sheetPaint(`<div class="sheet-wrap" data-conflict="${esc(key)}">${sheetHead('상대가 먼저 고쳤어요')}
    <div class="sheet-b">${lead}
      ${c.fields.slice(0, shown).map(f => `<fieldset class="card cf-row"><legend class="lab">${esc(fieldName(f))} <span class="h2sub num">고치기 전 ${cfAmt(fieldVal(c.base, f))}</span></legend>
        <label class="radio-row"><input type="radio" name="cf:${esc(f)}" value="mine" data-act="cfpick" data-v="${esc(f)}|mine" ${cfState.picks[f] === 'mine' ? 'checked' : ''}><span>내가 고친 값 <b class="num">${cfAmt(fieldVal(c.mine, f))}</b></span></label>
        <label class="radio-row"><input type="radio" name="cf:${esc(f)}" value="theirs" data-act="cfpick" data-v="${esc(f)}|theirs" ${cfState.picks[f] === 'theirs' ? 'checked' : ''}><span>상대가 바꾼 값 <b class="num">${cfAmt(fieldVal(c.theirs, f))}</b></span></label></fieldset>`).join('')}
      ${moreBtn('cfmore', shown, c.fields.length, '개', CF_STEP, '비교 항목 더 보기')}
      <p class="hint cf-progress" id="cf-progress">고른 항목 <span class="num">${done}/${c.fields.length}</span>${others ? ` · 확인할 예산 ${others}건 더 있어요` : ''} · 내 입력은 고를 때까지 이 기기에 남아요</p>
      <div class="err" id="cf-err" role="alert"></div></div>
    <div class="sheet-footer two"><button type="button" class="btn ghost" data-act="cfkeep">상대 값 그대로</button><button type="button" class="btn" data-act="cfsave">고른 값으로 저장</button></div></div>`, keep, true);
}
const fieldName = f => f === 'total' ? '전체 예산' : f.startsWith('cats.') ? core.majorLabel(f.slice(5)) + ' 예산' : f;
const fieldVal = (v, f) => { if (!v) return 0; if (f === 'total') return Number(v.total) || 0; return Number((v.cats || {})[f.slice(5)]) || 0; };
function saveConflict(keepTheirs) {
  const el = $('#sheet [data-conflict]'), key = el ? el.dataset.conflict : ''; const c = store.conflicts()[key]; if (!c) return;
  const err = m => { const e = $('#cf-err'); if (e) e.textContent = m; };
  if (keepTheirs) { if (!store.resolveConflict(key)) return err('기기에 저장하지 못했어요. 내 값은 그대로 남아 있어요'); }
  else {
    const left = c.fields.filter(f => !cfState.picks[f]);
    if (left.length) { const i = c.fields.indexOf(left[left.length - 1]); if (i >= cfState.shown) { cfState.shown = Math.ceil((i + 1) / CF_STEP) * CF_STEP; openConflict(key, true); } /* 고르지 않은 항목은 모두 보이게 펼친다 */ const fs = $(`#sheet [name="cf:${CSS.escape(left[0])}"]`); if (fs) fs.closest('fieldset').scrollIntoView({ block: 'nearest' }); return err(`아직 고르지 않은 항목이 ${left.length}개 있어요: ${left.map(fieldName).join(', ')}`); }
    const v = JSON.parse(JSON.stringify(store.merge3(c.base, c.mine, c.theirs).value)); v.cats = v.cats || {};
    c.fields.forEach(f => { const n = fieldVal(cfState.picks[f] === 'mine' ? c.mine : c.theirs, f);
      if (f === 'total') v.total = n; else if (n) v.cats[f.slice(5)] = n; else delete v.cats[f.slice(5)]; });
    const chk = core.budgetCheck({ total: Number(v.total) || 0, cats: v.cats });
    if (!chk.ok) return err(`고른 값으로는 대분류 합계 ${won(chk.allocated)}원 / 전체 ${won(Number(v.total) || 0)}원 · ${won(chk.short)}원 초과예요. 다른 쪽을 골라 주세요`);
    v.by = S.me || ''; v.at = Date.now();
    if (!store.resolveConflict(key, v)) return err('저장하지 못했어요. 내 값은 그대로 남아 있어요');
  }
  cfState = { key: '', shown: CF_STEP, picks: {} };
  const next = Object.keys(store.conflicts())[0];
  if (next) openConflict(next); else { $('#sheet').close(); savedToast(keepTheirs ? '상대 값을 그대로 뒀어요' : '고른 값으로 저장했어요'); }
}
// 연결 해제 전 고르지 않은 예산(Astra v25 P0-03): 해제를 막고 비교로 안내. 버리기는 대상·금액을 보여 주고 따로 확인
function openDisconnectGuard() {
  const all = store.conflicts(), ks = Object.keys(all);
  const line = k => { const c = all[k], r = core.monthOf(k.slice(3)); return `${r.year}년 ${r.month}월${k.startsWith('bt:') ? '부터' : ''} · ${c.fields.map(f => fieldName(f) + ' ' + cfAmt(fieldVal(c.mine, f))).join(', ')}`; };
  showSheet(`<div class="sheet-wrap">${sheetHead('고르지 않은 예산이 있어요')}
    <div class="sheet-b"><p class="hint">연결을 해제하면 이 기기에만 있는 내 예산 입력이 사라져요. 먼저 비교해 골라 주세요.</p>
      <div class="card list-card">${ks.map(k => `<button class="settings-row" data-act="cfopen" data-v="${esc(k)}"><span><b>내가 고친 값</b><small class="num">${esc(line(k))}</small></span>${icon('right')}</button>`).join('')}</div></div>
    <div class="sheet-footer two"><button type="button" class="btn ghost danger-t" data-act="discdrop">내 값 버리고 해제</button><button type="button" class="btn" data-act="cfopen">비교하고 고르기</button></div></div>`, true);
}
function dropAndDisconnect() {
  const all = store.conflicts(), ks = Object.keys(all);
  const what = ks.map(k => { const c = all[k], r = core.monthOf(k.slice(3)); return `${r.month}월 ` + c.fields.map(f => fieldName(f) + ' ' + cfAmt(fieldVal(c.mine, f))).join(', '); }).join(' / ');
  if (!confirm(`내가 고친 예산(${what})을 버리고 연결을 해제할까요? 되돌릴 수 없어요.`)) return;
  if (store.disconnect({ discardConflicts: true })) { $('#sheet').close(); } else toast('공유 대기 중인 기록·설정이 있어요. 먼저 공유해 주세요');
}

/* ---------------- 대분류 연결 (spec 7.2, v26): 확인 필요 → 연결됨을 이어서, 합쳐서 8개 + 더 보기(확인 필요 먼저). 두 제목·건수는 늘 보임 ---------------- */
let mapShown = MGR_STEP, mapSel = null;
function openMapping(keep) {
  if (!store.prefs()) { toast('서버 업데이트가 필요해요 (Apps Script 새 버전)'); return; }
  if (!keep) mapShown = MGR_STEP;
  const q = core.mappingQueue(liveTxs(), catMap(), S.settings.categories), rv = q.filter(x => x.review), dn = q.filter(x => !x.review);
  const nr = Math.min(rv.length, mapShown), nd = Math.min(dn.length, Math.max(0, mapShown - rv.length));
  const row = x => `<button class="settings-row" data-act="mapitem" data-v="${esc(x.name)}"><span><b>${esc(x.name)}</b><small><span class="num">${x.count}건 · ${won(x.net)}원</span> · ${x.review ? (x.newOnly ? '새 기록만 ' + core.majorLabel(x.hint) + ' · 지난 기록 확인 필요' : '기타로 집계 중' + (x.hint ? ' · ' + core.majorLabel(x.hint) + ' 제안' : '')) : '→ ' + core.majorLabel(x.id) + (x.source === 'table' ? ' (기본)' : '')}</small></span>${icon('right')}</button>`;
  sheetPaint(`<div class="sheet-wrap">${sheetHead('대분류 연결')}
    <div class="sheet-b"><p class="hint">예산과 분류 필터는 8개 대분류로만 봐요. 기존 분류 이름과 원본 기록은 그대로 남겨요.</p>
      <section class="map-sec" aria-labelledby="map-rh"><h3 class="sub-h" id="map-rh">확인 필요 <span class="num h2sub">${rv.length}개</span></h3>
        <div class="card list-card" data-ui-key="map-review">${rv.slice(0, nr).map(row).join('') || '<p class="empty">확인이 필요한 분류가 없어요.</p>'}</div></section>
      <section class="map-sec" aria-labelledby="map-dh"><h3 class="sub-h" id="map-dh">연결됨 <span class="num h2sub">${dn.length}개</span></h3>
        <div class="card list-card" data-ui-key="map-list">${dn.slice(0, nd).map(row).join('') || (dn.length ? `<p class="hint">확인 필요를 먼저 보여 드려요. 더 보기로 이어서 볼 수 있어요.</p>` : '<p class="empty">연결된 분류가 없어요.</p>')}</div></section>
      ${moreBtn('mapmore', nr + nd, q.length, '개', MGR_STEP)}</div></div>`, keep, true);
}
function openMapItem(name, pick) {
  const q = core.mappingQueue(liveTxs(), catMap(), S.settings.categories), x = q.find(i => i.name === name); if (!x) { openMapping(); return; }
  mapSel = { name, id: pick || (x.review ? x.hint || '' : x.id) };
  const none = name === '미분류', past = liveTxs().filter(t => (t.category || '미분류') === name), pastNet = netOf(past);
  showSheet(`<div class="sheet-wrap">${sheetHead(esc(name), 'mapping')}
    <div class="sheet-b"><p class="hint num">${x.count}건 · 합계 ${won(x.net)}원${x.examples.length ? '<br>예: ' + x.examples.map(t => `${md(t.date)} ${esc(t.merchant || t.category || '기록')} ${won(t.amount)}원`).join(' · ') : ''}</p>
      ${none ? '<p class="notice-soft">분류가 없는 기록은 이름으로 묶을 수 없어요. 기록을 열어 대분류를 골라 주세요. 그 전까지는 기타로 집계해요.</p>' : `<span class="lab">대분류</span><div class="cat-sheet" role="group" aria-label="대분류">${core.MAJORS.map(m => `<button type="button" class="mchip" data-act="mappick" data-v="${m.id}" aria-pressed="${mapSel.id === m.id}">${m.label}</button>`).join('')}</div>
      ${x.hint && x.review ? `<p class="hint">${core.majorLabel(x.hint)} 제안이에요. 고른 뒤 저장해야 연결돼요.</p>` : ''}
      <fieldset class="field bud-scope"><legend class="lab">적용 범위</legend>
        <label class="radio-row"><input type="radio" name="mscope" value="new"><span>새 기록만</span></label>
        <label class="radio-row"><input type="radio" name="mscope" value="all" checked><span>과거 ${past.length}건도 적용 · 합계 <span class="num">${won(pastNet)}원</span></span></label>
        <p class="hint">기록의 분류 이름은 바꾸지 않아요. 건별로 다른 대분류가 필요하면 그 기록에서 대분류를 고르면 그 선택이 우선해요.</p></fieldset>
      <div class="err" id="map-err" role="alert"></div>`}</div>
    ${none ? '' : `<div class="sheet-footer${x.source === 'map' || x.newOnly ? ' two' : ''}">${x.source === 'map' || x.newOnly ? '<button type="button" class="btn ghost" data-act="mapclear">연결 해제</button>' : ''}<button type="button" class="btn" data-act="mapsave">연결 저장</button></div>`}</div>`, true);
}
function saveMapItem(clear) {
  const name = mapSel && mapSel.name; if (!name) return;
  const scope = ($('#sheet [name=mscope]:checked') || {}).value || 'all', map = Object.assign({}, catMap());
  if (clear) delete map[name];
  else { if (!core.MAJOR_IDS.includes(mapSel.id)) { $('#map-err').textContent = '대분류를 골라 주세요'; return; } map[name] = scope === 'new' ? { m: mapSel.id, since: Date.now() } : mapSel.id; }
  if (!store.setPrefs({ cat_map: map, cat_map_rev: (Number((store.prefs() || {}).cat_map_rev) || 0) + 1 })) { const e = $('#map-err'); if (e) e.textContent = '저장하지 못했어요'; return; }
  openMapping(); savedToast(clear ? `${name} 연결을 풀었어요` : `${name} → ${core.majorLabel(mapSel.id)}로 연결했어요`);
}

/* ---------------- 공유 상태 시트(상태 줄·설정): 대기 상세 · 자동 재시도 · 저장 보호 ---------------- */
function syncSummary() {
  const n = store.pendingDetail(), st = store.status(), off = navigator.onLine === false;
  // '오늘'은 실제 오늘에만, 다른 날은 'M월 D일'(Astra P1-11·Fable P2-5). 오프라인을 공유 중보다 먼저 본다
  const ls = st.lastSync ? new Date(st.lastSync) : null, tm = ls ? ls.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }) : '';
  const when = ls ? (ymd(ls) === today() ? '오늘 ' : (ls.getFullYear() !== new Date().getFullYear() ? ls.getFullYear() + '년 ' : '') + (ls.getMonth() + 1) + '월 ' + ls.getDate() + '일 ') + tm : '';
  const txt = off ? `오프라인 · 공유 대기 ${n.total}건` : st.syncing ? `공유 중 · 남은 ${n.total}건` : st.error ? `공유하지 못했어요 · 대기 ${n.total}건` : n.total ? `이 기기에 저장 · 공유 대기 ${n.total}건${n.conflicts ? ` · 예산 선택 ${n.conflicts}건` : ''}` : n.conflicts ? `전송 대기 0건 · 선택이 필요한 예산 ${n.conflicts}건` : when ? `공유 완료 · ${when}` : '아직 공유 기록이 없어요';
  return { n, st, off, when, txt, warn: off || !!st.error || n.total > 0 || n.conflicts > 0, err: !!st.error && !off };
}
function persistText() {
  const p = S.persist && S.persist.state;
  return p === 'granted' ? '켜짐 · 브라우저가 저장 공간이 부족해도 이 앱의 기록을 지우지 않아요'
    : p === 'denied' ? '브라우저가 허락하지 않았어요 · 공유 대기 건이 있으면 앱 데이터를 지우지 마세요'
    : p === 'unsupported' ? '이 브라우저는 저장 보호 요청을 지원하지 않아요' : p === 'error' ? '요청하지 못했어요 · 다음에 앱을 열 때 다시 요청해요' : '요청 전이에요';
}
function openAppSheet() {
  showSheet(`<div class="sheet-wrap">${sheetHead('앱 업데이트·설치')}
    <div class="sheet-b"><div class="card list-card"><button class="settings-row" data-act="update"><span><b>최신 버전 받기</b><small id="ver">${esc(verText())}</small></span>${icon('right')}</button></div>
      <p class="hint"><b>홈 화면에 추가</b> · Safari 공유 버튼 → 홈 화면에 추가. 홈 화면 앱은 Safari와 저장공간이 따로라, 처음 열 때 설정 코드를 한 번 더 넣어야 해요. 기록은 업데이트해도 그대로 남아요.</p></div></div>`, true);
}
function openDisplaySheet() {
  const theme = S.theme || 'system';
  showSheet(`<div class="sheet-wrap">${sheetHead('화면·입력')}
    <div class="sheet-b"><span class="lab">화면 모드 <span class="h2sub">이 기기에만</span></span>
      <div class="seg seg3 theme-seg" role="group" aria-label="화면 모드" data-ui-key="theme">${[['system', '기기 설정', 'gear'], ['light', '라이트', 'sun'], ['dark', '다크', 'moon']].map(([k, l, ic]) => `<button data-act="theme" data-v="${k}" aria-pressed="${theme === k}">${icon(ic)}<span>${l}</span></button>`).join('')}</div>
      <label class="toggle kp-toggle" for="kp-on"><span>기록 금액 입력 방식: 화면 숫자 키패드<small>끄면 휴대폰 숫자 키보드 · 기록 화면의 금액 칸에만 적용 · 기록 화면에서도 바꿀 수 있어요</small></span><input type="checkbox" id="kp-on" data-act="kptoggle" ${useKeypad() ? 'checked' : ''}></label></div></div>`, true);
}
function openSyncSheet() {
  const s = syncSummary(), next = s.st.retryAt ? new Date(s.st.retryAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
  showSheet(`<div class="sheet-wrap">${sheetHead('공유 상태')}
    <div class="sheet-b"><div class="notice-soft${s.warn ? ' warn' : ''}" data-ui-key="sync-box"><b>${esc(s.txt)}</b><p>${s.n.total ? `기록 ${s.n.tx}건${s.n.settings ? ' + 설정 변경 ' + s.n.settings + '건' : ''} · 이 기기에 안전하게 저장돼 있어요. 아직 상대방에게는 보이지 않아요.` : '보낼 기록·설정이 없어요(전송 대기 0건).'}</p>
      ${s.n.conflicts ? `<button class="link cf-link" data-act="cfopen">선택이 필요한 예산 ${s.n.conflicts}건 · 내 값과 상대 값 비교${icon('right')}</button>` : ''}
      ${s.st.error ? `<p class="err-t">${esc(s.st.error)}</p>` : ''}${next && s.n.total ? `<p>자동으로 다시 보내요 · 다음 ${next}${s.st.retryN > 1 ? ` (${s.st.retryN}번째)` : ''}</p>` : ''}</div>
      <p class="hint">마지막 공유 ${s.when || '없음'}. 앱이 열려 있는 동안 실패하면 30초 → 1분 → 2분 … 간격으로 다시 보내요.</p>
      <p class="hint"><b>기기 저장 보호</b> · ${esc(persistText())}</p></div>
    <div class="sheet-footer"><button type="button" class="btn" data-act="syncnow" ${s.off ? 'disabled' : ''}>${s.off ? '연결되면 다시 공유해요' : '지금 다시 공유'}</button></div></div>`, true);
}

/* ---------------- 선택일 전체 기록 시트(v26): 날짜·합계 → 기록 8건, 이후 8건씩 이어 붙임 ---------------- */
function openDaySheet(day, keep) {
  if (!keep) dayShown = DAY_STEP;
  const d = listData(), sel = d.txs.filter(t => t.date === day).sort(byNewest), dt = parseDate(day), shown = Math.min(sel.length, dayShown);
  const m = sel.length ? calMetric(sel) : null, future = day > today();
  sheetPaint(`<div class="sheet-wrap">${sheetHead(`${dt.getMonth() + 1}월 ${dt.getDate()}일 ${KDAY[dt.getDay()]}`)}
    <div class="sheet-b" data-day="${day}"><p class="day-sum">${m ? `${m.label} <b class="num">${won(m.v)}원</b> · ${sel.length}건` : '이 날짜에는 기록이 없어요'}</p>
      ${sel.length ? `<div class="card list-card sel-rows" data-ui-key="day-rows">${sel.slice(0, shown).map(t => txRow(t, true)).join('')}</div>` : ''}${moreBtn('daymore', shown, sel.length, '건', DAY_STEP)}</div>
    ${future ? '' : `<div class="sheet-footer"><button type="button" class="btn ghost" data-act="caladd" data-v="${day}">${icon('plus')}<span>이 날짜에 기록</span></button></div>`}</div>`, keep, true);
}

/* ---------------- 차트: 막대(기간별·주별·일별) · 누적 흐름 ---------------- */
function barChart(periods, title) {
  const vals = periods.map(p => p.v), n = periods.length;
  const W = 340, H = 168, L = 42, R = 8, T = 20, B = 24, ymax = niceMax(Math.max(1, ...vals));
  const band = (W - L - R) / n, bw = Math.min(24, band * 0.6), y = v => T + (1 - Math.max(0, v) / ymax) * (H - T - B), every = n > 8 ? 2 : 1;
  const bars = vals.map((v, i) => {
    const cx = L + band * (i + .5), top = y(v), base = y(0), h = Math.max(0, base - top), rr = Math.min(4, h);
    const d = h <= 0 ? '' : `M${cx - bw / 2} ${base}V${top + rr}Q${cx - bw / 2} ${top} ${cx - bw / 2 + rr} ${top}H${cx + bw / 2 - rr}Q${cx + bw / 2} ${top} ${cx + bw / 2} ${top + rr}V${base}Z`;
    return `<path d="${d}" class="col${periods[i].sel ? ' sel' : ''}${periods[i].run ? ' run' : ''}"/>${(n - 1 - i) % every === 0 ? `<text x="${cx}" y="${H - 6}" class="axis" text-anchor="middle">${esc(periods[i].x)}</text>` : ''}${periods[i].sel && h > 0 ? `<text x="${cx}" y="${top - 5}" class="val" text-anchor="middle">${man(v)}</text>` : ''}`;
  }).join('');
  const pts = periods.map((p, i) => ({ x: L + band * (i + .5), label: p.title + (p.run ? ' (진행 중)' : ''), a: vals[i] }));
  const done = periods.filter(p => p.end < today()), avg = done.length ? done.reduce((s, p) => s + p.v, 0) / done.length : 0;
  anTable = { title, cols: ['기간', '순지출'], rows: periods.map(p => [p.title + (p.run ? ' (진행 중)' : ''), won(p.v) + '원']) };
  return `<div class="card chart-card" data-ui-key="an-chart"><p class="chart-t">${esc(title)} · ${esc(mjLabel(curMajor()))}</p>
    <div class="chart" data-pts='${esc(JSON.stringify(pts))}' data-w="${W}" data-bar="1">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}, ${n}개 기간, 평균 ${won(Math.round(avg))}원">
      <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--soft)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--accent)" stroke-width="3"/></pattern></defs>
      ${[0, ymax / 2, ymax].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${man(v)}</text>`).join('')}${bars}
    </svg><div class="tip" role="status"></div></div>
    <p class="hint">${done.length ? `끝난 ${done.length}개 기간 평균 ${won(Math.round(avg))}원` : '비교할 지난 기간이 아직 없어요'} · 진행 중은 빗금</p>
    <button type="button" class="link" data-act="antable">정확한 기간과 금액 표 보기${icon('right')}</button></div>`;
}
let anTable = null;
function openAnTable() {
  if (!anTable) return;
  showSheet(`<div class="sheet-wrap">${sheetHead(esc(anTable.title))}<div class="sheet-b"><table class="an-table"><thead><tr>${anTable.cols.map((c, i) => `<th scope="col"${i ? ' class="num"' : ''}>${esc(c)}</th>`).join('')}</tr></thead><tbody>${anTable.rows.map(r => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`, true);
}
/* 누적 지출: 이번 기간 vs 지난 기간(같은 날짜 차수끼리) */
function paceChart(r, pr, txs, prevTxs, upto, names) {
  const N = dayDiff(r.start, r.end) + 1, M = dayDiff(pr.start, pr.end) + 1, D = Math.max(N, M);
  const cum = (list, start, len) => { const daily = Array(len).fill(0); list.forEach(t => { const i = dayDiff(start, t.date); if (i >= 0 && i < len) daily[i] += signed(t); }); let s = 0; return daily.map(v => (s += v)); };
  const cur = cum(txs, r.start, N).slice(0, upto), prev = prevTxs.length ? cum(prevTxs, pr.start, M) : [];
  const W = 340, H = 168, L = 42, R = 12, T = 14, B = 24, ymax = niceMax(Math.max(1, ...cur, ...prev));
  const x = i => L + (D === 1 ? 0 : i / (D - 1) * (W - L - R)), y = v => T + (1 - Math.max(0, v) / ymax) * (H - T - B);
  const path = arr => arr.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(''), last = cur.length - 1;
  const pts = Array.from({ length: D }, (_, i) => ({ x: x(i), label: `${i + 1}일째 (${md(addDays(r.start, i))})`, a: cur[i], b: prev[i] }));
  anTable = { title: '누적 지출 흐름', cols: ['날짜', names[0], ...(prev.length ? [names[1]] : [])], rows: pts.map(p => [p.label, p.a != null ? won(p.a) + '원' : '-', ...(prev.length ? [p.b != null ? won(p.b) + '원' : '-'] : [])]) };
  return `<div class="card chart-card" data-ui-key="an-chart"><p class="chart-t">누적 지출 흐름 · ${esc(mjLabel(curMajor()))}</p>
    <div class="legend"><span><i class="key" style="background:var(--accent)"></i>${names[0]}</span>${prev.length ? `<span><i class="key" style="background:var(--prev)"></i>${names[1]}</span>` : ''}</div>
    <div class="chart" data-pts='${esc(JSON.stringify(pts))}' data-w="${W}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${names[0]} 누적 ${won(cur[last] || 0)}원${prev.length ? ', ' + names[1] + ' 최종 ' + won(prev[prev.length - 1]) + '원' : ''}">
      ${[0, ymax / 2, ymax].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${man(v)}</text>`).join('')}
      <text x="${L}" y="${H - 6}" class="axis">1일</text><text x="${W - R}" y="${H - 6}" class="axis" text-anchor="end">${D}일</text>
      ${prev.length ? `<path d="${path(prev)}" class="ln prev"/>` : ''}
      ${cur.length ? `<path d="${path(cur)}L${x(last)} ${y(0)}L${x(0)} ${y(0)}Z" class="area"/><path d="${path(cur)}" class="ln cur"/><circle cx="${x(last)}" cy="${y(cur[last])}" r="4.5" class="dot"/>` : ''}
      <line class="xh" y1="${T}" y2="${H - B}" x1="-10" x2="-10"/>
    </svg><div class="tip" role="status"></div></div>
    <p class="hint">기간 첫날(${md(r.start)})부터 같은 날짜끼리 비교해요.</p>
    <button type="button" class="link" data-act="antable">정확한 날짜별 금액 표 보기${icon('right')}</button></div>`;
}

function txRow(t, noDate) {
  const cls = t.type === 'refund' ? 'ref' : t.type === 'transfer' ? 'ex' : '';
  const d = parseDate(t.date);
  const name = t.merchant || t.category || '기록한 지출';
  const said = t.type === 'refund' ? `환불 ${won(t.amount)}원, 순지출에서 빠져요` : t.type === 'transfer' ? `지출 제외 ${won(t.amount)}원` : `지출 ${won(t.amount)}원`;
  return `<div class="swipe" data-id="${esc(t.id)}"><button class="swipe-del" data-act="askdel" data-v="${esc(t.id)}" tabindex="-1" aria-label="${esc(name)} 삭제">삭제</button><button class="tx${cls ? ' is-' + cls : ''}" data-act="edit" data-v="${esc(t.id)}" aria-label="${esc(name)}, ${said}, ${d.getMonth() + 1}월 ${d.getDate()}일 ${esc(t.category || '미분류')} ${esc(t.payer || '결제자 미지정')}${t.payer ? ' 결제' : ''}${t.method ? ' ' + esc(t.method) : ''}${t.refund_pending ? ', 환불 대기' : ''}. 눌러서 고치기">
    <span class="ic" aria-hidden="true">${categoryIcon(t.category)}</span>
    <span class="mid"><span class="m">${esc(t.merchant || t.category || '기록한 지출')}</span>
      <span class="meta">${noDate ? '' : `${d.getMonth() + 1}.${d.getDate()} · `}${esc(t.category || '미분류')} · ${esc(t.payer || '미지정')}${t.method ? ' · ' + esc(t.method) : ''}
      ${t.refund_pending ? '<span class="tag">환불 대기</span>' : ''}${t.type === 'transfer' ? '<span class="tag q">지출 제외</span>' : ''}${t.created_by === '정기' ? '<span class="tag q">정기</span>' : ''}${store.isPending(t.id) ? '<span class="tag q">공유 대기</span>' : ''}</span></span>
    <span class="a num ${cls}">${t.type === 'refund' ? '<span class="a-kind">환불</span> +' : ''}${wonWbr(t.amount)}</span></button></div>`;
}

// 앱을 켜 둔 채 새 주기로 넘어가도 보던 기간을 그대로(offset을 새 오늘로 재해석하지 않음, Astra P1-06). '다가오는 결제로'·'오늘'에서만 새 주기
let shownCycle = null;
function anchorOffset() {
  syncAutoOffset();
  if (shownCycle && shownCycle.off === offset && cycleRange(offset).start !== shownCycle.start) {
    for (let k = 0; k >= -120; k--) if (cycleRange(k).start === shownCycle.start) { offset = k; break; }
  }
  shownCycle = { off: offset, start: cycleRange(offset).start };
}
// 내역에 적용 중인 추가 조건(세부 분류·결제자·결제수단·금액·종류) 칩: 조건이 있을 때만(대분류·기간은 위의 칩·기간 줄)
function lfToolbar() {
  const kindName = KINDS.find(k => k[0] === lf.kind)[1];
  const chips = [['cats', lf.cats.length === 1 ? lf.cats[0] : '세부 분류 ' + lf.cats.length, lf.cats.length], ['payers', lf.payers.length === 1 ? lf.payers[0] + ' 결제' : '결제자 ' + lf.payers.length, lf.payers.length],
    ['methods', lf.methods.length === 1 ? lf.methods[0] : '결제수단 ' + lf.methods.length, lf.methods.length], ['amount', amtLabel(lf), lf.min || lf.max], ['kind', kindName, lf.kind !== 'all']].filter(c => c[2]);
  const mchip = lf.merchant ? `<button class="chip" data-act="lfmerchx" aria-pressed="true" aria-label="거래처 ${esc(lf.merchant)} 조건 지우기"><span>거래처 ${esc(lf.merchant)}</span>${icon('x')}</button>` : '';
  if (!chips.length && !mchip && !lf.q.trim() && lf.period === 'cycle') return '';
  return `<div class="filter-toolbar" data-ui-key="lf-toolbar"><div class="filters" role="group" aria-label="추가 조건">${chips.map(([k, label]) => `<button class="chip" data-act="lfopen" data-v="${k}" aria-pressed="true"><span>${esc(label)}</span>${icon('down')}</button>`).join('')}${mchip}</div><button class="link lf-reset" data-act="lfclear">조건 지우기</button></div>`;
}
const LIST_TABS = [['rows', '목록'], ['cal', '달력'], ['payer', '결제자']];
const wide = () => matchMedia('(width >= 840px)').matches;
function listView() {
  anchorOffset(); anchorMonth();
  const mode = view.list === 'cal' && lf.period !== 'cycle' ? 'rows' : view.list;
  const d = listData(), all = d.txs, s = core.summarize(all), nAct = lfActive(lf);
  const chipN = lf.cats.length + lf.payers.length + lf.methods.length + (lf.min || lf.max ? 1 : 0) + (lf.kind !== 'all' ? 1 : 0) + (lf.period !== 'cycle' ? 1 : 0);
  const tools = `<div class="list-tools" data-ui-key="list-tools">${tabsU('lmode', LIST_TABS, mode, '내역 보기', 'lmode')}
    <div class="lt-acts"><button class="icon-btn lt-an" data-act="analysis" aria-label="분석 보기">${icon('chart')}</button><button class="icon-btn" data-act="listmenu" aria-label="가져오기·내보내기">${icon('upload')}</button>
    <button class="icon-btn${chipN ? ' has-n' : ''}" data-act="lfopen" data-v="period" aria-label="기간·분류·결제자·금액 필터${chipN ? `, 조건 ${chipN}개 적용 중` : ''}">${icon('filter')}${chipN ? `<span class="n-badge num" aria-hidden="true">${chipN}</span>` : ''}</button></div></div>`;
  const head = `<h1 class="sr-only">내역</h1>${viewSeg()}${mode === 'cal' ? '' : periodNav({ locked: lf.period !== 'cycle', key: 'list-cycle' })}${catChips()}${lfToolbar()}${tools}`;
  if (mode === 'payer') return `<div class="list-side" data-ui-key="list-side">${head}</div><div class="list-main" data-ui-key="list-main">${payerBlock(all)}</div>`;
  if (mode === 'cal') {
    const r = curPeriod();
    if (!calDay || calDay < r.start || calDay > r.end) calDay = calDefault(r);
    calPicked[r.start] = calDay;
    const filtered = chipN > 0 || !!lf.q.trim() || curMajor() !== 'all';
    return `<div class="list-side cal-mode" data-ui-key="list-side">${head}${lf.q ? searchRow() : ''}${calendar(r, all, filtered, s)}</div>
      <div class="list-main" data-ui-key="list-main">${calSelection(all, filtered)}</div>`;
  }
  const [sumName, sumVal] = lf.kind === 'refund' ? ['환불 합계', s.refund] : lf.kind === 'transfer' ? ['지출 제외 합계', s.transfer] : ['순지출', s.net];
  const shown = Math.min(all.length, listShown);
  const label = nAct ? '결과' : lf.period !== 'cycle' ? (lf.period === 'all' ? '전체 기간' : '지정 기간') : mjLabel(curMajor());
  return `<div class="list-side" data-ui-key="list-side">${head}${searchRow()}
    <div class="results-sticky" data-ui-key="lf-sum"><div class="rs-main" role="group" aria-label="결과 ${s.count}건, ${sumName} ${won(sumVal)}원">
      <span class="rs-n">${esc(label)} · <b class="num">${s.count}</b>건 · ${sumName}</span><span class="rs-v"><b class="num">${won(sumVal)}원</b></span></div></div>
    <p class="sum-line" id="sum-line" data-ui-key="sum-line"><span>지출 <span class="num">${won(s.expense)}원</span></span><span>환불 <span class="num">${won(s.refund)}원</span></span><span>지출 제외 <span class="num">${won(s.transfer)}원</span></span><small class="sum-note">이체·카드대금은 ‘지출 제외’로 기록해요. 순지출에는 더하지 않아요.</small></p></div>
    <div class="list-main" data-ui-key="list-main">${all.length ? `<div class="card list-card rows-card" data-ui-key="rows">${all.slice(0, shown).map(t => txRow(t)).join('')}</div>${moreBtn('lmore', shown, all.length, '건', LIST_STEP)}`
      : `<div class="card empty-card"><div class="empty">${nAct || curMajor() !== 'all' ? '<b>이 조건의 기록이 없어요</b><br>검색어나 필터를 바꿔 보세요.' : '<b>이 기간에는 기록이 없어요</b><br>이전 기간을 보거나 새 기록을 남겨 보세요.'}</div>${nAct ? '<button class="btn ghost" data-act="lfclear">조건 지우기</button>' : curMajor() !== 'all' ? '<button class="btn ghost" data-act="pcat" data-v="all">필터 초기화</button>' : ''}</div>`}</div>`;
}
const searchRow = () => `<div class="search-row" data-ui-key="search-row"><div class="search-box"><input class="in search" type="search" placeholder="사용처 검색" value="${esc(lf.q)}" data-input="q" aria-label="기록 검색: 거래처·분류·메모로 찾을 수 있어요" enterkeyhint="search">
      ${lf.q ? `<button class="search-x" data-act="qclear" aria-label="검색어 지우기">${icon('x')}</button>` : ''}</div><button class="btn-sm search-go" data-act="qgo">찾기</button></div>`;
function listMenu() {
  showSheet(`<div class="sheet-wrap">${sheetHead('가져오기·내보내기')}
    <div class="sheet-b menu-list">
      <button type="button" class="menu-item" data-act="impopen" data-v="paste">${icon('paste')}<span><b>카드 알림 붙여넣기</b><span class="muted">문자·앱 알림 여러 건을 한 번에</span></span></button>
      <button type="button" class="menu-item" data-act="impopen" data-v="file">${icon('file')}<span><b>파일로 빠진 기록 찾기</b><span class="muted">카드 이용내역·다른 가계부 CSV·엑셀</span></span></button>
      <button type="button" class="menu-item" data-act="csv">${icon('ledger')}<span><b>CSV로 내보내기</b><span class="muted">전체 기록을 파일로</span></span></button>
    </div></div>`, true);
}
// 달력: 보던 기간(달력 월 또는 카드 이용 기간)을 일~토 연속 격자로. 칸 = 그날 순지출(약식), 선택한 날은 아래에 정확한 합계·건수와 '보기'(그날 기록은 시트)
// 기간 이동은 달력 머리에 한 벌(화살표·라벨), 좌우로 밀어도 같은 경로(changeCalendarCycle). 기간마다 마지막 선택일을 기억
let calDay = '', calAnim = '';
const calPicked = {};
function calDefault(r) { const td = today(); return calPicked[r.start] && calPicked[r.start] >= r.start && calPicked[r.start] <= r.end ? calPicked[r.start] : td >= r.start && td <= r.end ? td : r.end; }
function changeCalendarCycle(delta) {
  if (delta > 0 && curOff() >= 0) { calLive(pv() === 'month' ? '지금이 이번 달이에요' : '지금이 마지막 주기예요'); toast(pv() === 'month' ? '다음 달은 아직 오지 않았어요' : '다음 주기는 아직 오지 않았어요'); return; }
  movePeriod(delta);
  const r = curPeriod(); calDay = calDefault(r); calAnim = 'fade'; render();
  calLive(`${calTitle(r)} ${md(r.start)}부터 ${md(r.end)}까지, ${listData().txs.length}건. ${md(calDay)} 선택`);
}
function calLive(msg) { let el = document.getElementById('cal-live'); if (!el) { el = document.createElement('p'); el.id = 'cal-live'; el.className = 'sr-only'; el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); } el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 30); }
const calTitle = r => r.kind === 'month' ? r.year + '년 ' + r.month + '월' : r.off === 0 ? '이번 카드 주기' : r.off === -1 ? '지난 카드 주기' : r.year + '년 카드 주기';
const calAmt = n => core.shortWon(n);
const KDAY = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
function calMetric(list) {
  const s = core.summarize(list);
  if (lf.kind === 'refund') return { v: s.refund, refund: true, label: '환불 합계', short: '+' + calAmt(s.refund), said: `환불 ${won(s.refund)}원` };
  if (lf.kind === 'transfer') return { v: s.transfer, label: '지출 제외 합계', short: calAmt(s.transfer), said: `지출 제외 ${won(s.transfer)}원` };
  const n = s.net;
  return { v: Math.abs(n), refund: n < 0, label: n < 0 ? '순환불' : '순지출', short: n < 0 ? '+' + calAmt(n) : n === 0 ? '0원' : calAmt(n),
    said: `${n < 0 ? '순환불 ' + won(-n) : '순지출 ' + won(n)}원${s.refund || s.transfer ? ` (지출 ${won(s.expense)}원, 환불 ${won(s.refund)}원${s.transfer ? `, 지출 제외 ${won(s.transfer)}원` : ''})` : ''}` };
}
function zeroDaysOf(r, txs) { const has = new Set(txs.map(t => t.date)), end = today() < r.end ? today() : r.end; let n = 0; for (let d = r.start; d <= end; d = addDays(d, 1)) if (!has.has(d)) n++; return n; }
const calLegend = () => lf.kind === 'refund' ? '환불 합계' : lf.kind === 'transfer' ? '지출 제외 합계' : '순지출 · <span class="refund-t">+</span>는 순환불';
function calendar(r, txs, filtered, s) {
  const td = today(), byDay = {};
  txs.forEach(t => { (byDay[t.date] = byDay[t.date] || []).push(t); });
  const first = parseDate(r.start), cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push('<span class="cal-c pad" aria-hidden="true"></span>');
  for (let d = r.start; d <= r.end; d = addDays(d, 1)) {
    const dt = parseDate(d), list = byDay[d] || [], has = list.length > 0, future = d > td, m = has ? calMetric(list) : null;
    const mark = d === r.start || d === r.end || dt.getDate() === 1;
    const label = mark ? `<span class="cal-mo">${dt.getMonth() + 1}/</span>${dt.getDate()}` : dt.getDate();
    const said = has ? `${m.said}, ${list.length}건` : filtered ? '선택 조건에 맞는 기록 없음' : future ? '아직 오지 않은 날' : '기록 없음';
    const name = `${dt.getFullYear()}년 ${dt.getMonth() + 1}월 ${dt.getDate()}일 ${KDAY[dt.getDay()]}${d === r.start ? ', 기간 시작' : d === r.end ? ', 기간 끝' : ''}${d === td ? ', 오늘' : ''}${d === calDay ? ', 선택됨' : ''}, ${said}`;
    const z = !has && !future && !filtered ? '<span class="cal-z" aria-hidden="true">·</span>' : '';
    cells.push(`<button class="cal-c${future ? ' fut' : ''}${d === td ? ' today' : ''}${d === calDay ? ' sel' : ''}${dt.getDay() === 0 ? ' sun' : ''}${dt.getDate() === 1 && d !== r.start ? ' m1' : ''}" data-act="calday" data-v="${d}" aria-pressed="${d === calDay}"${d === td ? ' aria-current="date"' : ''} aria-label="${name}">
      <span class="cal-d">${label}</span>${has ? `<span class="cal-a num${m.refund ? ' is-refund' : ''}" aria-hidden="true">${m.short}</span>` : z}</button>`);
  }
  const anim = calAnim; calAnim = '';
  const onToday = curOff() === 0 && calDay === td;
  return `<div class="card cal" data-ui-key="calendar">${periodNav({ cal: true })}
    <div class="cal-swipe${anim ? ' cal-in' : ''}">
    <div class="cal-g cal-w" aria-hidden="true">${WEEK.map(w => `<span>${w}</span>`).join('')}</div>
    <div class="cal-g">${cells.join('')}</div></div>
    <div class="cal-foot"><p class="cal-legend">${filtered ? '선택 조건 · ' : ''}${calLegend()} · 금액은 약식${!filtered ? ` · 기록 없는 날 <span class="num">${zeroDaysOf(r, txs)}</span>일` : ''}</p>${onToday ? '' : '<button class="link cal-today" data-act="caltoday">오늘</button>'}</div>
    <p class="cal-total num" data-ui-key="cal-total">${esc(mjLabel(curMajor()))} · ${s.count}건 · 순지출 ${won(s.net)}원</p></div>`;
}
function calSelection(txs, filtered) {
  const day = calDay, sel = txs.filter(t => t.date === day).sort(byNewest), s = core.summarize(sel), d = parseDate(day), td = today(), future = day > td;
  const rel = day === td ? ' · 오늘' : day === addDays(td, -1) ? ' · 어제' : '';
  const m = sel.length ? calMetric(sel) : null;
  const none = filtered ? '선택 조건에 맞는 기록 없음 · 0건' : future ? '아직 오지 않은 날이에요' : '기록 없음';
  const cta = future ? `<button class="cal-add" data-act="tab" data-v="recur" aria-label="정기에서 예정 확인">${icon('repeat')}<span>정기 확인</span></button>`
    : `<button class="cal-add" data-act="caladd" data-v="${day}" aria-label="선택한 날짜 ${d.getMonth() + 1}월 ${d.getDate()}일에 기록">${icon('plus')}<span>기록</span></button>`;
  const showRows = sel.length > 0; // v26: 폭과 관계없이 선택일 기록 4건을 바로(별도 '보기' 단계 없음), 더 있으면 전체 시트
  const head = `<div class="cal-sel" data-ui-key="calsel" id="calsel" tabindex="-1">
      <div class="cal-sel-top"><div class="cal-sel-l"><p class="cal-sel-t" id="calsel-t">${d.getMonth() + 1}월 ${d.getDate()}일 ${KDAY[d.getDay()]}${rel}</p>
      <p class="cal-sel-v">${m ? `${m.label} <b class="num">${won(m.v)}원</b> <span class="cal-sel-n">${sel.length}건</span>` : `<span class="cal-sel-n">${none}</span>`}</p></div>
      <div class="cal-sel-acts">${cta}</div></div>
      ${future && sel.length ? '<p class="cal-sel-sub">미래 날짜로 적힌 기록이에요. 날짜가 맞는지 눌러서 확인해 주세요.</p>' : ''}</div>`;
  const parts = sel.length && (s.refund || s.transfer) ? `<p class="cal-sel-sub sel-parts">지출 <span class="num">${won(s.expense)}원</span> · 환불 <span class="num">${won(s.refund)}원</span>${s.transfer ? ` · 지출 제외 <span class="num">${won(s.transfer)}원</span>` : ''}</p>` : '';
  return `<section class="card sel-card" data-ui-key="selcard" aria-labelledby="calsel-t">${head}${parts}${showRows ? `<div class="list-card sel-rows" data-ui-key="calrows">${sel.slice(0, 4).map(t => txRow(t, true)).join('')}</div>` : ''}${sel.length > 4 ? `<button type="button" class="list-more" data-act="dayview" data-v="${day}" aria-haspopup="dialog" data-ui-key="day-more"><span>이 날 기록 모두 보기</span><span class="num lm-n">4 / ${sel.length}건</span>${icon('right')}</button>` : ''}</section>`;
}

/* ---------------- 설정 (v26): 우리 장부 → 기록 관리 → 앱·연결을 섹션 제목으로 이어서(탭 없음), 진입 13줄 안팎 ----------------
 * 카드 결제일·결제수단·집계 주기는 '카드 설정' 한 진입, 알림·파일 가져오기는 '기록 가져오기' 한 진입. 설정값 자체는 그대로 */
function settingsView() {
  const st = S.settings, cp = cardPrefs(), s = syncSummary(), bs = budgetState();
  const row = (act, title, sub, v, right) => `<button class="settings-row" data-act="${act}"${v ? ` data-v="${v}"` : ''}><span><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span>${right ? `<span class="sr-right num">${right}</span>` : ''}${icon('right')}</button>`;
  const theme = S.theme || 'system', review = core.majorTotals(liveTxs(), catMap()).review;
  const bm = core.budgetFor(bs.p, core.monthRange(0).ym);
  const sec = (id, title, body) => `<section class="set-sec" data-ui-key="set-${id}" aria-labelledby="set-h-${id}"><h2 class="set-h" id="set-h-${id}">${title}</h2>${body}</section>`;
  const book = `<div class="card list-card" data-ui-key="set-book-list">
      ${row('budget', '예산 보기·수정', bs.basis === 'month' ? `매월 1일~말일 · 대분류 8개` : bs.basis === 'choose' ? '기존 주기 예산 · 월 예산으로 바꿀 수 있어요' : `기존 주기 예산 · 매월 ${st.cycle_start_day}일 시작`, '', bs.basis === 'month' && bm.total ? man(bm.total) + '원' : '')}
      ${row('cardsettings', '카드 설정', `${store.prefs() ? (cp.payDay ? `결제일 매월 ${cp.payDay}일` : '결제일 미설정') + ' · ' : ''}이용 기간 매월 ${st.cycle_start_day}일 시작 · ${esc(cardLabel())}`)}
      ${row('mapping', '대분류 연결', review ? `확인이 필요한 기록 ${review}건` : '거래처·세부 분류를 8개로 묶어요')}
      <div class="settings-row static me-row"><span><b>이 기기 사용자</b><small>새 기록의 결제자 기본값</small></span>
        <div class="seg seg2 me-seg" role="group" aria-label="이 기기 사용자">${USERS.map(u => `<button data-act="me" data-v="${u}" aria-pressed="${S.me === u}">${u}</button>`).join('')}</div></div></div>
    <p class="hint">예산·분류·카드 설정은 두 사람에게 같이 적용돼요. 보기와 필터는 이 기기에만 기억해요.</p>`;
  const manage = `<div class="card list-card" data-ui-key="set-records">
      ${row('setlists', '분류·결제수단·결제자', `분류 ${st.categories.length}개 · 결제수단 ${st.methods.length}개 · 결제자 ${payerList().length}명`)}
      ${row('favmanage', '즐겨찾기', store.prefs() ? '두 사람이 같이 써요' : '서버 업데이트가 필요해요', '', store.prefs() ? favorites().length + '개' : '')}
      ${row('listmenu', '기록 가져오기', '카드 알림 붙여넣기 · 카드 이용내역·다른 가계부 파일')}
      ${row('csv', 'CSV로 내보내기', '전체 기록을 파일로', '', 'CSV')}</div>`;
  const app = `<div class="card list-card" data-ui-key="set-app">
      <button class="settings-row" data-act="syncsheet"><span><b>공유 상태·저장 보호</b><small class="${s.err ? 'err-t' : ''}">${esc(s.txt)}</small></span>${icon('right')}</button>
      <button class="settings-row" data-act="appsheet"><span><b>앱 업데이트·홈 화면에 추가</b><small id="ver">${esc(verText())}</small></span>${icon('right')}</button>
      <button class="settings-row" data-act="displaysheet"><span><b>화면·입력</b><small>${{ system: '기기 설정', light: '라이트', dark: '다크' }[theme]} · 숫자 입력 ${useKeypad() ? '화면 키패드' : '휴대폰 키보드'}</small></span>${icon('right')}</button>
      ${row('setcode', '설정 코드 바꾸기', '이 기기의 기록과 공유 대기 건은 그대로 남아요')}
      <button class="settings-row danger-row" data-act="disconnect"><span><b>이 기기 연결 해제</b><small>공유 대기 중인 기록·설정이나 고르지 않은 예산이 있으면 먼저 정리해요</small></span></button></div>`;
  return `<div class="page-title"><div class="pt-l"><h1>설정</h1></div></div>
    ${sec('book', '우리 장부', book)}${sec('manage', '기록 관리', manage)}${sec('app', '앱·연결', app)}
    <p class="fine-print">사이 · 카드값과 딱 맞는 부부 장부 · 기록 원본은 내 구글 시트</p>`;
}
// 카드 설정 한 진입(v26): 결제일·결제수단 / 이용 기간 시작일(카드 집계 주기). 실제 편집은 기존 시트 그대로
function openCardSettings() {
  const st = S.settings, cp = cardPrefs(), r = cycleRange(0), pay = cp.payDay ? core.billCycle(st.cycle_start_day, cp.payDay, new Date()).payDate : '';
  showSheet(`<div class="sheet-wrap">${sheetHead('카드 설정')}
    <div class="sheet-b"><p class="hint">모든 카드가 같은 이용 기간·결제일을 쓰는 기존 카드 묶음이에요. 카드마다 다른 결제일은 아직 지원하지 않아요.</p>
      <div class="card list-card"><button class="settings-row" data-act="setpay"><span><b>카드 결제일·결제수단</b><small>${store.prefs() ? cp.payDay ? `매월 ${cp.payDay}일 · 다음 ${longDate(pay)} · ${esc(cardLabel())}` : '정하면 결제일과 남은 날이 보여요' : '서버 업데이트가 필요해요'}</small></span>${icon('right')}</button>
        <button class="settings-row" data-act="setcycle"><span><b>카드 집계 주기</b><small>이용 기간 매월 ${st.cycle_start_day}일 시작 · 지금 ${md(r.start)}~${md(r.end)}</small></span>${icon('right')}</button></div></div></div>`, true);
}

function openCycleSheet() {
  const st = S.settings;
  showSheet(`<form data-form="settings" class="sheet-wrap" novalidate>${sheetHead('카드 집계 주기')}
    <div class="sheet-b"><div class="field"><label for="sd">이용 기간 시작일 (카드 집계 주기)</label>
      <select id="sd" class="in" name="cycle_start_day">${Array.from({ length: 31 }, (_, i) => i + 1).map(d => `<option value="${d}" ${Number(st.cycle_start_day) === d ? 'selected' : ''}>매월 ${d}일</option>`).join('')}</select>
      <p class="hint">카드 명세서의 ‘이용 기간’ 첫날이에요(예: 전월 11일 ~ 당월 10일이면 11일). 카드값이 빠져나가는 날은 설정 → 카드 결제일에서 따로 정해요. 29~31일을 고르면 그날이 없는 달은 말일부터 시작해요. 두 사람에게 같이 적용돼요.</p></div></div>
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
// from(포함)부터 그 규칙이 아직 기록되지 않은 첫 날짜(없으면 '')
function nextFrom(r, from) {
  const d = parseDate(r.start > from ? r.start : from);
  for (let i = 0; i < 400; i++, d.setDate(d.getDate() + 1)) {
    const hit = r.freq === 'week' ? d.getDay() === r.day : d.getDate() === Math.min(r.day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate());
    const s = ymd(d);
    if (r.end && s > r.end) return '';
    if (hit && !store.get('rec-' + r.id + '-' + s.replace(/-/g, ''))) return s; // 이미 기록된 날은 건너뜀
  }
  return '';
}
const nextDate = r => nextFrom(r, today());
// 그 범위에서(오늘 이후만) 아직 기록되지 않은 예정 건
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
/* 정기 (v26): 달 선택 → 요약 → 앞으로 예정 3건 → 이 달 기록됨 3건 → 꺼진 규칙 2개. 각 구역 제목에 전체 건수, 넘치면 제목 줄 '전체 보기' → 그 구역 전체 시트(8건 + 더 보기).
 * spec v26의 4·4·2는 규칙 행(스위치 때문에 금액이 아래 줄, 약 105px)으로 390×844 상한 760px를 넘어 spec 4절대로 행 수를 3·3·2로 줄였다(글자·간격은 그대로).
 * 지난 달은 실제 기록을 먼저 보여 주고 예정은 없다고 알린다 */
let rmoff = 0, ruleMgrShown = MGR_STEP, recurAll = { kind: '', shown: RECUR_ALL_STEP };
// 규칙 관리: 모든 규칙(켜짐·꺼짐) 8개 + 더 보기, 눌러서 고치기
function openRuleManage(keep) {
  if (!keep) ruleMgrShown = MGR_STEP;
  const list = rules() || [], shown = Math.min(list.length, ruleMgrShown);
  sheetPaint(`<div class="sheet-wrap">${sheetHead('정기 규칙 관리')}
    <div class="sheet-b"><p class="hint">정해진 날 기록을 한 번 만드는 예약이에요. 바꾼 내용은 이후 예정부터 적용되고 지난 기록은 그대로예요. 금액이 달라지면 그 기록만 고치면 되고, 지운 기록은 다시 만들지 않아요.</p>
      <div class="card list-card" data-ui-key="rule-list">${list.slice(0, shown).map(x => `<button class="settings-row" data-act="rule" data-v="${esc(x.id)}"><span><b>${esc(x.name)}</b><small>${ruleWhen(x)} · <span class="num">${won(x.amount)}원</span> · ${x.active ? '켜짐' : '꺼짐'}</small></span>${icon('right')}</button>`).join('') || '<p class="empty">등록한 규칙이 없어요.</p>'}</div>
      ${moreBtn('rmmore', shown, list.length, '개', MGR_STEP)}</div>
    <div class="sheet-footer"><button type="button" class="btn" data-act="rule">정기 지출 추가</button></div></div>`, keep, true);
}
function recurData() {
  const list = rules() || [], r = core.monthRange(rmoff, new Date()), td = today(), past = r.end < td;
  const up = past ? [] : upcomingIn(r), done = liveTxs().filter(t => inRange(t, r) && (t.created_by === '정기' || /^rec-/.test(t.id))).sort(byNewest);
  const off = list.filter(x => !x.active), from = r.start > td ? r.start : td;
  return { list, r, td, past, up, done, off, from, upRows: up.map(u => Object.assign({}, u.rule, { _date: u.date })) };
}
function ruleRowHtml(x, from) {
  const nx = x._date || (x.active ? nextFrom(x, from) : ''), nd = nx ? parseDate(nx) : null;
  return `<div class="rule${x.active ? '' : ' off'}"><button class="tx" data-act="rule" data-v="${esc(x.id)}" aria-label="${esc(x.name)} ${won(x.amount)}원, ${ruleWhen(x)}, ${esc(x.payer || '-')} 결제${x.active ? (nx ? ', 다음 ' + (nd.getMonth() + 1) + '월 ' + nd.getDate() + '일' : ', 종료') : ', 자동 기록 꺼짐'}. 눌러서 고치기">
      <span class="ic datebadge" aria-hidden="true">${nd ? `<small>${nd.getMonth() + 1}월</small><b class="num">${nd.getDate()}</b>` : `<small>${x.active ? '종료' : '꺼짐'}</small>${categoryIcon(x.category)}`}</span>
      <span class="mid"><span class="m">${esc(x.name)}</span><span class="meta">${esc(x.payer || '-')} · ${ruleWhen(x)}${x.active ? '' : ' · <b class="off-t">자동 기록 꺼짐</b>'}</span></span>
      <span class="a num">${wonWbr(x.amount)}</span></button>
      <label class="rule-sw"><input type="checkbox" data-act="rtoggle" data-v="${esc(x.id)}" ${x.active ? 'checked' : ''} aria-label="${esc(x.name)} 자동 기록"><span class="sw-t">${x.active ? '켜짐' : '꺼짐'}</span></label></div>`;
}
const RECUR_KIND = { up: ['앞으로 예정', 3, '건'], done: ['이 달 기록됨', 3, '건'], off: ['꺼진 규칙', 2, '개'] };
function recurSection(k, d) {
  const [title0, n, unit] = RECUR_KIND[k], items = k === 'up' ? d.upRows : k === 'done' ? d.done : d.off;
  const title = k === 'done' ? (rmoff === 0 ? '이 달 기록됨' : d.r.month + '월 기록됨') : k === 'up' && rmoff !== 0 ? d.r.month + '월 예정' : title0;
  const empty = k === 'done' ? '이 달에 기록된 정기 지출이 없어요.' : k === 'off' ? '꺼 둔 정기 지출이 없어요.' : !d.list.length ? '등록한 정기 지출이 없어요.' : d.past ? '지난 달은 예정 대신 위의 실제 기록을 봐요.' : '이 달에 남은 예정이 없어요.';
  const rows = items.slice(0, n);
  return `<section class="recur-sec" data-ui-key="recur-${k}" aria-labelledby="rh-${k}"><div class="section-head"><h2 id="rh-${k}">${title} <span class="h2sub num">${items.length}${unit}</span></h2>${items.length > n ? `<button type="button" class="link" data-act="recurall" data-v="${k}" aria-haspopup="dialog" aria-label="${title} 전체 ${items.length}${unit} 보기">전체 보기${icon('right')}</button>` : ''}</div>
    ${rows.length ? `<div class="${k === 'done' ? 'card list-card' : 'rules-list'}" data-ui-key="rules-${k}">${k === 'done' ? rows.map(t => txRow(t)).join('') : rows.map(x => ruleRowHtml(x, d.from)).join('')}</div>` : `<div class="card"><div class="empty">${empty}</div>${k === 'up' && !d.list.length ? '<button class="btn" data-act="rule">정기 지출 추가</button>' : ''}</div>`}
</section>`;
}
// 구역 전체 시트: 처음 8건, 더 보기로 8건씩
function openRecurAll(kind, keep) {
  if (!keep || recurAll.kind !== kind) recurAll = { kind, shown: RECUR_ALL_STEP };
  const d = recurData(), [title0, , unit] = RECUR_KIND[kind], items = kind === 'up' ? d.upRows : kind === 'done' ? d.done : d.off, shown = Math.min(items.length, recurAll.shown);
  sheetPaint(`<div class="sheet-wrap">${sheetHead(`${d.r.year}년 ${d.r.month}월 · ${title0}`)}
    <div class="sheet-b"><p class="hint num">전체 ${items.length}${unit}</p>
      <div class="${kind === 'done' ? 'card list-card' : 'rules-list'} recur-all" data-ui-key="recur-all">${kind === 'done' ? items.slice(0, shown).map(t => txRow(t)).join('') : items.slice(0, shown).map(x => ruleRowHtml(x, d.from)).join('')}</div>
      ${moreBtn('recurmore', shown, items.length, unit, RECUR_ALL_STEP)}</div></div>`, keep, true);
}
function recurView() {
  const list = rules();
  if (!list) return `<div class="page-title"><div class="pt-l"><h1>정기 지출</h1></div></div>
    <div class="card"><div class="empty">서버 업데이트가 필요해요.<br>구글 시트의 Apps Script를 새 버전으로 바꾸면 쓸 수 있어요.</div></div>`;
  const d = recurData(), r = d.r;
  // 요약: 지금·다음 달은 남은 예정 합계, 지난 달은 실제로 기록된 정기 지출 합계
  const sumUp = d.up.reduce((a, u) => a + u.rule.amount, 0), total = d.past ? netOf(d.done) : sumUp;
  const eyebrow = d.past ? r.month + '월에 기록된 정기 지출' : rmoff === 0 ? '이 달, 앞으로 나갈 돈' : r.month + '월에 나갈 돈';
  const note = d.past ? `${d.done.length}건 · 지난 달이라 예정은 없어요. 정해진 날 자동으로 남은 기록이에요.` : `예정 ${d.up.length}건${d.up.length ? ' · 다음 ' + md(d.up[0].date) : ''} · 실제 지출에는 아직 넣지 않았어요.`;
  const order = d.past ? ['done', 'off'] : ['up', 'done', 'off'];
  return `<div class="page-title"><div class="pt-l"><h1>정기 지출</h1></div><div class="pt-actions"><button class="link" data-act="rulemanage">규칙 관리 ${list.length}개</button><button class="icon-btn" data-act="rule" aria-label="정기 지출 추가">${icon('plus')}</button></div></div>
    <div class="recur-side" data-ui-key="recur-side">
    <div class="period-nav" data-ui-key="recur-nav"><button class="pn-btn" data-act="recmon" data-v="-1" aria-label="이전 달" ${rmoff <= -24 ? 'disabled' : ''}>${icon('left')}</button>
      <div class="period-lbl static"><b><span>${r.year}년 ${r.month}월</span></b><small class="num">${fd(r.start)} ~ ${fd(r.end)}</small></div>
      <button class="pn-btn" data-act="recmon" data-v="1" aria-label="다음 달" ${rmoff >= 12 ? 'disabled' : ''}>${icon('right')}</button></div>
    <section class="card rules-summary" data-ui-key="rules-sum"><p class="eyebrow">${eyebrow}</p>${amt(total)}<p class="rs-note">${note}</p></section></div>
    <div class="recur-main" data-ui-key="recur-main">${order.map(k => recurSection(k, d)).join('')}</div>`;
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
        <div class="amount-in"><input id="r-amount" name="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(d.amountText != null ? d.amountText : d.amount ? won(d.amount) : '')}" class="num" style="--len:${Math.max(6, d.amount ? won(d.amount).length : 0)}"${d.amountErr && d.amountErr !== 'empty' ? ' data-raw="1"' : ''}><span>원</span></div>
        <p class="amount-echo num" aria-live="polite">${d.amount >= 10000 ? koWon(d.amount) : ''}</p>
        <div class="err" id="rule-err" role="alert"></div></div>
      <div class="field"><label for="r-cat">${hasMajorCol() ? '세부 분류' : '분류'}</label><input id="r-cat" name="category" class="in" list="r-cats" autocomplete="off" placeholder="예: 대출, 통신비, 보험" value="${esc(d.category)}">
        <datalist id="r-cats">${[...new Set(['대출', '통신비', '보험', '구독', ...st.categories])].map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <p class="hint">새 분류를 적으면 분류 목록에도 추가돼요.</p></div>
      ${hasMajorCol() ? `<div class="field"><label for="r-major">대분류</label><select id="r-major" name="major" class="in"><option value="">세부 분류의 연결을 따름</option>${core.MAJORS.map(m => `<option value="${m.id}" ${d.major === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
        <p class="hint">이 규칙으로 만드는 기록의 대분류예요. 이미 만든 기록은 그대로예요.</p></div>` : ''}
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
  const ar = core.parseWon(fd.get('amount')); d.amount = ar.ok ? ar.value : 0; d.amountErr = ar.ok ? '' : ar.error; d.amountText = String(fd.get('amount') || '');
  d.category = String(fd.get('category') || '').trim();
  if (fd.has('major')) d.major = core.MAJOR_IDS.includes(fd.get('major')) ? fd.get('major') : ''; // 서버가 옛 버전이면 칸이 없고 값도 그대로
  d.day = Number(fd.get('day')); d.payer = fd.get('payer'); d.method = fd.get('method');
  d.start = fd.get('start') || today(); d.end = fd.get('end') || '';
}
function saveRule(f) {
  readRule(f);
  const d = ruleDraft;
  const err = m => { $('#rule-err').textContent = m; };
  if (!d.name) return err('이름을 입력해 주세요');
  if (d.amountErr) return err(WON_ERR[d.amountErr]);
  delete d.amountErr; delete d.amountText;
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
  if ($('#sheet[open] [data-ui-key=recur-all]')) openRecurAll(recurAll.kind, true); // 구역 전체 시트에서 켜고 끈 경우 그 자리에서 다시 그림
}
function deleteRule() {
  if (!confirm('이 정기 지출을 삭제할까요? 이미 기록된 지출은 남아요.')) return;
  const id = ruleDraft.id;
  if (!putRules((rules() || []).filter(r => r.id !== id))) { $('#rule-err').textContent = '기기에 저장하지 못했어요'; return; }
  $('#sheet').close();
  toast('삭제했어요');
}

/* ---------------- 입력 시트 ---------------- */
let draft = null, saved = false, editing = false, editBase = '';
// 수정 중 닫기 보호(Astra E01): 원본과 지금 입력을 비교
const editKey = d => JSON.stringify([d.amountText != null ? d.amountText : won(d.amount), d.merchant, d.date, d.payer, d.method, d.note, !!d.refund_pending, d.type, d.category || '', d.major || '']);
function editDirty() {
  if (!editing || !draft || saved) return false;
  const f = $('[data-form=entry]'); if (!f) return false;
  readEntry(f); return editKey(draft) !== editBase;
}
function askDiscard(onDiscard) {
  const dlg = $('#confirm'), back = document.activeElement;
  dlg.setAttribute('aria-labelledby', 'confirm-title');
  dlg.innerHTML = `<div class="confirm-box" tabindex="-1" autofocus><b id="confirm-title">수정한 내용이 있어요</b><p>닫으면 고친 내용이 사라져요.</p>
    <div class="confirm-btns"><button type="button" value="keep" class="btn">계속 수정</button><button type="button" value="drop" class="btn ghost">수정 버리기</button></div></div>`;
  dlg.querySelector('[value=keep]').onclick = () => { dlg.close(); const a = back && back.isConnected && $('#sheet').contains(back) ? back : $('#amount'); if (a) a.focus(); };
  dlg.querySelector('[value=drop]').onclick = () => { dlg.close(); onDiscard(); };
  dlg.oncancel = null;
  dlg.showModal();
}
function closeSheet() { if (!stashDraft()) return false; parkImport(); $('#sheet').close(); return true; }
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
function openEntry(id, ctx) {
  // 선택일에서 새로 기록하려는데 다른 날짜·결제자의 작성 중 기록이 있으면 섞지 않고 고르게 함(Astra P1-01)
  if (!id && ctx && ctx.date && !ctx.decided && S.draft && S.draft.created_by === S.me && (S.draft.date !== ctx.date || S.draft.payer !== S.me)) {
    const dr = S.draft, dlg = $('#confirm');
    const what = [dr.date ? md(dr.date) : '', dr.amountText || (dr.amount ? won(dr.amount) + '원' : ''), dr.merchant].filter(Boolean).map(esc).join(' · ');
    dlg.setAttribute('aria-labelledby', 'confirm-title');
    dlg.innerHTML = `<div class="confirm-box" tabindex="-1" autofocus><b id="confirm-title">작성 중인 기록이 있어요</b><p>${what || '저장하지 않은 기록'}</p>
      <div class="confirm-btns"><button type="button" value="keep" class="btn">이어서 쓰기</button><button type="button" value="new" class="btn ghost">${md(ctx.date)}에 새로 기록</button></div></div>`;
    dlg.querySelector('[value=keep]').onclick = () => { dlg.close(); openEntry(null, { keepDraft: true }); };
    dlg.querySelector('[value=new]').onclick = () => { dlg.close(); store.setLocal('draft', null); openEntry(null, { date: ctx.date, decided: true }); };
    dlg.oncancel = null;
    dlg.showModal();
    return;
  }
  const ex = id && store.get(id);
  editing = !!ex;
  const last = liveTxs().filter(t => t.created_by === S.me).sort((a, b) => b.created_at - a.created_at)[0];
  draft = ex ? Object.assign({}, ex) : {
    id: uid(), date: today(), merchant: '', amount: 0, type: 'expense',
    method: (last && last.method) || S.settings.methods[0] || '', category: '', major: '',
    payer: S.me, beneficiary: defaultBene(), note: '', refund_pending: false,
    created_by: S.me, created_at: Date.now(), updated_at: 0, deleted: false,
  };
  if (!ex && S.draft && S.draft.created_by === S.me) draft = Object.assign({}, S.draft, { id: uid(), created_at: Date.now() });
  if (!ex && ctx && ctx.date && !(S.draft && S.draft.created_by === S.me && S.draft.date === ctx.date)) { draft.date = ctx.date; draft.payer = S.me; } // 선택일에서 연 새 기록은 그 날짜·내 결제
  saved = false;
  editBase = ex ? editKey(Object.assign({}, ex, { amountText: won(ex.amount) })) : '';
  const dlg = $('#sheet');
  dlg.classList.remove('filter-sheet');
  dlg.innerHTML = entryHtml(!!ex);
  dlg.showModal();
  const a = $('#amount');
  a.style.setProperty('--len', Math.max(6, a.value.length));
  a.focus(); // OS 숫자 키보드(화면 키패드를 켰으면 키패드)
  if (a.value) a.setSelectionRange(a.value.length, a.value.length); // 수정·이어 쓰는 초안은 커서를 끝에
}
// 기록 시트(v25 2차, spec 8·10절): 기본 = 금액(OS 숫자 키보드) → 거래처 → 대분류 8개(4열×2행) → 결제자·결제수단·날짜 → 저장.
// 상세 = 세부 분류(기존 분류 이름) · 종류 · 환불 예정 · 메모 · 즐겨찾기. 두 칸 모두 한 폼 안이라 탭을 오가도 초안이 그대로다.
// 대분류(draft.major, 시트 major 열)와 세부 분류(draft.category)는 따로 저장한다(Astra P0-01). 대분류를 안 고르면 세부 분류의 연결로 집계.
// 서버가 옛 버전(major 열 없음)이면 대분류 칸이 분류 칸에 대분류 이름을 적는 v25 1차 방식으로 동작하고 '서버 업데이트 필요'를 알린다.
// 기록 금액 입력 방식(v25 3차, Mason 결정): 이전 버전을 쓰던 기기는 화면 숫자 키패드 그대로, 새 설치는 휴대폰 숫자 키보드(store loadState가 처음 한 번 정함).
// 기록 화면의 '휴대폰 키보드로/화면 키패드로'와 설정 → 앱·연결 → 화면·입력에서 바꾸고 기기별로 기억. 범위는 기록 화면의 금액 칸만(예산·명세서·정기는 휴대폰 키보드)
// 키패드 키도 직접 입력과 같은 금액 경로(moneyInput)
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'];
const MAJOR_NAMES = core.MAJORS.map(m => m.label);
const detailCats = () => S.settings.categories.filter(c => !MAJOR_NAMES.includes(c));
const hasMajorCol = () => store.features().includes('major');
const useKeypad = () => S.keypad === true;
const keypadHtml = () => `<div class="keypad" id="keypad" role="group" aria-label="금액 숫자 키패드">${KEYS.map(k => `<button type="button" class="kp" data-act="key" data-v="${k}" aria-label="${k === 'back' ? '한 자리 지우기' : k === '00' ? '0 두 개' : k}">${k === 'back' ? icon('backspace') : k}</button>`).join('')}</div>`;
const kpModeBtn = kp => `<button type="button" class="kp-mode" data-act="kpmode" aria-label="기록 금액 입력 방식: 지금 ${kp ? '화면 키패드' : '휴대폰 키보드'}. ${kp ? '휴대폰 키보드' : '화면 키패드'}로 바꾸기, 이 기기에 기억">${kp ? '휴대폰 키보드로' : '화면 키패드로'}</button>`;
// 기록 화면에서 입력 방식을 바꾼다: 다시 그리지 않고 키패드만 넣고 빼서 작성 중인 값·선택을 그대로 둔다
function setEntryKeypad(on) {
  const f = $('[data-form=entry]'), a = $('#amount'); if (!f || !a) return;
  f.classList.toggle('with-kp', on); f.classList.remove('kp-off');
  a.setAttribute('inputmode', on ? 'none' : 'numeric');
  const kpEl = $('#keypad'); if (on && !kpEl) f.querySelector('.amount-field').insertAdjacentHTML('afterend', keypadHtml()); if (!on && kpEl) kpEl.remove();
  const mb = f.querySelector('.kp-mode'); if (mb) mb.outerHTML = kpModeBtn(on);
  a.blur(); a.focus({ preventScroll: true }); // 키보드 종류를 바로 바꿈
}
// 지금 초안의 대분류 이름(정하지 않았으면 ''), 그리고 그것이 건별 선택인지(세부 분류 연결로 정해진 것인지)
const entryMajor = () => draft && (draft.major || draft.category) ? core.majorLabel(core.majorOf(Object.assign({ created_at: Date.now() }, draft), catMap()).id) : '';
const entryMajorExplicit = () => !!(draft && (core.MAJOR_IDS.includes(draft.major) || MAJOR_NAMES.includes(draft.category)));
function entryHtml(isEdit) {
  const d = draft, st = S.settings, kp = useKeypad();
  const stats = merchantStats();
  const top = Object.entries(stats).sort((a, b) => b[1].n - a[1].n).slice(0, 3).map(([k]) => k);
  const methods = st.methods.includes(d.method) || !d.method ? st.methods : st.methods.concat(d.method);
  const em = entryMajor(), ex = entryMajorExplicit(), dcats = [...new Set([...detailCats(), ...(d.category && !MAJOR_NAMES.includes(d.category) ? [d.category] : [])])];
  const cell = c => `<button type="button" class="cat-cell${em === c && !ex ? ' derived' : ''}" data-act="cat" data-v="${esc(c)}" aria-pressed="${em === c}"><span class="ci" aria-hidden="true">${categoryIcon(c)}</span><span class="cn">${esc(c)}</span></button>`;
  const paste = isEdit ? '' : `<button type="button" class="link with-icon paste-link" data-act="impopen" data-v="paste">${icon('paste')}<span>알림 붙여넣기</span></button>`;
  return `<form data-form="entry" class="sheet-wrap${kp ? ' with-kp' : ''}" novalidate>
    ${sheetHead(isEdit ? '기록 수정' : '지출 기록', '', paste)}
    <div class="sheet-b">
      <div class="ep ep-basic">
      <div class="field amount-field">
        <div class="amount-card" data-act="kpshow"><div class="amount-lab"><label for="amount">얼마를 썼나요?</label>${kpModeBtn(kp)}</div>
        <div class="amount-in"><input id="amount" name="amount" inputmode="${kp ? 'none' : 'numeric'}" enterkeyhint="next" autocomplete="off" placeholder="0" value="${esc(d.amountText != null ? d.amountText : d.amount ? won(d.amount) : '')}" class="num" aria-describedby="entry-err amount-echo" aria-invalid="${!!d.amountErr && d.amountErr !== 'empty'}"${d.amountErr && d.amountErr !== 'empty' ? ' data-raw="1"' : ''}><span>원</span></div></div>
        <p class="amount-echo num" id="amount-echo" aria-live="polite">${d.amount >= 10000 ? koWon(d.amount) : ''}</p>
        <div class="err" id="entry-err" role="alert">${d.amountErr && d.amountErr !== 'empty' ? WON_ERR[d.amountErr] : ''}</div>
        <p class="entry-ctx" id="entry-ctx">${ctxLine()}</p></div>
      ${kp ? keypadHtml() : ''}
      <div class="field merchant-field">
        <input id="merchant" name="merchant" class="in" list="mlist" autocomplete="off" placeholder="어디에 썼나요?" aria-label="거래처 (선택 입력)" value="${esc(d.merchant)}">
        <datalist id="mlist">${Object.keys(stats).map(m => `<option value="${esc(m)}">`).join('')}</datalist>
        ${top.length ? `<div class="chips recent-chips">${top.map(m => `<button type="button" class="chip" data-act="merchant" data-v="${esc(m)}" aria-pressed="${d.merchant === m}" aria-label="${esc(m)}">${esc(m)}</button>`).join('')}</div>` : ''}</div>
      ${hasMajorCol() ? `<div class="field cat-pick open" id="cat-pick"><span class="cat-note" id="cat-label">${catLabel()}</span>
        <div class="cat-all"><div class="cat-grid" id="cats" role="group" aria-label="대분류">${MAJOR_NAMES.map(cell).join('')}</div></div></div>`
      : `<div class="field cat-pick open legacy-cats" id="cat-pick"><span class="cat-note" id="cat-label">${store.serverState() === 'unknown' ? '서버 확인 중 · 확인되면 대분류를 따로 고를 수 있어요 · 지금은 분류로 집계' : '대분류 선택은 서버 업데이트 후 사용할 수 있어요 · 지금은 분류로 집계'}</span>
        <div class="cat-all"><div class="cat-grid" id="cats" role="group" aria-label="분류">${[...new Set([...st.categories, ...(d.category ? [d.category] : [])])].map(c => `<button type="button" class="cat-cell" data-act="ucat" data-v="${esc(c)}" aria-pressed="${d.category === c}"><span class="ci" aria-hidden="true">${categoryIcon(c)}</span><span class="cn">${esc(c)}</span></button>`).join('')}</div></div></div>`}
      <div class="entry-meta">
        <label class="chip-in duo" for="payer">${icon('card')}<select id="payer" name="payer" aria-label="결제자">${d.payer ? '' : '<option value="" selected>미지정</option>'}${payerList().map(u => `<option ${d.payer === u ? 'selected' : ''}>${u}</option>`).join('')}</select><span class="duo-sep" aria-hidden="true">·</span><select id="method" name="method" aria-label="결제수단">${methods.map(m => `<option ${d.method === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>${icon('down')}</label>
        <label class="chip-in date-chip" for="date" data-act="datepick"><span class="date-txt" aria-hidden="true">${dotDate(d.date)}</span>${icon('down')}<input id="date" name="date" type="date" aria-label="날짜" value="${esc(d.date)}" max="${today()}"></label></div>
      </div>
      <section class="ep ep-more" aria-labelledby="ep-more-h"><h3 class="sub-h ep-h" id="ep-more-h">더 자세히 <span class="h2sub">${isEdit ? `선택 · 기록한 사람 ${esc(d.created_by || '-')}` : '선택 · 비워 둬도 저장돼요'}</span></h3>
      ${hasMajorCol() ? `<div class="field"><span class="lab" id="dcat-lab">세부 분류 <span class="h2sub">선택 · 대분류와 따로 저장돼요</span></span>
        <p class="dcat-applied" id="dcat-applied">${appliedLine()}</p>
        <div class="chips dcats" role="group" aria-labelledby="dcat-lab">${dcats.map(c => { const mo = core.majorOf({ category: c, created_at: Date.now() }, catMap()); return `<button type="button" class="chip" data-act="dcat" data-v="${esc(c)}" aria-pressed="${d.category === c}">${esc(c)}<small>${mo.review ? '연결 확인 필요' : '기본 연결: ' + core.majorLabel(mo.id)}</small></button>`; }).join('') || '<p class="hint">세부 분류가 없어요. 설정 → 분류·결제수단·결제자에서 추가할 수 있어요.</p>'}</div></div>`
        : `<div class="notice-soft warn srv-note"><p>${store.serverState() === 'unknown' ? '서버를 확인하는 중이에요. 확인되면' : '서버 업데이트(Apps Script 새 버전) 뒤에'} 대분류와 세부 분류를 따로 고를 수 있어요. 지금은 위의 분류 하나로 저장하고, 대분류는 설정 → 대분류 연결로 정해요.</p>${store.serverState() === 'old' ? srvGuide() : ''}</div>`}
      <div class="field"><span class="lab">종류</span><div class="seg">${Object.entries(TYPE_LABEL).map(([k, l]) => `<button type="button" data-act="type" data-v="${k}" aria-pressed="${d.type === k}">${l}</button>`).join('')}</div>
        <p class="hint">이체·카드대금은 ‘지출 제외’로 기록해요. 순지출·카드값에는 더하지 않아요.</p></div>
      <div class="field"><label class="toggle" for="rp"><span>환불 받을 예정</span><input type="checkbox" id="rp" name="refund_pending" ${d.refund_pending ? 'checked' : ''}></label></div>
      <div class="field"><label for="note">메모</label><input id="note" name="note" class="in" autocomplete="off" placeholder="예: 선물, 정기검사" value="${esc(d.note)}"></div>
      ${isEdit ? '' : `<div class="field"><button type="button" class="btn ghost fav-chip-btn" data-act="favlist">${icon('star')}<span>즐겨찾기에서 불러오기</span></button></div>`}
      ${isEdit && d.type === 'expense' && store.prefs() ? `<div class="field fav-field">${favButton()}<p class="hint" id="fav-msg" role="status"></p></div>` : ''}
      ${isEdit ? `<div class="field"><button type="button" class="btn danger" data-act="delete">기록 삭제</button></div>` : ''}
      </section>
    </div>
    <div class="sheet-footer"><div class="err" id="entry-foot-err" role="alert"></div><button class="btn save" type="submit">${icon('check')}<span>${isEdit ? '수정 저장' : '기록하기'}</span></button>${isEdit ? '' : '<p class="foot-note">저장한 기록은 내역에서 바로 볼 수 있어요</p>'}</div></form>`;
}
// 기록 날짜는 '2026.10.21'로 보이고, 실제 선택은 기기 날짜 선택기(투명 입력)로 한다(Astra P1-03·P2-03)
const dotDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s.replace(/-/g, '.') : '';
// 화면 키패드 → 금액 칸: 끝에 붙이거나 끝 한 글자를 지우고, 직접 칠 때와 같은 input 이벤트로 moneyInput을 거친다
function keyIn(v) {
  const a = $('#amount'); if (!a) return;
  const s = a.value, digits = s.replace(/\D/g, '');
  if (v === 'back') { if (!s) return; a.value = s.slice(0, -1); }
  else {
    if (!digits && (v === '0' || v === '00')) return;            // 맨 앞 0은 받지 않음
    if (!a.dataset.raw && digits.length + v.length > 10) { const e = $('#entry-err'); if (e) e.textContent = WON_ERR.over; return; } // 10자리까지
    if (a.dataset.raw && s.length + v.length > 16) { const e = $('#entry-err'); if (e) e.textContent = '금액 칸에 숫자가 아닌 글자가 있어요. 지우고 다시 입력해 주세요'; return; } // 원문 모드는 16글자까지(Fable P2-2)
    a.value = s + v;
  }
  try { a.setSelectionRange(a.value.length, a.value.length); } catch (e) {}
  a.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: v === 'back' ? 'deleteContentBackward' : 'insertText', data: v === 'back' ? null : v }));
}
// 다른 글자 칸(거래처·메모)에 들어가면 키패드를 접고, 금액 칸·금액 카드로 돌아오면 다시 편다(OS 키보드와 동시에 보이지 않게)
document.addEventListener('focusin', e => {
  const f = e.target.closest && e.target.closest('[data-form=entry]'); if (!f) return;
  if (e.target.id === 'amount' || e.target.closest('#keypad')) f.classList.remove('kp-off');
  else if (e.target.matches('input:not([type=date]):not([type=checkbox]), textarea')) f.classList.add('kp-off');
});
// 키패드를 눌러도 금액 칸의 포커스·커서를 유지(마우스·손가락). 화면 낭독기의 두 번 탭은 click만 와서 그대로 동작
// 손가락·마우스로 키를 누르면 첫 탭부터 버튼이 포커스를 가져가지 않고 금액 칸에 포커스(Fable P2-3). 화면 낭독기의 두 번 탭(click만)은 낭독 위치를 키패드에 둔다
document.addEventListener('pointerdown', e => { if (!(e.target.closest && e.target.closest('#keypad .kp'))) return; e.preventDefault(); const a = $('#amount'); if (a && document.activeElement !== a) a.focus({ preventScroll: true }); });
function moreCell() { return ''; } // v25 2차: 대분류 8개를 늘 펼쳐 보여 더보기 칸이 없다
function refreshCats() {
  const em = entryMajor(), ex = entryMajorExplicit(), c = draft ? draft.category || '' : '';
  document.querySelectorAll('#sheet [data-act=cat]').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.v === em)); b.classList.toggle('derived', b.dataset.v === em && !ex); });
  document.querySelectorAll('#sheet [data-act=dcat]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === c)));
  refreshCatLabel();
}
// 분류 안내: 추천이면 '카페 추천 · 식비', 대분류를 안 고르고 세부 분류만 있으면 '세부 분류 카페에 따라 식비로 집계', 둘 다 고르면 '생활 · 세부 분류 카페'
function catLabel() {
  if (!draft) return '';
  const c = draft.category, em = entryMajor(), detail = c && !MAJOR_NAMES.includes(c);
  if (draft.catSug && c) return `<b>${esc(c)}</b> 추천${detail ? ' · ' + esc(em) : ''}`;
  if (core.MAJOR_IDS.includes(draft.major)) return detail ? `<b>${esc(em)}</b> · 세부 분류 ${esc(c)}` : '';
  return detail ? `세부 분류 <b>${esc(c)}</b>에 따라 ${esc(em)}로 집계 · 대분류를 고르면 그것이 먼저예요` : '';
}
function refreshCatLabel() { const el = $('#cat-label'); if (el) el.innerHTML = catLabel(); const ap = $('#dcat-applied'); if (ap) ap.innerHTML = appliedLine(); }
// 상세에서 실제로 적용되는 대분류(Astra v25 P1-13): 칩의 '기본 연결'과 이 기록의 집계를 구분
function appliedLine() {
  if (!draft) return '';
  const em = entryMajor();
  if (core.MAJOR_IDS.includes(draft.major)) return `이 기록은 <b>${esc(em)}</b>로 집계 · 위에서 고른 대분류가 먼저예요`;
  if (draft.category && !MAJOR_NAMES.includes(draft.category)) return `이 기록은 <b>${esc(em)}</b>로 집계 · 세부 분류 ${esc(draft.category)}의 기본 연결`;
  return '대분류를 고르지 않았어요 · 위에서 고르거나 세부 분류의 기본 연결을 따라요';
}
// 상세 탭 이름 옆 요약: 기본값(지출·환불 예정 없음·메모 없음·세부 분류 없음)이면 비우고, 바꾼 것만
function moreSummary() {
  const d = draft; if (!d) return '';
  return [d.category && !MAJOR_NAMES.includes(d.category) ? d.category : '', d.type !== 'expense' ? TYPE_LABEL[d.type] : '', d.refund_pending ? '환불 대기' : '', d.note ? '메모' : ''].filter(Boolean).join(' · ');
}
const summaryLine = moreSummary;
function refreshSummary() { const el = $('#es-sum'); if (el) el.textContent = moreSummary(); const c = $('#entry-ctx'); if (c) c.innerHTML = ctxLine(); const dt = $('#sheet .date-txt'); if (dt && draft) dt.textContent = dotDate(draft.date); }
// 오늘·내 결제가 아닌 기록이면 금액 바로 아래에 날짜·결제자를 보여 줌(선택일·이어 쓰는 초안, Astra V23-07·P1-01)
function ctxLine() {
  const d = draft; if (!d || (d.date === today() && d.payer === S.me)) return '';
  const dt = parseDate(d.date);
  return `${icon('calendar')}<span>${d.date.slice(0, 4) !== today().slice(0, 4) ? dt.getFullYear() + '년 ' : ''}${dt.getMonth() + 1}월 ${dt.getDate()}일 ${KDAY[dt.getDay()]} · ${esc(d.payer)} 결제</span><button type="button" class="link" data-act="ctxedit">바꾸기</button>`;
}
function readEntry(form) {
  const fd = new FormData(form);
  const ar = core.parseWon(fd.get('amount'));
  draft.amountText = String(fd.get('amount') || ''); // 잘못된 값도 원문 그대로(초안에도)
  draft.amount = ar.ok ? ar.value : 0; draft.amountErr = ar.ok ? '' : ar.error;
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
  if (t.category) { draft.category = t.category; draft.catSug = true; refreshCats(); }
  if (hasMajorCol() && core.MAJOR_IDS.includes(t.major) && !draft.major) { draft.major = t.major; draft.catSug = true; refreshCats(); }
  if (t.method && S.settings.methods.includes(t.method)) { draft.method = t.method; $('#method').value = t.method; }
  refreshSummary();
}

/* ---------------- 시트 공통 ---------------- */
function sheetHead(title, back, extra) {
  return `<div class="sheet-h"><div class="sh-l">${back ? `<button type="button" class="icon-btn ghost" data-act="${back}" aria-label="뒤로">${icon('left')}</button>` : ''}<h2 id="sheet-title" tabindex="-1" autofocus>${title}</h2></div><div class="sh-r">${extra || ''}<button type="button" class="icon-btn" data-act="close" aria-label="닫기">${icon('x')}</button></div></div>`;
}
function showSheet(html, compact) {
  const dlg = $('#sheet');
  dlg.classList.toggle('filter-sheet', !!compact);
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
}
// v26 더 보기: 같은 시트를 다시 그릴 때는 본문 스크롤 위치를 지킨다(더 불러와도 위로 튀지 않게)
function sheetPaint(html, keep, compact) { if (keep && $('#sheet').open) repaintSheet(html); else showSheet(html, compact); }
// 시트 안 내용만 다시 그린다(본문 스크롤 위치 유지)
function repaintSheet(html) {
  const dlg = $('#sheet'), b = $('#sheet .sheet-b'), y = b ? b.scrollTop : 0;
  const a = document.activeElement, aid = a && dlg.contains(a) ? a.id || (a.dataset && (a.dataset.act ? 'act:' + a.dataset.act + ':' + (a.dataset.v || '') : a.dataset.map ? 'map:' + a.dataset.map : a.dataset.input ? 'input:' + a.dataset.input : '')) : '';
  const sel = a && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
  const open = [...dlg.querySelectorAll('details')].map((d, i) => d.open ? (d.dataset.k || i) : null).filter(x => x !== null);
  const t = dlg.querySelector('.toast.in-sheet');
  dlg.innerHTML = html;
  if (t) { t.classList.remove('in-flow'); dlg.appendChild(t); }
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
let favShown = MGR_STEP, favMgrShown = MGR_STEP;
function openFavList(keep) {
  if ($('[data-form=entry]') && !stashDraft()) return;
  if (!keep) favShown = MGR_STEP;
  const all = favorites(), list = all.slice(0, favShown);
  sheetPaint(`<div class="sheet-wrap">${sheetHead('즐겨찾기로 기록')}
    <div class="sheet-b">
      <p class="hint fav-lead">누르면 오늘 기록으로 바로 저장해요. 결제자와 금액을 먼저 확인해 주세요.</p>
      ${!store.prefs() ? '<div class="empty">서버 업데이트가 필요해요 (Apps Script 새 버전).</div>' : list.length ? `<div class="favorites">${list.map(f => { const r = favRecord(f); return `<button class="favorite" data-act="favsave" data-v="${esc(f.id)}" aria-label="${esc(f.merchant)} ${won(f.amount)}원 오늘 기록"><span><b>${esc(f.merchant)}</b><span class="meta">${esc(r.category || '미분류')} · ${esc(r.payer)} 결제 · ${esc(r.method)}${r.payer !== f.payer ? ' <span class="caption">(결제자 목록에 없어 ' + esc(r.payer) + ')</span>' : ''}</span></span><span class="fav-amt num">${won(f.amount)}원${icon('plus')}</span></button>`; }).join('')}</div>${moreBtn('favmore', list.length, all.length, '개', MGR_STEP)}`
        : '<div class="empty"><b>즐겨찾기가 아직 없어요</b><br>자주 쓰는 기록을 열고 "즐겨찾기에 추가"를 눌러 보세요.</div>'}
    </div>
    <div class="sheet-footer two"><button type="button" class="btn ghost" data-act="favmanage">관리</button><button type="button" class="btn ghost" data-act="add">직접 금액 입력</button></div></div>`, keep, true);
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
  const ver = store.get(rec.id).updated_at;
  $('#sheet').close(); render();
  toast(`${f.merchant} ${won(f.amount)}원 기록했어요`, '되돌리기', () => {
    const t = store.get(rec.id);
    if (t && t.updated_at !== ver) { toast('그사이 수정된 기록이라 남겨 두었어요'); return; }
    if (store.remove(rec.id)) { render(); toast('되돌렸어요'); }
  }, 8000);
}
// 즐겨찾기 관리(삭제) 시트
function openFavManage(msg, keep) {
  if (!keep) favMgrShown = MGR_STEP;
  const all = favorites(), list = all.slice(0, favMgrShown);
  sheetPaint(`<div class="sheet-wrap">${sheetHead('즐겨찾기 관리', 'favlist')}
    <div class="sheet-b">
      <p class="hint fav-lead">두 사람이 같이 써요. 지워도 이미 남긴 기록은 그대로예요.</p>
      ${msg ? `<p class="resume-line">${msg}</p>` : ''}
      ${list.length ? `<div class="card list-card">${list.map(f => `<div class="favorite-row"><span class="fr-main"><b>${icon('starOn')}${esc(f.merchant)}</b><span class="muted">${esc(f.category || '미분류')} · ${esc(f.payer || '-')} 결제</span></span><b class="num">${won(f.amount)}원</b><button class="fr-del" data-act="favdel" data-v="${esc(f.id)}" aria-label="${esc(f.merchant)} 즐겨찾기 삭제">삭제</button></div>`).join('')}</div>${moreBtn('favmgrmore', list.length, all.length, '개', MGR_STEP)}`
        : '<div class="empty">즐겨찾기가 없어요. 기록을 열고 "즐겨찾기에 추가"를 눌러 보세요.</div>'}
    </div></div>`, keep);
}
let favUndo = null;

/* ---------------- 가져오기: 카드 알림 붙여넣기 · 파일 (확인 목록은 공용) ---------------- */
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const XLSX_SRI = 'sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA==';
const IMP_MAX_ROWS = 5000, IMP_MAX_BYTES = 10 * 1024 * 1024;
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
  if ($('[data-form=entry]') && !stashDraft()) return;
  // 저장하지 않고 닫은 확인 목록은 앱을 끄기 전까지 이어서 볼 수 있다(원문·파일은 기기 저장소에 남기지 않음)
  if (impPrev && impPrev.kind === kind && impPrev.items.length) { imp = impPrev; imp.resumed = true; imp.saving = false; }
  else imp = { kind, step: kind, text: '', items: [], unread: [], editing: -1, shown: REVIEW_STEP, file: null, err: '', saving: false };
  impPrev = null;
  showSheet(importHtml());
  if (imp.step === 'paste') { const t = $('#paste-text'); t.focus({ preventScroll: true }); }
}
// 시트가 닫힐 때 확인 중이던 목록을 잠시 보관
function parkImport() {
  if (imp && imp.step === 'review' && imp.items.length && !imp.done) { commitEdit(); impPrev = imp; }
  imp = null;
}
const renderImport = () => { if (imp) { repaintSheet(importHtml()); fitRows(); } };
const impHead = (title, back) => sheetHead(title, back ? 'impback' : '') + `<p class="step-label">${imp.kind === 'paste' ? (imp.step === 'paste' ? '1/2 알림 입력' : '2/2 저장할 기록 확인') : imp.step === 'file' ? '1/3 파일 선택' : imp.step === 'map' ? '2/3 파일 항목 확인' : '3/3 저장할 기록 확인'}</p>`;
function importHtml() {
  const st = imp.step;
  if (st === 'paste') return `<form data-form="paste" class="sheet-wrap" novalidate>${impHead('알림 붙여넣기', false)}
    <div class="sheet-b">
      <p class="lead-hint">카드 문자나 카드 앱 알림을 <b>여러 개 한 번에</b> 붙여넣으세요. 확인한 기록만 장부에 넣어요.</p>
      <label class="lab-strong" for="paste-text">카드 알림 원문</label>
      <textarea id="paste-text" class="in paste-in" rows="9" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="예)\n가나카드 승인 12,300원\n10/18 12:34 스타벅스">${esc(imp.text)}</textarea>
      <p class="hint">취소 알림도 함께 넣으면 환불로 기록해요. 글은 이 기기 안에서만 읽고 어디에도 보내지 않아요.</p>
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
  // v26: 필수 열 → 미리보기 3줄 → 추가 연결을 이어서(내부 탭 없음). 파일 선택 → 열 연결 → 확인의 3단계는 그대로
  return `<div class="sheet-wrap">${impHead('빠진 기록 가져오기', true)}
    <div class="sheet-b">
      <div class="mt-sec mt-cols">
      <div class="file-line"><span>${icon('file')}<b>${esc(f.name)}</b> <span class="muted">${f.data.length.toLocaleString('ko-KR')}줄</span></span><span class="fl-acts">${isCsv ? `<button type="button" class="link" data-act="impenc" aria-label="한글이 깨지면 ${f.enc === 'euc-kr' ? '자동으로' : '한글 파일로'} 다시 읽기">${f.enc === 'euc-kr' ? '자동으로 다시 읽기' : '한글 깨짐 고치기'}</button>` : ''}<button type="button" class="link" data-act="impfile">다른 파일</button></span></div>
      ${f.over ? `<p class="err" role="alert">5,000줄이 넘어요(${f.data.length.toLocaleString('ko-KR')}줄). 카드사에서 기간을 나눠 내려받아 주세요.</p>` : ''}
      ${f.sheets.length > 1 ? `<label class="map-row" for="map-sheet"><span>시트</span><select id="map-sheet" class="in" data-map="sheet">${f.sheets.map((s, i) => `<option value="${i}" ${i === f.si ? 'selected' : ''}>${esc(s.name)} (${s.rows.length}줄)</option>`).join('')}</select></label>` : ''}
      <h2 class="map-h">어떤 열인지 확인해 주세요</h2>
      <div class="column-map">${ROLES.slice(0, 3).map(sel).join('')}</div>
      ${conv && conv.negatives ? `<div class="field neg-field${needNeg ? ' need' : ''}" id="neg-field" tabindex="-1"><span class="lab" id="neg-lab">음수 금액이 ${conv.negatives}줄 있어요. 어떻게 기록할까요? <span class="req">필수</span></span><div class="seg" role="group" aria-labelledby="neg-lab">${[['refund', '환불'], ['expense', '지출'], ['skip', '건너뛰기']].map(([k, l]) => `<button type="button" data-act="impneg" data-v="${k}" aria-pressed="${f.negative === k}">${l}${conv.negSuggested === k ? ' <small>추천</small>' : ''}</button>`).join('')}</div>
        <p class="hint">카드 이용내역의 음수는 보통 취소(환불), 다른 가계부는 보통 지출이에요.</p></div>` : ''}
      </div>
      <div class="mt-sec mt-preview">
      <h2 class="map-h">미리보기 <span class="h2sub">앞쪽 원본 3줄</span></h2>
      <div class="card file-preview">${pv.map(({ r, it, why }) => `<div class="pv-row"><span class="pv-src">${esc(r.filter(v => v !== '' && v != null).join(' · ').slice(0, 70))}</span>
        ${it ? `<span class="pv-out"><span>→ ${it.date.slice(0, 4) !== String(new Date().getFullYear()) ? it.date.slice(0, 4) + '.' : ''}${md(it.date)}${it.time ? ' ' + it.time : ''} · ${esc(it.merchant || '거래처 없음')}</span><b class="num${it.type === 'refund' ? ' ref' : ''}">${it.type === 'refund' ? '환불 ' : it.type === 'transfer' ? '제외 ' : ''}${it.amount ? won(it.amount) + '원' : esc(it.foreign || '금액 없음')}</b></span>` : `<span class="pv-out pv-bad">→ ${esc(why || (f.mapping.date < 0 ? '날짜 열을 골라 주세요' : f.mapping.amount < 0 ? '금액 열을 골라 주세요' : '이 줄은 건너뛰어요'))}</span>`}</div>`).join('') || '<div class="empty">내용이 없어요</div>'}</div>
      ${conv ? `<p class="hint">${conv.items.length}건 읽음${conv.unread.length ? ` · ${conv.unread.length}줄은 가져올 수 없어요(다음 화면에서 이유 확인)` : ''}</p>` : ''}</div>
      <div class="mt-sec mt-more"><h2 class="map-h">추가 연결 <span class="h2sub">선택 · 시각·종류·통화·분류·결제자·결제수단·메모·할부 열이 있으면</span></h2>
      <label class="map-row" for="map-head"><span>항목 이름이 있는 줄</span><select id="map-head" class="in" data-map="head"><option value="-1" ${f.h < 0 ? 'selected' : ''}>없음 (첫 줄부터 내용)</option>${rows.slice(0, 15).map((r, i) => `<option value="${i}" ${f.h === i ? 'selected' : ''}>${i + 1}번째 줄: ${esc(r.filter(v => v !== '').slice(0, 4).join(', ').slice(0, 40))}</option>`).join('')}</select></label>
<div class="column-map">${ROLES.slice(3).map(sel).join('')}</div></div>
    </div>
    <div class="sheet-footer"><div class="err" id="imp-err" role="alert">${esc(imp.err)}</div>
      ${needNeg ? '<button type="button" class="btn" data-act="impgoneg">음수 금액 처리 선택</button>' : `<button type="button" class="btn" data-act="impfind" ${ready ? '' : 'disabled'}>확인 목록 보기</button>`}</div></div>`;
}

/* 후보 → 확인 목록 */
// 저장을 막는 조건(선택·저장 두 곳에서 같은 검사)
function impValidate(it) {
  const e = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || '') || core.toDate(it.date) !== it.date) e.push('날짜를 확인해 주세요');
  else if (it.date > today()) e.push('미래 날짜예요. 확인해 주세요');
  if (!core.validWon(it.amount)) e.push(it.foreign ? '원화 금액을 넣어 주세요' : '금액을 넣어 주세요');
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
  if (it.dup === 'same') t.push(`<span class="tag dup">이미 기록된 내역이에요</span>`);
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
// 선택을 막는 첫 문제의 항목 이름 → '금액을 확인하면 선택할 수 있어요'
function impWhy(it) {
  const first = [...it.issues, ...impValidate(it)][0] || '';
  const kw = ['날짜', '금액', '거래처', '결제자', '종류'].find(k => first.includes(k)) || '내용';
  return `${kw}${/[가-힣]$/.test(kw) && (kw.charCodeAt(kw.length - 1) - 0xAC00) % 28 ? '을' : '를'} 확인하면 선택할 수 있어요`;
}
function impRow(it, i) {
  const m = it.match;
  const match = m ? `<span class="imp-match">기록: ${parseDate(m.date).getFullYear() !== new Date().getFullYear() ? m.date.slice(0, 4) + '.' : ''}${md(m.date)} ${esc(m.merchant || '거래처 없음')} <span class="nw">${won(m.amount)}원</span></span>` : '';
  const editing = imp.editing === i, blocked = impBlocked(it), name = esc(it.merchant || '거래처 없음');
  return `<div class="import-row${it.on ? ' on' : ''}${it.dup ? ' is-dup' : ''}${editing ? ' is-editing' : ''}${blocked ? ' is-blocked' : ''}" data-i="${i}">
    <label class="imp-sel" for="impchk-${i}"><input type="checkbox" id="impchk-${i}" data-act="impchk" data-v="${i}" ${it.on ? 'checked' : ''} ${blocked ? `disabled aria-describedby="impwhy-${i}"` : ''} aria-label="${name} ${it.amount ? won(it.amount) + '원' : '금액 없음'} 기록하기"></label>
    <div class="imp-body">
      <label class="imp-top" for="impchk-${i}"><span class="imp-m">${name}</span><span class="imp-a num${it.type === 'refund' ? ' ref' : it.type === 'transfer' ? ' ex' : ''}">${it.type === 'refund' ? '환불 +' : ''}${it.amount ? wonWbr(it.amount) : '금액 없음'}</span></label>
      ${impTags(it) ? `<span class="imp-tags">${impTags(it)}</span>` : ''}${match}
      <span class="imp-act"><span class="imp-last"><span class="imp-meta">${impDate(it)}${it.time ? ' ' + it.time : ''} · ${esc(it.category || '미분류')}${it.sug ? ' <span class="muted">(추천)</span>' : ''} · ${it.payer ? esc(it.payer) + ' 결제' : '결제자 미정'}</span>${blocked ? `<span class="imp-edit-hint" id="impwhy-${i}">${impWhy(it)}</span>` : ''}</span><button type="button" class="imp-edit-btn" data-act="impedit" data-v="${i}" aria-expanded="${editing}" aria-label="${name} ${editing ? '수정 닫기' : '수정'}">${editing ? '닫기' : '수정'}</button></span>
    </div></div>${editing ? impEditor(it, i) : ''}`;
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
    <div class="row2"><div class="field"><label for="ie-time">시각</label><input id="ie-time" type="time" class="in" value="${esc(it.time || '')}"></div>
        <div class="field"><label for="ie-method">결제수단</label><select id="ie-method" class="in">${methods.map(m => `<option ${m === it.method ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></div></div>
      <div class="field"><label for="ie-note">메모</label><input id="ie-note" class="in" value="${esc(it.note || '')}" autocomplete="off" maxlength="200"></div>
    ${it.raw ? `<details class="source-detail"><summary>원문 보기</summary><pre>${esc(it.raw)}</pre></details>` : ''}
    <div class="err" id="ie-err" role="alert"></div>
    <div class="imp-edit-btns"><button type="button" class="btn ghost" data-act="impcancel">취소</button><button type="button" class="btn" data-act="impapply" data-v="${i}">목록에 반영</button></div>
  </div>`;
}
function impFooter() {
  const sel = imp.items.filter(it => it.on), s = core.summarize(sel);
  const parts = [s.expense ? `지출 <b class="num">${won(s.expense)}원</b>` : '', s.refund ? `환불 <b class="num">${won(s.refund)}원</b>` : '', s.transfer ? `지출 제외 <b class="num">${won(s.transfer)}원</b>` : ''].filter(Boolean).join(' · ');
  const label = imp.saving ? '기록하는 중…' : imp.editing >= 0 ? '수정 반영하고 ' + (sel.length ? sel.length + '건 ' : '') + '기록하기' : sel.length ? sel.length + '건 기록하기' : '기록하기';
  return `<div class="sheet-footer" id="imp-foot">
    <p class="foot-sum">${sel.length ? `<b>${sel.length}건</b> 선택 · ${parts}` : '기록할 내역을 골라 주세요'}</p>
    <div class="err" id="imp-err" role="alert">${esc(imp.err)}</div>
    <button type="button" class="btn" data-act="impsave" ${(sel.length || imp.editing >= 0) && !imp.saving ? '' : 'disabled'}>${label}</button></div>`;
}
function reviewHtml() {
  const c = impCount(), file = imp.kind === 'file', st = store.status();
  // v26: 확인 목록 6건 + '더 보기'(6건씩 이어 붙임). 고른 상태·수정 중인 행·확인 필요 상태는 전체 목록에서 그대로
  if (imp.editing >= 0) imp.shown = Math.max(imp.shown, imp.editing + 1);
  const shown = Math.min(imp.items.length, imp.shown || REVIEW_STEP), rows = imp.items.slice(0, shown).map(impRow).join('');
  const when = st.lastSync ? new Date(st.lastSync).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }) : '';
  return `<div class="sheet-wrap">${impHead(file ? '빠진 기록 가져오기' : '알림 붙여넣기', true)}
    <div class="sheet-b">
      ${imp.resumed ? `<p class="resume-line">아까 확인하던 목록이에요. <button type="button" class="link" data-act="impfresh">새로 시작</button></p>` : ''}
      <div class="import-summary" role="status"><span><b class="num">${c.fresh}</b> ${file ? '빠진 기록' : '새 기록'}</span><span><b class="num">${c.dup}</b> 이미 있음</span><span${c.check ? ' class="warn"' : ''}><b class="num">${c.check}</b> 확인 필요</span></div>
      ${navigator.onLine === false || !st.lastSync || Date.now() - st.lastSync > 10 * 60e3 ? `<p class="hint basis">이 기기에 있는 기록과 비교했어요${when ? ` · 마지막 공유 ${when}` : ''}${navigator.onLine === false ? ' · 오프라인이라 다른 기기의 새 기록은 빠져 있을 수 있어요' : ''}</p>` : ''}
      <div class="imp-tools"><button type="button" class="link" data-act="impsel" data-v="new">추가할 것만 선택</button><button type="button" class="link" data-act="impsel" data-v="none">모두 선택 해제</button>
        <label class="imp-bulk">결제자 모두 <select class="in" data-input="impbulk" aria-label="모든 건의 결제자 한꺼번에 바꾸기"><option value="">그대로</option>${payerList().map(p => `<option>${esc(p)}</option>`).join('')}</select></label></div>
      ${imp.items.length ? `<div class="card import-list">${rows}</div>` : '<div class="card"><div class="empty">가져올 내역이 없어요.</div></div>'}
      ${moreBtn('impmore', shown, imp.items.length, '건', REVIEW_STEP)}
      ${imp.unread.length ? `<details class="source-detail unread" open data-k="unread"><summary>가져오지 못한 내용 ${imp.unread.length}개</summary>${(ur => imp.unread.slice(0, 6).map(ur).join('') + (imp.unread.length > 6 ? `<details class="unread-rest" data-k="unread-rest"><summary>나머지 ${Math.min(200, imp.unread.length) - 6}개 보기</summary>${imp.unread.slice(6, 200).map(ur).join('')}</details>` : ''))(u => `<div class="unread-row"><b>${u.line ? u.line + '번째 줄 · ' : ''}${esc(u.why)}</b><pre>${esc(u.raw)}</pre></div>`)}
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
    amount: (r => r.ok ? r.value : 0)(core.parseWon($('#ie-amount').value)),
    date: $('#ie-date').value || '',
    merchant: $('#ie-merchant').value.trim().slice(0, 60),
    category: $('#ie-cat').value, payer: $('#ie-payer').value,
    time: $('#ie-time') ? $('#ie-time').value : it.time, method: $('#ie-method') ? $('#ie-method').value : it.method,
    note: $('#ie-note') ? $('#ie-note').value.trim().slice(0, 200) : it.note,
  });
  const ty = $('#ie-type [aria-pressed=true]'); if (ty) next.type = ty.dataset.v;
  const ar = core.parseWon($('#ie-amount').value);
  const wrongAmt = !ar.ok && ar.error !== 'empty';
  const errs = impValidate(next).filter(e => !(wrongAmt && /금액/.test(e)));
  if (wrongAmt) errs.unshift(WON_ERR[ar.error]);
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
    const vers = ids.map(id => (store.get(id) || {}).updated_at); // 되돌리기는 그사이 고친 기록을 지우지 않는다(Astra R03)
    imp.done = true; imp = null; impPrev = null;
    $('#sheet').close();
    resetListFilter(); lf.period = 'custom'; lf.from = dates[0]; lf.to = dates[dates.length - 1]; tab = 'list'; render(); scrollTo(0, 0);
    toast(`${n}건 저장했어요 · 저장한 기간을 보여드려요`, '되돌리기', () => {
      const cur = ids.map(id => store.get(id));
      const back = cur.filter((t, k) => t && !t.deleted && t.updated_at === vers[k]).map(t => Object.assign({}, t, { deleted: true }));
      const changed = cur.filter((t, k) => t && !t.deleted && t.updated_at !== vers[k]).length;
      if (!back.length) { toast(changed ? `${changed}건은 그사이 수정돼 남겨 두었어요. 확인해 주세요` : '되돌릴 기록이 없어요'); return; }
      if (store.upsertMany(back)) { render(); toast(`${back.length}건을 되돌렸어요${changed ? ` · ${changed}건은 그사이 수정돼 남겨 두었어요` : ''}`); }
    });
  }, 30);
}

/* ---------------- 내역 필터(추가 조건) ----------------
 * 기간 '보던 기간' = 위의 월별/카드 청구 기간(lf.period 'cycle'), 또는 전체 기간·직접 지정. 대분류는 칩, 여기서는 세부 분류·결제자·결제수단·금액·종류 */
const LF0 = () => ({ period: 'cycle', from: '', to: '', cats: [], payers: [], methods: [], min: 0, max: 0, kind: 'all', q: '', merchant: '' });
let lf = LF0(), lfDraft = null;
const KINDS = [['all', '전체'], ['expense', '지출'], ['refund', '환불'], ['refund_pending', '환불 대기'], ['transfer', '지출 제외']];
const lfActive = f => f.cats.length + f.payers.length + (f.methods || []).length + (f.min || f.max ? 1 : 0) + (f.kind !== 'all' ? 1 : 0) + (f.period !== 'cycle' ? 1 : 0) + (f.q.trim() ? 1 : 0);
const amtLabel = f => f.min && f.max ? `${man(f.min)}~${man(f.max)}` : f.min ? `${man(f.min)} 이상` : f.max ? `${man(f.max)} 이하` : '';
// 필터 시트(v26): 조건 종류 탭 없이 기간 → 세부 분류 → 결제자·결제수단 → 금액 → 종류를 이어서. 조건 요약·결과 N건·적용은 늘 보임, 닫으면 기존 조건 그대로.
// 툴바 칩으로 열면 그 조건 위치로 바로 내려 준다
const LF_SEC_OF = { period: 'lf-period', cats: 'lf-cats', payers: 'lf-payers', methods: 'lf-methods', amount: 'lf-amount', kind: 'lf-kind' };
function openListFilter(section) {
  lfDraft = JSON.parse(JSON.stringify(lf));
  lfDraft.offset = curOff();
  showSheet(lfSheetHtml(), true);
  const sec = section && section !== 'period' && document.getElementById(LF_SEC_OF[section]); if (sec) sec.scrollIntoView({ block: 'start' });
}
function lfSummary(f) {
  const parts = [f.period === 'all' ? '전체 기간' : f.period === 'custom' ? '직접 지정' : '', f.cats.length ? '세부 분류 ' + f.cats.length : '', f.payers.length ? '결제자 ' + f.payers.length : '', (f.methods || []).length ? '결제수단 ' + f.methods.length : '', f.min || f.max ? '금액' : '', f.kind !== 'all' ? KINDS.find(k => k[0] === f.kind)[1] : ''].filter(Boolean);
  return parts.length ? '조건: ' + parts.join(' · ') : '추가 조건 없음';
}
// 결제자 필터: 설정의 사람 + 실제 기록에 남은 결제자 + 미지정(빈 결제자, Astra P1-08) + 이미 고른 값
const lfPayers = f => [...new Set([...payerList(), ...liveTxs().map(t => t.payer || '미지정'), ...(f.payers || [])])];
const methodList = f => [...new Set([...S.settings.methods, ...liveTxs().map(t => t.method || '미지정'), ...(f.methods || [])])];
function lfSheetHtml() {
  const f = lfDraft, cats = [...new Set([...S.settings.categories, ...liveTxs().map(t => t.category || '미분류')])];
  const month = pv() === 'month', r = f.period === 'cycle' ? (month ? monthPeriod(f.offset) : billPeriod(f.offset)) : null;
  const range = f.period === 'all' ? null : f.period === 'custom' ? (f.from && f.to ? { start: f.from, end: f.to } : cycleRange(0)) : r;
  const base = core.scopeTxs(liveTxs(), { range, methods: month ? null : billMethods(), major: curMajor(), map: catMap() });
  const n = core.filterTxs(base, f, null).length;
  const amtMsg = f.minBad ? '최소 금액: ' + f.minBad : f.maxBad ? '최대 금액: ' + f.maxBad : f.min && f.max && f.min > f.max ? '최소 금액이 최대 금액보다 커요' : '';
  const badAmt = !!amtMsg, badDate = f.period === 'custom' && f.from && f.to && f.from > f.to, bad = badAmt || badDate;
  const chip = (act, v, on, label) => `<button type="button" class="chip" data-act="${act}" data-v="${esc(v)}" aria-pressed="${on}">${esc(label)}</button>`;
  const t = r ? periodTitle(r) : null;
  return `<div class="sheet-wrap">
    ${sheetHead('내역 필터')}
    <div class="sheet-b lf-body"><p class="hint lf-sum" id="lf-sum">${month ? '월별' : '카드 청구(' + esc(cardLabel()) + ')'} · 대분류 ${esc(mjLabel(curMajor()))} · ${esc(lfSummary(f))}</p>
      <section class="filter-section" id="lf-period"><h3>기간</h3>
        <div class="seg">${[['cycle', month ? '보던 달' : '보던 청구'], ['all', '전체 기간'], ['custom', '직접 지정']].map(([k, l]) => `<button type="button" data-act="lfperiod" data-v="${k}" aria-pressed="${f.period === k}">${l}</button>`).join('')}</div>
        ${f.period === 'cycle' ? `<div class="cyc lf-cyc"><button type="button" data-act="lfcyc" data-v="-1" aria-label="이전 ${month ? '달' : '청구'}">${icon('left')}</button><div class="lbl"><b>${esc(t.title)}</b>${esc(t.sub)}</div><button type="button" data-act="lfcyc" data-v="1" aria-label="다음 ${month ? '달' : '청구'}" ${f.offset >= 0 ? 'disabled' : ''}>${icon('right')}</button></div>` : ''}
        ${f.period === 'custom' ? `<div class="row2 custom-dates"><label>시작일<input type="date" class="in" data-input="lffrom" value="${esc(f.from || cycleRange(0).start)}" max="${today()}"></label><label>끝일<input type="date" class="in" data-input="lfto" value="${esc(f.to || today())}" max="${today()}"></label></div>` : ''}
        <div class="err">${badDate ? '시작일이 끝일보다 늦어요' : ''}</div>
      </section>
      <section class="filter-section" id="lf-cats"><h3>세부 분류 <span class="h2sub">여러 개 고를 수 있어요</span></h3><div class="chips">${cats.map(c => chip('lfcat', c, f.cats.includes(c), c)).join('')}</div></section>
      <section class="filter-section" id="lf-payers"><h3>결제자</h3><div class="chips">${lfPayers(f).map(p => chip('lfpayer', p, f.payers.includes(p), p)).join('')}</div></section>
      <section class="filter-section" id="lf-methods"><h3>결제수단 <span class="h2sub">카드 명세서와 맞춰 볼 때</span></h3><div class="chips">${methodList(f).map(m => chip('lfmethod', m, f.methods.includes(m), m)).join('')}</div></section>
      <section class="filter-section" id="lf-amount"><h3>금액</h3><div class="row2 amt-range">
        <label>최소 금액(원)<input class="in num" data-money data-input="lfmin" inputmode="numeric" autocomplete="off" placeholder="제한 없음" value="${esc(f.minText != null ? f.minText : f.min ? won(f.min) : '')}" aria-invalid="${!!f.minBad}"${f.minBad ? ' data-raw="1"' : ''}></label>
        <label>최대 금액(원)<input class="in num" data-money data-input="lfmax" inputmode="numeric" autocomplete="off" placeholder="제한 없음" value="${esc(f.maxText != null ? f.maxText : f.max ? won(f.max) : '')}" aria-invalid="${!!f.maxBad}"${f.maxBad ? ' data-raw="1"' : ''}></label></div>
        <div class="err">${esc(amtMsg)}</div></section>
      <section class="filter-section" id="lf-kind"><h3>종류</h3><div class="chips">${KINDS.map(([k, l]) => chip('lfkind', k, f.kind === k, l)).join('')}</div></section>
    </div>
    <div class="sheet-footer lf-foot"><button type="button" class="btn ghost" data-act="lfreset">조건 지우기</button><button type="button" class="btn" data-act="lfapply" ${bad ? 'disabled' : ''}>결과 ${n}건 보기</button></div></div>`;
}
const repaintLf = () => repaintSheet(lfSheetHtml());
function applyListFilter() {
  const off = lfDraft.offset; delete lfDraft.offset; ['minBad', 'maxBad', 'minText', 'maxText'].forEach(k => delete lfDraft[k]);
  if (lfDraft.period === 'cycle' && off !== curOff()) setPeriodOff(off);
  lf = lfDraft; lfDraft = null; listShown = LIST_STEP; calDay = '';
  if (lf.period !== 'cycle' && view.list === 'cal') view.list = 'rows';
  $('#sheet').close(); render(); scrollTo(0, 0);
}
// 조건만 지운다(보던 기간·보기·대분류는 그대로)
function resetListFilter() { lf = LF0(); listShown = LIST_STEP; calDay = ''; }
let qTimer;

/* ---------------- 이벤트 ---------------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const v = b.dataset.v, sheetOpen = $('#sheet').open;
  const go = t => { if ($('#sheet').open) $('#sheet').close(); tab = t; render(); scrollTo(0, 0); };
  switch (b.dataset.act) {
    case 'tab': tab = v; render(); scrollTo(0, 0); break;
    case 'add': if (sheetOpen) { parkImport(); } openEntry(); break;
    /* v25 보기·기간·대분류 (홈·내역·분석 공통) */
    case 'pview': if (pv() === v) { if (sheetOpen) $('#sheet').close(); break; } v25.pv = v; saveV25(); resetShown(); calDay = ''; if (sheetOpen) $('#sheet').close(); render(); calLive((v === 'month' ? '월별' : '카드 청구') + ', ' + periodTitle(curPeriod()).title + ', ' + mjLabel(curMajor())); break;
    case 'cyc': movePeriod(Number(v)); render(); calLive(periodTitle(curPeriod()).aria); break;
    case 'psheet': case 'lperiod': openPeriodSheet(); break;
    case 'pmore': { const n = periodShown; periodShown += PERIOD_STEP; openPeriodSheet(true); afterMore('#sheet .period-opt', n, PERIOD_STEP, '개'); break; }
    case 'ppick': { setPeriodOff(Number(v)); $('#sheet').close(); const r = curPeriod(); if (tab === 'list' && view.list === 'cal') { calDay = calDefault(r); } render(); calLive(periodTitle(r).aria); break; }
    case 'pfindgo': { const off = findPeriod(($('#pfind-m') || {}).value || ''); if (off == null) { $('#pfind-err').textContent = '그 달에 해당하는 기간을 찾지 못했어요. 지난 달 중에서 골라 주세요'; break; } setPeriodOff(off); $('#sheet').close(); render(); break; }
    case 'hauto': if (pv() === 'month') { moff = 0; mShown = ''; } else { offsetTouched = false; autoSig = ''; syncAutoOffset(true); } listShown = LIST_STEP; calDay = ''; if (sheetOpen) $('#sheet').close(); render(); break;
    case 'pcat': v25.cat[pv()] = v; saveV25(); resetShown(); if (sheetOpen) $('#sheet').close(); render(); calLive('분류 ' + mjLabel(v)); break;
    case 'pcatsheet': openCatSheet(); break;
    case 'pcatlist': v25.cat[pv()] = v; saveV25(); resetListFilter(); view.list = 'rows'; go('list'); break;
    case 'homelist': resetListFilter(); view.list = view.list === 'payer' ? 'rows' : view.list; go('list'); break;
    case 'nextbill': offset = 0; offsetTouched = true; resetListFilter(); view.list = 'rows'; go('list'); break;
    case 'analysis': anShown = AN_STEP; anDetail = ''; go('analysis'); break;
    case 'andetail': anDetail = v; anShown = AN_STEP; render(); scrollTo(0, 0); break;
    case 'anback': anDetail = ''; anShown = AN_STEP; render(); scrollTo(0, 0); break;
    case 'ansub': { const [k, x] = v.split(':'); view.anSub[k] = x; saveView(); anShown = AN_STEP; render(); break; }
    case 'anmore': { const n = anShown; anShown += AN_STEP; render(); afterMore('[data-ui-key=an-bars] .bar-line', n, AN_STEP, '개'); break; }
    // 분석에서 내역으로: 보던 기간·카드·대분류·적용 조건을 그대로 두고 누른 항목만 더한다(Astra v25 P1-12)
    case 'anpick': { const i = v.indexOf(':'), sub = v.slice(0, i), key = v.slice(i + 1); lf = Object.assign({}, lf); listShown = LIST_STEP; calDay = ''; if (sub === 'major') { v25.cat[pv()] = key; saveV25(); } else if (sub === 'detail') lf.cats = [key]; else lf.merchant = key; view.list = 'rows'; go('list'); break; } // 거래처는 검색어를 바꾸지 않고 정확히 그 거래처(Astra P1-12)
    case 'antable': openAnTable(); break;
    case 'payermore': { const n = payerShown; payerShown += PAYER_STEP; render(); afterMore('.people .person', n, PAYER_STEP, '명'); break; }
    case 'lfmerchx': lf = Object.assign({}, lf, { merchant: '' }); listShown = LIST_STEP; render(); break;
    case 'payerlist': lf = Object.assign({}, lf, { payers: [v] }); listShown = LIST_STEP; calDay = ''; view.list = 'rows'; go('list'); break; // 결제자 합계와 같은 조건 + 결제자만(Astra v25 P1-12)
    case 'lmore': { const n = listShown; listShown += LIST_STEP; render(); afterMore('[data-ui-key=rows] .swipe', n, Math.min(LIST_STEP, listData().txs.length - n), '건'); break; }
    case 'qgo': { const q = $('[data-input=q]'); if (q) { lf.q = q.value; q.blur(); } listShown = LIST_STEP; render(); break; }
    /* 카드값 */
    case 'setpay': openPaySheet(); break;
    case 'paymethod': b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); break;
    case 'stmt': openStatement(); break;
    case 'cardpick': openCardSheet(); break;
    case 'cardset': v25.card = v; saveV25(); listShown = LIST_STEP; $('#sheet').close(); render(); break;
    case 'billlist': resetListFilter(); if (pv() !== 'bill') { v25.pv = 'bill'; saveV25(); } view.list = 'rows'; go('list'); break;
    case 'favlist': openFavList(); break;
    case 'favmore': { const n = favShown; favShown += MGR_STEP; openFavList(true); afterMore('#sheet .favorite', n, MGR_STEP, '개'); break; }
    case 'favmgrmore': { const n = favMgrShown; favMgrShown += MGR_STEP; openFavManage('', true); afterMore('#sheet .favorite-row', n, MGR_STEP, '개'); break; }
    case 'favsave': saveFavorite(v); break;
    case 'ctxedit': { const c = $('#date'); if (c) { c.scrollIntoView({ block: 'center' }); c.focus({ preventScroll: true }); try { c.showPicker && c.showPicker(); } catch (er) {} } break; }
    case 'morecat': { const pk = $('#cat-pick'); if (!pk) break; const open = !pk.classList.contains('open'); pk.classList.toggle('open', open);
      const t = open ? $('#cats [aria-pressed=true]') || $('#cats .cat-cell') : $('#sheet .cat-more'); if (t) t.focus({ preventScroll: true }); if (open) { const g = $('#cats'); if (g) g.scrollIntoView({ block: 'nearest' }); } break; }
    /* 예산 */
    case 'budget': openBudget(!sheetOpen); break;
    case 'bmon': bud.ym = core.addMonths(bud.ym, Number(v)); bud.field = ''; openBudget(); break;
    case 'bedit': openBudgetEdit(v); break;
    case 'blegacy': showSheet(budgetLegacyHtml(budgetState(), true), true); break;
    case 'blegacykeep': if (store.setPrefs({ budget_basis: 'legacy' })) { openBudget(); savedToast('기존 주기 예산을 그대로 써요'); } break;
    case 'bmonthstart': startMonthBudget(); break;
    case 'bcleanup': { const ks = oldMonthKeys(); if (!ks.length || !confirm(`24개월 지난 월 예산 ${ks.length}개를 지울까요? 지난 달 예산 표시가 기본값으로 바뀔 수 있어요.`)) break; if (store.setPrefs(Object.fromEntries(ks.map(k => [k, null])))) { openBudget(); savedToast(`오래된 월 예산 ${ks.length}개를 정리했어요`); } break; }
    case 'blegacyedit': openLegacyBudgetForm(); break;
    /* 대분류 연결 */
    case 'mapping': openMapping(); break;
    case 'mapmore': { const n = mapShown; mapShown += MGR_STEP; openMapping(true); afterMore('#sheet .map-sec .settings-row', n, MGR_STEP, '개'); break; }
    case 'mapitem': openMapItem(v); break;
    case 'mappick': if (mapSel) { mapSel.id = v; setPressed(b.parentElement, v); } break;
    case 'mapsave': saveMapItem(false); break;
    case 'mapclear': saveMapItem(true); break;
    case 'cfsave': saveConflict(false); break;
    case 'cfkeep': saveConflict(true); break;
    case 'cfopen': openConflictSafe(v); break;
    /* 공유 상태 */
    case 'statusrow': { if (store.pendingDetail().conflicts && !store.pendingDetail().total) { openConflict(Object.keys(store.conflicts())[0]); break; } const n = store.pendingDetail().total, st = store.status(); if ((n || st.error) && navigator.onLine !== false) { sync(); toast(`공유 대기 ${n}건을 지금 다시 보내요`); } else openSyncSheet(); break; }
    case 'syncsheet': openSyncSheet(); break;
    case 'syncnow': sync(); setTimeout(() => { if ($('#sheet [data-ui-key=sync-box]')) openSyncSheet(); }, 50); break;
    /* 설정 */
    case 'cardsettings': openCardSettings(); break;
    case 'theme': store.setLocal('theme', v === 'system' ? null : v); applyTheme(S.theme); render(); if ($('#sheet .kp-toggle')) setPressed(b.parentElement, v); break;
    case 'appsheet': openAppSheet(); break;
    case 'displaysheet': openDisplaySheet(); break;
    case 'kptoggle': if (!store.setLocal('keypad', !!b.checked)) { b.checked = !b.checked; toast('기기에 저장하지 못했어요'); break; } render(); break;
    case 'kpmode': { const on = !useKeypad(); if (!store.setLocal('keypad', on)) { toast('기기에 저장하지 못했어요'); break; } setEntryKeypad(on); break; } // 버튼 이름이 바뀌어 알림 없이도 보임(알림이 대분류 칸을 가리지 않게). 이 기기에 기억
    case 'themetoggle': store.setLocal('theme', isDark() ? 'light' : 'dark'); applyTheme(S.theme); render(); break;
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
    case 'close': if (editDirty()) { askDiscard(() => { saved = true; closeSheet(); }); break; } closeSheet(); break;
    case 'refunds': resetListFilter(); lf.kind = 'refund_pending'; lf.period = 'all'; view.list = 'rows'; go('list'); break;
    /* 내역 필터 */
    case 'lfopen': openListFilter(v); break;
    case 'lfclear': resetListFilter(); render(); break;
    case 'qclear': lf.q = ''; listShown = LIST_STEP; render(); { const q = $('[data-input=q]'); if (q) { q.value = ''; q.focus(); } } break;
    case 'lfperiod': lfDraft.period = v; if (v === 'custom' && !lfDraft.from) { const r = curPeriod(); lfDraft.from = r.start; lfDraft.to = r.end < today() ? r.end : today(); } repaintLf(); break;
    case 'lfcyc': lfDraft.offset = Math.min(0, lfDraft.offset + Number(v)); repaintLf(); break;
    case 'lfcat': case 'lfpayer': case 'lfmethod': { const k = b.dataset.act === 'lfcat' ? 'cats' : b.dataset.act === 'lfpayer' ? 'payers' : 'methods'; lfDraft[k] = lfDraft[k] || []; lfDraft[k] = lfDraft[k].includes(v) ? lfDraft[k].filter(x => x !== v) : [...lfDraft[k], v]; repaintLf(); break; }
    case 'lfkind': lfDraft.kind = v; repaintLf(); break;
    case 'lfreset': lfDraft = Object.assign(LF0(), { offset: curOff() }); repaintLf(); break;
    case 'lfapply': applyListFilter(); break;
    case 'listmenu': listMenu(); break;
    /* 가져오기 */
    case 'impopen': openImport(v); break;
    case 'impfile': imp.step = 'file'; imp.err = ''; renderImport(); break;
    case 'impback': imp.err = ''; imp.editing = -1; imp.resumed = false; imp.step = imp.step === 'review' ? (imp.kind === 'paste' ? 'paste' : 'map') : 'file'; renderImport(); break;
    case 'impfresh': { const k = imp.kind; imp = null; impPrev = null; openImport(k); break; }
    case 'impenc': { const f = imp.file; f.enc = f.enc === 'euc-kr' ? '' : 'euc-kr'; f.sheets = [{ name: f.name, rows: core.parseCsv(core.decodeText(f.u8, f.enc || undefined)) }]; f.si = 0; setupMapping(); renderImport(); break; }
    case 'impneg': imp.file.negative = v; renderImport(); break;
    case 'impgoneg': { renderImport(); const nf = $('#neg-field'); if (nf) { nf.scrollIntoView({ block: 'center' }); const first = nf.querySelector('[data-act=impneg]'); if (first) first.focus({ preventScroll: true }); } break; }
    case 'impfind': {
      const f = imp.file;
      if (f.mapping.date < 0 || f.mapping.amount < 0) { imp.err = '날짜와 금액 열을 골라 주세요'; renderImport(); break; }
      if (imp.items.some(it => it.edited) && !confirm('확인 목록에서 고친 내용이 사라져요. 다시 찾을까요?')) break;
      const conv = core.rowsToCandidates(f.data, f.mapping, convOpts(f));
      if (conv.negatives && !f.negative) { imp.err = '음수 금액을 어떻게 가져올지 골라 주세요'; renderImport(); break; }
      imp.items = prepareItems(conv.items, false); imp.unread = conv.unread; imp.step = 'review'; imp.shown = REVIEW_STEP; imp.editing = -1; imp.err = '';
      renderImport(); $('#sheet .sheet-b').scrollTop = 0; break;
    }
    case 'impchk': {
      const it = imp.items[Number(v)];
      if (b.checked && impBlocked(it)) { b.checked = false; break; } // 선택 불가(체크 비활성): 고치는 건 '수정' 버튼으로
      it.on = b.checked; b.closest('.import-row').classList.toggle('on', it.on); refreshImpFooter(); break;
    }
    case 'impsel': if (!commitEdit()) break; imp.items.forEach(it => { it.on = v === 'new' ? impDefaultOn(it) : false; }); imp.err = ''; renderImport(); break;
    case 'impedit': openEditor(Number(v)); break;
    case 'impcancel': imp.editing = -1; renderImport(); break;
    case 'impapply': if (commitEdit()) renderImport(); break;
    case 'ietype': setPressed(b.parentElement, v); break;
    case 'impmore': { if (!commitEdit()) break; const n = imp.shown; imp.shown += REVIEW_STEP; renderImport(); afterMore('#sheet .import-row', n, Math.min(REVIEW_STEP, imp.items.length - n), '건'); break; }
    case 'impsave': impSave(); break;
    /* 즐겨찾기 */
    case 'favadd': addFavorite(); break;
    case 'favdel':
      if ($('[data-form=entry]')) { const ok = removeFavorite(v, true); const x = $('[data-act=favdel]'); if (x) x.outerHTML = favButton(); $('#fav-msg').textContent = ok ? '즐겨찾기에서 뺐어요(두 사람 모두에게서)' : '즐겨찾기를 지우지 못했어요'; }
      else { const gone = favorites().find(f => f.id === v); const ok = removeFavorite(v, true); favUndo = ok ? gone : null; openFavManage(ok ? `${esc(gone.merchant)} 즐겨찾기를 지웠어요. <button type="button" class="link" data-act="favundo">되돌리기</button>` : '즐겨찾기를 지우지 못했어요', true); }
      break;
    case 'favundo': if (favUndo && !favorites().some(f => f.id === favUndo.id)) store.setPrefs({ favorites: favorites().concat(favUndo) }); favUndo = null; openFavManage('되돌렸어요', true); break;
    case 'favmanage': if (!stashDraft()) break; openFavManage(); break;
    case 'me': store.setLocal('me', v); render(); break;
    case 'sync': sync(); break;
    case 'merchant': $('#merchant').value = v; draft.merchant = v; suggestFor(v); break;
    case 'key': keyIn(v); break;
    case 'datepick': { const di = $('#date'); if (di && di.showPicker) { try { di.showPicker(); } catch (er) { di.focus(); } } break; }
    case 'kpshow': { const f = $('[data-form=entry]'); if (f) f.classList.remove('kp-off'); const a = $('#amount'); if (a && document.activeElement !== a && !e.target.closest('label')) a.focus({ preventScroll: true }); break; }
    case 'cat': { // 대분류: 새 서버는 major 칸(세부 분류와 따로), 옛 서버는 분류 칸에 대분류 이름(v25 1차 방식)
      const id = core.MAJOR_IDS[MAJOR_NAMES.indexOf(v)];
      if (hasMajorCol()) draft.major = draft.major === id ? '' : id;
      else { if (entryMajor() === v && draft.category !== v) break; draft.category = draft.category === v ? '' : v; }
      draft.catSug = false; refreshCats(); refreshFavButton(); refreshSummary(); break; }
    case 'ucat': draft.category = draft.category === v ? '' : v; draft.catSug = false; setPressed($('#cats'), draft.category); refreshFavButton(); refreshSummary(); break; // 옛 서버: v24처럼 분류 하나
    case 'dcat': draft.category = draft.category === v ? '' : v; if (!hasMajorCol() && draft.category) draft.major = ''; draft.catSug = false; refreshCats(); refreshFavButton(); refreshSummary(); break;
    case 'type': draft.type = v; setPressed(b.parentElement, v); refreshSummary(); refreshFavButton(); break;
    case 'delete':
      { const id = draft.id; askDelete(id, () => { saved = true; $('#sheet').close(); }); }
      break;
    case 'csv': exportCsv(); break;
    case 'update': if (verFailed || verSlow || !verLatest) { verCheckedAt = 0; checkUpdate(true); } else applyUpdate(); break;
    case 'rule': openRule(v); break;
    case 'recurall': openRecurAll(v); break;
    case 'recurmore': { const n = recurAll.shown; recurAll.shown += RECUR_ALL_STEP; openRecurAll(recurAll.kind, true); afterMore('#sheet .recur-all > *', n, RECUR_ALL_STEP, '건'); break; }
    case 'recmon': rmoff = Math.max(-24, Math.min(12, rmoff + Number(v))); render(); break;
    case 'rulemanage': openRuleManage(); break;
    case 'rmmore': { const n = ruleMgrShown; ruleMgrShown += MGR_STEP; openRuleManage(true); afterMore('#sheet [data-ui-key=rule-list] .settings-row', n, MGR_STEP, '개'); break; }
    case 'lmode': view.list = v; saveView(); resetShown(); if (tab !== 'list') go('list'); else render(); break;
    case 'calday': if (calEatClick && Date.now() - calEatClick < 400) { calEatClick = 0; break; } calEatClick = 0; calDay = v; calPicked[curPeriod().start] = v; render(); break;
    case 'calcyc': changeCalendarCycle(Number(v)); break;
    case 'caltoday': if (pv() === 'month') { moff = 0; mShown = ''; } else { offset = 0; offsetTouched = true; shownCycle = null; } calDay = today(); calAnim = 'fade'; render(); calLive('오늘, ' + md(calDay) + ' 선택'); break;
    case 'caladd': if (sheetOpen) $('#sheet').close(); openEntry(null, { date: v }); break;
    case 'dayview': openDaySheet(v); break;
    case 'daymore': { const bd = $('#sheet .sheet-b'), day = bd ? bd.dataset.day : '', n = dayShown; dayShown += DAY_STEP; if (day) { openDaySheet(day, true); afterMore('#sheet .sel-rows .swipe', n, DAY_STEP, '건'); } break; }
    case 'rfreq': readRule($('[data-form=rule]')); ruleDraft.freq = v; ruleDraft.day = v === 'week' ? 1 : Math.min(28, new Date().getDate()); $('#sheet').innerHTML = ruleHtml(); break;
    case 'rtoggle': toggleRule(v); break;
    case 'rdelete': deleteRule(); break;
    case 'disconnect':
      if (store.pendingDetail().total) { toast('공유 대기 기록·설정이 있어요. 먼저 공유해 주세요'); break; }
      if (store.pendingDetail().conflicts) { openDisconnectGuard(); break; }
      if (confirm('이 기기 연결을 해제할까요? 기록은 구글 시트에 남아 있어요.')) store.disconnect();
      break;
    case 'discdrop': dropAndDisconnect(); break;
    case 'cfpick': { const [f, w] = v.split('|'); cfState.picks[f] = w; const c = store.conflicts()[cfState.key]; const pe = $('#cf-progress'); if (c && pe) { const n = c.fields.filter(x => cfState.picks[x]).length; pe.querySelector('.num').textContent = n + '/' + c.fields.length; } const er = $('#cf-err'); if (er) er.textContent = ''; break; }
    case 'cfmore': { const n = cfState.shown; cfState.shown += CF_STEP; openConflict(cfState.key, true); afterMore('#sheet .cf-row', n, CF_STEP, '개'); break; }
  }
});
document.addEventListener('input', e => {
  const k = e.target.dataset && e.target.dataset.input;
  if (e.target.matches('[data-form=settings] input,[data-form=settings] select,[data-form=settings] textarea,[data-form=setup] input,[data-form=setup] textarea')) dirtyControls.add(e.target);
  if (k === 'q') { lf.q = e.target.value; listShown = LIST_STEP; clearTimeout(qTimer); if (!e.isComposing) qTimer = setTimeout(render, 150); }
  if (k === 'lfmin' || k === 'lfmax' || k === 'lffrom' || k === 'lfto') {
    if (k === 'lfmin' || k === 'lfmax') {
      moneyInput(e.target, e); const r = core.parseWon(e.target.value), key = k === 'lfmin' ? 'min' : 'max';
      lfDraft[key] = r.ok ? r.value : 0; lfDraft[key + 'Text'] = e.target.value; lfDraft[key + 'Bad'] = !r.ok && r.error !== 'empty' ? WON_ERR[r.error] : '';
    }
    else if (e.target.value) lfDraft[k === 'lffrom' ? 'from' : 'to'] = e.target.value;
    const tmp = document.createElement('div'); tmp.innerHTML = lfSheetHtml();
    ['.lf-foot', '#lf-amount .err', '#lf-period .err'].forEach(sel => { const a = $('#sheet ' + sel), b2 = tmp.querySelector(sel); if (a && b2) a.outerHTML = b2.outerHTML; });
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
  if (k === 'stmt') {
    const msg = moneyInput(e.target, e); stmtText = e.target.value;
    const cr = core.parseClaimWon(stmtText), ledger = stmtLedger();
    $('#stmt-err').textContent = cr.ok || cr.error === 'empty' ? '' : msg || WON_ERR[cr.error];
    if (cr.ok) e.target.setAttribute('aria-invalid', 'false');
    if (cr.ok || !stmtText.trim()) saveStmtMemo(ledger);
    const res = $('#stmt-res'); if (res) res.innerHTML = stmtResult(ledger);
    return;
  }
  if (e.target.id === 'amount' || e.target.id === 'r-amount' || e.target.dataset.money !== undefined) {
    let msg = moneyInput(e.target, e);
    // 예산 칸: 빈칸·0 = 미설정(오류 아님, spec 6.3)
    if (e.target.closest('[data-form=budget],[data-form=budget-legacy]') && core.parseBudgetWon(e.target.value).ok) { msg = ''; e.target.setAttribute('aria-invalid', 'false'); }
    const err = $(e.target.id === 'amount' ? '#entry-err' : e.target.id === 'r-amount' ? '#rule-err' : e.target.id === 'ie-amount' ? '#ie-err' : e.target.closest('[data-form=budget]') ? '#budget-err' : '#none');
    if (err) err.textContent = msg;
  }
});
document.addEventListener('compositionend', e => { if (e.target.dataset.input === 'q') { lf.q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(render, 150); } });
document.addEventListener('change', e => {
  if (e.target.id === 'merchant') { draft.merchant = e.target.value.trim(); suggestFor(draft.merchant); }
  if (e.target.closest && e.target.closest('[data-form=entry]')) { refreshFavButton(); if (['date', 'payer', 'method', 'rp', 'note'].includes(e.target.id)) { readEntry(e.target.form); refreshSummary(); } }
  if (e.target.id === 'imp-file' && e.target.files && e.target.files[0]) loadImportFile(e.target.files[0]);
  if (e.target.id === 'payday') { const pv = $('#pay-preview'); if (pv) pv.textContent = payPreview(core.validPayDay(e.target.value)); }
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
    if (draft.amountErr) { $('#entry-err').textContent = WON_ERR[draft.amountErr]; $('#amount').setAttribute('aria-invalid', 'true'); $('#amount').focus(); return; }
    if (draft.date > today()) { $('#entry-err').textContent = '미래 날짜는 기록할 수 없어요'; return; }
    const rec = Object.assign({}, draft); delete rec.amountText; delete rec.amountErr; delete rec.catSug;
    // 대분류: 옛 서버에는 보내지 않는다(받아 줄 열이 없어 조용히 사라지므로). 새 서버에서 지운 대분류는 '-'(빈 값은 서버가 기존 값을 유지)
    if (!hasMajorCol()) { if (!(editing && store.get(rec.id) && store.get(rec.id).major)) delete rec.major; }
    else if (!rec.major && editing && store.get(rec.id) && core.MAJOR_IDS.includes(store.get(rec.id).major)) rec.major = '-';
    if (upsert(rec)) { saved = true; store.setLocal('draft', null); $('#sheet').close(); render(); savedEntryToast(rec, editing); }
    else { const fe = $('#entry-foot-err'); if (fe) fe.textContent = '저장하지 못했어요. 기기 저장공간을 확인한 뒤 다시 눌러 주세요'; }
  }
  if (kind === 'rule') { saveRule(f); return; }
  if (kind === 'paste') {
    const text = $('#paste-text').value; imp.text = text;
    if (document.activeElement) document.activeElement.blur();
    const r = core.parseNotices(text, { today: today() });
    if (!r.items.length) { imp.err = text.trim() ? '카드 알림을 찾지 못했어요. 금액(원)이 들어 있는 알림인지 확인해 주세요' : '붙여넣은 내용이 없어요'; renderImport(); return; }
    imp.err = ''; imp.resumed = false; imp.items = prepareItems(r.items, true); imp.unread = r.unread; imp.step = 'review'; imp.editing = -1; imp.shown = REVIEW_STEP;
    renderImport(); $('#sheet .sheet-b').scrollTop = 0; return;
  }
  if (kind === 'budget') { saveBudget(f); return; }
  if (kind === 'pay') { savePay(f); return; }
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
// 저장한 기록이 지금 보는 기간·보기 밖이면 어디에 들어갔는지 알리고 '보기'로 그 기간 내역을 연다(spec 4.3: 사라진 것처럼 느끼지 않게)
function savedEntryToast(rec, wasEdit) {
  const msg = wasEdit ? '고쳤어요' : '기록했어요';
  if (!['home', 'list', 'analysis'].includes(tab)) { toast(msg); return; }
  const p = curPeriod(), inScope = p.kind === 'month' || billMethods().includes(rec.method || '');
  if (rec.date >= p.start && rec.date <= p.end && inScope) { toast(msg); return; }
  const where = p.kind === 'bill' && !inScope ? `${rec.method || '이 결제수단'}은 카드값에 넣지 않아요 · 월별에 보여요`
    : p.kind === 'bill' ? (rec.date > p.end ? '이 이용 기간 뒤라 다음 청구에 들어가요' : '다른 청구에 들어가요') : `${parseDate(rec.date).getMonth() + 1}월 기록이에요`;
  toast(`${msg} · ${where}`, '보기', () => jumpToRecord(rec));
}
function jumpToRecord(rec) {
  if (pv() === 'bill' && !billMethods().includes(rec.method || '')) { v25.pv = 'month'; saveV25(); }
  if (pv() === 'month') moff = Math.min(0, core.monthOffsetOf(rec.date.slice(0, 7)));
  else for (let k = 0; k >= -240; k--) { const r = cycleRange(k); if (rec.date >= r.start && rec.date <= r.end) { offset = k; offsetTouched = true; break; } }
  resetListFilter(); view.list = 'rows'; tab = 'list'; render(); scrollTo(0, 0);
}
// 저장하지 않고 닫은 새 기록은 초안으로 보관 (다음에 + 누르면 이어서)
// 저장하지 못하면 false: 닫지 않고 이유를 남긴다(Astra V22-04). 잘못된 금액 원문만 있어도 초안으로 남긴다
function stashDraft() {
  const f = $('[data-form=entry]');
  if (!saved && !editing && draft && f) {
    readEntry(f);
    const has = draft.amount || (draft.amountText || '').trim() || draft.merchant || draft.note;
    if (!store.setLocal('draft', has ? draft : null)) {
      const fe = $('#entry-foot-err'); if (fe) fe.textContent = has ? '작성 중인 내용을 기기에 남기지 못했어요. 기록하거나 기기 저장공간을 확인해 주세요' : '이전 초안을 지우지 못했어요. 기기 저장공간을 확인한 뒤 다시 닫아 주세요';
      return false;
    }
  }
  draft = null;
  return true;
}
$('#sheet').addEventListener('cancel', e => {
  if (editDirty()) { e.preventDefault(); askDiscard(() => { saved = true; closeSheet(); }); return; }
  if (!stashDraft()) { e.preventDefault(); return; }
  parkImport();
});
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

/* ---------------- 키보드·화면 크기 대응 ----------------
 * --vvh/--vvt = 키보드를 뺀 실제 보이는 높이·위치(아이폰은 키보드가 떠도 창 높이가 그대로라 직접 잰다).
 * 키보드가 떠 있으면 html.kbd: 시트 아래 버튼의 홈 막대 여백을 줄이고, 입력 칸을 다시 보이게 올린다.
 * --nav-h = 아래 탭 실제 높이(글자 크기·safe-area 포함). 본문 아래 여백과 알림 위치가 이 값을 따른다. */
function vvFit(h, top) {
  const root = document.documentElement;
  root.style.setProperty('--vvh', h + 'px');
  root.style.setProperty('--vvt', top + 'px');
  const kb = innerHeight - h > 120;
  if (root.classList.contains('kbd') !== kb) root.classList.toggle('kbd', kb);
  fitSheet(); fitSticky();
  const a = document.activeElement;
  if (kb && a && a.closest && a.closest('#sheet') && a.matches('input,select,textarea')) requestAnimationFrame(() => revealField(a, 'instant'));
}
// 시트 안 입력 칸을 보이는 영역 안으로. 칸이 영역보다 크면(긴 붙여넣기 칸) 위쪽을 맞춘다
function revealField(a, behavior) {
  const box = a.closest('.sheet-b');
  a.scrollIntoView({ block: box && a.offsetHeight > box.clientHeight * .7 ? 'start' : 'nearest', behavior });
}
// 시트 본문이 160px보다 좁아지면(가로 화면+키보드) 아래 버튼을 본문과 같이 스크롤되게 한다(Astra 시트 4)
function fitSheet() {
  const dlg = $('#sheet'); if (!dlg || !dlg.open) return;
  dlg.classList.remove('tight');
  const b = dlg.querySelector('.sheet-b');
  if (b && b.clientHeight < 160 && dlg.querySelector('.sheet-footer')) dlg.classList.add('tight');
}
// 결과 합계 줄이 화면 높이의 25%를 넘으면(큰 글자) 붙어 있지 않게 한다(Astra L03)
// 거래 행: 금액이 내용 폭의 45%를 넘거나 거래처에 8글자(8em)를 못 주면 금액을 거래처 아래 줄로(Astra X02·V22-05)
function fitRows() {
  const rows = [...document.querySelectorAll('#app .tx, #sheet .tx')];
  const want = rows.map(row => {
    const a = row.querySelector('.a'); if (!a || !row.clientWidth) return null;
    const fs = parseFloat(getComputedStyle(row).fontSize) || 16, ic = row.querySelector('.ic');
    const content = row.clientWidth - (ic ? ic.offsetWidth : 38) - 12;
    const rg = document.createRange(); rg.selectNodeContents(a); // 줄이 나뉘어 있어도 글자 전체 폭(조각 폭 합)
    const aw = [...rg.getClientRects()].reduce((w, r) => w + r.width, 0);
    return aw > content * .45 || content - aw - 12 < 8 * fs;
  });
  rows.forEach((row, i) => { if (want[i] !== null && row.classList.contains('stack') !== want[i]) row.classList.toggle('stack', want[i]); });
  // 확인 목록 행(거래처 | 금액)도 같은 기준
  const tops = [...document.querySelectorAll('#sheet .imp-top')];
  const want2 = tops.map(top => {
    const a = top.querySelector('.imp-a'); if (!a || !top.clientWidth) return null;
    const fs = parseFloat(getComputedStyle(top).fontSize) || 16, rg = document.createRange(); rg.selectNodeContents(a);
    const aw = [...rg.getClientRects()].reduce((w, r) => w + r.width, 0);
    return aw > top.clientWidth * .45 || top.clientWidth - aw - 8 < 8 * fs;
  });
  tops.forEach((top, i) => { if (want2[i] !== null && top.classList.contains('stack') !== want2[i]) top.classList.toggle('stack', want2[i]); });
}
addEventListener('resize', () => fitRows());
function fitSticky() {
  const el = document.querySelector('.results-sticky');
  const root = document.documentElement;
  if (!el) { root.style.setProperty('--sticky-h', '0px'); return; }
  const vh = window.visualViewport ? visualViewport.height : innerHeight, h = el.getBoundingClientRect().height;
  const off = h > vh * .14; // v25: 큰 글자에서 합계 줄이 화면을 덮지 않게(이전 25%)
  if (el.classList.contains('no-stick') !== off) el.classList.toggle('no-stick', off);
  // 붙어 있는 합계 줄 아래로 포커스가 숨지 않게(실제 높이 + 12px)
  root.style.setProperty('--sticky-h', off || getComputedStyle(el).position !== 'sticky' ? '0px' : Math.round(h + 12) + 'px');
}
// 시트 아래 버튼·본문 크기가 바뀌면(오류 줄 추가, 글자 크기, 내용 교체) 좁은 시트 판정과 시트 안 알림 위치를 다시 잰다(Astra V22-07)
if (window.ResizeObserver) {
  const sheetRO = new ResizeObserver(() => {
    fitSheet(); fitRows();
    const t = document.querySelector('#sheet .toast.in-sheet'), f = document.querySelector('#sheet .sheet-footer');
    if (t) t.style.bottom = (f ? f.getBoundingClientRect().height : 0) + 12 + 'px';
  });
  const watchSheet = () => { const d = $('#sheet'); sheetRO.disconnect(); sheetRO.observe(d); d.querySelectorAll('.sheet-footer,.sheet-b').forEach(e => sheetRO.observe(e)); };
  new MutationObserver(watchSheet).observe($('#sheet'), { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
  const stickyRO = new ResizeObserver(() => fitSticky());
  new MutationObserver(() => { const el = document.querySelector('.results-sticky'); stickyRO.disconnect(); if (el) stickyRO.observe(el); }).observe($('#app'), { childList: true, subtree: true });
  addEventListener('resize', fitSticky);
}
window.__vvFit = vvFit; // 레이아웃 점검(layout-matrix)이 키보드를 흉내 낼 때 쓴다
if (window.visualViewport) {
  const fit = () => vvFit(visualViewport.height, visualViewport.offsetTop);
  visualViewport.addEventListener('resize', fit);
  visualViewport.addEventListener('scroll', fit); fit();
}
if (window.ResizeObserver) {
  const navObs = new ResizeObserver(() => {
    requestAnimationFrame(fitRows); // 글자 크기·글꼴이 바뀌면 탭 높이도 바뀐다 → 거래 행 배치도 다시
    const n = document.querySelector('nav.tabs'), r = n && n.getBoundingClientRect();
    const bottomBar = r && r.width > r.height;
    document.documentElement.style.setProperty('--nav-h', (bottomBar ? Math.round(r.height) : 0) + 'px');
  });
  new MutationObserver(() => { const n = document.querySelector('nav.tabs'); if (n && !n.dataset.obs) { n.dataset.obs = 1; navObs.observe(n); } }).observe($('#app'), { childList: true });
  addEventListener('resize', () => { const n = document.querySelector('nav.tabs'); if (n) { navObs.unobserve(n); navObs.observe(n); } });
}
// 입력 칸 포커스 때 타이머로 가운데 맞추던 동작은 뺐다(OS 자동 스크롤과 이중 이동, Astra N04). 키보드가 열린 뒤 가려졌을 때만 vvFit이 옮긴다.

/* ---------------- 앱 업데이트 ---------------- */
// 버전 = sw.js의 CACHE 이름. 이 화면을 연 시점의 버전과 지금 서버의 sw.js를 비교한다.
let verRunning = '', verLatest = '', verCheckedAt = 0;
// 실행 중 버전 = 이 화면을 연 서비스 워커의 캐시 이름(없으면 첫 조회값), 서버 버전 = 지금 sw.js. 실패·지연은 버전보다 먼저 보인다(Astra V22-10)
let verFailed = false, verSlow = false, verOkAt = 0;
// 이 화면을 맡은 서비스 워커에게 자기 캐시 이름을 묻는다(여러 캐시가 남아 있어도 정확)
if (navigator.serviceWorker && navigator.serviceWorker.controller) {
  navigator.serviceWorker.addEventListener('message', e => { const v = e.data && e.data.version && String(e.data.version).replace('sai-shell-', ''); if (v) { verRunning = v; const el = $('#ver'); if (el) el.textContent = verText(); } });
  try { navigator.serviceWorker.controller.postMessage('version'); } catch (e) {}
}
function verText() {
  const cur = verRunning ? '현재 ' + verRunning : '현재 버전 확인 중';
  const last = verOkAt ? ' · 마지막 확인 ' + new Date(verOkAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }) : '';
  if (verFailed) return cur + ' · 최신 버전을 확인하지 못했어요' + last + ' · 눌러서 다시 확인';
  if (verSlow) return cur + ' · 확인이 오래 걸려요' + last + ' · 눌러서 다시 확인';
  if (!verLatest) return cur;
  return cur + (verLatest !== verRunning ? ' · 새 버전이 있어요 (' + verLatest + ') · 눌러서 업데이트' : ' · 최신 버전이에요' + last);
}
async function checkUpdate(force) {
  if (!force && Date.now() - verCheckedAt < 5 * 60e3) return verLatest !== verRunning;
  verCheckedAt = Date.now(); verFailed = false; verSlow = false;
  const slow = setTimeout(() => { verSlow = true; const el = $('#ver'); if (el) el.textContent = verText(); }, 5000);
  try {
    const ctrl = new AbortController(), kill = setTimeout(() => ctrl.abort(), 10000);
    const src = await (await fetch('sw.js?t=' + Date.now(), { cache: 'no-store', signal: ctrl.signal })).text();
    clearTimeout(kill);
    const v = (src.match(/sai-shell-([\w.-]+)/) || [])[1];
    if (v) { verLatest = v; verOkAt = Date.now(); if (!verRunning) verRunning = v; } else { verFailed = true; verCheckedAt = 0; }
  } catch (e) { verFailed = true; verCheckedAt = 0; }
  clearTimeout(slow); verSlow = false; // 늦게라도 끝나면(성공·실패) '오래 걸려요'는 지운다
  { const el = $('#ver'); if (el) el.textContent = verText(); }
  if (verFailed) return false;
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
// 저장 보호(v25): 연결된 기기에서 한 번 요청(이미 허락됐으면 다시 묻지 않음). 결과는 설정 → 앱·연결에 보인다
if (store.connected() && !(S.persist && S.persist.state === 'granted')) store.persistStorage();
// 넓은 화면(>840)에서만 달력 선택일 기록을 오른쪽 칸에 펼친다 → 폭이 그 경계를 넘으면 다시 그림
{ let wasWide = wide(); addEventListener('resize', () => { if (wide() !== wasWide) { wasWide = wide(); render(); } }); }
