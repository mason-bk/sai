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
 *             store.pendingCount()    공유 대기 기록 건수(거래 outbox의 고유 id 수)
 *             store.pendingDetail()   { tx, settings, total } 공유 대기 = 기록 건수 + 설정 변경(묶어서 1건) (v25, spec 12절 N의 정의)
 *   기록      store.upsert(rec)       새 기록/수정 → true|false(기기 저장 실패)
 *             store.upsertMany(recs)  여러 건을 한 번에 저장·전송
 *             store.remove(id)        지운 표시(되돌리기는 upsert로 deleted:false)
 *   공유 설정 store.settings()        분류·결제수단·결제자·주기·정기·prefs
 *             store.saveSettings(p)   일부 키만 바꿔 저장·전송
 *             store.prefs()           prefs 객체(없으면 null = 서버 구버전)
 *             store.setPrefs(p)       prefs 일부 키 저장 → true|false(용량 초과·서버 구버전)
 *   기기 설정 store.local(k) / store.setLocal(k, v)   me·view·draft 처럼 이 기기에만 남는 값
 *   동기화    store.sync(), store.status() → { syncing, error, lastSync, retryAt, retryN }
 *             공유가 실패하면 앱이 열린 동안 30초 → 1분 → 2분 … 10분 간격으로 다시 보낸다(v25). 성공하면 간격을 처음으로
 *   저장 보호 store.persistStorage() → navigator.storage.persist() 요청, 결과는 기기 상태 persist { state, at }(v25)
 *   연결      store.connected(), store.parseCode(text), store.validUrl(url), store.connect(cfg), store.disconnect()
 *   인증      store.auth  (v21 구글 로그인에서 채움)
 *   알림      store.on('change' | 'status' | 'notice' | 'conflict', fn)
 *   충돌      store.conflicts() → { 키: { mine, theirs, base, fields, reason: 'same' | 'over', over } }, store.resolveConflict(key, value | undefined) (v25 2차: 월 예산 수정 번호 비교)
 *             reason 'same' = 같은 항목을 서로 다르게 고침, 'over' = 다른 항목끼리 합치면 대분류 합계가 전체 예산을 넘음(v25 3차, 자동으로 합치지 않음)
 *             충돌이 하나라도 남아 있으면 연결 해제를 거부한다(내 초안 보호). 버리려면 disconnect({ discardConflicts: true })
 *   서버 기능 store.features() → ['major', 'prefsRev'] (옛 서버면 빈 배열: 거래별 대분류 열·예산 충돌 검사 없음)
 *             store.serverState() → 'unknown'(아직 서버 응답을 못 받음: 오프라인 첫 실행 등) | 'old' | 'new' (v25 3차)
 *             월 예산(bm:/bt:)은 'new'일 때만 저장한다: 옛 서버는 수정 번호를 비교하지 못해 거의 동시 저장을 막을 수 없다(Astra v25 P0-02)
 * ===================================================================== */

const STORE_KEY = 'sai.v1';
const DEFAULT_SETTINGS = {
  cycle_start_day: 11,
  categories: ['식비', '카페', '생활', '병원', '교통', '쇼핑', '경조사', '기타'],
  methods: ['카드', '현금', '계좌이체'],
  beneficiaries: ['공동', '아내', '남편'],
};
const PREFS_LIMIT = 19000;
// 수정 번호(rev)로 충돌을 가리는 공유 값: 월 예산 'bm:YYYY-MM'·'bt:YYYY-MM'(v25 2차)
const REV_KEY = /^b[mt]:\d{4}-\d{2}$/;
const revOf = v => (v && typeof v === 'object' && Number(v.rev)) || 0;
// 합친 예산의 대분류 합계가 전체 예산을 넘는 금액(전체 미설정이면 0). core.budgetCheck와 같은 규칙(데이터 층만 따로 실행될 때를 위해 같은 식)
const overBy = v => { if (!v || typeof v !== 'object') return 0; const t = Number(v.total) || 0, c = v.cats && typeof v.cats === 'object' ? v.cats : {}; const sum = Object.values(c).reduce((a, x) => a + (Number(x) > 0 ? Number(x) : 0), 0); return t > 0 && sum > t ? sum - t : 0; };
// 예산 값의 비교용 핵심(전체·대분류만)
const coreOf = v => v && typeof v === 'object' ? { total: Number(v.total) || 0, cats: Object.assign({}, v.cats || {}) } : null;
/* v25 4차(Astra P0-02 B): 내가 실제로 바꾼 항목만 내 변경으로. from = 편집을 시작할 때 본 값, to = 그 값에 내 수정을 적용한 값.
 * 이전 내 변경(prev) 위에 from→to에서 바뀐 항목만 얹는다(편집 중 받은 상대 값은 섞지 않음) */
function applyEdit(prev, from, to) {
  if (to == null) return null;
  if (prev == null) return JSON.parse(JSON.stringify(to));
  const v = merge3(from, prev, to).value; ['rev', 'by', 'at'].forEach(k => { if (k in to) v[k] = to[k]; });
  return v;
}
// 내 값과 상대 값이 다른 예산 항목('total', 'cats.<id>'): 합계 초과로 자동 합치지 못할 때 고를 항목
function diffFields(m, t) {
  const J = v => JSON.stringify(v === undefined ? null : v), out = [];
  if (J(m && m.total) !== J(t && t.total)) out.push('total');
  const mc = m && m.cats || {}, tc = t && t.cats || {};
  [...new Set([...Object.keys(mc), ...Object.keys(tc)])].forEach(k => { if (J(mc[k]) !== J(tc[k])) out.push('cats.' + k); });
  return out;
}
/* 3방향 합치기: 기준(내가 고치기 전) · 내 값 · 상대(지금 서버) 값을 항목별로 비교. 한 단계 아래 객체(cats)는 항목별로 본다.
 * 내가 안 바꾼 항목은 상대 값, 상대가 안 바꾼 항목은 내 값, 둘 다 같은 값으로 바꿨으면 그 값, 서로 다르게 바꿨으면 충돌(fields에 '경로') */
function merge3(base, mine, theirs) {
  const skip = { rev: 1, by: 1, at: 1 }, J = v => JSON.stringify(v === undefined ? null : v), conflicts = [];
  const obj = v => v && typeof v === 'object' && !Array.isArray(v);
  function walk(b, m, t, path) {
    const out = {}, keys = [...new Set([...Object.keys(obj(b) ? b : {}), ...Object.keys(obj(m) ? m : {}), ...Object.keys(obj(t) ? t : {})])];
    keys.forEach(k => {
      if (!path && skip[k]) return;
      const bv = obj(b) ? b[k] : undefined, mv = obj(m) ? m[k] : undefined, tv = obj(t) ? t[k] : undefined;
      if (!path && (obj(mv) || obj(tv) || obj(bv))) { out[k] = walk(bv, mv, tv, k); return; }
      let v;
      if (J(mv) === J(bv)) v = tv; else if (J(tv) === J(bv) || J(tv) === J(mv)) v = mv; else { conflicts.push(path ? path + '.' + k : k); v = tv; }
      if (v !== undefined) out[k] = v;
    });
    return out;
  }
  const value = walk(base, mine, theirs, '');
  if (obj(mine)) ['by', 'at'].forEach(k => { if (k in mine) value[k] = mine[k]; });
  return { value, conflicts };
} // 서버 cleanPrefs_는 JSON 2만 자를 넘으면 prefs 전체를 비운다 → 여유를 두고 막는다

let S = loadState();

const store = (() => {
  const listeners = { change: [], status: [], notice: [], conflict: [] };
  const emit = (ev, arg) => listeners[ev].forEach(fn => { try { fn(arg); } catch (e) { console.error(e); } });
  const synced = new Set();
  let syncing = false, syncAgain = false, syncError = '', revRequeue = 0;
  // 자동 재시도(v25): 대기 중인 기록·설정이 있는데 공유가 실패하면 간격을 두 배씩 늘려 다시 보낸다. core.retryDelay와 같은 간격(데이터 층만 따로 실행될 때를 위해 같은 식을 둠)
  let retryN = 0, retryTimer = null, retryAt = 0;
  const retryDelay = n => typeof core !== 'undefined' && core.retryDelay ? core.retryDelay(n) : Math.min(600000, 30000 * Math.pow(2, Math.max(0, n - 1)));
  const hasPending = () => !!S.cfg && (Object.keys(S.outbox).length > 0 || !!S.pendingSettings);
  function clearRetry() { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; retryAt = 0; }
  function scheduleRetry() {
    clearRetry();
    if (!hasPending()) { retryN = 0; return; }
    retryN++;
    const ms = retryDelay(retryN); retryAt = Date.now() + ms;
    retryTimer = setTimeout(() => { retryTimer = null; retryAt = 0; sync(); }, ms);
    if (retryTimer && retryTimer.unref) retryTimer.unref(); // Node 테스트가 타이머 때문에 끝나지 않는 일이 없게
  }

  const serverState = () => !Array.isArray(S.features) ? 'unknown' : S.features.includes('prefsRev') ? 'new' : 'old';
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
      let prefsErr = '';
      if (S.pendingSettings) try {
        // 보낼 내용과 '보낸 뒤 바뀌었는지' 비교 기준을 기다리기 전에 함께 고정한다
        const sent = JSON.stringify(S.pendingSettings), dirty = (S.prefsDirty || []).slice();
        const out = JSON.parse(sent);
        const prefsBase = {}, found = {}, mine = {}, hold = {};
        // v25 4차(Fable P1): 바꾼 prefs 키가 없으면 prefs를 보내지 않는다(기준 없이 통째로 보내 상대 변경을 덮지 않게)
        if (out.prefs && !dirty.length) delete out.prefs;
        if (out.prefs && dirty.length) {
          // 보내기 직전 서버의 최신 prefs를 받아 그 위에 얹는다(기록은 건드리지 않는 빈 동기화)
          const pre = await api({ action: 'sync', since: Number.MAX_SAFE_INTEGER, ops: [] });
          S.features = Array.isArray(pre.features) ? pre.features : []; // 응답에 기능이 없으면 옛 서버(이전 값을 믿지 않음, Astra P0-02 A)
          S.serverPrefs = (pre.settings && pre.settings.prefs) || {};
          const base = Object.assign({}, S.serverPrefs);
          dirty.forEach(k => {
            // 월 예산은 전송 직전에 서버 기능을 다시 본다: 수정 번호를 비교하지 못하는 서버면 보내지 않고 이 기기에 보관(Astra P0-02 A)
            if (REV_KEY.test(k) && serverState() !== 'new') { hold[k] = 1; return; }
            // v25 2차: 수정 번호를 가진 공유 값(월 예산)은 내가 고치기 전 값(기준)과 지금 서버 값을 비교해 3방향으로 합친다
            const b0 = REV_KEY.test(k) && S.prefsBase && S.prefsBase[k];
            // 내 값 = 편집 시작 값에 내가 바꾼 항목만 얹은 값(있으면). 화면 값에는 편집 중 받은 상대 값이 섞여 있을 수 있다(Astra P0-02 B)
            const mv = b0 && b0.mine !== undefined ? b0.mine : k in out.prefs ? out.prefs[k] : null;
            if (b0) {
              const sv = k in S.serverPrefs ? S.serverPrefs[k] : null, bv = b0.value;
              mine[k] = mv;
              // 새로 만드는 '그 달만'·'이후 달' 값이 물려받은 기본값(dep)이 편집 사이 바뀌었으면, 그 기본값을 기준·상대 값으로 비교
              if (bv == null && sv == null && b0.dep && mv != null) {
                const dsv = S.serverPrefs[b0.dep.key], dbv = coreOf(b0.dep.value) || { total: 0, cats: {} }, dtv = coreOf(dsv) || { total: 0, cats: {} };
                if (JSON.stringify(dbv) !== JSON.stringify(dtv)) {
                  const m = merge3(dbv, mv, dtv), theirs = Object.assign({}, dtv, { by: dsv && dsv.by || '', from: b0.dep.key });
                  if (m.conflicts.length) { found[k] = { key: k, mine: mv, theirs, base: dbv, fields: m.conflicts, reason: 'same', dep: b0.dep.key, keyServer: null }; return; }
                  if (overBy(m.value)) { found[k] = { key: k, mine: mv, theirs, base: dbv, fields: diffFields(mv, dtv), reason: 'over', over: overBy(m.value), dep: b0.dep.key, keyServer: null }; return; }
                  base[k] = Object.assign(m.value, { rev: 1 }); prefsBase[k] = 0; return;
                }
              }
              if (revOf(sv) !== revOf(bv)) {
                const m = merge3(bv, mv, sv);
                if (m.conflicts.length) { found[k] = { key: k, mine: mv, theirs: sv, base: bv, fields: m.conflicts, reason: 'same' }; return; } // 서버 값 그대로 두고 내 값은 충돌 기록에
                // 다른 항목끼리라도 합친 결과가 전체 한도를 넘으면 자동으로 합치지 않는다(Astra v25 P0-02-3): 내 값을 보관하고 고르게 함
                if (mv != null && overBy(m.value)) { found[k] = { key: k, mine: mv, theirs: sv, base: bv, fields: diffFields(mv, sv), reason: 'over', over: overBy(m.value) }; return; }
                base[k] = mv == null ? null : Object.assign(m.value, { rev: revOf(sv) + 1 }); // 다른 항목만 고쳤으면 자동으로 합침
                if (base[k] == null) delete base[k];
              } else if (mv == null) delete base[k]; else base[k] = mv;
              prefsBase[k] = revOf(sv);
              return;
            }
            if (k in out.prefs) base[k] = out.prefs[k]; else delete base[k];
          });
          out.prefs = base;
          if (dirty.every(k => hold[k])) delete out.prefs; // 보관만 했으면 prefs는 보내지 않음(옛 서버에 통째로 덮어쓰지 않게)
          // 합친 결과가 서버 한도(2만 자)를 넘으면 서버가 prefs 전체를 비운다 → 보내지 않고 이유를 알린다(Fable v25 P2-2)
          const size = out.prefs ? JSON.stringify(out.prefs).length : 0;
          if (size > PREFS_LIMIT) { const e = new Error('공유 설정이 ' + size.toLocaleString('en-US') + '자로 한도(' + PREFS_LIMIT.toLocaleString('en-US') + '자)를 넘어 보내지 않았어요. 예산 → 오래된 월 예산 정리 또는 즐겨찾기를 줄여 주세요'); e.code = 'prefs_too_big'; throw e; }
        }
        const r = await api(Object.keys(prefsBase).length ? { action: 'settings', settings: out, prefsBase } : { action: 'settings', settings: out });
        if (r.features) S.features = r.features;
        // 서버가 '조회한 뒤 사이에 바뀌었다'고 돌려준 키(경합). 같은 항목이 겹치지 않고 합계도 넘지 않으면 고를 것이 없다 → 내 값을 기준 그대로 다시 보낸다(Fable v25 P2-6)
        const requeue = {};
        (r.conflicts || []).forEach(c => {
          const bv = S.prefsBase && S.prefsBase[c.key] ? S.prefsBase[c.key].value : null, mv = mine[c.key], m = merge3(bv, mv, c.server), over = mv != null ? overBy(m.value) : 0;
          if (!m.conflicts.length && !over && revRequeue < 3) { requeue[c.key] = mv; return; }
          // 다시 보내도 계속 경합이면(3번) 고르게 한다: 'race'(합계 초과가 아님, Fable P2-2)
          found[c.key] = { key: c.key, mine: mv, theirs: c.server, base: bv, fields: m.conflicts.length ? m.conflicts : diffFields(mv, c.server), reason: m.conflicts.length ? 'same' : over ? 'over' : 'race', over };
        });
        // 보내는 사이 같은 키를 다시 고쳤으면(대기열 값이 보낸 값과 다름) 그 최신 값을 내 값으로(Fable P2-1: 두 번째 수정 유실 방지)
        const sentPrefs = JSON.parse(sent).prefs || {};
        Object.keys(found).forEach(k => {
          const cur = S.pendingSettings && S.pendingSettings.prefs && k in S.pendingSettings.prefs ? S.pendingSettings.prefs[k] : undefined;
          if (cur === undefined || JSON.stringify(cur) === JSON.stringify(sentPrefs[k])) return;
          const pb = S.prefsBase && S.prefsBase[k], f = found[k], nm = pb && pb.mine !== undefined ? pb.mine : cur;
          const m = merge3(f.base, nm, f.theirs), over = nm != null ? overBy(m.value) : 0;
          if (!m.conflicts.length && !over && !f.dep) { delete found[k]; requeue[k] = nm; return; } // 고를 것이 없어짐 → 기준 그대로 다시 보냄
          Object.assign(f, { mine: nm, fields: m.conflicts.length ? m.conflicts : diffFields(nm, f.theirs), reason: m.conflicts.length ? 'same' : over ? 'over' : f.reason, over });
        });
        // 보낸 값이 서버에 저장됐으니 그 키의 기준은 이제 서버 값(보내는 사이 다시 고쳐 대기열이 남아도 내 이전 저장을 상대 수정으로 오인하지 않게). 다시 보낼 키는 원래 기준 유지
        if (S.prefsBase) Object.keys(S.prefsBase).forEach(k => { if (k in prefsBase || dirty.includes(k)) { if (found[k] || k in requeue || hold[k]) return; const sp = (r.settings && r.settings.prefs) || {}; const nb = Object.assign({}, S.prefsBase[k], { value: k in sp ? sp[k] : null }); delete nb.dep; S.prefsBase[k] = nb; } });
        if (JSON.stringify(S.pendingSettings) === sent) {
          const keepBase = S.prefsBase; S.settings = normSettings(r.settings); S.pendingSettings = null; S.prefsDirty = null; S.prefsBase = null; S.serverPrefs = r.settings.prefs || null;
          const again = Object.assign({}, requeue); Object.keys(hold).forEach(k => { again[k] = sentPrefs[k]; });
          if (Object.keys(again).length) { // 기준(내가 고치기 전 값)은 그대로, 내 값만 다시 대기열에 → 다음 전송의 사전 조회가 지금 서버 값과 3방향으로 합친다. 보관(hold)한 월 예산도 그대로 대기
            const pp = Object.assign({}, S.settings.prefs);
            Object.keys(again).forEach(k => { if (again[k] == null) delete pp[k]; else pp[k] = again[k]; });
            S.pendingSettings = { prefs: pp }; S.prefsDirty = Object.keys(again);
            S.prefsBase = {}; Object.keys(again).forEach(k => { S.prefsBase[k] = keepBase && keepBase[k] ? keepBase[k] : { value: null }; });
            S.settings = Object.assign({}, S.settings, { prefs: pp });
          }
        }
        if (Object.keys(requeue).length) { revRequeue++; syncAgain = true; } else revRequeue = 0;
        // 충돌로 보관한 키는 대기열·기준에서 빼고 화면 값은 상대 값으로(같은 충돌을 다음 전송에서 다시 만들지 않게). 내 값은 충돌 기록에 있다
        Object.keys(found).forEach(k => {
          const tv = found[k].theirs;
          if (S.prefsDirty) S.prefsDirty = S.prefsDirty.filter(x => x !== k);
          if (S.prefsBase) delete S.prefsBase[k];
          if (found[k].dep) return; // 물려받은 기본값 충돌: 그 키는 서버에 없음 → 화면 값에서 내 새 키만 뺀다
          [S.pendingSettings, S.settings].forEach(o => { if (o && o.prefs) { o.prefs = Object.assign({}, o.prefs); if (tv == null) delete o.prefs[k]; else o.prefs[k] = tv; } });
        });
        Object.keys(found).forEach(k => { if (found[k].dep) [S.pendingSettings, S.settings].forEach(o => { if (o && o.prefs) { o.prefs = Object.assign({}, o.prefs); delete o.prefs[k]; } }); });
        // 바꾼 prefs 키가 남지 않았으면 대기열에서 prefs를 뺀다(빈 대기열은 비움, Fable P1)
        if (S.prefsDirty && !S.prefsDirty.length) S.prefsDirty = null;
        if (!S.prefsDirty && S.pendingSettings && S.pendingSettings.prefs) { const ps = Object.assign({}, S.pendingSettings); delete ps.prefs; S.pendingSettings = Object.keys(ps).length ? ps : null; }
        if (Object.keys(hold).length) prefsErr = '공유 예산 ' + Object.keys(hold).length + '건은 서버 업데이트 뒤에 보내요 · 이 기기에 보관 중';
        if (Object.keys(found).length) { S.prefsConflicts = Object.assign({}, S.prefsConflicts, found); emit('conflict', Object.keys(found)); }
        save();
      } catch (e) {
        // 공유 설정이 한도를 넘어 못 보내도 기록(거래)은 계속 보낸다(Fable v25 P2-7)
        if (e.code !== 'prefs_too_big') throw e;
        prefsErr = e.message;
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
      S.since = res.now; S.lastSync = Date.now(); S.features = Array.isArray(res.features) ? res.features : []; // 옛 서버는 features가 없다
      S.serverPrefs = res.settings && res.settings.prefs || null;
      if (!S.pendingSettings) S.settings = normSettings(res.settings);
      save();
      retryN = 0; clearRetry();
      if (prefsErr) syncError = prefsErr; // 기록은 공유됐고 설정만 남음(다시 보내도 같아 자동 재시도는 하지 않음)
    } catch (e) {
      const why = e.code ? e.code + ' · ' + (e.message || '') : e.name === 'AbortError' ? '30초 응답 없음' : (e.name || '') + ' ' + (e.message || '');
      syncError = e.code === 'unauthorized' ? '설정 코드가 바뀌었어요. 설정 → 설정 코드 바꾸기'
        : navigator.onLine === false ? '' : '공유 실패 (' + why.trim().slice(0, 120) + ') · 기록은 이 기기에 안전해요';
      if (e.code === 'prefs_too_big') syncError = e.message;
      if (e.code !== 'unauthorized' && e.code !== 'prefs_too_big') scheduleRetry(); else clearRetry(); // 설정 코드가 바뀌었거나 용량 초과는 다시 보내도 같다 // 설정 코드가 바뀐 경우는 다시 보내도 같다
    } finally {
      syncing = false;
      emit('change');
      if (syncAgain) { syncAgain = false; sync(); }
    }
  }
  // v25 3차(Astra P1-08): 결제자가 빈 기록을 '누구 몫'이나 공동으로 자동으로 채우지 않는다(실제 결제자 근거가 없음). 화면·집계·필터 모두 '미지정'

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
  function setPrefs(patch, opts) {
    if (!S.settings.prefs) { emit('notice', '서버 업데이트가 필요해요 (Apps Script 새 버전)'); return false; }
    // 월 예산은 수정 번호를 비교하는 서버에서만 저장(옛 서버·아직 확인 전이면 저장하지 않고 화면이 입력을 그대로 둔다)
    if (Object.keys(patch).some(k => REV_KEY.test(k)) && serverState() !== 'new') { emit('notice', serverState() === 'old' ? '공유 예산을 저장하려면 서버 업데이트가 필요해요' : '서버를 확인하는 중이에요. 연결된 뒤 다시 저장해 주세요'); return false; }
    const prefs = Object.assign({}, S.settings.prefs, patch);
    Object.keys(patch).forEach(k => { if (patch[k] === null) delete prefs[k]; }); // null = 그 키를 지움(서버 병합에서도 지워진다)
    if (JSON.stringify(prefs).length > PREFS_LIMIT) { emit('notice', '공유 설정 용량이 가득 찼어요. 즐겨찾기를 조금 지워 주세요'); return false; }
    const dirtyBefore = S.prefsDirty, baseBefore = S.prefsBase;
    S.prefsDirty = [...new Set([...(S.prefsDirty || []), ...Object.keys(patch)])];
    // 수정 번호를 가진 값은 처음 고칠 때의 값(이 기기가 마지막으로 받은 서버 값)을 기준으로 남긴다. 보낼 때 서버 값과 비교
    Object.keys(patch).forEach(k => {
      if (!REV_KEY.test(k)) return;
      if (!(S.prefsBase && k in S.prefsBase)) S.prefsBase = Object.assign({}, S.prefsBase, { [k]: { value: opts && opts.base && k in opts.base ? opts.base[k] : (k in (S.settings.prefs || {}) ? JSON.parse(JSON.stringify(S.settings.prefs[k])) : null) } });
      // v25 4차: 내가 바꾼 항목만 따로(opts.edit = { from, to }), 새 키가 물려받은 기본값(opts.dep = { key, value })
      const pb = Object.assign({}, S.prefsBase[k]), ed = opts && opts.edit && opts.edit[k];
      if (ed) pb.mine = applyEdit(pb.mine !== undefined ? pb.mine : pb.value, ed.from, ed.to); else delete pb.mine;
      if (opts && opts.dep && opts.dep[k] && pb.value == null && !pb.dep) pb.dep = opts.dep[k];
      S.prefsBase = Object.assign({}, S.prefsBase, { [k]: pb });
    });
    if (!saveSettings({ prefs })) { S.prefsDirty = dirtyBefore; S.prefsBase = baseBefore; return false; }
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
  /* 저장 보호(v25): 브라우저가 저장 공간이 부족할 때 이 앱의 기록을 지우지 않게 요청한다. 결과는 이 기기 상태에만 남기고 설정 화면에 보인다.
   * 지원하지 않거나 거절돼도 앱은 그대로 동작한다(공유되지 않은 기록이 있으면 상태 줄이 계속 알린다) */
  async function persistStorage() {
    const st = typeof navigator !== 'undefined' && navigator.storage;
    let state = 'unsupported';
    try {
      if (st && st.persist) { let granted = st.persisted ? await st.persisted() : false; if (!granted) granted = await st.persist(); state = granted ? 'granted' : 'denied'; }
    } catch (e) { state = 'error'; }
    S.persist = { state, at: Date.now() }; save(); emit('change');
    return S.persist;
  }
  /* 충돌 해결(v25 2차): 고른 값을 상대 값 위에 다시 저장(기준 = 상대 값). keep = 상대 값 그대로 두고 내 초안 버림 */
  function resolveConflict(key, value) {
    const c = S.prefsConflicts && S.prefsConflicts[key]; if (!c) return false;
    const rest = Object.assign({}, S.prefsConflicts); delete rest[key];
    const before = S.prefsConflicts; S.prefsConflicts = rest;
    if (value === undefined) { if (!save()) { S.prefsConflicts = before; return false; } emit('change'); return true; } // 기기 저장에 실패하면 충돌을 그대로 두고 false
    const kb = c.dep ? (c.keyServer || null) : c.theirs; // 물려받은 기본값 충돌이면 그 키의 서버 값(없음)이 기준
    if (!setPrefs({ [key]: Object.assign({}, value, { rev: revOf(kb) + 1 }) }, { base: { [key]: kb } })) { S.prefsConflicts = before; return false; }
    return true;
  }
  function connect(cfg) { S.cfg = cfg; syncError = ''; save(); emit('change'); sync(); }
  function disconnect(opts) {
    if (Object.keys(S.outbox).length || S.pendingSettings) return false;
    if (Object.keys(S.prefsConflicts || {}).length && !(opts && opts.discardConflicts)) return false; // 고르지 않은 예산 초안이 있으면 해제하지 않음(Astra v25 P0-03)
    localStorage.removeItem(STORE_KEY); S = blankState(); emit('change');
    return true;
  }

  return {
    list, get: id => S.txs[id], isPending: id => !!S.outbox[id], pendingCount: () => Object.keys(S.outbox).length,
    pendingDetail: () => { const tx = Object.keys(S.outbox).length, settings = S.pendingSettings ? 1 : 0; return { tx, settings, total: tx + settings, conflicts: Object.keys(S.prefsConflicts || {}).length }; },
    conflicts: () => S.prefsConflicts || {}, resolveConflict, features: () => S.features || [], serverState, merge3, overBy,
    upsert: rec => upsertMany([rec]), upsertMany: recs => upsertMany(recs),
    remove: id => !!S.txs[id] && upsertMany([Object.assign({}, S.txs[id], { deleted: true })]),
    settings: () => S.settings, saveSettings, prefs: () => S.settings.prefs || null, setPrefs,
    local: k => S[k], setLocal: (k, v) => { const prev = S[k]; S[k] = v; if (save()) return true; S[k] = prev; return false; }, // 실패하면 메모리도 되돌림
    sync, status: () => ({ syncing, error: syncError, lastSync: S.lastSync, retryAt, retryN }), persistStorage,
    connected: () => !!S.cfg, parseCode, validUrl, connect, disconnect,
    auth: { method: () => (S.cfg ? 'key' : 'none') },
    on: (ev, fn) => listeners[ev].push(fn),
  };
})();

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && typeof s === 'object') {
      // 기록 금액 입력 방식(v25 3차, Mason 결정): 고른 적이 없는 기존 기기(이전 버전을 연결해 쓰던 기기)는 화면 키패드 유지, 그 밖은 휴대폰 숫자 키보드
      if (typeof s.keypad !== 'boolean') s.keypad = s.keypad === undefined && !!s.cfg;
      return Object.assign(blankState(), s);
    }
  } catch (e) {}
  return blankState();
}
function blankState() {
  return { cfg: null, me: null, settings: DEFAULT_SETTINGS, txs: {}, outbox: {}, since: 0, lastSync: 0, pendingSettings: null, draft: null, keypad: false }; // 새 설치 = 휴대폰 숫자 키보드
}
