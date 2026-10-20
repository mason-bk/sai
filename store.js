'use strict';
/* =====================================================================
 * 데이터 층 (store)
 * 화면 코드(app.js)는 저장·동기화·연결을 이 파일의 store.* 로만 한다.
 * 서버를 바꿀 때(예: Apps Script + 구글 시트 → 정식 DB·간편로그인) 이 파일만 갈아끼운다.
 *
 * 인터페이스 (화면이 쓰는 전부)
 *   읽기      S                       메모리 스냅샷. 화면은 읽기만 한다
 *             store.list()            지우지 않은 기록 배열
 *             store.get(id)           기록 하나(지운 것 포함)
 *             store.isPending(id)     아직 서버에 안 간 기록인지
 *             store.pendingCount()    공유 대기 건수
 *   기록      store.upsert(rec)       새 기록/수정 → true|false(기기 저장 실패)
 *             store.upsertMany(recs)  여러 건을 한 번에 저장·전송
 *             store.remove(id)        지운 표시(되돌리기는 upsert로 deleted:false)
 *   공유 설정 store.settings()        분류·결제수단·결제자·주기·정기·prefs
 *             store.saveSettings(p)   일부 키만 바꿔 저장·전송
 *             store.prefs()           prefs 객체(없으면 null = 서버 구버전)
 *             store.setPrefs(p)       prefs 일부 키 저장 → true|false(용량 초과·서버 구버전)
 *   기기 설정 store.local(k) / store.setLocal(k, v)   me·view·draft 처럼 이 기기에만 남는 값
 *   동기화    store.sync(), store.status() → { syncing, error, lastSync }
 *   연결      store.connected(), store.parseCode(text), store.validUrl(url), store.connect(cfg), store.disconnect()
 *   인증      store.auth  (v21 구글 로그인에서 채움)
 *   알림      store.on('change' | 'status' | 'notice', fn)
 * ===================================================================== */

const STORE_KEY = 'sai.v1';
const DEFAULT_SETTINGS = {
  cycle_start_day: 11,
  categories: ['식비', '카페', '생활', '병원', '교통', '쇼핑', '경조사', '기타'],
  methods: ['카드', '현금', '계좌이체'],
  beneficiaries: ['공동', '아내', '남편'],
};
const PREFS_LIMIT = 19000; // 서버 cleanPrefs_는 JSON 2만 자를 넘으면 prefs 전체를 비운다 → 여유를 두고 막는다

let S = loadState();

const store = (() => {
  const listeners = { change: [], status: [], notice: [] };
  const emit = (ev, arg) => listeners[ev].forEach(fn => { try { fn(arg); } catch (e) { console.error(e); } });
  const synced = new Set();
  let syncing = false, syncAgain = false, syncError = '';

  function normSettings(x) {
    return Object.assign({}, DEFAULT_SETTINGS, x, { cycle_start_day: Number(x && x.cycle_start_day) || 11 });
  }
  function save() {
    mergeDisk();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); return true; }
    catch (e) { emit('notice', '기기 저장공간이 부족해요'); return false; }
  }
  // 다른 탭/창이 저장한 미전송 기록·거래를 잃지 않도록 디스크 내용과 병합 (수정 시각이 새로운 쪽 우선)
  function mergeDisk() {
    let d;
    try { d = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return; }
    if (!d || !d.txs) return;
    const newer = (a, b) => !b || (a && a.updated_at > b.updated_at);
    Object.values(d.txs).forEach(t => { if (newer(t, S.txs[t.id])) S.txs[t.id] = t; });
    Object.values(d.outbox || {}).forEach(t => {
      if (newer(t, S.outbox[t.id]) && newer(t, S.txs[t.id]) || (S.txs[t.id] && S.txs[t.id].updated_at === t.updated_at && !S.outbox[t.id] && !synced.has(t.id + ':' + t.updated_at))) {
        S.outbox[t.id] = t; S.txs[t.id] = t;
      }
    });
  }
  window.addEventListener('storage', e => { if (e.key === STORE_KEY) { mergeDisk(); emit('change'); } });

  /* ---------- 서버 호출 (Apps Script JSON API) ---------- */
  async function api(body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(S.cfg.url, {
        method: 'POST', redirect: 'follow', signal: ctrl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign(credentials(), body)),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (err) { const e = new Error('HTTP ' + res.status + ' JSON 아님: ' + text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 80)); e.code = 'bad_response'; throw e; }
      if (!data.ok) { const e = new Error(data.error && data.error.message); e.code = data.error && data.error.code; throw e; }
      return data;
    } finally { clearTimeout(timer); }
  }
  // 요청에 붙는 인증 정보. 공유 키(설정 코드) 방식
  function credentials() { return { key: S.cfg.key }; }

  async function sync() {
    if (!S.cfg) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true; syncError = ''; emit('status');
    try {
      if (S.pendingSettings) {
        // 보낼 내용과 '보낸 뒤 바뀌었는지' 비교 기준을 기다리기 전에 함께 고정한다
        const sent = JSON.stringify(S.pendingSettings), dirty = (S.prefsDirty || []).slice();
        const out = JSON.parse(sent);
        if (out.prefs && dirty.length) {
          // 보내기 직전 서버의 최신 prefs를 받아 그 위에 얹는다(기록은 건드리지 않는 빈 동기화)
          const pre = await api({ action: 'sync', since: Number.MAX_SAFE_INTEGER, ops: [] });
          S.serverPrefs = (pre.settings && pre.settings.prefs) || {};
          const base = Object.assign({}, S.serverPrefs);
          dirty.forEach(k => { if (k in out.prefs) base[k] = out.prefs[k]; else delete base[k]; });
          out.prefs = base;
        }
        const r = await api({ action: 'settings', settings: out });
        if (JSON.stringify(S.pendingSettings) === sent) { S.settings = normSettings(r.settings); S.pendingSettings = null; S.prefsDirty = null; S.serverPrefs = r.settings.prefs || null; }
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
      S.serverPrefs = res.settings && res.settings.prefs || null;
      if (!S.pendingSettings) S.settings = normSettings(res.settings);
      save();
      if (fillPayers()) syncAgain = true;
    } catch (e) {
      const why = e.code ? e.code + ' · ' + (e.message || '') : e.name === 'AbortError' ? '30초 응답 없음' : (e.name || '') + ' ' + (e.message || '');
      syncError = e.code === 'unauthorized' ? '설정 코드가 바뀌었어요. 설정 → 설정 코드 바꾸기'
        : navigator.onLine === false ? '' : '공유 실패 (' + why.trim().slice(0, 120) + ') · 기록은 이 기기에 안전해요';
    } finally {
      syncing = false;
      emit('change');
      if (syncAgain) { syncAgain = false; sync(); }
    }
  }
  // 이관한 기존 기록은 결제자가 비어 있다 → 예전 '누구 몫' 값(없으면 공동)으로 채워 시트에도 반영 (데이터 이관 규칙)
  function fillPayers() {
    const todo = list().filter(t => !t.payer && !S.outbox[t.id]);
    if (todo.length) upsertMany(todo.map(t => Object.assign({}, t, { payer: t.beneficiary || '공동' })), true);
    return todo.length > 0;
  }

  /* ---------- 기록 ---------- */
  const list = () => Object.values(S.txs).filter(t => !t.deleted);
  // 여러 건을 한 번에: 기기 저장 1회, 전송 1회. 실패하면 모두 되돌린다
  // 금액 계약: 지우지 않은 기록은 양의 정수 1 ~ 9,999,999,999원. 화면 검사를 지나쳐도 여기서 막는다(v22)
  const okAmount = n => Number.isSafeInteger(n) && n >= 1 && n <= 9999999999;
  function upsertMany(recs, noSync) {
    if (!noSync && recs.some(r => !r.deleted && !okAmount(r.amount))) { emit('notice', '금액을 확인해 주세요 (1 ~ 9,999,999,999원)'); return false; }
    const prev = recs.map(r => [r.id, S.txs[r.id], S.outbox[r.id]]);
    recs.forEach(r => {
      const p = S.txs[r.id];
      const rec = Object.assign({}, r, { updated_at: Math.max(Date.now(), (p && p.updated_at || 0) + 1) });
      S.txs[rec.id] = rec;
      S.outbox[rec.id] = rec;
    });
    if (!save()) {
      prev.forEach(([id, tx, out]) => {
        if (tx) S.txs[id] = tx; else delete S.txs[id];
        if (out) S.outbox[id] = out; else delete S.outbox[id];
      });
      return false;
    }
    if (!noSync) sync();
    return true;
  }

  /* ---------- 공유 설정 ---------- */
  // 기기 저장에 실패하면 되돌리고 false (성공해야 화면 갱신·전송)
  function saveSettings(patch) {
    const before = [S.settings, S.pendingSettings, S.prefsDirty];
    S.settings = Object.assign({}, S.settings, patch);
    S.pendingSettings = Object.assign({}, S.pendingSettings, patch);
    if (!save()) { [S.settings, S.pendingSettings, S.prefsDirty] = before; emit('change'); return false; }
    emit('change'); sync();
    return true;
  }
  /* prefs는 서버가 통째로 바꾼다. 두 사람이 다른 항목(예: 예산과 즐겨찾기)을 거의 동시에 고쳐도 서로 지우지 않도록
   * 이 기기에서 바꾼 키만 기억했다가, 보낼 때 마지막으로 받은 서버 prefs 위에 얹는다(같은 키를 동시에 고치면 나중 저장이 남음) */
  function setPrefs(patch) {
    if (!S.settings.prefs) { emit('notice', '서버 업데이트가 필요해요 (Apps Script 새 버전)'); return false; }
    const prefs = Object.assign({}, S.settings.prefs, patch);
    if (JSON.stringify(prefs).length > PREFS_LIMIT) { emit('notice', '공유 설정 용량이 가득 찼어요. 즐겨찾기를 조금 지워 주세요'); return false; }
    const dirtyBefore = S.prefsDirty;
    S.prefsDirty = [...new Set([...(S.prefsDirty || []), ...Object.keys(patch)])];
    if (!saveSettings({ prefs })) { S.prefsDirty = dirtyBefore; return false; }
    return true;
  }

  /* ---------- 연결 (설정 코드) ---------- */
  function parseCode(text) {
    try {
      const raw = String(text || '').trim().replace(/\s/g, '');
      const cfg = JSON.parse(decodeURIComponent(escape(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))));
      return cfg && cfg.key ? cfg : null;
    } catch (e) { return null; }
  }
  // 편집기에서 만든 코드는 주소가 테스트용(/dev)일 수 있다 → 배포 주소(/exec)만 받는다
  const validUrl = url => /^(https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$|http:\/\/localhost[:/])/.test(url || '');
  function connect(cfg) { S.cfg = cfg; syncError = ''; save(); emit('change'); sync(); }
  function disconnect() {
    if (Object.keys(S.outbox).length || S.pendingSettings) return false;
    localStorage.removeItem(STORE_KEY); S = blankState(); emit('change');
    return true;
  }

  return {
    list, get: id => S.txs[id], isPending: id => !!S.outbox[id], pendingCount: () => Object.keys(S.outbox).length,
    upsert: rec => upsertMany([rec]), upsertMany: recs => upsertMany(recs),
    remove: id => !!S.txs[id] && upsertMany([Object.assign({}, S.txs[id], { deleted: true })]),
    settings: () => S.settings, saveSettings, prefs: () => S.settings.prefs || null, setPrefs,
    local: k => S[k], setLocal: (k, v) => { S[k] = v; return save(); },
    sync, status: () => ({ syncing, error: syncError, lastSync: S.lastSync }),
    connected: () => !!S.cfg, parseCode, validUrl, connect, disconnect,
    auth: { method: () => (S.cfg ? 'key' : 'none') },
    on: (ev, fn) => listeners[ev].push(fn),
  };
})();

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && typeof s === 'object') return Object.assign(blankState(), s);
  } catch (e) {}
  return blankState();
}
function blankState() {
  return { cfg: null, me: null, settings: DEFAULT_SETTINGS, txs: {}, outbox: {}, since: 0, lastSync: 0, pendingSettings: null, draft: null };
}
