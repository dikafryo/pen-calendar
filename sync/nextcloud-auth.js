// sync/nextcloud-auth.js — NextCloud 인증 + 다중 캘린더 선택 관리
// 변경점 (v26.5.7):
//   - 캘린더별 calendar-color 추출 (Apple iCal 표준 속성)
//   - tsdav가 색을 못 주면 직접 PROPFIND로 raw XML 가져와서 파싱
//   - [nc-debug] 로그로 어디서 색이 오는지 추적

const { createDAVClient } = require('tsdav');
const Store = require('electron-store');

const store = new Store({
  name: 'nextcloud-auth',
  encryptionKey: 'desktop-calendar-v1-nc-auth'
});

let cachedClient = null;

function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('서버 주소를 입력하세요');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, '');
  let calDavUrl;
  if (/\/remote\.php\/dav(\/.*)?$/i.test(s)) {
    calDavUrl = s.replace(/\/+$/, '');
    s = s.replace(/\/remote\.php\/dav.*$/i, '');
  } else {
    calDavUrl = s + '/remote.php/dav';
  }
  return { serverUrl: s, calDavUrl };
}

async function authenticate({ serverUrl, username, password }) {
  if (!username || !password) throw new Error('ID와 비밀번호를 모두 입력하세요');
  const norm = normalizeServerUrl(serverUrl);

  const client = await createDAVClient({
    serverUrl: norm.calDavUrl,
    credentials: { username, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav'
  });

  const calendars = await client.fetchCalendars();

  store.set('credentials', {
    serverUrl: norm.serverUrl,
    calDavUrl: norm.calDavUrl,
    username, password
  });
  store.set('connectedAt', new Date().toISOString());
  store.delete('selectedCalendars');

  cachedClient = client;

  // 🆕 색상 보충 (tsdav가 안 줬으면 PROPFIND로 직접)
  const enriched = await enrichColors(calendars, { username, password });

  return {
    username,
    serverUrl: norm.serverUrl,
    calendars: filterEventCalendars(enriched)
  };
}

// ─────────────────────────────────────────────
// displayName 안전 추출 (tsdav 버전별 호환)
// ─────────────────────────────────────────────
function extractDisplayName(c) {
  const dn = c.displayName;
  if (typeof dn === 'string' && dn.trim()) return dn.trim();
  if (dn && typeof dn === 'object') {
    const candidates = [dn._cdata, dn._text, dn['#text'], dn._, dn.value];
    for (const v of candidates) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  if (c.url) {
    try {
      const segs = String(c.url).replace(/\/+$/, '').split('/').filter(Boolean);
      const last = segs[segs.length - 1];
      const decoded = decodeURIComponent(last || '');
      if (decoded) return decoded;
    } catch {}
    return c.url;
  }
  return '(이름 없음)';
}

// ─────────────────────────────────────────────
// 🆕 v26.5.7: NextCloud 캘린더 색상 추출
//   가능한 모든 필드를 체크 (tsdav 버전별로 다름)
// ─────────────────────────────────────────────
function extractCalendarColor(c) {
  const candidates = [
    c.calendarColor,
    c['calendar-color'],
    c.color,
    c.props && c.props['calendar-color'],
    c.props && c.props.calendarColor,
    c.props && c.props['{http://apple.com/ns/ical/}calendar-color'],
    c.raw && c.raw['calendar-color'],
  ];
  for (const raw of candidates) {
    const hex = normalizeHexColor(raw);
    if (hex) return hex;
  }
  return null;
}

function normalizeHexColor(raw) {
  // 객체로 들어오는 경우 (CDATA 등)
  if (raw && typeof raw === 'object') {
    raw = raw._cdata || raw._text || raw['#text'] || raw._ || raw.value || null;
  }
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (s[0] !== '#') s = '#' + s;
  if (/^#[0-9a-f]{8}$/i.test(s)) return s.substring(0, 7).toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return ('#' + s[1]+s[1] + s[2]+s[2] + s[3]+s[3]).toLowerCase();
  }
  return null;
}

// ─────────────────────────────────────────────
// 🆕 v26.5.7: tsdav가 calendar-color를 안 주는 경우
//   직접 PROPFIND 요청으로 raw XML 받아서 정규식 파싱
// ─────────────────────────────────────────────
async function fetchColorViaPropfind(calendarUrl, credentials) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:x1="http://apple.com/ns/ical/">
  <d:prop>
    <x1:calendar-color/>
  </d:prop>
</d:propfind>`;

  const auth = 'Basic ' + Buffer
    .from(credentials.username + ':' + credentials.password)
    .toString('base64');

  try {
    const res = await fetch(calendarUrl, {
      method: 'PROPFIND',
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '0',
        'Authorization': auth
      },
      body
    });
    if (!res.ok) return null;
    const xml = await res.text();

    // <x1:calendar-color>#FFCC00FF</x1:calendar-color> 식으로 들어옴
    const m = xml.match(/<[^>]*calendar-color[^>]*>([^<]+)<\/[^>]*calendar-color>/i);
    return m ? normalizeHexColor(m[1]) : null;
  } catch (err) {
    console.warn('[nc-debug] PROPFIND 실패:', calendarUrl, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// 🆕 v26.5.7: 색상 보충
//   1) tsdav 응답에서 직접 추출 시도
//   2) 못 찾으면 PROPFIND로 raw XML 요청
//   3) 디버그 로그로 어떤 경로로 색이 왔는지 추적
// ─────────────────────────────────────────────
async function enrichColors(calendars, credentials) {
  // 첫 캘린더의 raw 구조 한 번만 출력 (디버그용)
  if (calendars && calendars[0]) {
    const sample = calendars[0];
    const keys = Object.keys(sample);
    console.log('[nc-debug] tsdav 응답 키 목록:', keys.join(', '));
    if (sample.props) {
      console.log('[nc-debug] sample.props 키:', Object.keys(sample.props).join(', '));
    }
  }

  const result = [];
  for (const c of (calendars || [])) {
    let color = extractCalendarColor(c);
    let source = color ? 'tsdav' : null;

    // 1차에서 못 찾았으면 PROPFIND
    if (!color && c.url && credentials) {
      color = await fetchColorViaPropfind(c.url, credentials);
      if (color) source = 'propfind';
    }

    console.log(`[nc-debug] "${extractDisplayName(c)}" 색상 = ${color || '(없음)'} via ${source || 'none'}`);
    result.push({ ...c, _resolvedColor: color });
  }
  return result;
}

function filterEventCalendars(calendars) {
  return (calendars || [])
    .filter(c => !c.components || c.components.length === 0 || c.components.includes('VEVENT'))
    .map(c => ({
      url: c.url,
      displayName: extractDisplayName(c),
      ctag: c.ctag || null,
      // 🆕 enrichColors가 미리 _resolvedColor에 정리해뒀으면 그거, 아니면 1차 시도
      color: c._resolvedColor || extractCalendarColor(c) || null
    }));
}

async function getClient() {
  if (cachedClient) return cachedClient;
  const cred = store.get('credentials');
  if (!cred) return null;
  cachedClient = await createDAVClient({
    serverUrl: cred.calDavUrl,
    credentials: { username: cred.username, password: cred.password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav'
  });
  return cachedClient;
}

async function listCalendars() {
  const client = await getClient();
  if (!client) throw new Error('NextCloud에 로그인되어 있지 않습니다');
  const cals = await client.fetchCalendars();
  const cred = store.get('credentials');
  // 🆕 색상 보충
  const enriched = await enrichColors(cals, cred ? {
    username: cred.username, password: cred.password
  } : null);
  return filterEventCalendars(enriched);
}

// ─────────────────────────────────────────────
// 다중 캘린더 선택 저장/조회
// ─────────────────────────────────────────────
function getSelectedCalendars() {
  return store.get('selectedCalendars') || [];
}

function setSelectedCalendars(list) {
  if (Array.isArray(list) && list.length > 0 && !list.some(c => c.isPrimary)) {
    list[0].isPrimary = true;
  }
  store.set('selectedCalendars', list || []);
}

function getPrimaryCalendarUrl() {
  const list = getSelectedCalendars();
  const p = list.find(c => c.isPrimary);
  if (p) return p.url;
  if (list[0]) return list[0].url;
  return null;
}

function isAuthenticated() { return !!store.get('credentials'); }

function getStatus() {
  const cred = store.get('credentials');
  if (!cred) return { authenticated: false };
  const selected = getSelectedCalendars();
  return {
    authenticated: true,
    username: cred.username,
    serverUrl: cred.serverUrl,
    selectedCalendars: selected,
    selectedCount: selected.length,
    connectedAt: store.get('connectedAt') || null
  };
}

function revoke() {
  store.delete('credentials');
  store.delete('connectedAt');
  store.delete('selectedCalendars');
  cachedClient = null;
}

module.exports = {
  authenticate,
  getClient,
  listCalendars,
  getSelectedCalendars,
  setSelectedCalendars,
  getPrimaryCalendarUrl,
  isAuthenticated,
  getStatus,
  revoke
};