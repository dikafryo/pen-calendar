// sync/nextcloud-auth.js — NextCloud 인증 + 다중 캘린더 선택 관리
// 변경점 (멀티 캘린더):
//   - selectedCalendarUrl/Name (단일) → selectedCalendars (배열)
//   - getPrimaryCalendarUrl: 새 일정의 기본 저장 위치

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
  // 새 인증 시 기존 선택은 초기화
  store.delete('selectedCalendars');

  cachedClient = client;

  return {
    username,
    serverUrl: norm.serverUrl,
    calendars: filterEventCalendars(calendars)
  };
}

// ─────────────────────────────────────────────
// 🆕 displayName 안전 추출
//   tsdav가 서버에 따라 string / { _cdata } / { _text } / { #text } / 빈 객체
//   여러 형태로 돌려줘서 통일된 문자열로 뽑아내야 함
// ─────────────────────────────────────────────
function extractDisplayName(c) {
  const dn = c.displayName;

  // 1) 평범한 문자열 (대부분의 경우)
  if (typeof dn === 'string' && dn.trim()) return dn.trim();

  // 2) XML CDATA/text 객체 형태 (일부 NextCloud 버전)
  if (dn && typeof dn === 'object') {
    const candidates = [dn._cdata, dn._text, dn['#text'], dn._, dn.value];
    for (const v of candidates) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }

  // 3) URL 마지막 세그먼트로 폴백 (예: /calendars/user/personal/ → "personal")
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

function filterEventCalendars(calendars) {
  return (calendars || [])
    .filter(c => !c.components || c.components.length === 0 || c.components.includes('VEVENT'))
    .map(c => ({
      url: c.url,
      displayName: extractDisplayName(c),  // 🆕 안전 추출
      ctag: c.ctag || null
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
  return filterEventCalendars(cals);
}

// ─────────────────────────────────────────────
// 🆕 다중 캘린더 선택 저장/조회
//   selectedCalendars: [{ url, displayName, isPrimary }]
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
