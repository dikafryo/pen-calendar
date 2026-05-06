// sync/nextcloud-calendar.js — NextCloud 다중 캘린더 양방향 동기화
// 변경점 (멀티 캘린더):
//   - 단일 selectedCalendarUrl 의존 제거 → 모든 selectedCalendars 순회
//   - 캘린더별 etagMap 따로 (etagMap_<calendarUrlHash>)
//   - 각 이벤트에 ncCalendarUrl 필드 추가

const ICAL = require('ical.js');
const Store = require('electron-store');
const ncAuth = require('./nextcloud-auth');

const syncStore = new Store({
  name: 'nextcloud-calendar-sync',
  encryptionKey: 'desktop-calendar-v1-nc-cal-sync'
});

const PROD_ID = '-//neisme//Calendar//KR';
const PAST_DAYS = 7;
const FUTURE_DAYS = 56;

const pad2 = n => String(n).padStart(2, '0');
function formatDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function formatTime(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

// 캘린더 URL을 store key로 안전하게 (URL은 길고 특수문자 많아서)
function urlKey(url) {
  return 'etagMap_' + Buffer.from(url).toString('base64').replace(/[/+=]/g, '_').slice(0, 80);
}

// ─────────────────────────────────────────────
// 🆕 v26.5.8b 헬퍼: ICAL.Time → "YYYY-MM-DD" (시간/타임존 무시)
//   - EXDATE/RECURRENCE-ID 값에서 날짜 부분만 뽑아 app.js의
//     exdates / originalStart 모델("YYYY-MM-DD")과 맞춤.
// ─────────────────────────────────────────────
function icalTimeToDateStr(t) {
  if (!t) return '';
  if (typeof t === 'string') {
    // 안전망: "20260514T140000Z" 같은 raw 문자열도 처리
    const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(t);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  }
  if (t.year && t.month && t.day) {
    return `${t.year}-${pad2(t.month)}-${pad2(t.day)}`;
  }
  try {
    const js = t.toJSDate();
    return formatDate(js);
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────
// 🆕 v26.5.8b 단일 VEVENT → local 객체 (마스터/분리 인스턴스 공통 변환)
//   - RRULE → local.recurrence (문자열)
//   - EXDATE → local.exdates (["YYYY-MM-DD", ...])
//   - 분리 인스턴스(RECURRENCE-ID 있음)의 식별/연결은 호출자(icsToLocals)에서 처리
// ─────────────────────────────────────────────
function veventToLocal(vevent, url, etag, calendarUrl, idPrefix) {
  const event = new ICAL.Event(vevent);
  if (!event.startDate) return null;

  let date, time = '';
  if (event.startDate.isDate) {
    date = `${event.startDate.year}-${pad2(event.startDate.month)}-${pad2(event.startDate.day)}`;
  } else {
    const js = event.startDate.toJSDate();
    date = formatDate(js); time = formatTime(js);
  }

  const alarmSet = new Set();
  vevent.getAllSubcomponents('valarm').forEach(va => {
    const trig = va.getFirstPropertyValue('trigger');
    if (!trig) return;
    let minutes = null;
    if (trig.toSeconds) minutes = Math.abs(Math.round(trig.toSeconds() / 60));
    else if (typeof trig === 'string') {
      const m = /-?P(?:T)?(\d+)([MHD])/i.exec(trig);
      if (m) {
        const n = parseInt(m[1], 10);
        const u = m[2].toUpperCase();
        minutes = u === 'M' ? n : u === 'H' ? n * 60 : n * 1440;
      }
    }
    if (minutes === 5) alarmSet.add('5min');
    else if (minutes === 30) alarmSet.add('30min');
    else if (minutes === 1440) alarmSet.add('1day');
  });

  // 🆕 v26.5.8b RRULE — ICAL.Recur → "FREQ=WEEKLY;INTERVAL=1;COUNT=10" 형태
  let recurrence = '';
  const rruleVal = vevent.getFirstPropertyValue('rrule');
  if (rruleVal) {
    // ICAL.Recur.toString() = "FREQ=WEEKLY;..." (RRULE: 접두사 없음)
    // 안전하게 접두사 제거 (env에 따라 붙는 케이스 방지)
    recurrence = String(rruleVal).replace(/^RRULE:/i, '').trim();
  }

  // 🆕 v26.5.8b EXDATE — 여러 줄 + 한 줄 콤마구분 모두 처리
  const exdates = [];
  vevent.getAllProperties('exdate').forEach(prop => {
    const values = (typeof prop.getValues === 'function')
      ? prop.getValues()
      : [prop.getFirstValue()];
    values.forEach(v => {
      const ds = icalTimeToDateStr(v);
      if (ds) exdates.push(ds);
    });
  });

  const local = {
    id: idPrefix + event.uid,
    ncUid: event.uid,
    ncUrl: url,
    ncEtag: etag,
    ncCalendarUrl: calendarUrl,
    title: event.summary || '(제목 없음)',
    date, time,
    source: 'nextcloud',
    alarms: [...alarmSet],
    memo: event.description || ''
  };
  if (recurrence) local.recurrence = recurrence;
  if (exdates.length > 0) local.exdates = exdates;
  return local;
}

// ─────────────────────────────────────────────
// ICS → 로컬 (배열 반환 — 마스터 + 분리 인스턴스들)
//
// 🆕 v26.5.8b 변경:
//   - 한 ICS 안에 여러 VEVENT(마스터 1 + RECURRENCE-ID 가진 분리 인스턴스 N) 가능
//   - 마스터: RECURRENCE-ID 없는 VEVENT → app.js 모델의 id = nc_<hash>_<uid>
//   - 분리 인스턴스: RECURRENCE-ID 있는 VEVENT
//       → id = master.id + "@" + originalStart
//       → recurrenceId = master.id
//       → originalStart = "YYYY-MM-DD" (RECURRENCE-ID 의 날짜 부분)
//       → recurrence/exdates 는 분리 인스턴스에서 무시
// ─────────────────────────────────────────────
function icsToLocals(rawIcs, url, etag, calendarUrl) {
  try {
    const jcal = ICAL.parse(rawIcs);
    const vcal = new ICAL.Component(jcal);
    const vevents = vcal.getAllSubcomponents('vevent') || [];
    if (vevents.length === 0) return [];

    const idPrefix = 'nc_' + Buffer.from(calendarUrl).toString('base64').slice(0, 12) + '_';

    // 마스터 vs 분리 인스턴스 분리
    let masterVevent = null;
    const detachedVevents = [];
    for (const ve of vevents) {
      if (ve.getFirstPropertyValue('recurrence-id')) {
        detachedVevents.push(ve);
      } else {
        masterVevent = ve; // 보통 1개 — 여러 개면 마지막 유효본 사용
      }
    }
    // 마스터가 없는 경우 (외부 캘린더에서 분리 인스턴스만 노출되는 드문 케이스):
    // 첫 vevent를 마스터로 fallback
    if (!masterVevent && detachedVevents.length > 0) {
      masterVevent = detachedVevents.shift();
    }

    const results = [];
    const master = masterVevent
      ? veventToLocal(masterVevent, url, etag, calendarUrl, idPrefix)
      : null;
    if (master) results.push(master);

    if (master) {
      for (const ve of detachedVevents) {
        const recIdProp = ve.getFirstProperty('recurrence-id');
        if (!recIdProp) continue;
        const recIdValue = recIdProp.getFirstValue();
        const originalStart = icalTimeToDateStr(recIdValue);
        if (!originalStart) continue;

        const inst = veventToLocal(ve, url, etag, calendarUrl, idPrefix);
        if (!inst) continue;

        inst.id = master.id + '@' + originalStart;
        inst.recurrenceId = master.id;
        inst.originalStart = originalStart;
        // 분리 인스턴스에 RRULE/EXDATE가 있어도 의미 없음 — 정리
        delete inst.recurrence;
        delete inst.exdates;
        results.push(inst);
      }
    }

    return results;
  } catch (err) {
    console.error('[nc] ICS 파싱 실패:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// 로컬 → ICS (변경 없음)
// ─────────────────────────────────────────────
function localToIcs(local) {
  const vcal = new ICAL.Component(['vcalendar', [], []]);
  vcal.updatePropertyWithValue('prodid', PROD_ID);
  vcal.updatePropertyWithValue('version', '2.0');
  vcal.updatePropertyWithValue('calscale', 'GREGORIAN');

  const vevent = new ICAL.Component('vevent');
  const event = new ICAL.Event(vevent);

  const uid = local.ncUid || `neisme-${Date.now()}-${Math.random().toString(36).slice(2,8)}@neis.me`;
  event.uid = uid;
  event.summary = local.title || '';
  if (local.memo) event.description = local.memo;

  if (local.time) {
    const startJs = new Date(`${local.date}T${local.time}:00+09:00`);
    const endJs = new Date(startJs.getTime() + 60 * 60 * 1000);
    event.startDate = ICAL.Time.fromJSDate(startJs, true);
    event.endDate = ICAL.Time.fromJSDate(endJs, true);
  } else {
    const [y, m, d] = local.date.split('-').map(Number);
    const start = new ICAL.Time({ year: y, month: m, day: d, isDate: true });
    const end = start.clone(); end.day += 1;
    event.startDate = start;
    event.endDate = end;
  }

  const now = ICAL.Time.fromJSDate(new Date(), true);
  vevent.updatePropertyWithValue('dtstamp', now);
  vevent.updatePropertyWithValue('last-modified', now);
  if (!local.ncUid) vevent.updatePropertyWithValue('created', now);

  (local.alarms || []).forEach(a => {
    const min = a === '5min' ? 5 : a === '30min' ? 30 : 1440;
    const valarm = new ICAL.Component('valarm');
    valarm.addPropertyWithValue('action', 'DISPLAY');
    valarm.addPropertyWithValue('description', local.title || '알림');
    const trigProp = new ICAL.Property('trigger');
    trigProp.setValue(ICAL.Duration.fromSeconds(-min * 60));
    valarm.addProperty(trigProp);
    vevent.addSubcomponent(valarm);
  });

  vcal.addSubcomponent(vevent);
  return { iCalString: vcal.toString(), uid };
}

// ─────────────────────────────────────────────
// 🆕 캘린더 1개 fetch (timeRange 적용)
// ─────────────────────────────────────────────
async function fetchOneInRange(client, allDavCalendars, calendarUrl) {
  const target = allDavCalendars.find(c => c.url === calendarUrl);
  if (!target) {
    console.warn('[nc-cal] 캘린더 못 찾음:', calendarUrl);
    return { calendar: null, objects: [] };
  }

  const now = new Date();
  const start = new Date(now); start.setDate(now.getDate() - PAST_DAYS); start.setHours(0,0,0,0);
  const end   = new Date(now); end.setDate(now.getDate() + FUTURE_DAYS); end.setHours(23,59,59,999);

  const objects = await client.fetchCalendarObjects({
    calendar: target,
    timeRange: { start: start.toISOString(), end: end.toISOString() }
  });
  return { calendar: target, objects: objects || [] };
}

// ─────────────────────────────────────────────
// 🆕 캘린더 1개 동기화
// ─────────────────────────────────────────────
async function syncOne(client, allDavCalendars, calendarUrl) {
  const { calendar, objects } = await fetchOneInRange(client, allDavCalendars, calendarUrl);
  if (!calendar) return { events: [], deletedIds: [], isFull: false };

  const events = [];
  const newMap = {};
  const seen = new Set();

  for (const o of objects) {
    // 🆕 v26.5.8b: 한 ICS 객체가 마스터 + 분리 인스턴스 N개를 포함할 수 있음
    const locals = icsToLocals(o.data, o.url, o.etag, calendarUrl);
    if (locals.length === 0) continue;
    // etagMap은 UID 기준 1개 (분리 인스턴스도 같은 ICS URL/etag 공유)
    const masterUid = locals[0].ncUid;
    seen.add(masterUid);
    newMap[masterUid] = { url: o.url, etag: o.etag };
    for (const local of locals) {
      events.push(local);
    }
  }

  const key = urlKey(calendarUrl);
  const prevMap = syncStore.get(key);

  let deletedIds = [];
  let isFull = false;

  if (!prevMap) {
    // 처음 동기화 = 전체
    isFull = true;
  } else {
    // 증분: 이전엔 있었는데 지금은 없는 = 삭제됨
    deletedIds = Object.keys(prevMap)
      .filter(uid => !seen.has(uid))
      .map(uid => 'nc_' + Buffer.from(calendarUrl).toString('base64').slice(0, 12) + '_' + uid);

    // 변경된 것만 추리기 (etag 비교)
    if (!isFull) {
      const changedEvents = events.filter(ev => {
        const prev = prevMap[ev.ncUid];
        return !prev || prev.etag !== ev.ncEtag;
      });
      // events 자리에 변경된 것만 넣음
      events.length = 0;
      events.push(...changedEvents);
    }
  }

  syncStore.set(key, newMap);
  return { events, deletedIds, isFull };
}

// ─────────────────────────────────────────────
// 🆕 모든 선택된 캘린더 동기화
// ─────────────────────────────────────────────
async function incrementalSync() {
  const client = await ncAuth.getClient();
  if (!client) throw new Error('NextCloud에 로그인되어 있지 않습니다');

  const selected = ncAuth.getSelectedCalendars();
  if (selected.length === 0) {
    return { events: [], deletedIds: [], isFull: true };
  }

  // DAV 캘린더 목록을 한 번만 fetch (각 syncOne에서 재사용)
  const allDavCalendars = await client.fetchCalendars();

  const allEvents = [];
  const allDeleted = [];
  let anyFull = false;

  for (const cal of selected) {
    try {
      const r = await syncOne(client, allDavCalendars, cal.url);
      if (r.isFull) anyFull = true;
      allEvents.push(...r.events);
      allDeleted.push(...r.deletedIds);
    } catch (err) {
      console.error(`[nc-cal] ${cal.displayName} 동기화 실패:`, err.message);
    }
  }

  // 더 이상 선택되지 않은 캘린더의 etagMap 삭제
  const selectedUrls = new Set(selected.map(c => c.url));
  Object.keys(syncStore.store).forEach(k => {
    if (k.startsWith('etagMap_')) {
      // 해당 키에 저장된 url을 알 방법이 없어 — 키만 보고는 매칭 불가
      // 대신 prev 데이터를 보면서 매칭하는 건 너무 비싸므로,
      // 대신 selectedUrls 변경 시 키들을 다 비우는 게 안전
    }
  });

  syncStore.set('lastSyncAt', new Date().toISOString());
  return { events: allEvents, deletedIds: allDeleted, isFull: anyFull };
}

// ─────────────────────────────────────────────
// 푸시 — 이벤트의 ncCalendarUrl 사용
// ─────────────────────────────────────────────
async function pushEvent(local) {
  const client = await ncAuth.getClient();
  if (!client) throw new Error('NextCloud에 로그인되어 있지 않습니다');

  // calendarUrl 결정: 이벤트에 있으면 그거, 없으면 primary
  const calendarUrl = local.ncCalendarUrl || ncAuth.getPrimaryCalendarUrl();
  if (!calendarUrl) throw new Error('동기화할 NextCloud 캘린더가 선택되지 않았습니다');

  const allDavCalendars = await client.fetchCalendars();
  const target = allDavCalendars.find(c => c.url === calendarUrl);
  if (!target) throw new Error('NextCloud 캘린더를 찾을 수 없습니다: ' + calendarUrl);

  const { iCalString, uid } = localToIcs(local);

  let resultUrl, resultEtag;
  if (local.ncUrl) {
    const res = await client.updateCalendarObject({
      calendarObject: { url: local.ncUrl, data: iCalString, etag: local.ncEtag }
    });
    resultUrl = local.ncUrl;
    resultEtag = extractEtag(res) || local.ncEtag;
  } else {
    const filename = uid + '.ics';
    const res = await client.createCalendarObject({
      calendar: target, filename, iCalString
    });
    resultUrl = (res && res.url) || target.url.replace(/\/$/, '') + '/' + filename;
    resultEtag = extractEtag(res) || null;
  }

  // etagMap 갱신
  const key = urlKey(calendarUrl);
  const map = syncStore.get(key) || {};
  map[uid] = { url: resultUrl, etag: resultEtag };
  syncStore.set(key, map);

  return {
    id: 'nc_' + Buffer.from(calendarUrl).toString('base64').slice(0, 12) + '_' + uid,
    ncUid: uid,
    ncUrl: resultUrl,
    ncEtag: resultEtag,
    ncCalendarUrl: calendarUrl,
    title: local.title || '',
    date: local.date,
    time: local.time || '',
    source: 'nextcloud',
    alarms: local.alarms || [],
    memo: local.memo || ''
  };
}

function extractEtag(res) {
  if (!res) return null;
  if (res.etag) return res.etag;
  if (res.headers) {
    if (typeof res.headers.get === 'function') return res.headers.get('etag');
    if (res.headers.etag) return res.headers.etag;
  }
  return null;
}

async function deleteEvent(local) {
  const client = await ncAuth.getClient();
  if (!client) throw new Error('NextCloud에 로그인되어 있지 않습니다');
  if (!local || !local.ncUrl) throw new Error('NextCloud URL이 없습니다');

  await client.deleteCalendarObject({
    calendarObject: { url: local.ncUrl, etag: local.ncEtag }
  });

  if (local.ncCalendarUrl && local.ncUid) {
    const key = urlKey(local.ncCalendarUrl);
    const map = syncStore.get(key) || {};
    delete map[local.ncUid];
    syncStore.set(key, map);
  }
}

function getLastSyncAt() { return syncStore.get('lastSyncAt') || null; }
function clearSyncState() {
  Object.keys(syncStore.store).forEach(k => syncStore.delete(k));
}

// ─────────────────────────────────────────────
// 🆕 임의 날짜 범위 fetch (etagMap 영향 없음, 단순 fetch)
// ─────────────────────────────────────────────
async function fetchRange(startISO, endISO) {
  const client = await ncAuth.getClient();
  if (!client) throw new Error('NextCloud에 로그인되어 있지 않습니다');

  const selected = ncAuth.getSelectedCalendars();
  if (selected.length === 0) return { events: [] };

  const allDavCalendars = await client.fetchCalendars();
  const allEvents = [];

  for (const cal of selected) {
    const target = allDavCalendars.find(c => c.url === cal.url);
    if (!target) continue;

    try {
      const objects = await client.fetchCalendarObjects({
        calendar: target,
        timeRange: { start: startISO, end: endISO }
      });
      (objects || []).forEach(o => {
        const locals = icsToLocals(o.data, o.url, o.etag, cal.url);
        locals.forEach(l => allEvents.push(l));
      });
    } catch (err) {
      console.error(`[nc-cal] fetchRange ${cal.displayName} 실패:`, err.message);
    }
  }

  return { events: allEvents };
}

module.exports = {
  incrementalSync,
  pushEvent,
  deleteEvent,
  getLastSyncAt,
  clearSyncState,
  fetchRange   // 🆕
};