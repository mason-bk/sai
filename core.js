'use strict';
/* =====================================================================
 * 순수 로직 (core) - 화면·저장소·네트워크에 의존하지 않는다.
 * 브라우저에서는 window.core, Node·다른 앱(iOS·Android 정식 앱 등)에서는 require('./core.js').
 *
 *   날짜·주기    ymd, parseDate, addDays, dayDiff, cycleRange(startDay, offset, now)
 *   금액         signed(tx), parseAmount(text)
 *   카드 알림    parseNotices(text, { today }) → { items, unread }
 *   추천         suggest(merchant, history, settings, text) → { category, payer, method }
 *   중복 대조    markDuplicates(candidates, existing) (후보에 dup 표시)
 *   파일         decodeText(bytes), parseCsv(text), detectHeaderRow(rows), guessColumns(header, rows),
 *                rowsToCandidates(rows, mapping, opts) → { items, unread }
 *   필터·합계    filterTxs(txs, filter, range), summarize(txs)
 * ===================================================================== */
(function (root) {
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, k) => { const d = parseDate(s); d.setDate(d.getDate() + k); return ymd(d); };
  const dayDiff = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);
  const validYmd = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate();

  /* 카드 결제 주기 한 달: startDay일 ~ 다음 달 startDay-1일. 29~31일은 그날이 없는 달엔 말일부터 */
  function cycleRange(startDay, offset, now) {
    const day = Number(startDay) || 11;
    const startIn = (y, m0) => new Date(y, m0, Math.min(day, new Date(y, m0 + 1, 0).getDate()));
    now = now || new Date();
    let y = now.getFullYear(), m = now.getMonth();
    if (now.getDate() < startIn(y, m).getDate()) m -= 1;
    m += offset || 0;
    const start = startIn(y, m);
    const next = startIn(y, m + 1);
    const end = new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1);
    return { start: ymd(start), end: ymd(end), label: (start.getMonth() + 1) + '.' + start.getDate() + ' - ' + (end.getMonth() + 1) + '.' + end.getDate(), year: start.getFullYear() };
  }

  /* 순지출 기여: 환불은 빼고, 지출 제외(이체·카드대금)는 0 */
  const signed = t => t.type === 'refund' ? -t.amount : t.type === 'transfer' ? 0 : t.amount;

  /* "12,300", "₩12,300", "(1,000)", "-1,000원" → 숫자 (괄호·마이너스는 음수). 숫자가 아니면 NaN */
  function parseAmount(v) {
    if (typeof v === 'number') return v;
    let s = String(v == null ? '' : v).trim();
    if (!s) return NaN;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[₩원\s,]|KRW/gi, '');
    if (/^-/.test(s)) { neg = !neg; s = s.slice(1); }
    if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
    const n = Math.round(Number(s));
    return neg ? -n : n;
  }

  /* 거래처 비교용: 공백·기호·법인 표기 제거, 소문자 */
  const normMerchant = s => String(s || '').toLowerCase().replace(/\(주\)|주식회사|㈜/g, '').replace(/[\s·.,_\-()[\]'"/]/g, '');
  const merchantMatch = (a, b) => {
    const x = normMerchant(a), y = normMerchant(b);
    if (!x || !y) return false;
    return x === y || (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x)));
  };

  /* ---------------- 카드 알림(문자·앱 푸시) 해석 ---------------- */
  const FOREIGN = /(USD|US\$|EUR|JPY|CNY|GBP|HKD|SGD|AUD|CAD|VND|THB|PHP|TWD|CHF)\s*([\d,]+(?:\.\d+)?)/i;
  const AMT = /(?:₩\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s*원|₩\s*(\d{1,3}(?:,\d{3})+|\d+)|KRW\s*(\d{1,3}(?:,\d{3})+|\d+)/g;
  const NOT_PAID = /(누적|잔액|한도|가능|포인트|캐시백|적립|할인|청구|결제\s*예정|월\s*납입|회차)[^\d\n]{0,8}$/;
  const HEADER = /(카드|체크|card).{0,14}(승인|취소|거절|결제)|^\s*(승인|취소|결제)\b|web발신/i;
  const DATE_FULL = /(20\d{2})\s*[.\/\-년]\s*(\d{1,2})\s*[.\/\-월]\s*(\d{1,2})\s*일?/;
  const DATE_KO = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/;
  const DATE_MD = /(^|[^\d,.])(\d{1,2})[\/.](\d{1,2})(?![\d,]|\.\d)/;
  const TIME = /(^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?!\d)/;
  const TIME_KO = /([01]?\d|2[0-3])\s*시\s*([0-5]?\d)\s*분/;

  function amountsIn(text) {
    const out = [];
    let m; AMT.lastIndex = 0;
    while ((m = AMT.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      out.push({ n: Number((m[1] || m[2] || m[3]).replace(/,/g, '')), paid: !NOT_PAID.test(before), index: m.index, len: m[0].length });
    }
    return out;
  }
  const hasAmt = t => amountsIn(t).some(a => a.paid) || FOREIGN.test(t);
  const hasWhen = t => DATE_FULL.test(t) || DATE_KO.test(t) || DATE_MD.test(t) || TIME.test(t);

  // 붙여넣은 글을 알림 한 건씩으로 나눈다: 빈 줄, [Web발신], 새 승인 머리줄, 금액+날짜가 다 있는 새 한 줄
  function splitNotices(text) {
    const blocks = []; let cur = [];
    const flush = () => { if (cur.length) blocks.push(cur); cur = []; };
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(line => {
      let t = line.trim();
      if (!t) { flush(); return; }
      if (/web\s*발신/i.test(t)) { flush(); t = t.replace(/\[?\s*web\s*발신\s*\]?/ig, '').trim(); if (!t) return; }
      const curHasAmt = cur.some(hasAmt);
      if (cur.length && curHasAmt && (HEADER.test(t) || (hasAmt(t) && hasWhen(t)))) flush();
      cur.push(t);
    });
    flush();
    return blocks;
  }

  function inferDate(m, d, today) {
    const t = parseDate(today);
    let y = t.getFullYear();
    if (!validYmd(y, m, d) && !validYmd(y - 1, m, d)) return '';
    let s = y + '-' + pad(m) + '-' + pad(d);
    if (!validYmd(y, m, d) || s > addDays(today, 1)) { y -= 1; s = y + '-' + pad(m) + '-' + pad(d); }
    return validYmd(y, m, d) ? s : '';
  }

  const MERCHANT_LABEL = /^(가맹점명?|이용처|사용처|거래처|상호명?|가맹점\s*명)\s*[:：]?\s*/;
  const DROP_TOKEN = /카드|체크|신용|card|은행|뱅크|^(승인|취소|거절|일시불|할부|해외|국내|결제|사용|이용|정상|완료|금액|일시|님|본인|가족|원|건)$|^승인번호|^\d+개월$|^[\d\s.,:/*()\-]+$/i;

  function merchantOf(lines) {
    const cleaned = lines.map(line => {
      let t = line;
      t = t.replace(/(누적|잔액|한도|이용\s*가능|포인트|적립|캐시백)[\s\S]*$/, '');      // 누적·잔액 뒤는 버림
      t = t.replace(/\[[^\]]*\]|【[^】]*】|<[^>]*>/g, ' ');                          // [카드사] 같은 머리표
      t = t.replace(FOREIGN, ' ').replace(AMT, ' ');
      t = t.replace(DATE_FULL, ' ').replace(DATE_KO, ' ').replace(TIME_KO, ' ');
      t = t.replace(new RegExp(TIME.source, 'g'), '$1 ').replace(new RegExp(DATE_MD.source, 'g'), '$1 ');
      t = t.replace(/[가-힣A-Za-z]{1,3}\*{1,3}[가-힣A-Za-z]{0,2}님?/g, ' ');            // 홍*동, 김**님
      t = t.replace(/\(\s*[\d*]{2,6}\s*\)|\*+\d{2,4}|\d{4}\*+|\d+\*\d+\**/g, ' ');       // (1234), *1234, (1*2*)
      t = t.replace(/[가-힣]{2,4}님/g, ' ');
      t = t.replace(/\(\s*(일시불|할부|\d+\s*개월)\s*\)/g, ' ');
      t = t.trim();
      const label = MERCHANT_LABEL.test(t);
      t = t.replace(MERCHANT_LABEL, '');
      const tokens = t.split(/[\s|·,]+/).filter(Boolean).filter(w => !DROP_TOKEN.test(w));
      return { text: tokens.join(' ').replace(/^[\-:：/]+|[\-:：/]+$/g, '').trim(), label };
    });
    const labeled = cleaned.find(c => c.label && c.text);
    if (labeled) return labeled.text;
    // 시각·날짜가 있는 줄 다음 줄을 우선(여러 줄 문자), 없으면 그 줄 자체(한 줄 알림), 그다음 아무 줄
    const whenIdx = lines.findIndex(l => TIME.test(l) || TIME_KO.test(l) || DATE_MD.test(l) || DATE_KO.test(l) || DATE_FULL.test(l));
    if (whenIdx >= 0) {
      for (let i = whenIdx; i < cleaned.length; i++) if (cleaned[i].text) return cleaned[i].text;
    }
    const any = cleaned.find(c => c.text);
    return any ? any.text : '';
  }

  /* 알림 한 덩어리 → 후보 기록 */
  function parseNotice(lines, today) {
    const text = lines.join('\n');
    if (/거절|승인\s*실패|한도\s*초과/.test(text)) return { unread: '거절된 결제라 기록하지 않아요' };
    const amts = amountsIn(text).filter(a => a.paid);
    const fx = text.match(FOREIGN);
    if (!amts.length && !fx) return { unread: '금액을 찾지 못했어요' };
    // '취소가능'·'취소 시' 같은 안내 문구는 취소가 아니다
    const cancel = /취소(?!\s*(가능|시|하려면|문의|안내))|환불/.test(text);
    const item = { amount: amts.length ? amts[0].n : 0, type: cancel ? 'refund' : 'expense', issues: [] };
    if (new Set(amts.map(a => a.n)).size > 1) item.issues.push('금액이 여러 개예요. 확인해 주세요');
    if (!cancel && !/승인|결제|사용|이용|출금|일시불|할부|체크|카드|card/i.test(text)) item.issues.push('결제 알림이 맞는지 확인해 주세요');
    if (fx) item.foreign = fx[1].toUpperCase().replace('US$', 'USD') + ' ' + fx[2];
    if (!item.amount) item.issues.push('원화 금액을 넣어 주세요');
    // 날짜·시각은 금액을 지운 글에서 찾는다(USD 25.00 같은 숫자를 날짜로 오인하지 않게)
    const scan = text.replace(new RegExp(FOREIGN.source, 'gi'), ' ').replace(AMT, ' ');
    let m;
    if ((m = scan.match(DATE_FULL)) && validYmd(+m[1], +m[2], +m[3])) item.date = m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    else if ((m = scan.match(DATE_KO))) { item.date = inferDate(+m[1], +m[2], today); item.yearGuessed = true; }
    else if ((m = scan.match(DATE_MD))) { item.date = inferDate(+m[2], +m[3], today); item.yearGuessed = true; }
    if (!item.date) { item.date = today; item.issues.push('날짜를 확인해 주세요'); }
    else if (item.date > today) { item.date = today; item.issues.push('날짜를 확인해 주세요'); }
    else if (dayDiff(item.date, today) > 45 && !DATE_FULL.test(scan)) item.issues.push('연도를 확인해 주세요');
    if ((m = scan.match(TIME))) item.time = pad(+m[2]) + ':' + m[3];
    else if ((m = scan.match(TIME_KO))) item.time = pad(+m[1]) + ':' + pad(+m[2]);
    const mo = text.match(/(\d{1,2})\s*개월/);
    if (mo && +mo[1] >= 2 && !/일시불/.test(text)) item.months = +mo[1];
    item.merchant = merchantOf(lines).slice(0, 60);
    if (!item.merchant) item.issues.push('거래처를 넣어 주세요');
    item.raw = text;
    return { item };
  }

  function parseNotices(text, opts) {
    const today = (opts && opts.today) || ymd(new Date());
    const items = [], unread = [];
    splitNotices(text).forEach(lines => {
      const r = parseNotice(lines, today);
      if (r.item) items.push(r.item);
      else if (lines.join('').replace(/\s/g, '').length > 3) unread.push({ raw: lines.join('\n'), why: r.unread });
    });
    return { items, unread };
  }

  /* ---------------- 분류·결제자·결제수단 추천 ---------------- */
  const KEYWORDS = [
    ['카페', /커피|카페|cafe|coffee|스타벅스|starbucks|투썸|이디야|메가엠지씨|메가커피|빽다방|폴바셋|컴포즈|블루보틀|할리스|탐앤탐스/i],
    ['식비', /식당|김밥|분식|치킨|피자|버거|맥도날드|롯데리아|배달의민족|배민|요기요|쿠팡이츠|국밥|베이커리|파리바게뜨|뚜레쥬르|정육|반찬|마트|이마트|홈플러스|롯데마트|코스트코/i],
    ['교통', /택시|카카오t|티머니|코레일|korail|srt|고속버스|버스|지하철|철도|주유|오일|주차|하이패스|톨게이트/i],
    ['병원', /병원|의원|약국|치과|한의원|메디컬|클리닉/i],
    ['생활', /다이소|편의점|gs25|cu|세븐일레븐|이마트24|올리브영|세탁|관리비|생활/i],
    ['쇼핑', /쿠팡|11번가|g마켓|옥션|무신사|지그재그|ssg|에이블리|오늘의집|아마존|amazon|알리|ali/i],
  ];
  // history: 지운 것 뺀 기록 배열. 같은 거래처 → 비슷한 이름 → 분류 이름 포함 → 일반 키워드 순
  // makeSuggester: 거래처별 최근 기록 색인을 한 번 만들어 여러 후보에 재사용한다
  function makeSuggester(history, settings) {
    const cats = (settings && settings.categories) || [];
    const methods = (settings && settings.methods) || [];
    const latest = new Map(); // 정규화 거래처 → 가장 최근 기록
    history.forEach(t => {
      if (!t.merchant) return;
      const k = normMerchant(t.merchant), cur = latest.get(k);
      if (k && (!cur || (t.updated_at || 0) > (cur.updated_at || 0))) latest.set(k, t);
    });
    const keys = [...latest.keys()];
    const cache = new Map();
    return function (merchant, rawText) {
      const out = {};
      const n = normMerchant(merchant);
      let last = latest.get(n), from = 'history';
      if (!last && n.length >= 2) {
        if (!cache.has(n)) {
          let best = null;
          keys.forEach(k => { if (k.length >= 2 && (k.includes(n) || n.includes(k))) { const t = latest.get(k); if (!best || (t.updated_at || 0) > (best.updated_at || 0)) best = t; } });
          cache.set(n, best);
        }
        last = cache.get(n); from = 'similar';
      }
      if (last) {
        if (last.category) out.category = last.category;
        if (last.payer) out.payer = last.payer;
        if (last.method) out.method = last.method;
        out.from = from;
      }
      if (!out.category && merchant) {
        const byName = cats.find(c => c.length >= 2 && n.includes(normMerchant(c)));
        const byKw = KEYWORDS.find(([c, re]) => cats.includes(c) && re.test(merchant));
        out.category = byName || (byKw && byKw[0]) || '';
        if (out.category) out.from = out.from || 'keyword';
      }
      // 알림 글에 설정의 결제수단 이름(또는 '카드'를 뺀 앞부분)이 있으면 그 결제수단
      if (rawText) {
        const hit = methods.find(m => {
          const stem = m.replace(/(체크|신용)?카드$/, '');
          return rawText.includes(m) || (stem.length >= 2 && stem !== m && rawText.includes(stem));
        });
        if (hit) out.method = hit;
      }
      return out;
    };
  }
  const suggest = (merchant, history, settings, rawText) => makeSuggester(history, settings)(merchant, rawText);

  /* ---------------- 중복 대조 ----------------
   * candidates: { date, amount, merchant, type, time?, id? }  existing: 지운 것 뺀 기록 배열
   * 결과 dup: '' | 'same'(이미 있음: 같은 날짜·금액·종류 + 같은 거래처 또는 한쪽 거래처 없음)
   *          | 'similar'(비슷한 기록: 이름이 겹치거나 하루 차이) | 'batch'(이번 목록 안에서 반복)
   * 기존 기록 하나는 후보 하나에만 짝지어진다. 목록 안 반복은 시각이 같을 때(또는 opts.batchNoTime) 표시한다:
   * 시각 없는 카드 명세서의 같은 줄 두 개는 실제로 두 번 결제했을 수 있다 */
  function markDuplicates(candidates, existing, opts) {
    const o = opts || {};
    const kind = t => t.type || 'expense';
    const used = new Set();
    const ids = new Set(existing.map(t => t.id));
    const byAmt = new Map();
    existing.forEach(t => { const k = t.amount + '|' + kind(t); if (!byAmt.has(k)) byAmt.set(k, []); byAmt.get(k).push(t); });
    const pick = (c, test) => (byAmt.get(c.amount + '|' + kind(c)) || []).find(t => !used.has(t.id) && test(t));
    const sameName = (a, b) => normMerchant(a) === normMerchant(b);
    candidates.forEach(c => {
      c.dup = ''; c.match = null;
      if (c.id && ids.has(c.id)) { c.dup = 'same'; used.add(c.id); return; }
      if (!c.amount) return;
      let t = pick(c, t => t.date === c.date && (sameName(t.merchant, c.merchant) || !t.merchant || !c.merchant));
      if (t) c.dup = 'same';
      else if ((t = pick(c, t => t.date === c.date && merchantMatch(t.merchant, c.merchant)) || pick(c, t => Math.abs(dayDiff(t.date, c.date)) <= 1))) c.dup = 'similar';
      if (t) { used.add(t.id); c.match = { id: t.id, date: t.date, merchant: t.merchant, amount: t.amount }; }
    });
    const seen = new Set();
    candidates.forEach(c => {
      const k = [c.date, c.amount, kind(c), normMerchant(c.merchant), c.time || ''].join('|');
      if (seen.has(k) && (c.time || o.batchNoTime)) { if (c.dup !== 'same') c.dup = 'batch'; }
      seen.add(k);
    });
    return candidates;
  }

  /* ---------------- 파일 (CSV·엑셀) ---------------- */
  // 한국 카드사 CSV는 EUC-KR인 경우가 많다: UTF-8로 엄격히 읽어 보고 실패하면 EUC-KR
  function decodeText(bytes, enc) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (enc) return new TextDecoder(enc).decode(u8).replace(/^﻿/, '');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, ''); }
    catch (e) { return new TextDecoder('euc-kr').decode(u8); }
  }
  function parseCsv(text) {
    text = String(text || '').replace(/^﻿/, '');
    const head = text.slice(0, 4000).split('\n').slice(0, 10).join('\n').replace(/"[^"]*"/g, '');
    const count = ch => head.split(ch).length - 1;
    const delim = [',', '\t', ';'].sort((a, b) => count(b) - count(a))[0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(r => r.map(v => v.trim())).filter(r => r.some(v => v !== ''));
  }

  const ROLE_RULES = {
    date: [/^(이용|승인|거래|사용|매출)\s*(일자|일시|날짜|일)$/, /(이용|승인|거래|사용|매출)\s*(일자|일시|날짜|일)/, /^(날짜|일자|일시|date)$/i, /날짜|일자|일시|date/i],
    time: [/^(이용|승인|거래)?\s*(시간|시각)$|^time$/i],
    amount: [/(이용|승인|거래|사용|매출)\s*금액(?!.*(외화|현지|달러))/, /^(금액|amount|금액\s*\(원\)|원화\s*금액)$/i, /(결제|출금)\s*금액|원화/, /금액|amount/i],
    merchant: [/가맹점|이용처|사용처|거래처|상호|merchant|payee/i, /^(내용|내역|적요|사용\s*내역|description|memo|이용\s*내역)$/i, /내용|내역|적요/],
    type: [/^(종류|구분|유형|상태|승인\s*구분|취소\s*여부|거래\s*구분|type)$/i, /취소|구분|상태/],
    category: [/^(분류|카테고리|category|대분류)$/i, /분류|카테고리/i],
    payer: [/^(결제자|사용자|이용자|카드\s*소지자|본인\s*구분)$/],
    method: [/^(결제\s*수단|결제\s*방법|카드명|카드\s*종류|이용\s*카드|자산)$/, /결제\s*수단|카드명/],
    note: [/^(메모|비고|note|memo)$/i],
    months: [/할부|개월/],
    id: [/^id$/i],
    currency: [/^(통화|화폐|currency|통화\s*코드|결제\s*통화)$/i],
  };
  const SKIP_HEADER = /수수료|잔액|포인트|할인|적립|결제\s*예정|누적|외화|현지|달러|이자|청구/;
  const HEADER_WORD = /일자|일시|날짜|date|금액|amount|가맹점|이용처|사용처|거래처|내용|적요|분류|구분|메모|결제|승인|이용/i;

  function detectHeaderRow(rows) {
    let best = 0, score = -1;
    rows.slice(0, 30).forEach((r, i) => {
      const s = r.filter(v => typeof v === 'string' && v.length <= 20 && HEADER_WORD.test(v)).length;
      if (s > score) { score = s; best = i; }
    });
    return score >= 2 ? best : -1; // -1 = 머리줄 없음
  }

  function toDate(v) {
    if (typeof v === 'number' && v > 20000 && v < 80000) { // 엑셀 날짜 일련번호
      const d = new Date((Math.floor(v) - 25569) * 864e5); // 소수점(시각)은 버린다: 오후 시각이 다음 날로 넘어가지 않게
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }
    const s = String(v == null ? '' : v).trim();
    let m;
    if ((m = s.match(/^(\d{4})\s*[.\/\-년]\s*(\d{1,2})\s*[.\/\-월]\s*(\d{1,2})/)) && validYmd(+m[1], +m[2], +m[3])) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})(?!\d)/)) && validYmd(+m[1], +m[2], +m[3])) return m[1] + '-' + m[2] + '-' + m[3];
    if ((m = s.match(/^(\d{2})[.\/\-](\d{1,2})[.\/\-](\d{1,2})(?!\d)/)) && validYmd(2000 + +m[1], +m[2], +m[3])) return (2000 + +m[1]) + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)) && validYmd(+m[3], +m[1], +m[2])) return m[3] + '-' + pad(+m[1]) + '-' + pad(+m[2]); // 미국식 월/일/연
    return '';
  }
  const timeOf = v => {
    if (typeof v === 'number' && v > 0 && v < 1) { const mins = Math.round(v * 1440); return pad(Math.floor(mins / 60) % 24) + ':' + pad(mins % 60); }
    if (typeof v === 'number' && v > 20000) { const mins = Math.round((v % 1) * 1440); return mins ? pad(Math.floor(mins / 60) % 24) + ':' + pad(mins % 60) : ''; }
    const m = String(v == null ? '' : v).match(TIME);
    return m ? pad(+m[2]) + ':' + m[3] : '';
  };

  // header: 머리줄 값 배열(없으면 null), rows: 데이터 줄. 반환 { date, amount, merchant, ... : 열 번호 | -1 }
  function guessColumns(header, rows) {
    const n = Math.max(header ? header.length : 0, ...rows.slice(0, 50).map(r => r.length));
    const names = Array.from({ length: n }, (_, i) => String(header && header[i] != null ? header[i] : '').trim());
    const sample = rows.slice(0, 50);
    const share = (i, test) => { const vals = sample.map(r => r[i]).filter(v => v !== '' && v != null); return vals.length ? vals.filter(test).length / vals.length : 0; };
    const out = {}, taken = new Set();
    Object.keys(ROLE_RULES).forEach(role => {
      out[role] = -1;
      for (const re of ROLE_RULES[role]) {
        const i = names.findIndex((nm, k) => nm && !taken.has(k) && re.test(nm) && !(role === 'amount' && SKIP_HEADER.test(nm)) && !(role === 'date' && /결제\s*(예정)?일/.test(nm)));
        if (i >= 0) { out[role] = i; taken.add(i); break; }
      }
    });
    // 이름으로 못 찾으면 값으로: 날짜처럼 보이는 열, 숫자 열, 글자 많은 열
    const cols = names.map((_, i) => i).filter(i => !taken.has(i) && !SKIP_HEADER.test(names[i]));
    if (out.date < 0) { const i = cols.find(i => share(i, v => !!toDate(v)) >= 0.8); if (i !== undefined) { out.date = i; taken.add(i); } }
    if (out.amount < 0) { const i = cols.find(i => !taken.has(i) && share(i, v => Number.isFinite(parseAmount(v)) && Math.abs(parseAmount(v)) >= 100) >= 0.8); if (i !== undefined) { out.amount = i; taken.add(i); } }
    if (out.merchant < 0) {
      const textCols = cols.filter(i => !taken.has(i) && share(i, v => typeof v === 'string' && /[가-힣A-Za-z]/.test(v) && !toDate(v)) >= 0.6);
      const distinct = i => new Set(sample.map(r => r[i])).size;
      textCols.sort((a, b) => distinct(b) - distinct(a));
      if (textCols.length) out.merchant = textCols[0];
    }
    // 날짜 열에 시각이 같이 있으면 시각 열로도 쓴다
    if (out.time < 0 && out.date >= 0 && share(out.date, v => !!timeOf(v)) >= 0.5) out.time = out.date;
    return out;
  }

  /* 종류 칸 글자 → 'expense' | 'refund' | 'transfer' | 'income' | 'unknown' | '' (빈 칸)
   * '취소 아님'·'취소가능'은 정상, '취소여부' 열의 Y/O는 취소 */
  function typeOf(text, header) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return '';
    if (/취소\s*(아님|안\s*함|없음|불가|가능)/.test(t)) return 'expense';
    if (/취소/.test(header || '') && /^(y|yes|o|예|네|1|true)$/i.test(t)) return 'refund';
    if (/취소/.test(header || '') && /^(n|no|x|아니오|아니요|0|false|-)$/i.test(t)) return 'expense';
    if (/취소|환불|반품|refund|cancel|reversal/i.test(t)) return 'refund';
    if (/수입|입금|급여|income/i.test(t)) return 'income';
    if (/이체|지출\s*제외|카드\s*대금|대금|transfer/i.test(t)) return 'transfer';
    if (/^(정상|승인|일시불|할부|사용|결제|지출|매출|소비|expense|purchase|approved?|n|-)$/i.test(t) || /승인|일시불|할부/.test(t)) return 'expense';
    return 'unknown';
  }

  /* 표 → 후보 기록
   * mapping: guessColumns 결과. opts.negative: 'refund' | 'expense' | 'skip' (비우면 추천값으로 미리보기)
   * opts.header: 머리줄(종류 열 이름 해석용), opts.today: 미래 날짜 판단 기준
   * 반환 items(후보) / unread(가져올 수 없는 줄과 이유) / negatives(음수 금액 줄 수) / negRule(적용한 규칙) / negSuggested */
  function rowsToCandidates(rows, mapping, opts) {
    const o = Object.assign({ negative: '', header: null, today: ymd(new Date()) }, opts);
    const get = (r, role) => mapping[role] >= 0 ? r[mapping[role]] : '';
    const typeHeader = o.header && mapping.type >= 0 ? String(o.header[mapping.type] || '') : '';
    const items = [], unread = [];
    const amts = rows.map(r => parseAmount(get(r, 'amount'))).filter(Number.isFinite);
    const negatives = amts.filter(n => n < 0).length;
    // 추천: 음수가 대부분이면 다른 가계부 방식(지출=음수, 양수=수입), 일부만이면 취소·환불
    const negSuggested = negatives ? (negatives >= amts.length * 0.6 ? 'expense' : 'refund') : '';
    const negRule = o.negative || negSuggested;
    rows.forEach((r, i) => {
      const line = i + 1;
      const raw = r.filter(v => v !== '' && v != null).join(' · ').slice(0, 160);
      const merchant = String(get(r, 'merchant') || '').trim();
      if (/^(합계|소계|총계|total|합\s*계)/i.test(merchant) || /^(합계|소계|총계)/.test(String(r[0] || ''))) return;
      const date = toDate(get(r, 'date'));
      let amount = parseAmount(get(r, 'amount'));
      if (!date && !Number.isFinite(amount)) return; // 빈 줄·안내 문구
      if (!date) { unread.push({ raw, why: '날짜를 읽지 못했어요', line }); return; }
      if (!Number.isFinite(amount) || amount === 0) { unread.push({ raw, why: '금액을 읽지 못했어요', line }); return; }
      const typeText = String(get(r, 'type') || '').trim();
      const named = typeOf(typeText, typeHeader);
      if (named === 'income') { unread.push({ raw, why: '수입은 가져오지 않아요', line }); return; }
      const issues = [];
      let type = named === 'refund' || named === 'transfer' ? named : 'expense';
      if (named === 'unknown') issues.push(`종류를 확인해 주세요 (${typeText.slice(0, 12)})`);
      if (amount < 0) {
        if (negRule === 'skip') { unread.push({ raw, why: '음수 금액이라 건너뛰었어요', line }); return; }
        if (negRule === 'refund' && type === 'expense') type = 'refund';
        if (named === 'expense' && negRule === 'refund') issues.push('승인인데 음수 금액이에요. 확인해 주세요');
        amount = -amount;
      } else if (negRule === 'expense' && negatives && type === 'expense' && !named) {
        unread.push({ raw, why: '수입(양수 금액)은 가져오지 않아요', line }); return;
      }
      const item = { date, amount, merchant: merchant.slice(0, 60), type, issues, line, raw };
      // 통화 열이 원화가 아니면 금액을 원화로 쓰지 않는다
      const cur = mapping.currency >= 0 ? String(get(r, 'currency') || '').trim() : '';
      if (cur && !/^(krw|원|₩|won)$/i.test(cur)) { item.foreign = cur.toUpperCase() + ' ' + amount; item.amount = 0; issues.push('원화 금액을 넣어 주세요'); }
      if (date > o.today) issues.push('미래 날짜예요. 확인해 주세요');
      const time = mapping.time >= 0 ? timeOf(get(r, 'time')) : '';
      if (time) item.time = time;
      ['category', 'payer', 'method'].forEach(k => { const v = String(get(r, k) || '').trim(); if (v) item[k] = v.slice(0, 60); });
      const note = String(get(r, 'note') || '').trim(); if (note) item.note = note.slice(0, 200);
      const months = parseInt(get(r, 'months'), 10);
      if (months >= 2) item.months = months;
      const id = String(get(r, 'id') || '').trim();
      if (id) item.id = id;
      if (!item.merchant) issues.push('거래처를 넣어 주세요');
      items.push(item);
    });
    return { items, unread, negatives, negRule, negSuggested };
  }

  /* ---------------- 필터·합계 ----------------
   * filter: { cats:[], payers:[], min, max, kind:'all'|'expense'|'refund'|'transfer'|'refund_pending', q }
   * range: { start, end } 또는 null(전체 기간). 같은 항목 안은 OR, 항목끼리는 AND */
  function filterTxs(txs, f, range) {
    const q = String(f.q || '').trim().toLowerCase();
    const min = Number(f.min) || 0, max = Number(f.max) || 0;
    return txs.filter(t => {
      if (range && (t.date < range.start || t.date > range.end)) return false;
      if (f.cats && f.cats.length && !f.cats.includes(t.category || '미분류')) return false;
      if (f.payers && f.payers.length && !f.payers.includes(t.payer || '공동')) return false;
      if (min && t.amount < min) return false;
      if (max && t.amount > max) return false;
      if (f.kind === 'refund_pending' && !t.refund_pending) return false;
      if (['expense', 'refund', 'transfer'].includes(f.kind) && (t.type || 'expense') !== f.kind) return false;
      if (q && ![t.merchant, t.note, t.category, t.method, t.payer].join(' ').toLowerCase().includes(q)) return false;
      return true;
    });
  }
  function summarize(txs) {
    const s = { count: txs.length, net: 0, expense: 0, refund: 0, transfer: 0 };
    txs.forEach(t => { s.net += signed(t); s[t.type === 'refund' ? 'refund' : t.type === 'transfer' ? 'transfer' : 'expense'] += t.amount; });
    return s;
  }

  const core = {
    pad, ymd, parseDate, addDays, dayDiff, cycleRange, signed, parseAmount, normMerchant, merchantMatch,
    splitNotices, parseNotices, suggest, makeSuggester, markDuplicates, typeOf,
    decodeText, parseCsv, detectHeaderRow, guessColumns, toDate, rowsToCandidates,
    filterTxs, summarize,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else root.core = core;
})(typeof window !== 'undefined' ? window : this);
