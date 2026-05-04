// ╔══════════════════════════════════════════════════════════════════════╗
// ║  renderer/app.js — neisme Calendar 위젯 메인 렌더러 스크립트            ║
// ║                                                                      ║
// ║  이 파일은 화면(UI)에서 일어나는 모든 일을 담당함:                     ║
// ║   - 캘린더 그리드 그리기, 날짜 셀 클릭 처리                            ║
// ║   - 일정 추가/편집/삭제 모달                                           ║
// ║   - 메모/할 일 패널                                                    ║
// ║   - 설정 패널, 컨텍스트 메뉴, 토스트(작은 알림) 등                      ║
// ║   - Google Calendar/Tasks, NextCloud Calendar 동기화 "호출"            ║
// ║                                                                      ║
// ║  실제 Google/NextCloud 통신은 main.js의 sync/* 모듈이 담당.            ║
// ║  여기서는 window.electronAPI를 통해 IPC로 호출만 함.                   ║
// ╚══════════════════════════════════════════════════════════════════════╝


// ─────────────────────────────────────────────────────────────────────
// 환경 감지
// ─────────────────────────────────────────────────────────────────────
// preload.js가 contextBridge로 window.electronAPI를 노출함.
// Electron으로 실행하면 정의돼있고, 일반 브라우저에서 열면 undefined.
// 아래 코드 곳곳에서 "isElectron이면 IPC, 아니면 fallback" 분기에 사용함.
const isElectron = !!window.electronAPI;


// ─────────────────────────────────────────────────────────────────────
// 전역 상태 (state)
// ─────────────────────────────────────────────────────────────────────
// 화면에 보이는 모든 정보의 "단일 출처(single source of truth)".
// 사용자가 뭘 클릭하든, 동기화로 데이터가 바뀌든 결국 이 객체가 갱신되고
// renderXxx() 함수들이 이걸 보고 다시 그림.
const state = {
  layout: 'split',              // 레이아웃 모드: 'uniform' | 'emphasis' | 'split'
  weekStartsOn: 1,              // 주의 시작 요일 (0=일, 1=월). uniform만 일요일 시작
  viewWeekStart: null,          // 현재 화면에 보이는 5주 그리드의 첫째 날 (Date 객체)
  selectedDate: new Date(),     // 사용자가 마지막으로 클릭한 날짜
  editingEventId: null,         // 일정 편집 모달이 열려있을 때 그 일정 id (없으면 null=신규)
  editingAlarms: new Set(),     // 모달에서 켜둔 알람들 ('5min', '30min', '1day')
  locked: true,                 // 창 잠금 상태 (잠그면 드래그/리사이즈 불가)
  events: [],                   // 모든 일정 목록 (로컬+Google+NextCloud 합쳐서 보관)
  memos: [],                    // 모든 메모/할 일 목록 (로컬+Google Tasks)
  memoFilter: 'all',            // 메모 탭 필터: 'all' | 'active' | 'gtasks'
  opacity: 0.88,                // 위젯 투명도 (0~1)
  fontSize: 10,                 // 기본 폰트 크기 (pt)

  // Google 연결 상태 (refreshGoogleAuthStatus()에서 갱신)
  googleAuthenticated: false,
  googleEmail: null,
  googleSelectedCalendars: [],   // [{id, summary, backgroundColor, isPrimary}]

  // NextCloud 연결 상태 (refreshNextcloudAuthStatus()에서 갱신)
  nextcloudAuthenticated: false,
  nextcloudUsername: null,
  nextcloudCalendarName: null,
  nextcloudSelectedCalendars: [],   // [{url, displayName, isPrimary}]

  // 🆕 캘린더별 커스텀 색상 캐시 (빠른 lookup용)
  // 형식: { google: { 'cal-id': '#ff0000' }, nextcloud: { 'url': '#00ff00' } }
  // refreshXxxAuthStatus() 호출 시 selectedCalendars로부터 자동 갱신
  calendarColors: {
    google: {},
    nextcloud: {}
  },

  // 🆕 동기화된 날짜 범위 (Date 객체 또는 null)
  // - 처음 5분마다 동기화 / 수동 동기화 후 갱신됨
  // - 사용자가 이 범위 밖으로 캘린더 이동하면 ensureRangeSynced()가 자동 fetch
  syncedRange: {
    google: { start: null, end: null },
    nextcloud: { start: null, end: null }
  }
};


// ─────────────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────────────
// 월 이름 한국어 (renderHeader에서 사용)
const MONTHS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
// 요일 이름 한국어 (0=일요일 ~ 6=토요일, JS Date.getDay()와 동일한 인덱스)
const DOW = ['일','월','화','수','목','금','토'];
// 알람 키 → 분 단위 변환 테이블 (scheduleAlarms에서 setTimeout 시간 계산에 사용)
const ALARM_MINUTES = { '5min': 5, '30min': 30, '1day': 24 * 60 };


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 저장소 (Storage) — electron-store 또는 localStorage 호환 어댑터  ║
// ║                                                                  ║
// ║  preload.js가 window.storage를 노출함. 내부적으로는 IPC를 통해     ║
// ║  메인 프로세스의 electron-store에 저장됨.                          ║
// ║  키별로 JSON 문자열로 직렬화해서 저장.                              ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * 앱 시작 시 모든 데이터(일정/메모/설정)를 한 번에 불러와 state에 채움.
 * 처음 실행이면 샘플 데이터를 채워줌 (getSampleEvents, getSampleMemos).
 */
async function loadAll() {
  // 일정: 저장소에 없으면 샘플 일정 2개를 채워넣음
  state.events = (await loadJSON('cal_events_v4')) || getSampleEvents();
  // 메모: 마찬가지로 없으면 샘플
  state.memos  = (await loadJSON('cal_memos_v4')) || getSampleMemos();

  // 설정 (레이아웃, 투명도, 폰트크기): 있으면 state에 덮어쓰기
  const settings = await loadJSON('cal_settings_v4');
  if (settings) Object.assign(state, settings);

  // 레이아웃에 따라 주 시작 요일 자동 결정
  // - uniform: 일요일 시작 (전통적인 한국 캘린더)
  // - emphasis/split: 월요일 시작 (주말이 한쪽에 모이도록)
  state.weekStartsOn = state.layout === 'uniform' ? 0 : 1;

  // 잠금 상태는 메인 프로세스의 electron-store에서 가져옴
  // (창의 movable/resizable 속성과 동기화돼야 하기 때문)
  if (isElectron) state.locked = await window.electronAPI.getLock();

  // 🆕 옵션A — 이전에 동기화했던 범위 복원
  await loadSyncedRange();
}

/**
 * 일정 목록을 저장소에 저장하고, 알람도 다시 스케줄링.
 * 일정이 바뀔 때마다 호출됨 (저장 후 알람 재계산).
 */
async function saveEvents() {
  await saveJSON('cal_events_v4', state.events);
  scheduleAlarms();   // 일정이 바뀌었으니 24시간 내 알람 setTimeout을 새로 잡음
}

/** 메모 저장 (저장만, 알람은 안 건드림) */
async function saveMemos() {
  await saveJSON('cal_memos_v4', state.memos);
}

/** 설정 저장 (레이아웃/투명도/폰트크기만) — 일정/메모는 따로 저장됨 */
async function saveSettings() {
  await saveJSON('cal_settings_v4', {
    layout: state.layout,
    opacity: state.opacity,
    fontSize: state.fontSize
  });
}

/**
 * 저장소에서 키로 JSON을 읽음.
 * window.storage.get(key)는 { value: "..." } 또는 null을 반환.
 * 파싱 실패하면 null 리턴 (저장된 데이터가 깨졌을 때 앱이 죽지 않게).
 */
async function loadJSON(key) {
  try {
    const r = await window.storage.get(key);
    return r ? JSON.parse(r.value) : null;
  } catch { return null; }
}

/** 저장소에 JSON 직렬화해서 저장. 실패해도 조용히 무시. */
async function saveJSON(key, data) {
  try { await window.storage.set(key, JSON.stringify(data)); } catch {}
}

/**
 * 첫 실행 샘플 일정 2개 (오늘+이틀 전).
 * dStr(0)=오늘, dStr(-2)=이틀 전 형태로 동적 생성.
 */
function getSampleEvents() {
  const t = new Date();
  const dStr = (offset) => {
    const d = new Date(t); d.setDate(t.getDate() + offset);
    return formatDate(d);
  };
  return [
    { id:'e1', title:'아토미 헤어 PPT 마무리', date:dStr(0),  time:'10:00', source:'local', alarms:['30min'], memo:'' },
    { id:'e6', title:'헬스장',                date:dStr(-2), time:'19:00', source:'local', alarms:[],         memo:'' }
  ];
}

/** 첫 실행 샘플 메모 2개 */
function getSampleMemos() {
  return [
    { id:'m1', text:'PPT 12장 검토',                completed:false, source:'local' },
    { id:'m2', text:'Synology DS1821+ 백업 점검',   completed:false, source:'local' }
  ];
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 알람 매니저                                                     ║
// ║                                                                  ║
// ║  각 일정의 alarms 배열(['5min','30min','1day'])을 보고            ║
// ║  setTimeout으로 미래 시점에 알림을 띄우게 예약함.                   ║
// ║                                                                  ║
// ║  - 24시간 이상 미래의 알람은 굳이 지금 안 잡음 (24시간마다 재호출)   ║
// ║  - 1분 이상 과거의 알람은 무시 (이미 지나감)                       ║
// ║  - firedAlarms로 중복 발사 방지                                   ║
// ╚══════════════════════════════════════════════════════════════════╝

const alarmTimers = new Map();   // 예약된 setTimeout id들 (재스케줄 시 cancel용)
const firedAlarms = new Set();   // 이미 발사한 알람 키들 ('이벤트id_5min' 형태)

function scheduleAlarms() {
  // 1) 기존에 예약된 모든 타이머 취소
  for (const t of alarmTimers.values()) clearTimeout(t);
  alarmTimers.clear();

  const now = Date.now();
  const today = new Date(now);
  today.setHours(0,0,0,0);

  // 🆕 사전 필터용: 오늘과 그 다음 1일까지의 날짜 문자열만 후보
  //    (알람은 최대 24시간 전까지만 예약하므로,
  //     "오늘 날짜에 알람" 또는 "내일 1일전(=오늘 발생) 알람"만 가능)
  //    "1day" 알람은 24h 전이라 오늘 날짜 일정 = 어제 발생 → 이미 지남
  //    실제 후보는 오늘 + 내일 일정만 보면 충분
  const todayStr = formatDate(today);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const tomorrowStr = formatDate(tomorrow);
  const dayAfterTomorrow = new Date(today); dayAfterTomorrow.setDate(today.getDate() + 2);
  const dayAfterTomorrowStr = formatDate(dayAfterTomorrow);

  // 2) 모든 일정을 돌면서 24시간 안에 발사할 알람만 setTimeout 예약
  //    7000건이라도 사전 필터(문자열 비교)로 99%는 즉시 skip
  for (const ev of state.events) {
    // ── 빠른 사전 필터들 ──
    // 시간 없는(종일) 일정은 알람 불가 / 알람 배열 없으면 스킵
    if (!ev.time || !ev.alarms || ev.alarms.length === 0) continue;
    // 🆕 날짜 문자열 비교 (Date 객체 생성 없이)
    //    오늘 / 내일 / 모레(1day 알람의 24h 후 발생 가능성)만 후보
    if (ev.date !== todayStr && ev.date !== tomorrowStr && ev.date !== dayAfterTomorrowStr) continue;

    // ── 여기까지 통과한 건 정말 알람 후보 (보통 5~20건) ──
    // 일정의 정확한 발생 시각 (밀리초)
    const eventTime = new Date(`${ev.date}T${ev.time}:00`).getTime();
    if (isNaN(eventTime)) continue;

    for (const alarmKey of ev.alarms) {
      const minutes = ALARM_MINUTES[alarmKey];
      if (!minutes) continue;

      // 알람이 울려야 할 시각 = 일정시각 - N분
      const alarmTime = eventTime - minutes * 60 * 1000;
      const delay = alarmTime - now;

      // 24시간 넘게 미래면 지금 setTimeout 안 걸어둠
      if (delay > 24 * 60 * 60 * 1000) continue;
      // 1분 이상 지나간 과거면 무시
      if (delay < -60 * 1000) continue;

      // 같은 일정의 같은 알람을 두 번 울리지 않게 키로 막음
      const key = `${ev.id}_${alarmKey}`;
      if (firedAlarms.has(key)) continue;

      // 실제 예약 — Math.max(0, delay)로 음수 보호
      const timeoutId = setTimeout(() => {
        fireAlarm(ev, alarmKey);
        firedAlarms.add(key);
      }, Math.max(0, delay));
      alarmTimers.set(key, timeoutId);
    }
  }
}

/**
 * 알람을 실제로 띄움.
 * - Electron이면 OS 네이티브 알림 (메인 프로세스에 IPC)
 * - 브라우저면 Web Notification API 또는 토스트
 */
function fireAlarm(event, alarmKey) {
  const label = alarmLabel(alarmKey);
  const title = `🔔 ${label} 알림`;
  const body = `${event.time}  ${event.title}${event.memo ? '\n' + event.memo : ''}`;

  if (isElectron) {
    // Windows/macOS 네이티브 알림 + 사운드
    window.electronAPI.showNotification({
      title, body,
      // 5분 전은 critical(더 강한 알림 스타일)
      urgency: alarmKey === '5min' ? 'critical' : 'normal'
    });
  } else if ('Notification' in window && Notification.permission === 'granted') {
    // 브라우저 알림 (사용자가 권한을 줬을 때만)
    new Notification(title, { body });
  } else {
    // 둘 다 안 되면 위젯 안의 토스트
    toast(`🔔 ${event.title} (${label})`);
  }
}

// 24시간마다 알람 재스케줄 (날짜가 바뀌어 새 알람들이 24h 윈도우에 들어옴)
setInterval(scheduleAlarms, 24 * 60 * 60 * 1000);


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 5주 그리드 계산                                                 ║
// ║                                                                  ║
// ║  이 캘린더는 항상 5주(35일)를 보여줌.                              ║
// ║  현재 날짜를 중심으로 위로 1주, 아래로 3주가 기본.                  ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * referenceDate를 기준으로, 그 날짜의 "이전 주의 첫째 날"을 반환.
 * - "이번 주의 시작" 구하기 (요일에 따라 보정)
 * - 거기서 7일 더 빼서 → 이전 주의 시작 = 5주 그리드의 첫째 날
 *
 * 예) referenceDate = 5/15(목), 월요일 시작
 *     → 이번 주 시작 = 5/12(월)
 *     → 5주 그리드 시작 = 5/5(월) ← 화면 좌상단 셀
 */
function compute5WeekStart(referenceDate) {
  const d = new Date(referenceDate);
  d.setHours(0,0,0,0);                                  // 시간 부분 제거 (00:00 기준)
  let diff = d.getDay() - state.weekStartsOn;            // 주 시작에서 며칠이 지났나
  if (diff < 0) diff += 7;                              // 음수 보정 (일요일에 월요일 시작이면 -1)
  d.setDate(d.getDate() - diff);                        // 이번 주 시작으로
  d.setDate(d.getDate() - 7);                           // 이전 주 시작으로 (한 주 더 위로)
  return d;
}

/**
 * 5주(35일) 날짜 배열 반환. viewWeekStart부터 35일 연속.
 * renderCalendar에서 셀을 그릴 때 사용.
 */
function getViewDates() {
  const dates = [];
  for (let i = 0; i < 35; i++) {
    const d = new Date(state.viewWeekStart);
    d.setDate(state.viewWeekStart.getDate() + i);
    dates.push(d);
  }
  return dates;
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 렌더링 함수들                                                   ║
// ║                                                                  ║
// ║  state를 보고 DOM(화면)을 다시 그리는 함수들.                       ║
// ║  - renderWeekdays: 요일 헤더 (월화수목금토일)                       ║
// ║  - renderHeader:   상단 "2026년 5월" 같은 라벨                     ║
// ║  - renderCalendar: 본격 35개 날짜 셀                               ║
// ║  - showDayPopover: 셀 클릭 시 옆에 뜨는 일정 목록 박스               ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * 요일 헤더 그리기 (캘린더 그리드 위쪽 줄).
 * 레이아웃에 따라 다르게 렌더링됨.
 * - split: "월화수목금 [토/일]" (마지막 칸은 토/일 합침)
 * - 그 외: 각 요일을 7칸으로
 */
function renderWeekdays() {
  const wd = document.getElementById('weekdays');
  wd.className = 'weekdays ' + state.layout;   // CSS에서 레이아웃별 grid-template-columns 적용

  // ── split 모드: 토/일을 한 칸에 묶음 ──
  if (state.layout === 'split') {
    wd.innerHTML = `
      <div class="weekday">월</div>
      <div class="weekday">화</div>
      <div class="weekday">수</div>
      <div class="weekday">목</div>
      <div class="weekday">금</div>
      <div class="weekday weekday-stack">
        <span class="sat-label">토</span>
        <span class="separator">/</span>
        <span class="sun-label">일</span>
      </div>
    `;
    return;
  }

  // ── uniform / emphasis 모드: 7칸 ──
  // weekStartsOn에 따라 시작 요일이 다름. order 배열로 인덱스 회전.
  const order = [];
  for (let i = 0; i < 7; i++) order.push((state.weekStartsOn + i) % 7);

  wd.innerHTML = order.map(idx => {
    let cls = '';
    if (idx === 0) cls = 'sun';   // 일요일 → 빨강
    if (idx === 6) cls = 'sat';   // 토요일 → 파랑
    const isWeekend = idx === 0 || idx === 6;
    // emphasis 모드에서는 주말 칸을 좁게(compact)
    if (state.layout === 'emphasis' && isWeekend) cls += ' compact';
    return `<div class="weekday ${cls}">${DOW[idx]}</div>`;
  }).join('');
}

/**
 * 상단 헤더 라벨 갱신 ("2026년 5월", "· 오늘 5.2 (토)").
 * 그리드 가운데 날짜의 월을 "지금 보고 있는 달"로 간주함.
 */
function renderHeader() {
  const today = new Date();

  // 5주 그리드의 가운데 날짜 (시작일 + 17일 ≈ 3주차 중간)
  const center = new Date(state.viewWeekStart);
  center.setDate(state.viewWeekStart.getDate() + 17);

  document.getElementById('yearLabel').textContent  = center.getFullYear() + '년';
  document.getElementById('monthLabel').textContent = MONTHS[center.getMonth()];
  // "· 오늘 5.2 (토)" 형식
  document.getElementById('todayInfo').textContent =
    `· 오늘 ${today.getMonth()+1}.${today.getDate()} (${DOW[today.getDay()]})`;
}

/**
 * 본격 캘린더 그리드(35개 셀) 그리기.
 * 가장 길고 복잡한 함수. 단계별로:
 *   1) 헤더/요일 다시 그리기
 *   2) 오늘 / 이번 주 시작 계산
 *   3) 35일 각각의 셀 만들기
 *      - 색상 클래스 (today, this-week, sun/sat, other-month)
 *      - 레이아웃별 크기 (compact/half)
 *      - split 모드는 grid-area 직접 지정
 *      - 일정 미리보기 텍스트
 *   4) 클릭 / 더블클릭 핸들러 연결
 */
function renderCalendar() {
  renderHeader();
  renderWeekdays();

  const grid = document.getElementById('daysGrid');
  grid.className = 'days ' + state.layout;
  grid.innerHTML = '';

  // ── 오늘과 "이번 주 시작" 계산 (this-week 강조용) ──
  const today = new Date();
  today.setHours(0,0,0,0);
  let diff = today.getDay() - state.weekStartsOn;
  if (diff < 0) diff += 7;
  const thisWeekStart = new Date(today);
  thisWeekStart.setDate(today.getDate() - diff);

  // ── 그리드 가운데 날짜의 월 = 현재 보고 있는 달 ──
  // 이 월에 속하지 않는 셀은 흐리게(other-month) 처리
  const center = new Date(state.viewWeekStart);
  center.setDate(state.viewWeekStart.getDate() + 17);
  const viewMonth = center.getMonth();

  const dates = getViewDates();   // 35일치 Date 배열

  // ── 35개 셀을 하나씩 만들어 그리드에 붙이기 ──
  dates.forEach((d, i) => {
    const cell = document.createElement('div');
    cell.className = 'day';

    const dow = d.getDay();
    if (dow === 0) cell.classList.add('sun');                    // 일요일
    if (dow === 6) cell.classList.add('sat');                    // 토요일
    if (d.getMonth() !== viewMonth) cell.classList.add('other-month');   // 이전/다음 달

    // 레이아웃별 셀 변형:
    // - compact: emphasis 모드의 주말 (좁고 도트만 표시)
    // - half:    split 모드의 토/일 (반쪽짜리)
    const isWeekend = dow === 0 || dow === 6;
    const isCompact = state.layout === 'emphasis' && isWeekend;
    const isHalf    = state.layout === 'split'    && isWeekend;
    if (isCompact) cell.classList.add('compact');
    if (isHalf)    cell.classList.add('half');

    // ── split 모드: 그리드 위치 직접 지정 ──
    // 평일은 2행 차지, 토는 위쪽 반칸, 일은 아래쪽 반칸
    if (state.layout === 'split') {
      const weekIdx = Math.floor(i / 7);                      // 몇 째 주
      const dowInWeek = (dow - state.weekStartsOn + 7) % 7;   // 주 시작 기준 0~6

      if (dowInWeek < 5) {
        // 평일: 한 칸 너비, 2행 높이 (위/아래 합쳐서 평일 1칸)
        cell.style.gridColumn = (dowInWeek + 1);
        cell.style.gridRow = `${weekIdx * 2 + 1} / span 2`;
      } else if (dowInWeek === 5) {
        // 토요일: 6번째 열, 위쪽 반칸
        cell.style.gridColumn = 6;
        cell.style.gridRow = weekIdx * 2 + 1;
      } else {
        // 일요일: 6번째 열, 아래쪽 반칸
        cell.style.gridColumn = 6;
        cell.style.gridRow = weekIdx * 2 + 2;
      }
    }

    // ── 이번 주 강조 (셀이 속한 주의 시작이 thisWeekStart와 같으면) ──
    const cellWeekStart = new Date(d);
    let cellDiff = d.getDay() - state.weekStartsOn;
    if (cellDiff < 0) cellDiff += 7;
    cellWeekStart.setDate(d.getDate() - cellDiff);
    cellWeekStart.setHours(0,0,0,0);
    if (sameDate(cellWeekStart, thisWeekStart)) cell.classList.add('this-week');
    // 오늘 강조
    if (sameDate(d, today)) cell.classList.add('today');

    // ── 이 날짜의 일정 추출 ── (시간순 정렬)
    const dateStr = formatDate(d);
    const dayEvents = state.events
      .filter(e => e.date === dateStr)
      .sort((a,b) => (a.time||'99:99').localeCompare(b.time||'99:99'));

    const hasAlarm = dayEvents.some(e => e.alarms && e.alarms.length > 0);

    // 셀 크기에 따라 최대 표시 일정 수
    const maxEvents = isCompact ? 0 : (isHalf ? 1 : 4);

    // ── 일정 텍스트 HTML 만들기 ──
    let eventHtml = '';
    if (!isCompact) {
      eventHtml = dayEvents.slice(0, maxEvents).map(e => `
        <div class="day-event ${e.source}" title="${escapeHtml(e.title)}${e.time ? ' ' + e.time : ''}">
          ${e.time ? `<b>${e.time.slice(0,5)}</b> ` : ''}${escapeHtml(e.title)}
        </div>
      `).join('');
      if (dayEvents.length > maxEvents) {
        const moreText = isHalf ? `+${dayEvents.length - maxEvents}` : `+${dayEvents.length - maxEvents}개 더`;
        eventHtml += `<div class="day-event-more">${moreText}</div>`;
      }
    }

    // compact 모드는 텍스트 대신 색깔 점(dot)만 (최대 6개)
    // 🆕 inline style로 캘린더별 색상 적용
    const dotsHtml = isCompact && dayEvents.length > 0
      ? `<div class="day-dots">${dayEvents.slice(0, 6).map(e =>
          `<span class="dot ${e.source}" style="background:${eventColor(e)}"></span>`
        ).join('')}</div>`
      : '';

    // ── 셀 최종 HTML ──
    cell.innerHTML = `
      <div class="day-header">
        <div class="day-num">${d.getDate()}</div>
        ${hasAlarm && !isCompact && !isHalf ? '<div class="day-alarm-icon">🔔</div>' : ''}
      </div>
      <div class="day-events">${eventHtml}</div>
      ${dotsHtml}
    `;

    // ── 클릭: 일정 팝오버 열기 ──
    cell.addEventListener('click', (ev) => {
      ev.stopPropagation();   // document 클릭 핸들러로 전파 방지(설정창 닫힘 방지)
      // 셀 클릭 시 다른 팝업들은 다 닫고 popover만 새로 열림
      hideContextMenu();
      document.getElementById('settingsPanel').classList.remove('show');

      state.selectedDate = d;
      showDayPopover(cell, d);
    });

    // ── 더블클릭: 새 일정 추가 모달 열기 ──
    cell.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      hideContextMenu();
      document.getElementById('settingsPanel').classList.remove('show');
      hideDayPopover();
      openEventModal(null, d);   // null=신규 일정, d=해당 날짜 기본값
    });

    grid.appendChild(cell);
  });
}

/**
 * 날짜 셀 옆에 뜨는 "그 날의 일정 목록" 팝오버.
 * - 일정 클릭 → 편집 모달
 * - + 버튼 → 새 일정 모달
 */
function showDayPopover(cell, date) {
  const pop = document.getElementById('dayPopover');
  const dateStr = formatDate(date);

  // 그 날의 일정 (시간순)
  const events = state.events
    .filter(e => e.date === dateStr)
    .sort((a,b) => (a.time||'99:99').localeCompare(b.time||'99:99'));

  // 헤더 날짜 표시 ("5월 1일 (목)")
  document.getElementById('popoverDate').textContent =
    `${date.getMonth()+1}월 ${date.getDate()}일 (${DOW[date.getDay()]})`;

  // 일정 리스트 HTML
  const eventsHtml = events.length === 0
    ? '<div class="pop-empty">일정이 없습니다</div>'
    : events.map(e => `
        <div class="pop-event" data-id="${e.id}">
          <div class="pop-event-color" style="background:${eventColor(e)}"></div>
          <div class="pop-event-info">
            <div class="pop-event-title">${escapeHtml(e.title)}</div>
            <div class="pop-event-time">
              ${e.time || '종일'}
              ${e.alarms && e.alarms.length ? ` · 🔔 ${e.alarms.map(alarmLabel).join(', ')}` : ''}
            </div>
          </div>
        </div>
      `).join('');
  document.getElementById('popoverEvents').innerHTML = eventsHtml;

  // ── 팝오버 위치: 셀 오른쪽 옆에 ──
  // 화면 밖으로 나가지 않게 최대값 보정
  const rect = cell.getBoundingClientRect();
  pop.style.left = Math.min(rect.right + 8, window.innerWidth - 280) + 'px';
  pop.style.top  = Math.max(8, Math.min(rect.top, window.innerHeight - 240)) + 'px';
  pop.classList.add('show');

  // ── 일정 항목 클릭 → 편집 모달 ──
  pop.querySelectorAll('.pop-event').forEach(el => {
    el.addEventListener('click', () => {
      const ev = state.events.find(x => x.id === el.dataset.id);
      if (ev) { hideDayPopover(); openEventModal(ev); }
    });
  });

  // ── + 버튼 → 새 일정 모달 ──
  document.getElementById('popoverAdd').onclick = () => {
    hideDayPopover();
    openEventModal(null, date);
  };
}

/** 팝오버 닫기 (다른 곳 클릭하면 호출됨) */
function hideDayPopover() {
  document.getElementById('dayPopover').classList.remove('show');
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 메모 / 할 일 패널                                                ║
// ║                                                                  ║
// ║  - Google Tasks와 양방향 동기화됨                                  ║
// ║  - source가 'gtasks'인 메모는 체크/수정/삭제 시 즉시 push           ║
// ║  - source가 'local'인 메모는 그냥 로컬 저장만                       ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * 메모 리스트 다시 그리기.
 * 탭 필터(state.memoFilter)에 따라 필터링.
 * 완료된 항목은 아래로 정렬.
 */
function renderMemos() {
  const list = document.getElementById('memoList');

  // ── 탭 필터 적용 ──
  let memos = [...state.memos];
  if (state.memoFilter === 'active')      memos = memos.filter(m => !m.completed);
  else if (state.memoFilter === 'gtasks') memos = memos.filter(m => m.source === 'gtasks');

  // 비어있으면 안내문
  if (memos.length === 0) {
    list.innerHTML = '<div class="memo-empty">항목이 없습니다</div>';
    return;
  }

  // 완료(true=1) 항목을 뒤로 정렬
  memos.sort((a, b) => Number(a.completed) - Number(b.completed));

  // ── HTML 만들기 ──
  // contenteditable로 텍스트를 인라인 편집 가능하게 함
  list.innerHTML = memos.map(m => `
    <div class="memo-item ${m.completed ? 'completed' : ''}" data-id="${m.id}">
      <div class="memo-checkbox"></div>
      <div class="memo-text" contenteditable="true" spellcheck="false">${escapeHtml(m.text)}</div>
      <span class="memo-source-badge ${m.source}">${m.source === 'gtasks' ? 'G' : 'L'}</span>
      <button class="memo-delete">✕</button>
    </div>
  `).join('');

  // ── 각 메모의 이벤트 핸들러 연결 ──
  list.querySelectorAll('.memo-item').forEach(el => {
    const id = el.dataset.id;

    // 체크박스 클릭 → 완료 상태 토글 + Google Tasks에 push
    el.querySelector('.memo-checkbox').addEventListener('click', async () => {
      const m = state.memos.find(x => x.id === id);
      if (!m) return;
      m.completed = !m.completed;
      // Google Tasks 메모면 서버에도 반영
      if (m.source === 'gtasks' && m.googleId && isElectron) {
        const r = await window.electronAPI.pushGoogleTask(m);
        if (r.ok) Object.assign(m, r.task);   // 서버가 돌려준 etag/updated 등 갱신
      }
      await saveMemos();
      renderMemos();
    });

    // ✕ 버튼 → 삭제 (Google이면 서버에서도 삭제)
    el.querySelector('.memo-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      const m = state.memos.find(x => x.id === id);
      if (m && m.source === 'gtasks' && m.googleId && isElectron) {
        await window.electronAPI.deleteGoogleTask(m.googleId);
      }
      state.memos = state.memos.filter(x => x.id !== id);
      await saveMemos();
      renderMemos();
    });

    // 텍스트 인라인 편집 → blur(포커스 잃을 때) 시 저장 + push
    const textEl = el.querySelector('.memo-text');
    textEl.addEventListener('blur', async () => {
      const m = state.memos.find(x => x.id === id);
      if (m && textEl.textContent.trim() && m.text !== textEl.textContent.trim()) {
        m.text = textEl.textContent.trim();
        if (m.source === 'gtasks' && m.googleId && isElectron) {
          const r = await window.electronAPI.pushGoogleTask(m);
          if (r.ok) Object.assign(m, r.task);
        }
        await saveMemos();
      }
    });

    // Enter 키로 편집 종료 (줄바꿈 막고 blur 발동)
    textEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); textEl.blur(); }
    });
  });
}

/**
 * 새 메모 추가.
 * - Google 연결돼있으면 'gtasks'로 만들어 서버에 푸시 (실패 시 'local'로 폴백)
 * - 안 돼있으면 그냥 'local'
 */
async function addMemo(text) {
  if (!text.trim()) return;

  // 일단 임시 객체 생성 (Google 연결 시 서버 응답으로 덮어씀)
  let newMemo = {
    id: 'm' + Date.now() + Math.random().toString(36).slice(2,5),
    text: text.trim(),
    completed: false,
    source: state.googleAuthenticated ? 'gtasks' : 'local'
  };

  // Google Tasks로 푸시 시도
  if (newMemo.source === 'gtasks' && isElectron) {
    const r = await window.electronAPI.pushGoogleTask(newMemo);
    if (r.ok) {
      newMemo = r.task;   // 서버가 부여한 googleId, etag 포함된 객체로 교체
    } else {
      // 푸시 실패 시 로컬로 저장 (네트워크 끊김 등)
      toast('Google Tasks 푸시 실패: ' + r.error, 3500);
      newMemo.source = 'local';
    }
  }

  state.memos.push(newMemo);
  await saveMemos();
  renderMemos();
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 유틸 함수들                                                     ║
// ║                                                                  ║
// ║  자주 쓰는 작은 도우미 함수들.                                       ║
// ╚══════════════════════════════════════════════════════════════════╝

/** 두 Date가 같은 날짜(연/월/일)인지 비교. 시간은 무시. */
function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth() &&
         a.getDate()     === b.getDate();
}

/** Date → "YYYY-MM-DD" 문자열. 일정의 date 필드는 항상 이 형식. */
function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/** source별 색상 코드 반환 (도트, 보더 등에 사용) */
function sourceColor(s) {
  return s === 'google'    ? '#4285f4'
       : s === 'nextcloud' ? '#0082c9'
       :                     '#34a853';   // local
}

/**
 * 🆕 이벤트의 실제 색상 결정.
 *  - google/nextcloud 이벤트면 캘린더별 customColor lookup
 *  - 없으면 sourceColor 폴백
 */
function eventColor(e) {
  if (e.source === 'google' && e.googleCalendarId) {
    const c = state.calendarColors.google[e.googleCalendarId];
    if (c) return c;
  }
  if (e.source === 'nextcloud' && e.ncCalendarUrl) {
    const c = state.calendarColors.nextcloud[e.ncCalendarUrl];
    if (c) return c;
  }
  return sourceColor(e.source);
}

/** 🆕 hex(#RRGGBB) → "rgba(r,g,b,a)" 문자열 */
function hexToRgba(hex, alpha) {
  if (!hex || hex[0] !== '#') return `rgba(0,0,0,${alpha})`;
  const c = hex.replace('#', '');
  const full = c.length === 3
    ? c.split('').map(x => x + x).join('')
    : c;
  const r = parseInt(full.substring(0, 2), 16) || 0;
  const g = parseInt(full.substring(2, 4), 16) || 0;
  const b = parseInt(full.substring(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 🆕 hex 색을 어둡게 (텍스트 색용). factor 0~1, 작을수록 어두움 */
function darkenHex(hex, factor) {
  if (!hex || hex[0] !== '#') return '#333';
  const c = hex.replace('#', '');
  const full = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  const r = Math.round((parseInt(full.substring(0, 2), 16) || 0) * factor);
  const g = Math.round((parseInt(full.substring(2, 4), 16) || 0) * factor);
  const b = Math.round((parseInt(full.substring(4, 6), 16) || 0) * factor);
  return `rgb(${r},${g},${b})`;
}

/**
 * 🆕 day-event용 inline style 문자열.
 *  background(15% 투명) + 진한 텍스트색 + border-left-color
 */
function eventInlineStyle(e) {
  const color = eventColor(e);
  return `background:${hexToRgba(color, 0.15)};color:${darkenHex(color, 0.45)};border-left-color:${color}`;
}

/** 알람 키 → 한국어 라벨 ('5min' → '5분전', '30min' → '30분전', '1day' → '1일전') */
function alarmLabel(a) {
  return a === '5min'  ? '5분전'
       : a === '30min' ? '30분전'
       :                 '1일전';
}

/**
 * HTML 특수문자 이스케이프 (XSS 방지).
 * innerHTML로 사용자 입력을 넣기 전에 반드시 거치기.
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/**
 * 화면 하단에 잠깐 떴다 사라지는 토스트 메시지.
 * duration 기본 2초, 길게 보여주려면 3500 등으로 지정.
 */
function toast(msg, duration) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration || 2000);
}

/** 새 일정용 고유 id 생성 ('e' + 타임스탬프 + 랜덤문자) */
function uid() { return 'e' + Date.now() + Math.random().toString(36).slice(2,5); }

/**
 * 🆕 캘린더 표시 이름 추출 (UI용 안전망).
 * 소스(google/nextcloud)에 따라 다른 필드를 읽고, 비어있으면 폴백.
 */
function calDisplayName(c, source) {
  if (source === 'google') {
    const s = (c.summary || '').trim();
    if (s) return s;
    return c.id || '(이름 없음)';
  }
  // nextcloud
  const dn = c.displayName;
  if (typeof dn === 'string' && dn.trim()) return dn.trim();
  // 객체로 들어온 경우 (이론적으로 sync/nextcloud-auth.js에서 이미 처리되지만 방어적으로)
  if (dn && typeof dn === 'object') {
    const v = dn._cdata || dn._text || dn['#text'] || dn._ || dn.value;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // URL 마지막 세그먼트
  if (c.url) {
    try {
      const segs = String(c.url).replace(/\/+$/, '').split('/').filter(Boolean);
      const last = decodeURIComponent(segs[segs.length - 1] || '');
      if (last) return last;
    } catch {}
    return c.url;
  }
  return '(이름 없음)';
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 일정 모달 (Event Modal)                                          ║
// ║                                                                  ║
// ║  날짜 셀 더블클릭 / 팝오버에서 일정 클릭 시 열리는 큰 팝업창.          ║
// ║  - 신규: openEventModal(null, 기본날짜)                            ║
// ║  - 편집: openEventModal(event)                                    ║
// ║                                                                  ║
// ║  저장 위치(source)에 따라 저장 시 동작이 달라짐:                    ║
// ║   - local:     그냥 state.events에만 저장                          ║
// ║   - google:    Google Calendar API로 push                         ║
// ║   - nextcloud: NextCloud CalDAV로 push                            ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * 일정 모달 열기.
 * @param {object|null} event       편집할 기존 일정. null이면 신규.
 * @param {Date} [defaultDate]      신규 일정의 기본 날짜 (해당 셀의 날짜)
 */
function openEventModal(event, defaultDate) {
  const bg     = document.getElementById('eventModalBg');     // 검은 반투명 배경
  const title  = document.getElementById('modalTitle');        // 제목 ("일정 추가" / "일정 편집")
  const delBtn = document.getElementById('deleteEvent');       // 삭제 버튼 (편집 시만 표시)

  // 모달이 열릴 때마다 알람 선택 초기화
  state.editingAlarms = new Set();

  // ── source 드롭다운 옵션 활성화/비활성화 ──
  // Google이 연결 안 됐으면 'google' 옵션을 disabled로
  // NextCloud가 연결 안 됐으면 'nextcloud' 옵션을 disabled로
  const sourceSelect = document.getElementById('evSource');
  const googleOpt = sourceSelect.querySelector('option[value="google"]');
  if (googleOpt) googleOpt.disabled = !state.googleAuthenticated;
  const ncOpt = sourceSelect.querySelector('option[value="nextcloud"]');
  if (ncOpt) ncOpt.disabled = !state.nextcloudAuthenticated;

  if (event) {
    // ─── 편집 모드: 기존 값 채우기 ───
    state.editingEventId = event.id;
    title.textContent = '일정 편집';
    document.getElementById('evTitle').value  = event.title;
    document.getElementById('evDate').value   = event.date;
    document.getElementById('evTime').value   = event.time || '';
    document.getElementById('evSource').value = event.source;
    document.getElementById('evMemo').value   = event.memo || '';
    // 기존 알람들을 editingAlarms에 채워서 칩(chip) 활성화 상태로
    (event.alarms || []).forEach(a => state.editingAlarms.add(a));
    delBtn.style.display = 'inline-block';   // 편집 시에만 "삭제" 버튼 보임
  } else {
    // ─── 신규 모드: 빈 폼 ───
    state.editingEventId = null;
    title.textContent = '일정 추가';
    document.getElementById('evTitle').value  = '';
    // 더블클릭한 셀의 날짜 또는 마지막으로 클릭한 날짜
    document.getElementById('evDate').value   = formatDate(defaultDate || state.selectedDate);
    document.getElementById('evTime').value   = '';
    // 기본 저장 위치: Google 연결되면 google, 아니면 local
    document.getElementById('evSource').value = state.googleAuthenticated ? 'google' : 'local';
    document.getElementById('evMemo').value   = '';
    delBtn.style.display = 'none';
  }

  // 🆕 캘린더 하위 드롭다운 갱신 (source가 google/nextcloud일 때만 보임)
  updateEventCalendarDropdown(event);

  updateAlarmChips();         // 칩 disabled/active 상태 갱신
  bg.classList.add('show');   // 모달 표시

  // 모달이 떠오른 직후 제목 입력칸에 자동 포커스
  // 50ms 지연: 브라우저가 트랜지션을 끝낸 뒤 focus가 안 끊기게
  setTimeout(() => document.getElementById('evTitle').focus(), 50);
}

/** 모달 닫고 편집 상태 초기화 */
function closeEventModal() {
  document.getElementById('eventModalBg').classList.remove('show');
  state.editingEventId = null;
}

/**
 * 🆕 일정 모달의 캘린더 하위 드롭다운 갱신.
 *
 * - source가 'local' → 드롭다운 숨김
 * - source가 'google' → state.googleSelectedCalendars로 채움
 * - source가 'nextcloud' → state.nextcloudSelectedCalendars로 채움
 *
 * 신규: 기본 캘린더(isPrimary)를 자동 선택, 변경 가능
 * 편집: 기존 일정의 캘린더로 설정 + 비활성화 (캘린더 이동은 지원 안 함)
 *      → 옮기려면 일단 삭제하고 다른 캘린더에 새로 만들어야 함
 *
 * @param {object|null} event  편집 중인 기존 일정 (null이면 신규)
 */
function updateEventCalendarDropdown(event) {
  const source = document.getElementById('evSource').value;
  const row = document.getElementById('evCalendarRow');
  const sel = document.getElementById('evCalendar');

  if (source === 'local') {
    row.style.display = 'none';
    return;
  }

  row.style.display = 'block';

  // 어느 source의 선택된 캘린더 목록을 쓸지
  const calendars = source === 'google'
    ? state.googleSelectedCalendars
    : state.nextcloudSelectedCalendars;

  if (!calendars || calendars.length === 0) {
    sel.innerHTML = '<option value="">선택된 캘린더 없음</option>';
    sel.disabled = true;
    return;
  }

  // 옵션 만들기 (id 또는 url을 value로)
  sel.innerHTML = calendars.map(c => {
    const id   = source === 'google' ? c.id : c.url;
    const name = calDisplayName(c, source);
    return `<option value="${escapeHtml(id)}">${escapeHtml(name)}${c.isPrimary ? ' ⭐' : ''}</option>`;
  }).join('');

  if (event) {
    // 편집: 기존 값 + 비활성화
    const eventCalId = source === 'google' ? event.googleCalendarId : event.ncCalendarUrl;
    if (eventCalId) sel.value = eventCalId;
    sel.disabled = true;
  } else {
    // 신규: 기본 캘린더 자동 선택, 변경 가능
    const primary = calendars.find(c => c.isPrimary);
    if (primary) sel.value = source === 'google' ? primary.id : primary.url;
    sel.disabled = false;
  }
}

/**
 * 알람 칩(chip) 상태 갱신.
 * - 시간이 비어있으면 모든 칩을 disabled (종일 일정엔 알람 못 검)
 * - editingAlarms에 들어있는 칩은 active(파란색)
 *
 * 호출 시점:
 *  - 모달 열 때 (openEventModal에서)
 *  - 시간 입력값이 바뀔 때 (input 이벤트로)
 *  - 칩 클릭 직후 (토글 후 다시 그리기)
 */
function updateAlarmChips() {
  const hasTime = !!document.getElementById('evTime').value;
  document.querySelectorAll('.alarm-chip').forEach(chip => {
    const alarm = chip.dataset.alarm;
    chip.classList.toggle('disabled', !hasTime);
    chip.classList.toggle('active', hasTime && state.editingAlarms.has(alarm));
  });
}

/**
 * 모달의 "저장" 버튼 클릭 핸들러.
 * 신규/편집/source 변경을 모두 처리하는 핵심 로직.
 *
 * 처리 순서:
 *  1) 입력값 검증 (제목 필수)
 *  2) 편집이면 기존 항목 찾기, source 변경 시 옛 원격 항목 삭제
 *  3) source에 따라 Google / NextCloud로 push (또는 로컬만)
 *  4) state.events 갱신 → 저장 → 화면 다시 그리기
 */
async function saveEvent() {
  const title = document.getElementById('evTitle').value.trim();
  if (!title) { toast('제목을 입력하세요'); return; }

  const time = document.getElementById('evTime').value;

  // 폼 입력값을 객체로 묶음
  const data = {
    title,
    date:   document.getElementById('evDate').value,
    time,
    source: document.getElementById('evSource').value,
    memo:   document.getElementById('evMemo').value,
    // 시간이 없으면 알람도 없음 (종일 일정은 알람 불가)
    alarms: time ? Array.from(state.editingAlarms) : []
  };

  // 🆕 어느 캘린더로 보낼지 (google/nextcloud일 때만)
  const calendarValue = document.getElementById('evCalendar').value;
  if (data.source === 'google' && calendarValue) {
    data.googleCalendarId = calendarValue;
  } else if (data.source === 'nextcloud' && calendarValue) {
    data.ncCalendarUrl = calendarValue;
  }

  // 더블 클릭 방지 — 저장 진행 중에는 버튼 비활성화
  const saveBtn = document.getElementById('saveEvent');
  saveBtn.disabled = true;

  try {
    if (state.editingEventId) {
      // ═══════════════════════════════════════════════
      // 편집 모드
      // ═══════════════════════════════════════════════
      const idx = state.events.findIndex(e => e.id === state.editingEventId);
      if (idx < 0) return;

      const old = state.events[idx];
      let merged = { ...old, ...data };   // 기존 + 새 입력

      // ── source 가 바뀐 경우: 이전 원격 일정 삭제 ──
      // 예) Google → NextCloud 로 옮기면 Google에서 지우고, 새로 NextCloud에 넣음
      if (old.source !== data.source) {
        if (old.source === 'google' && old.googleId && isElectron) {
          await window.electronAPI.deleteGoogleEvent(old);   // 🆕 객체 전체
        }
        if (old.source === 'nextcloud' && old.ncUrl && isElectron) {
          await window.electronAPI.deleteNextcloudEvent(old);
        }
        // 이전 원격 메타데이터(googleId, ncUrl 등) 다 제거 — 새 source에서 새로 받음
        delete merged.googleId; delete merged.etag; delete merged.googleCalendarId;
        delete merged.ncUid; delete merged.ncUrl; delete merged.ncEtag; delete merged.ncCalendarUrl;
      }

      // ── 새 source로 push ──
      if (data.source === 'google' && isElectron && state.googleAuthenticated) {
        toast('Google에 동기화 중...');
        const r = await window.electronAPI.pushGoogleEvent(merged);
        if (r.ok) merged = { ...merged, ...r.event };  // 서버 응답 메타데이터 흡수
        else      toast('Google 푸시 실패: ' + r.error, 3500);
      } else if (data.source === 'nextcloud' && isElectron && state.nextcloudAuthenticated) {
        toast('NextCloud에 동기화 중...');
        const r = await window.electronAPI.pushNextcloudEvent(merged);
        if (r.ok) merged = { ...merged, ...r.event };
        else      toast('NextCloud 푸시 실패: ' + r.error, 3500);
      }

      state.events[idx] = merged;
      toast('수정되었습니다');

    } else {
      // ═══════════════════════════════════════════════
      // 신규 모드
      // ═══════════════════════════════════════════════
      let newEvent = { id: uid(), ...data };

      if (data.source === 'google' && isElectron && state.googleAuthenticated) {
        toast('Google에 동기화 중...');
        const r = await window.electronAPI.pushGoogleEvent(newEvent);
        if (r.ok) newEvent = r.event;       // 서버에서 부여한 googleId 등으로 교체
        else {
          // 푸시 실패 시 로컬로 폴백 저장 (네트워크 끊김 등)
          toast('Google 푸시 실패, 로컬로 저장: ' + r.error, 3500);
          newEvent.source = 'local';
        }
      } else if (data.source === 'nextcloud' && isElectron && state.nextcloudAuthenticated) {
        toast('NextCloud에 동기화 중...');
        const r = await window.electronAPI.pushNextcloudEvent(newEvent);
        if (r.ok) newEvent = r.event;
        else {
          toast('NextCloud 푸시 실패, 로컬로 저장: ' + r.error, 3500);
          newEvent.source = 'local';
        }
      }

      state.events.push(newEvent);
      toast('추가되었습니다');
    }

    // 저장 + 모달 닫기 + 다시 그리기 (saveEvents 안에서 알람 재스케줄까지 함)
    await saveEvents();
    closeEventModal();
    renderCalendar();

  } finally {
    // 성공/실패와 관계없이 저장 버튼 다시 활성화
    saveBtn.disabled = false;
  }
}

/**
 * 모달의 "삭제" 버튼.
 * 원격 일정이면 서버에서도 같이 지움.
 */
async function deleteEvent() {
  if (!state.editingEventId) return;
  if (!confirm('이 일정을 삭제하시겠습니까?')) return;

  const ev = state.events.find(e => e.id === state.editingEventId);

  // ── 원격 일정이면 서버에서도 삭제 ──
  if (ev && isElectron) {
    if (ev.source === 'google' && ev.googleId) {
      toast('Google에서 삭제 중...');
      // 🆕 객체 전체 전달 (deleteEvent가 googleCalendarId 사용)
      const r = await window.electronAPI.deleteGoogleEvent(ev);
      if (!r.ok) toast('Google 삭제 실패: ' + r.error, 3500);
    } else if (ev.source === 'nextcloud' && ev.ncUrl) {
      toast('NextCloud에서 삭제 중...');
      const r = await window.electronAPI.deleteNextcloudEvent(ev);
      if (!r.ok) toast('NextCloud 삭제 실패: ' + r.error, 3500);
    }
  }

  // 로컬에서 제거
  state.events = state.events.filter(e => e.id !== state.editingEventId);
  await saveEvents();
  closeEventModal();
  renderCalendar();
  toast('삭제되었습니다');
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 잠금 / 설정 / 레이아웃 적용                                       ║
// ║                                                                  ║
// ║  state 값을 화면(DOM)과 메인프로세스에 반영하는 함수들.              ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * 잠금 상태를 화면에 반영 + 메인프로세스에도 알림.
 * @param {boolean} fromIPC  메인프로세스에서 알려온 변경이면 true (다시 IPC 호출 안 함)
 */
async function applyLock(fromIPC = false) {
  const w   = document.getElementById('widget');
  const ind = document.getElementById('lockIndicator');

  if (state.locked) { w.classList.add('locked');    ind.textContent = '🔒'; }
  else              { w.classList.remove('locked'); ind.textContent = '🔓'; }

  // 설정 패널의 체크박스도 동기화
  document.getElementById('lockToggle').checked = state.locked;

  // 메인프로세스에 알려서 BrowserWindow의 movable/resizable 변경
  // (메인이 보낸 변경이면 무한루프 방지를 위해 안 보냄)
  if (isElectron && !fromIPC) await window.electronAPI.setLock(state.locked);
}

/** 투명도 슬라이더 값을 CSS 변수에 반영 (--opacity) */
function applyOpacity() {
  document.documentElement.style.setProperty('--opacity', state.opacity);
  document.getElementById('opacityValue').textContent = Math.round(state.opacity * 100) + '%';
  document.getElementById('opacitySlider').value = state.opacity * 100;
}

/** 폰트 크기를 CSS 변수에 반영 (--font-scale) */
function applyFontSize() {
  document.documentElement.style.setProperty('--font-scale', state.fontSize / 10);
  document.getElementById('fontValue').textContent = state.fontSize + 'pt';
  document.getElementById('fontSlider').value = state.fontSize;
}

/**
 * 레이아웃 변경 (3개 카드 중 하나).
 * - weekStartsOn 자동 변경 (uniform=일요일, 그외=월요일)
 * - 활성 카드 표시
 * - 5주 그리드 시작점 재계산
 * - 다시 그리기
 */
function applyLayout() {
  state.weekStartsOn = state.layout === 'uniform' ? 0 : 1;
  document.querySelectorAll('.layout-card').forEach(card => {
    card.classList.toggle('active', card.dataset.layout === state.layout);
  });
  state.viewWeekStart = compute5WeekStart(new Date());
  renderCalendar();
}

/**
 * 우클릭 컨텍스트 메뉴 표시.
 * 화면 밖으로 나가지 않게 위치 보정.
 */
function showContextMenu(x, y) {
  const menu = document.getElementById('contextMenu');
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  menu.classList.add('show');

  // 메뉴가 화면 밖으로 나가면 반대쪽으로 위치 조정
  const rect = menu.getBoundingClientRect();
  if (rect.right  > window.innerWidth)  menu.style.left = (x - rect.width)  + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top  = (y - rect.height) + 'px';
}

function hideContextMenu() {
  document.getElementById('contextMenu').classList.remove('show');
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ Google 인증 + 동기화                                             ║
// ║                                                                  ║
// ║  - refreshGoogleAuthStatus: 메인에서 상태 받아와 UI 갱신             ║
// ║  - syncFromGoogle: Calendar + Tasks 양쪽 동기화                     ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Google 인증 상태를 메인에서 가져와 state와 UI를 갱신.
 * - 연결됨: 버튼 "연결됨" 초록색, 이메일 표시
 * - 미연결: 버튼 "연결" 파란색, "미연결" 표시
 *
 * 호출 시점:
 *  - 앱 시작 시
 *  - 로그인/로그아웃 직후
 */
async function refreshGoogleAuthStatus() {
  if (!isElectron) return;
  try {
    const status = await window.electronAPI.authGoogleStatus();
    state.googleAuthenticated = !!status.authenticated;
    state.googleEmail = status.email;

    // 선택된 캘린더 목록 캐시
    if (state.googleAuthenticated) {
      state.googleSelectedCalendars = await window.electronAPI.googleGetSelectedCalendars() || [];
    } else {
      state.googleSelectedCalendars = [];
    }

    // 🆕 캘린더별 색상 캐시 재구성
    //  - customColor 우선, 없으면 backgroundColor, 그것도 없으면 source 기본색
    state.calendarColors.google = {};
    state.googleSelectedCalendars.forEach(c => {
      state.calendarColors.google[c.id] = c.customColor || c.backgroundColor || '#4285f4';
    });

    const btn     = document.getElementById('googleAuthBtn');
    const emailEl = document.getElementById('googleEmail');

    if (state.googleAuthenticated && state.googleEmail) {
      const count = state.googleSelectedCalendars.length;
      btn.textContent = count > 0 ? '연결됨' : '캘린더 선택';
      btn.classList.add('connected');
      btn.title = `${state.googleEmail}\n캘린더 ${count}개 선택됨\n클릭하여 캘린더 관리`;
      emailEl.textContent = count > 0
        ? `${state.googleEmail} · 캘린더 ${count}개`
        : `${state.googleEmail} (캘린더 미선택)`;
      emailEl.classList.remove('disconnected');
    } else {
      btn.textContent = '연결';
      btn.classList.remove('connected');
      btn.title = 'Google 계정 연결';
      emailEl.textContent = '미연결';
      emailEl.classList.add('disconnected');
    }
  } catch (err) {
    console.error('Auth status check failed:', err);
  }
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ NextCloud 인증 + 동기화                                          ║
// ║                                                                  ║
// ║  Google과 거의 같은 패턴.                                            ║
// ║  단, NextCloud는 "인증됨"과 "캘린더 선택됨"이 분리됨.                 ║
// ║  (인증만 되고 캘린더 선택을 안 한 중간 상태가 있을 수 있음)            ║
// ╚══════════════════════════════════════════════════════════════════╝

async function refreshNextcloudAuthStatus() {
  if (!isElectron) return;
  try {
    const status = await window.electronAPI.authNextcloudStatus();

    // 🆕 인증 + 1개 이상 캘린더 선택돼있으면 "완전히 연결됨"
    state.nextcloudUsername = status.username || null;
    state.nextcloudSelectedCalendars = status.selectedCalendars || [];
    state.nextcloudAuthenticated = !!status.authenticated && state.nextcloudSelectedCalendars.length > 0;

    // 기본 캘린더 이름 (UI 툴팁용)
    const primary = state.nextcloudSelectedCalendars.find(c => c.isPrimary);
    state.nextcloudCalendarName = primary ? primary.displayName : null;
    
    // 🆕 캘린더별 색상 캐시 재구성 (NextCloud는 url이 키)
    state.calendarColors.nextcloud = {};
    state.nextcloudSelectedCalendars.forEach(c => {
      state.calendarColors.nextcloud[c.url] = c.customColor || '#0082c9';
    });

    const btn = document.getElementById('nextcloudAuthBtn');
    const lbl = document.getElementById('nextcloudStatus');

    if (state.nextcloudAuthenticated) {
      // ▼ 완전히 연결된 상태
      const count = state.nextcloudSelectedCalendars.length;
      btn.textContent = '연결됨';
      btn.classList.add('connected');
      btn.title = `${status.username} @ ${status.serverUrl}\n캘린더 ${count}개 선택됨\n클릭하여 캘린더 관리`;
      lbl.textContent = `${status.username} · 캘린더 ${count}개`;
      lbl.classList.remove('disconnected');

    } else if (status.authenticated) {
      // ▼ 로그인만 됐고 캘린더 미선택 (드문 케이스)
      btn.textContent = '캘린더 선택';
      btn.classList.remove('connected');
      btn.title = '동기화할 캘린더를 선택하세요';
      lbl.textContent = `${status.username} (캘린더 미선택)`;
      lbl.classList.add('disconnected');

    } else {
      // ▼ 완전 미연결
      btn.textContent = '연결';
      btn.classList.remove('connected');
      btn.title = 'NextCloud 계정 연결';
      lbl.textContent = '미연결';
      lbl.classList.add('disconnected');
    }
  } catch (err) {
    console.error('NextCloud status check failed:', err);
  }
}

/**
 * Google Calendar + Google Tasks 양쪽 동기화.
 * @param {object} opts
 * @param {boolean} opts.silent  true면 토스트 안 띄움 (자동 동기화용)
 *
 * 동작 흐름 (Calendar / Tasks 각각):
 *  1) IPC로 메인에 동기화 요청
 *  2) isFull(전체)이면 그 source의 일정/메모를 다 갈아끼움
 *  3) 증분이면 deletedIds 적용 + 변경된 항목만 upsert
 *  4) 저장 + 화면 다시 그리기 + 알람 재스케줄
 */
async function syncFromGoogle({ silent = false } = {}) {
  if (!isElectron || !state.googleAuthenticated) return;
  if (!silent) toast('Google 동기화 중...');

  // ── Calendar 동기화 ──
  let calOk = false, calMsg = '';
  try {
    const r = await window.electronAPI.syncGoogleCalendar();
    if (r.ok) {
      calOk = true;
      if (r.isFull) {
        // 전체 동기화: 기존 google 일정 다 지우고 새로 채움
        state.events = state.events.filter(e => e.source !== 'google');
        state.events.push(...(r.events || []));
      } else {
        // 증분: 삭제된 거 제거 + 변경된 거 upsert
        if (r.deletedIds?.length) {
          state.events = state.events.filter(e => !r.deletedIds.includes(e.id));
        }
        (r.events || []).forEach(g => {
          const idx = state.events.findIndex(e => e.id === g.id);
          if (idx >= 0) state.events[idx] = g;   // 기존 갱신
          else          state.events.push(g);    // 새로 추가
        });
      }
      calMsg = `Calendar ${(r.events||[]).length}건`;
    } else {
      calMsg = 'Calendar 실패: ' + r.error;
    }
  } catch (e) { calMsg = 'Calendar 오류: ' + e.message; }

  // ── Tasks 동기화 (위 Calendar와 동일한 패턴) ──
  let taskOk = false, taskMsg = '';
  try {
    const r = await window.electronAPI.syncGoogleTasks();
    if (r.ok) {
      taskOk = true;
      if (r.isFull) {
        state.memos = state.memos.filter(m => m.source !== 'gtasks');
        state.memos.push(...(r.memos || []));
      } else {
        if (r.deletedIds?.length) {
          state.memos = state.memos.filter(m => !r.deletedIds.includes(m.id));
        }
        (r.memos || []).forEach(g => {
          const idx = state.memos.findIndex(m => m.id === g.id);
          if (idx >= 0) state.memos[idx] = g;
          else          state.memos.push(g);
        });
      }
      taskMsg = `Tasks ${(r.memos||[]).length}건`;
    } else {
      taskMsg = 'Tasks 실패: ' + r.error;
    }
  } catch (e) { taskMsg = 'Tasks 오류: ' + e.message; }

  // 저장 + 다시 그리기
  await saveEvents();
  await saveMemos();
  renderCalendar();
  renderMemos();
  scheduleAlarms();

  // 🆕 동기화된 범위 기록 (백엔드의 PAST_DAYS=7, FUTURE_DAYS=56 와 동일)
  if (calOk) updateSyncedRange('google', -7, 56);

  // 결과 토스트
  if (!silent) {
    if (calOk && taskOk) toast(`동기화 완료 · ${calMsg} · ${taskMsg}`);
    else                 toast([calMsg, taskMsg].filter(Boolean).join(' / '), 3500);
  }
}

/**
 * NextCloud Calendar 동기화.
 * Google과 거의 같지만 NextCloud는 Tasks 동기화는 없음(이번 단계엔).
 */
async function syncFromNextcloud({ silent = false } = {}) {
  if (!isElectron || !state.nextcloudAuthenticated) return;
  if (!silent) toast('NextCloud 동기화 중...');

  try {
    const r = await window.electronAPI.syncNextcloud();
    if (!r.ok) {
      if (!silent) toast('NextCloud 실패: ' + r.error, 3500);
      return;
    }
    if (r.isFull) {
      // 전체: nextcloud 일정 다 갈아엎음
      state.events = state.events.filter(e => e.source !== 'nextcloud');
      state.events.push(...(r.events || []));
    } else {
      // 증분 처리
      if (r.deletedIds?.length) {
        state.events = state.events.filter(e => !r.deletedIds.includes(e.id));
      }
      (r.events || []).forEach(g => {
        const idx = state.events.findIndex(e => e.id === g.id);
        if (idx >= 0) state.events[idx] = g;
        else          state.events.push(g);
      });
    }
    await saveEvents();
    renderCalendar();
    scheduleAlarms();
    // 🆕 동기화된 범위 기록
    updateSyncedRange('nextcloud', -7, 56);
    if (!silent) toast(`NextCloud 동기화 완료 · ${(r.events || []).length}건`);
  } catch (e) {
    if (!silent) toast('NextCloud 오류: ' + e.message, 3500);
  }
}

/**
 * "지금 동기화" 통합 트리거.
 * 연결된 모든 계정을 병렬로 동기화. 둘 다 미연결이면 토스트만.
 *
 * 호출 위치:
 *  - 설정 패널 "🔄 동기화" 헤더 클릭
 *  - 컨텍스트 메뉴 "지금 동기화"
 *  - 트레이 메뉴 "지금 동기화" (메인 → 'trigger-sync' 이벤트)
 */
async function triggerSyncAll() {
  if (!isElectron) { toast('Electron 환경에서만 동작합니다'); return; }
  const tasks = [];
  if (state.googleAuthenticated)    tasks.push(syncFromGoogle());
  if (state.nextcloudAuthenticated) tasks.push(syncFromNextcloud());
  if (tasks.length === 0) { toast('연결된 계정이 없습니다'); return; }
  await Promise.all(tasks);
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 🆕 임의 범위 자동 동기화 (캘린더 이동 시)                          ║
// ║                                                                  ║
// ║  사용자가 동기화된 범위 밖으로 이동하면 자동으로 그 부분을 fetch.    ║
// ║  - state.syncedRange로 추적                                        ║
// ║  - 휠은 디바운스 (마구 굴려도 폭주 안 함)                           ║
// ║  - 백그라운드 fetch (UI 블록 안 함)                                 ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * 동기화된 범위 갱신.
 * 백엔드가 항상 (오늘 - past)일 ~ (오늘 + future)일을 가져오니까,
 * 동기화 직후엔 그 범위로 설정.
 * 🆕 변경 즉시 디스크에도 저장
 */
function updateSyncedRange(source, pastDays, futureDays) {
  const now = new Date();
  const start = new Date(now); start.setDate(now.getDate() + pastDays); start.setHours(0,0,0,0);
  const end   = new Date(now); end.setDate(now.getDate() + futureDays); end.setHours(23,59,59,999);

  const cur = state.syncedRange[source];
  // 기존 범위가 더 넓으면 보존 (사용자가 멀리 봤던 범위 유지)
  if (cur.start && cur.start < start) start.setTime(cur.start.getTime());
  if (cur.end && cur.end > end) end.setTime(cur.end.getTime());

  state.syncedRange[source].start = start;
  state.syncedRange[source].end = end;
  saveSyncedRange();
}

/**
 * 🆕 syncedRange를 disk에 저장 (Date → ISO 문자열로 직렬화)
 */
async function saveSyncedRange() {
  const serializable = {
    google: {
      start: state.syncedRange.google.start ? state.syncedRange.google.start.toISOString() : null,
      end:   state.syncedRange.google.end   ? state.syncedRange.google.end.toISOString()   : null
    },
    nextcloud: {
      start: state.syncedRange.nextcloud.start ? state.syncedRange.nextcloud.start.toISOString() : null,
      end:   state.syncedRange.nextcloud.end   ? state.syncedRange.nextcloud.end.toISOString()   : null
    }
  };
  await saveJSON('cal_synced_range_v1', serializable);
}

/**
 * 🆕 syncedRange를 disk에서 복원 (ISO 문자열 → Date)
 * loadAll() 마지막에 호출됨
 */
async function loadSyncedRange() {
  const saved = await loadJSON('cal_synced_range_v1');
  if (!saved) return;
  ['google', 'nextcloud'].forEach(src => {
    if (saved[src]?.start) state.syncedRange[src].start = new Date(saved[src].start);
    if (saved[src]?.end)   state.syncedRange[src].end   = new Date(saved[src].end);
  });
}

/**
 * 두 범위 [a1,a2]와 [b1,b2]의 차집합 (a 안에서 b를 뺀 부분들).
 * b가 a를 완전히 덮으면 [], 아니면 1~2개의 [start,end] 반환.
 */
function rangeDifference(a1, a2, b1, b2) {
  const out = [];
  // a 가 b 시작보다 일찍 시작하면, 앞쪽 미동기화 부분
  if (a1 < b1) out.push([a1, new Date(Math.min(a2.getTime(), b1.getTime()))]);
  // a 가 b 끝보다 늦게 끝나면, 뒤쪽 미동기화 부분
  if (a2 > b2) out.push([new Date(Math.max(a1.getTime(), b2.getTime())), a2]);
  return out;
}

/**
 * 현재 화면에 보이는 5주 그리드가 동기화된 범위 안에 있는지 확인하고,
 * 벗어난 부분이 있으면 백그라운드로 자동 fetch.
 *
 * 마진 7일: 사용자가 다음 주로 이동할 때 매번 fetch하는 걸 줄이려고
 * 미리 좀 여유있게.
 */
async function ensureRangeSynced() {
  if (!isElectron) return;

  // 현재 화면 범위 (그리드 시작 + 35일)
  const viewStart = new Date(state.viewWeekStart);
  viewStart.setHours(0,0,0,0);
  const viewEnd = new Date(viewStart);
  viewEnd.setDate(viewStart.getDate() + 34);   // 35일
  viewEnd.setHours(23,59,59,999);

  // 마진 7일 — 미리 좀 여유있게 fetch
  const need_start = new Date(viewStart); need_start.setDate(viewStart.getDate() - 7);
  const need_end   = new Date(viewEnd);   need_end.setDate(viewEnd.getDate() + 7);

  const tasks = [];

  // ── Google ──
  if (state.googleAuthenticated) {
    const r = state.syncedRange.google;
    if (!r.start || !r.end) {
      // 아예 동기화 안 된 상태 — 일단 기본 동기화부터
      tasks.push(syncFromGoogle({ silent: true }));
    } else {
      const gaps = rangeDifference(need_start, need_end, r.start, r.end);
      if (gaps.length > 0) {
        // 가장 바깥 범위 한 번에 (gap이 2개여도 한 호출로)
        const gapStart = gaps[0][0];
        const gapEnd = gaps[gaps.length - 1][1];
        tasks.push(fetchAndMergeGoogle(gapStart, gapEnd));
      }
    }
  }

  // ── NextCloud ──
  if (state.nextcloudAuthenticated) {
    const r = state.syncedRange.nextcloud;
    if (!r.start || !r.end) {
      tasks.push(syncFromNextcloud({ silent: true }));
    } else {
      const gaps = rangeDifference(need_start, need_end, r.start, r.end);
      if (gaps.length > 0) {
        const gapStart = gaps[0][0];
        const gapEnd = gaps[gaps.length - 1][1];
        tasks.push(fetchAndMergeNextcloud(gapStart, gapEnd));
      }
    }
  }

  if (tasks.length > 0) {
    showSyncIndicator(true);
    try { await Promise.all(tasks); } finally { showSyncIndicator(false); }
  }
}

/** Google에서 특정 범위만 fetch + state에 합치기 */
async function fetchAndMergeGoogle(start, end) {
  try {
    const r = await window.electronAPI.fetchGoogleRange({
      startISO: start.toISOString(),
      endISO: end.toISOString()
    });
    if (!r.ok) { console.warn('[range-sync] google:', r.error); return; }

    // upsert: 같은 id가 있으면 덮어쓰고, 없으면 추가
    (r.events || []).forEach(g => {
      const idx = state.events.findIndex(e => e.id === g.id);
      if (idx >= 0) state.events[idx] = g;
      else          state.events.push(g);
    });

    // 동기화 범위 확장
    const cur = state.syncedRange.google;
    if (cur.start && start < cur.start) cur.start = start;
    if (cur.end && end > cur.end)       cur.end = end;
    if (!cur.start) { cur.start = start; cur.end = end; }
    saveSyncedRange();   // 🆕 즉시 저장

    await saveEvents();
    renderCalendar();
  } catch (e) { console.warn('[range-sync] google 예외:', e.message); }
}

/** NextCloud에서 특정 범위만 fetch + state에 합치기 */
async function fetchAndMergeNextcloud(start, end) {
  try {
    const r = await window.electronAPI.fetchNextcloudRange({
      startISO: start.toISOString(),
      endISO: end.toISOString()
    });
    if (!r.ok) { console.warn('[range-sync] nextcloud:', r.error); return; }

    (r.events || []).forEach(g => {
      const idx = state.events.findIndex(e => e.id === g.id);
      if (idx >= 0) state.events[idx] = g;
      else          state.events.push(g);
    });

    const cur = state.syncedRange.nextcloud;
    if (cur.start && start < cur.start) cur.start = start;
    if (cur.end && end > cur.end)       cur.end = end;
    if (!cur.start) { cur.start = start; cur.end = end; }
    saveSyncedRange();   // 🆕 즉시 저장

    await saveEvents();
    renderCalendar();
  } catch (e) { console.warn('[range-sync] nextcloud 예외:', e.message); }
}

/**
 * 동기화 중 표시 — 헤더 옆에 작은 점 같은 거.
 * #todayInfo 옆에 "· ⟳" 텍스트를 붙였다 뗐다.
 */
function showSyncIndicator(on) {
  const el = document.getElementById('todayInfo');
  if (!el) return;
  if (on) {
    if (!el.dataset.origText) el.dataset.origText = el.textContent;
    el.textContent = el.dataset.origText + ' · ⟳';
    el.classList.add('syncing');
  } else {
    if (el.dataset.origText !== undefined) {
      el.textContent = el.dataset.origText;
      delete el.dataset.origText;
    }
    el.classList.remove('syncing');
  }
}

// 디바운스: 사용자가 휠을 빠르게 굴려서 ensureRangeSynced가 폭주하지 않게
let _ensureSyncTimer = null;
function debouncedEnsureRangeSynced() {
  clearTimeout(_ensureSyncTimer);
  _ensureSyncTimer = setTimeout(ensureRangeSynced, 400);
}

/**
 * 🆕 옵션A — 앱 시작 시 "기본 윈도우 밖" 범위 갱신.
 *
 * loadSyncedRange로 복원된 syncedRange가 기본 윈도우(±1주~8주)보다
 * 넓으면 그 부분만 fetchRange로 갱신.
 *
 * 동작 예시:
 * - 어제 1년 후 일정까지 봤다 → syncedRange.end = 오늘 + 365일
 * - 오늘 앱 시작 → syncFromGoogle()는 ±8주만 정확히 동기화
 * - 그 다음 이 함수가 +56일 ~ +365일 부분을 fetchRange로 갱신
 *   (변경/삭제는 못 잡지만, 새로 추가된 일정은 잡힘)
 */
async function refreshExtendedRanges() {
  if (!isElectron) return;

  // 기본 윈도우 (백엔드 PAST_DAYS=7, FUTURE_DAYS=56과 동일)
  const now = new Date();
  const baseStart = new Date(now); baseStart.setDate(now.getDate() - 7); baseStart.setHours(0,0,0,0);
  const baseEnd   = new Date(now); baseEnd.setDate(now.getDate() + 56); baseEnd.setHours(23,59,59,999);

  const tasks = [];

  // ── Google ──
  if (state.googleAuthenticated) {
    const r = state.syncedRange.google;
    if (r.start && r.end) {
      // 기본 윈도우 밖 (양쪽) 부분 갱신
      if (r.start < baseStart) tasks.push(fetchAndMergeGoogle(r.start, baseStart));
      if (r.end > baseEnd)     tasks.push(fetchAndMergeGoogle(baseEnd, r.end));
    }
  }

  // ── NextCloud ──
  if (state.nextcloudAuthenticated) {
    const r = state.syncedRange.nextcloud;
    if (r.start && r.end) {
      if (r.start < baseStart) tasks.push(fetchAndMergeNextcloud(r.start, baseStart));
      if (r.end > baseEnd)     tasks.push(fetchAndMergeNextcloud(baseEnd, r.end));
    }
  }

  if (tasks.length > 0) {
    showSyncIndicator(true);
    try { await Promise.all(tasks); } finally { showSyncIndicator(false); }
  }
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 이벤트 바인딩 (모든 버튼/입력의 클릭/키 핸들러)                     ║
// ║                                                                  ║
// ║  여기서부터는 DOMContentLoaded 직후 한 번에 .addEventListener를       ║
// ║  거는 코드들이 쭉 이어짐.                                            ║
// ║  앞에서 정의한 함수들을 실제로 사용자 동작과 연결하는 부분.            ║
// ╚══════════════════════════════════════════════════════════════════╝

// ─── 네비게이션 버튼들 (이전 주 / 다음 주 / 이전 달 / 다음 달 / 오늘) ───

document.getElementById('prevWeek').addEventListener('click', () => {
  // 이전 주: viewWeekStart에서 7일 빼기
  state.viewWeekStart = new Date(state.viewWeekStart);
  state.viewWeekStart.setDate(state.viewWeekStart.getDate() - 7);
  renderCalendar();
  debouncedEnsureRangeSynced();   // 🆕
});

document.getElementById('nextWeek').addEventListener('click', () => {
  // 다음 주: 7일 더하기
  state.viewWeekStart = new Date(state.viewWeekStart);
  state.viewWeekStart.setDate(state.viewWeekStart.getDate() + 7);
  renderCalendar();
  debouncedEnsureRangeSynced();   // 🆕
});

document.getElementById('prevMonth').addEventListener('click', () => {
  // 이전 달: 그리드 가운데 날짜의 월을 -1, 그 후 5주 시작점 재계산
  const center = new Date(state.viewWeekStart);
  center.setDate(state.viewWeekStart.getDate() + 17);
  center.setMonth(center.getMonth() - 1);
  state.viewWeekStart = compute5WeekStart(center);
  renderCalendar();
  debouncedEnsureRangeSynced();   // 🆕
});

document.getElementById('nextMonth').addEventListener('click', () => {
  // 다음 달: 동일 패턴, 월을 +1
  const center = new Date(state.viewWeekStart);
  center.setDate(state.viewWeekStart.getDate() + 17);
  center.setMonth(center.getMonth() + 1);
  state.viewWeekStart = compute5WeekStart(center);
  renderCalendar();
  debouncedEnsureRangeSynced();   // 🆕
});

document.getElementById('todayBtn').addEventListener('click', () => {
  // "오늘" 버튼: 오늘이 포함된 5주 그리드로 점프
  state.viewWeekStart = compute5WeekStart(new Date());
  state.selectedDate = new Date();
  renderCalendar();
  debouncedEnsureRangeSynced();   // 🆕 (오늘 근처는 보통 동기화돼 있어 noop이지만 안전망)
});


// ─── 마우스 휠로 주 단위 이동 ───
// 캘린더 영역에서 휠 굴리면 한 주씩 이동. 너무 빨라서 화면이 헷갈리지 않게
// 250ms throttle (lastWheelTime으로 구현).
let lastWheelTime = 0;
document.querySelector('.calendar').addEventListener('wheel', (e) => {
  e.preventDefault();   // 페이지 스크롤 막기

  const now = Date.now();
  if (now - lastWheelTime < 250) return;   // 아직 250ms 안 지남
  lastWheelTime = now;

  // 휠 작은 떨림(트랙패드 등)은 무시
  if (Math.abs(e.deltaY) < 5) return;

  state.viewWeekStart = new Date(state.viewWeekStart);
  // 휠 아래(+)는 다음 주, 위(-)는 이전 주
  state.viewWeekStart.setDate(state.viewWeekStart.getDate() + (e.deltaY > 0 ? 7 : -7));
  renderCalendar();
  debouncedEnsureRangeSynced();   // 🆕
}, { passive: false });   // preventDefault 쓰려면 passive: false 필수


// ─── 좌측 상단 📅 아이콘 → neis.me 홈 열기 ───
document.getElementById('brandLink').addEventListener('click', (e) => {
  e.stopPropagation();
  // Electron이면 OS 기본 브라우저로, 아니면 새 탭으로
  if (isElectron) window.electronAPI.openExternal('https://neis.me');
  else            window.open('https://neis.me', '_blank');
});


// ─── 일정 모달의 저장/취소/삭제 버튼 ───
document.getElementById('saveEvent').addEventListener('click', saveEvent);
document.getElementById('cancelEvent').addEventListener('click', closeEventModal);
document.getElementById('deleteEvent').addEventListener('click', deleteEvent);

// 모달 배경(검은 영역) 클릭 → 닫기. 단, 모달 박스 안 클릭은 무시.
document.getElementById('eventModalBg').addEventListener('click', e => {
  if (e.target.id === 'eventModalBg') closeEventModal();
});

// 시간 입력 변경 시 알람 칩 활성화/비활성화 갱신
document.getElementById('evTime').addEventListener('input', updateAlarmChips);

// 🆕 저장 위치 변경 시 캘린더 하위 드롭다운 갱신
document.getElementById('evSource').addEventListener('change', () => {
  updateEventCalendarDropdown(null);   // 신규 모드로 갱신 (편집 시엔 source 변경 가능)
});

// 알람 칩 클릭 → editingAlarms에 추가/제거
document.querySelectorAll('.alarm-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    if (chip.classList.contains('disabled')) return;   // 시간 없으면 클릭 무시
    const a = chip.dataset.alarm;
    if (state.editingAlarms.has(a)) state.editingAlarms.delete(a);
    else                            state.editingAlarms.add(a);
    updateAlarmChips();
  });
});


// ─── 메모 입력창 ───
// Enter 누르면 메모 추가
document.getElementById('memoInput').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const text = e.target.value;
    if (text.trim()) { await addMemo(text); e.target.value = ''; }
  }
});

// 메모 탭 (전체/진행중/Tasks) 클릭 시 필터 변경
document.querySelectorAll('.memo-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.memo-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.memoFilter = tab.dataset.tab;
    renderMemos();
  });
});


// ─── 레이아웃 카드 (균일/가로압축/세로분할) 클릭 ───
document.querySelectorAll('.layout-card').forEach(card => {
  card.addEventListener('click', async () => {
    state.layout = card.dataset.layout;
    applyLayout();
    await saveSettings();
    const names = { uniform: '균일 모드', emphasis: '가로 압축 모드', split: '세로 분할 모드' };
    toast(names[state.layout]);
  });
});


// ─── 설정 버튼 (⚙) → 설정 패널 토글 ───
document.getElementById('settingsBtn').addEventListener('click', e => {
  e.stopPropagation();   // document 클릭 핸들러로 전파 방지 (열자마자 닫히지 않게)
  document.getElementById('settingsPanel').classList.toggle('show');
});


// ─── 투명도/폰트 슬라이더 ───
document.getElementById('opacitySlider').addEventListener('input', async e => {
  state.opacity = e.target.value / 100;
  applyOpacity();
  await saveSettings();
});
document.getElementById('fontSlider').addEventListener('input', async e => {
  state.fontSize = parseFloat(e.target.value);
  applyFontSize();
  await saveSettings();
});


// ─── 잠금 토글 체크박스 ───
document.getElementById('lockToggle').addEventListener('change', async e => {
  state.locked = e.target.checked;
  await applyLock();
});


// ─── 설정 패널 "🔄 동기화" 헤더 클릭 → 즉시 동기화 ───
// ?. 는 syncHeader 요소가 없으면 안 죽게 하는 안전장치
document.getElementById('syncHeader')?.addEventListener('click', () => {
  triggerSyncAll();
});


// ─── Google 인증 버튼 (🆕 멀티 캘린더) ───
// 동작:
//  - 미연결: OAuth 시작 → 성공 시 캘린더 선택 모달 자동 오픈
//  - 연결됨: 캘린더 관리 모달 오픈 (재선택 또는 연결 해제)
document.getElementById('googleAuthBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!isElectron) { toast('Electron 환경에서만 동작합니다'); return; }

  const btn = e.target;
  const status = await window.electronAPI.authGoogleStatus();

  if (status.authenticated) {
    // ─── 이미 연결됨 → 캘린더 관리 모달 ───
    await openGoogleCalendarSelectModal();
  } else {
    // ─── 미연결 → OAuth 시작 ───
    btn.disabled = true;
    btn.textContent = '인증 중...';
    toast('브라우저에서 Google 로그인을 진행하세요');
    try {
      const result = await window.electronAPI.authGoogle();
      if (result.ok) {
        toast(`연결됨: ${result.email}`);
        await refreshGoogleAuthStatus();
        // 인증 직후 캘린더 선택 모달 자동 오픈
        await openGoogleCalendarSelectModal();
      } else {
        toast('연결 실패: ' + result.error, 4000);
      }
    } catch (err) {
      toast('연결 실패: ' + err.message, 4000);
    } finally {
      btn.disabled = false;
      await refreshGoogleAuthStatus();
    }
  }
});


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ Google 캘린더 선택 모달 (🆕)                                     ║
// ║                                                                  ║
// ║  체크박스 = 동기화에 포함                                           ║
// ║  ⭐ 별 = 새 일정의 기본 저장 위치 (1개만)                           ║
// ╚══════════════════════════════════════════════════════════════════╝

const gcalModalBg = document.getElementById('gcalModalBg');

// 모달이 열려있을 때 사용자가 만지작거리는 임시 선택 상태
// 형식: [{ id, summary, backgroundColor, isPrimary, _checked }]
let gcalDraft = [];

/**
 * 🆕 캘린더 목록 조회가 실패해도 모달을 열어서 "연결 해제"는 가능하게 함.
 *  - API 성공: 모든 캘린더 표시
 *  - API 실패: 저장된 selected만 표시 + 에러 안내 박스
 *  - selected도 없으면: 빈 안내 + 연결 해제 버튼만
 */
async function openGoogleCalendarSelectModal() {
  // 저장된 선택 목록 (이건 로컬 store라 토큰 권한과 무관하게 항상 읽힘)
  const selected = await window.electronAPI.googleGetSelectedCalendars() || [];
  const selectedIds = new Set(selected.map(c => c.id));
  const primaryId = (selected.find(c => c.isPrimary) || {}).id;

  // 캘린더 목록 가져오기 (실패할 수 있음)
  let allCals = [];
  let listError = null;
  try {
    const r = await window.electronAPI.googleListCalendars();
    if (r.ok) {
      allCals = r.calendars || [];
    } else {
      listError = r.error || '알 수 없는 오류';
    }
  } catch (err) {
    listError = err.message || String(err);
  }

  // 🆕 API 실패 시 저장된 selected 목록만이라도 보여주기
  //    (사용자가 이전에 어떤 캘린더 골랐는지 보이고, customColor도 유지됨)
  if (allCals.length === 0 && selected.length > 0) {
    allCals = selected.map(c => ({
      id: c.id,
      summary: c.summary,
      backgroundColor: c.backgroundColor || '#4285f4',
      primary: false
    }));
  }

  // draft 초기화: 저장된 selected의 customColor가 있으면 우선 적용
  gcalDraft = allCals.map(c => {
    const saved = selected.find(s => s.id === c.id);
    return {
      id: c.id,
      summary: c.summary,
      backgroundColor: c.backgroundColor,
      // 🆕 customColor: 저장된 값 > 원래 backgroundColor > 폴백
      customColor: (saved && saved.customColor) || c.backgroundColor || '#4285f4',
      _checked: selectedIds.has(c.id),
      isPrimary: c.id === primaryId
    };
  });

  renderGcalList(listError);   // 🆕 에러 메시지 함께 전달
  gcalModalBg.classList.add('show');
}

function closeGcalModal() {
  gcalModalBg.classList.remove('show');
  gcalDraft = [];
}

/**
 * 🆕 변경점:
 *  - listError 인자 받아서 모달 상단에 안내 박스 표시
 *  - 캘린더별 색상 input(컬러피커) 추가 — 클릭하면 native color picker
 *  - 빈 목록일 때도 안내 메시지로 변경 (연결 해제는 여전히 가능)
 */
function renderGcalList(listError) {
  const list = document.getElementById('gcalList');

  // 🆕 에러 안내 박스 (목록 위에)
  let errorBox = '';
  if (listError) {
    errorBox = `
      <div class="cal-select-error">
        ⚠ 캘린더 목록을 가져올 수 없습니다.<br>
        <small>${escapeHtml(listError)}</small><br>
        <small style="opacity:0.8">권한이 부족하거나 네트워크 문제일 수 있습니다. 아래 <b>연결 해제</b> 후 다시 연결해보세요.</small>
      </div>
    `;
  }

  // 빈 목록 + 에러 없음 (희귀 케이스)
  if (gcalDraft.length === 0) {
    list.innerHTML = errorBox + '<div class="cal-select-empty">사용 가능한 캘린더가 없습니다</div>';
    return;
  }

  // 정상 렌더 (+ 에러가 있으면 위에 박스 함께)
  list.innerHTML = errorBox + gcalDraft.map((c, i) => `
    <div class="cal-select-item" data-idx="${i}">
      <input type="checkbox" class="cal-check" ${c._checked ? 'checked' : ''}>
      <input type="color" class="cal-color-input" value="${escapeHtml(c.customColor)}" title="클릭하여 색상 변경">
      <span class="cal-name">${escapeHtml(calDisplayName(c, 'google'))}</span>
      <button class="cal-color-reset" title="원래 색상으로 복원">↺</button>
      <button class="cal-star ${c.isPrimary ? 'active' : ''}" title="기본 캘린더로 지정">
        ${c.isPrimary ? '⭐' : '☆'}
      </button>
    </div>
  `).join('');

  // 체크박스 변경
  list.querySelectorAll('.cal-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const item = cb.closest('.cal-select-item');
      const i = parseInt(item.dataset.idx, 10);
      gcalDraft[i]._checked = cb.checked;
      if (!cb.checked && gcalDraft[i].isPrimary) {
        gcalDraft[i].isPrimary = false;
        const next = gcalDraft.find(x => x._checked);
        if (next) next.isPrimary = true;
      }
      renderGcalList(listError);
    });
  });

  // 🆕 색상 변경 — input change/input 양쪽으로 즉시 반영 (renderGcalList 안 다시 호출 → 포커스 안 깨짐)
  list.querySelectorAll('.cal-color-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = parseInt(inp.closest('.cal-select-item').dataset.idx, 10);
      gcalDraft[i].customColor = inp.value;
      // 굳이 전체 다시 그리지 않음 (picker 닫힘 방지). input value 자체가 도트 색이라 시각 반영 자동
    });
  });

  // 🆕 색상 리셋 버튼 — 원래 backgroundColor로 되돌림
  list.querySelectorAll('.cal-color-reset').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(btn.closest('.cal-select-item').dataset.idx, 10);
      gcalDraft[i].customColor = gcalDraft[i].backgroundColor || '#4285f4';
      renderGcalList(listError);
    });
  });

  // 별 클릭
  list.querySelectorAll('.cal-star').forEach(star => {
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = star.closest('.cal-select-item');
      const i = parseInt(item.dataset.idx, 10);
      if (!gcalDraft[i]._checked) { toast('먼저 체크해주세요'); return; }
      gcalDraft.forEach(x => x.isPrimary = false);
      gcalDraft[i].isPrimary = true;
      renderGcalList(listError);
    });
  });
}

// 모달 배경 클릭 → 닫기
gcalModalBg.addEventListener('click', e => {
  if (e.target.id === 'gcalModalBg') closeGcalModal();
});
document.getElementById('gcalCancel').addEventListener('click', closeGcalModal);

// 저장 버튼
document.getElementById('gcalSave').addEventListener('click', async () => {
  const picked = gcalDraft.filter(c => c._checked).map(c => ({
    id: c.id,
    summary: calDisplayName(c, 'google'),
    backgroundColor: c.backgroundColor,
    customColor: c.customColor,        // 🆕 사용자가 정한 색
    isPrimary: c.isPrimary
  }));

  if (picked.length === 0) {
    if (!confirm('선택된 캘린더가 없습니다. 모든 Google 일정이 화면에서 사라집니다. 계속할까요?')) return;
  }

  await window.electronAPI.googleSetSelectedCalendars(picked);
  closeGcalModal();
  await refreshGoogleAuthStatus();    // calendarColors 캐시 재빌드
  toast(`Google 캘린더 ${picked.length}개 저장됨`);

  // 🆕 색상만 바꾼 경우에도 즉시 화면에 반영되도록 다시 렌더
  renderCalendar();

  // 캘린더 set이 바뀐 경우엔 동기화도 새로
  state.events = state.events.filter(e => e.source !== 'google');
  await saveEvents();
  renderCalendar();
  setTimeout(() => syncFromGoogle(), 300);
});

// 연결 해제 링크
document.getElementById('gcalRevoke').addEventListener('click', async () => {
  if (!confirm('Google 연결을 해제하시겠습니까?\n가져온 Google 일정과 Tasks도 함께 제거됩니다.')) return;
  try {
    await window.electronAPI.authGoogleRevoke();
    state.events = state.events.filter(e => e.source !== 'google');
    state.memos  = state.memos.filter(m  => m.source !== 'gtasks');
    // 🆕 동기화 범위 초기화
    state.syncedRange.google = { start: null, end: null };
    saveSyncedRange();
    await saveEvents();
    await saveMemos();
    closeGcalModal();
    renderCalendar();
    renderMemos();
    toast('연결 해제됨');
  } catch (err) {
    toast('해제 실패: ' + err.message);
  } finally {
    await refreshGoogleAuthStatus();
  }
});


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ NextCloud 인증 + 캘린더 선택 모달                                ║
// ║                                                                  ║
// ║  2단계 모달:                                                       ║
// ║   ① 서버주소/ID/비밀번호 입력 (#ncStep1)                            ║
// ║   ② 인증 성공 후 캘린더 선택 (#ncStep2)                             ║
// ╚══════════════════════════════════════════════════════════════════╝

// 모달 요소들 캐시 (자주 쓰니까)
const ncModalBg = document.getElementById('ncModalBg');
const ncStep1   = document.getElementById('ncStep1');
const ncStep2   = document.getElementById('ncStep2');

/** NextCloud 모달 열기. step1=서버 입력, step2=캘린더 선택 */
function openNcModal(step1 = true) {
  ncStep1.style.display = step1 ? 'block' : 'none';
  ncStep2.style.display = step1 ? 'none'  : 'block';
  ncModalBg.classList.add('show');
}

/** NextCloud 모달 닫기. 비밀번호 필드는 보안상 매번 비움 */
function closeNcModal() {
  ncModalBg.classList.remove('show');
  document.getElementById('ncPass').value = '';
}

// 모달 배경 클릭 → 닫기 (모달 박스 안 클릭은 무시)
ncModalBg.addEventListener('click', e => {
  if (e.target.id === 'ncModalBg') closeNcModal();
});
// 두 단계 모두 "취소" 버튼은 그냥 닫기
document.getElementById('ncCancel').addEventListener('click', closeNcModal);
document.getElementById('ncCancel2').addEventListener('click', closeNcModal);


// ─── NextCloud 연결 버튼 (🆕 멀티 캘린더) ───
// 동작:
//  - 미연결: step1 모달(서버/ID/비번) → 인증 성공 → step2(체크박스 멀티셀렉)
//  - 연결됨: 관리 모달 (재선택 또는 연결 해제)
document.getElementById('nextcloudAuthBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!isElectron) { toast('Electron 환경에서만 동작합니다'); return; }

  const status = await window.electronAPI.authNextcloudStatus();

  if (status.authenticated) {
    // 이미 인증됨 → 관리 모달
    await openNextcloudManageModal();
  } else {
    // 미연결 → step1
    document.getElementById('ncServer').value = '';
    document.getElementById('ncUser').value = '';
    document.getElementById('ncPass').value = '';
    openNcModal(true);
    setTimeout(() => document.getElementById('ncServer').focus(), 50);
  }
});


// ─── 모달 step1의 "연결" 버튼 ───
// 입력값으로 인증 시도 → 성공하면 step2로 (멀티 셀렉)
document.getElementById('ncConnect').addEventListener('click', async () => {
  const serverUrl = document.getElementById('ncServer').value.trim();
  const username  = document.getElementById('ncUser').value.trim();
  const password  = document.getElementById('ncPass').value;

  if (!serverUrl || !username || !password) {
    toast('모든 필드를 입력하세요');
    return;
  }

  const btn = document.getElementById('ncConnect');
  btn.disabled = true;
  btn.textContent = '연결 중...';
  try {
    const r = await window.electronAPI.authNextcloud({ serverUrl, username, password });
    if (!r.ok) {
      toast('연결 실패: ' + r.error, 4000);
      return;
    }
    // 인증 성공 → step2로 (멀티셀렉 캘린더 목록)
    initNcStep2Draft(r.calendars || []);
    renderNcCalendarsMulti();
    openNcModal(false);
  } catch (err) {
    toast('연결 실패: ' + err.message, 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = '연결';
  }
});


// ─── NextCloud step2 (멀티셀렉 + 별) ───
// step1과 step2는 같은 모달의 두 단계. step2의 draft 상태는 모달 내부 변수로 관리.
let ncStep2Draft = [];

function initNcStep2Draft(calendars) {
  // 첫 가입이라 모두 미체크. 첫 번째에 별 표시 (사용자가 바꿀 수 있음)
  ncStep2Draft = calendars.map((c, i) => ({
    url: c.url,
    displayName: c.displayName,
    _checked: false,
    isPrimary: false
  }));
}

function renderNcCalendarsMulti() {
  const list = document.getElementById('ncCalendars');
  if (ncStep2Draft.length === 0) {
    list.innerHTML = '<div class="cal-select-empty">사용 가능한 캘린더가 없습니다</div>';
    return;
  }

  list.innerHTML = ncStep2Draft.map((c, i) => `
    <div class="cal-select-item" data-idx="${i}">
      <input type="checkbox" class="cal-check" ${c._checked ? 'checked' : ''}>
      <span class="cal-color-dot" style="background:#0082c9"></span>
      <span class="cal-name">${escapeHtml(calDisplayName(c, 'nextcloud'))}</span>
      <button class="cal-star ${c.isPrimary ? 'active' : ''}" title="기본 캘린더로 지정">
        ${c.isPrimary ? '⭐' : '☆'}
      </button>
    </div>
  `).join('');

  list.querySelectorAll('.cal-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const i = parseInt(cb.closest('.cal-select-item').dataset.idx, 10);
      ncStep2Draft[i]._checked = cb.checked;
      // 체크 해제 시 별도 보정
      if (!cb.checked && ncStep2Draft[i].isPrimary) {
        ncStep2Draft[i].isPrimary = false;
        const next = ncStep2Draft.find(x => x._checked);
        if (next) next.isPrimary = true;
      }
      // 별 자동 부여: 이번 체크가 첫 체크면 기본으로
      if (cb.checked && !ncStep2Draft.some(x => x.isPrimary)) {
        ncStep2Draft[i].isPrimary = true;
      }
      renderNcCalendarsMulti();
    });
  });

  list.querySelectorAll('.cal-star').forEach(star => {
    star.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(star.closest('.cal-select-item').dataset.idx, 10);
      if (!ncStep2Draft[i]._checked) { toast('먼저 체크해주세요'); return; }
      ncStep2Draft.forEach(x => x.isPrimary = false);
      ncStep2Draft[i].isPrimary = true;
      renderNcCalendarsMulti();
    });
  });
}


// ─── step2의 "완료" 버튼 ───
document.getElementById('ncSelectDone').addEventListener('click', async () => {
  const picked = ncStep2Draft.filter(c => c._checked).map(c => ({
    url: c.url,
    displayName: calDisplayName(c, 'nextcloud'),  // 🆕 빈 이름 방지
    isPrimary: c.isPrimary
  }));

  if (picked.length === 0) { toast('최소 한 개 이상 선택하세요'); return; }

  await window.electronAPI.nextcloudSetSelectedCalendars(picked);
  closeNcModal();
  toast(`NextCloud 캘린더 ${picked.length}개 선택됨`);
  await refreshNextcloudAuthStatus();
  setTimeout(() => syncFromNextcloud(), 500);
});


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ NextCloud 관리 모달 (🆕 이미 연결된 상태에서 캘린더 재선택)         ║
// ╚══════════════════════════════════════════════════════════════════╝

const ncManageModalBg = document.getElementById('ncManageModalBg');
let ncManageDraft = [];

async function openNextcloudManageModal() {
  // 저장된 선택 목록은 항상 읽기 가능
  const selected = await window.electronAPI.nextcloudGetSelectedCalendars() || [];
  const selectedUrls = new Set(selected.map(c => c.url));
  const primaryUrl = (selected.find(c => c.isPrimary) || {}).url;

  let allCals = [];
  let listError = null;
  try {
    const r = await window.electronAPI.nextcloudListCalendars();
    if (r.ok) {
      allCals = r.calendars || [];
    } else {
      listError = r.error || '알 수 없는 오류';
    }
  } catch (err) {
    listError = err.message || String(err);
  }

  // 🆕 API 실패 시 저장된 selected 만이라도 표시
  if (allCals.length === 0 && selected.length > 0) {
    allCals = selected.map(c => ({
      url: c.url,
      displayName: c.displayName
    }));
  }

  ncManageDraft = allCals.map(c => {
    const saved = selected.find(s => s.url === c.url);
    return {
      url: c.url,
      displayName: c.displayName,
      customColor: (saved && saved.customColor) || '#0082c9',  // 🆕
      _checked: selectedUrls.has(c.url),
      isPrimary: c.url === primaryUrl
    };
  });

  renderNcManageList(listError);
  ncManageModalBg.classList.add('show');
}

function closeNcManageModal() {
  ncManageModalBg.classList.remove('show');
  ncManageDraft = [];
}

function renderNcManageList(listError) {
  const list = document.getElementById('ncManageList');

  let errorBox = '';
  if (listError) {
    errorBox = `
      <div class="cal-select-error">
        ⚠ 캘린더 목록을 가져올 수 없습니다.<br>
        <small>${escapeHtml(listError)}</small><br>
        <small style="opacity:0.8">서버가 응답하지 않거나 비밀번호가 만료됐을 수 있습니다. 아래 <b>연결 해제</b> 후 다시 연결해보세요.</small>
      </div>
    `;
  }

  if (ncManageDraft.length === 0) {
    list.innerHTML = errorBox + '<div class="cal-select-empty">사용 가능한 캘린더가 없습니다</div>';
    return;
  }

  list.innerHTML = errorBox + ncManageDraft.map((c, i) => `
    <div class="cal-select-item" data-idx="${i}">
      <input type="checkbox" class="cal-check" ${c._checked ? 'checked' : ''}>
      <input type="color" class="cal-color-input" value="${escapeHtml(c.customColor)}" title="클릭하여 색상 변경">
      <span class="cal-name">${escapeHtml(calDisplayName(c, 'nextcloud'))}</span>
      <button class="cal-color-reset" title="기본 색상(#0082c9)으로 복원">↺</button>
      <button class="cal-star ${c.isPrimary ? 'active' : ''}" title="기본 캘린더로 지정">
        ${c.isPrimary ? '⭐' : '☆'}
      </button>
    </div>
  `).join('');

  list.querySelectorAll('.cal-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const i = parseInt(cb.closest('.cal-select-item').dataset.idx, 10);
      ncManageDraft[i]._checked = cb.checked;
      if (!cb.checked && ncManageDraft[i].isPrimary) {
        ncManageDraft[i].isPrimary = false;
        const next = ncManageDraft.find(x => x._checked);
        if (next) next.isPrimary = true;
      }
      renderNcManageList(listError);
    });
  });

  // 🆕 색상 input
  list.querySelectorAll('.cal-color-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = parseInt(inp.closest('.cal-select-item').dataset.idx, 10);
      ncManageDraft[i].customColor = inp.value;
    });
  });

  // 🆕 색상 리셋
  list.querySelectorAll('.cal-color-reset').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(btn.closest('.cal-select-item').dataset.idx, 10);
      ncManageDraft[i].customColor = '#0082c9';
      renderNcManageList(listError);
    });
  });

  list.querySelectorAll('.cal-star').forEach(star => {
    star.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(star.closest('.cal-select-item').dataset.idx, 10);
      if (!ncManageDraft[i]._checked) { toast('먼저 체크해주세요'); return; }
      ncManageDraft.forEach(x => x.isPrimary = false);
      ncManageDraft[i].isPrimary = true;
      renderNcManageList(listError);
    });
  });
}

ncManageModalBg.addEventListener('click', e => {
  if (e.target.id === 'ncManageModalBg') closeNcManageModal();
});
document.getElementById('ncManageCancel').addEventListener('click', closeNcManageModal);

document.getElementById('ncManageSave').addEventListener('click', async () => {
  const picked = ncManageDraft.filter(c => c._checked).map(c => ({
    url: c.url,
    displayName: calDisplayName(c, 'nextcloud'),
    customColor: c.customColor,    // 🆕
    isPrimary: c.isPrimary
  }));

  if (picked.length === 0) {
    if (!confirm('선택된 캘린더가 없습니다. 모든 NextCloud 일정이 화면에서 사라집니다. 계속할까요?')) return;
  }

  await window.electronAPI.nextcloudSetSelectedCalendars(picked);
  closeNcManageModal();
  await refreshNextcloudAuthStatus();
  toast(`NextCloud 캘린더 ${picked.length}개 저장됨`);

  // 🆕 색상만 바뀌었을 경우에도 즉시 반영
  renderCalendar();

  state.events = state.events.filter(e => e.source !== 'nextcloud');
  await saveEvents();
  renderCalendar();
  setTimeout(() => syncFromNextcloud(), 300);
});

document.getElementById('ncManageRevoke').addEventListener('click', async () => {
  if (!confirm('NextCloud 연결을 해제하시겠습니까?\n가져온 NextCloud 일정도 함께 제거됩니다.')) return;
  try {
    await window.electronAPI.authNextcloudRevoke();
    state.events = state.events.filter(e => e.source !== 'nextcloud');
    // 🆕 동기화 범위 초기화
    state.syncedRange.nextcloud = { start: null, end: null };
    saveSyncedRange();
    await saveEvents();
    closeNcManageModal();
    renderCalendar();
    toast('NextCloud 연결 해제됨');
  } catch (err) {
    toast('해제 실패: ' + err.message);
  } finally {
    await refreshNextcloudAuthStatus();
  }
});


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 컨텍스트 메뉴 (타이틀바 우클릭 시 뜨는 메뉴)                       ║
// ╚══════════════════════════════════════════════════════════════════╝

// 타이틀바 우클릭 → 메뉴 표시
document.getElementById('titlebar').addEventListener('contextmenu', e => {
  e.preventDefault();   // 기본 브라우저 우클릭 메뉴 막기
  showContextMenu(e.clientX, e.clientY);
});

// 메뉴 항목들 ─────
document.getElementById('ctxUnlock').addEventListener('click', async () => {
  state.locked = !state.locked;
  await applyLock();
  hideContextMenu();
  toast(state.locked ? '잠금됨' : '잠금 해제됨 (이동/리사이즈 가능)');
});

document.getElementById('ctxSync').addEventListener('click', () => {
  hideContextMenu();
  triggerSyncAll();
});

document.getElementById('ctxSettings').addEventListener('click', () => {
  hideContextMenu();
  document.getElementById('settingsPanel').classList.add('show');
});

document.getElementById('ctxAlwaysTop').addEventListener('click', async () => {
  hideContextMenu();
  if (!isElectron) { toast('Electron 환경에서만 동작합니다'); return; }
  try {
    const current = await window.electronAPI.getAlwaysOnTop();
    const next = !current;
    await window.electronAPI.setAlwaysOnTop(next);
    toast(next ? '항상 위에 표시 ON' : '항상 위에 표시 OFF');
  } catch (err) {
    toast('설정 실패: ' + err.message);
  }
});


// ─── 설정 패널의 "항상 위에 표시" 체크박스 ───
document.getElementById('alwaysOnTopToggle').addEventListener('change', async (e) => {
  if (!isElectron) return;
  try {
    await window.electronAPI.setAlwaysOnTop(e.target.checked);
  } catch (err) {
    toast('설정 실패: ' + err.message);
  }
});


// ─── 트레이/위젯 어디서든 "항상 위에 표시"가 변경되면 체크박스 즉시 반영 ───
// 메인이 'always-on-top-changed' 이벤트를 보내옴
if (isElectron && window.electronAPI.onAlwaysOnTopChanged) {
  window.electronAPI.onAlwaysOnTopChanged((enabled) => {
    const cb = document.getElementById('alwaysOnTopToggle');
    if (cb) cb.checked = enabled;
  });
}


// ─── 시작 시 체크박스 초기 상태 동기화 (작은 IIFE) ───
// 메인의 store에서 alwaysOnTop 값을 읽어 체크박스에 반영
(async () => {
  if (!isElectron) return;
  try {
    const aot = await window.electronAPI.getAlwaysOnTop();
    const cb = document.getElementById('alwaysOnTopToggle');
    if (cb) cb.checked = aot;
  } catch {}
})();


// ─── 컨텍스트 메뉴 "종료" 항목 ───
document.getElementById('ctxQuit').addEventListener('click', async () => {
  hideContextMenu();
  if (isElectron && confirm('정말 종료하시겠습니까?')) {
    await window.electronAPI.quit();
  }
});


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 전역 클릭/키보드/포커스 핸들러 (UI 정리용)                         ║
// ║                                                                  ║
// ║  사용자가 위젯의 빈 공간을 클릭하거나 다른 앱으로 포커스가 옮겨가면     ║
// ║  열려있던 모든 팝업/메뉴를 깔끔히 닫음.                              ║
// ╚══════════════════════════════════════════════════════════════════╝

// 위젯 외부(또는 캘린더 빈 영역) 클릭 → 모든 팝오버/메뉴 닫기
document.addEventListener('click', () => {
  hideContextMenu();
  document.getElementById('settingsPanel').classList.remove('show');
  hideDayPopover();
});

// 단, 설정 패널이나 팝오버 "안쪽" 클릭은 위 핸들러로 전파되지 않게 막음
// (안 막으면 패널 안 뭐든 클릭하자마자 패널이 닫혀버림)
document.getElementById('settingsPanel').addEventListener('click', e => e.stopPropagation());
document.getElementById('dayPopover').addEventListener('click', e => e.stopPropagation());


// 창 포커스 잃을 때(다른 앱 클릭 등) → 패널 닫기
// 단, 모달이 떠있을 땐 닫지 않음 (DevTools 등으로 잠시 포커스 옮겨도 입력 유지)
window.addEventListener('blur', () => {
  const anyModalOpen =
    document.getElementById('eventModalBg').classList.contains('show') ||
    document.getElementById('ncModalBg').classList.contains('show') ||
    document.getElementById('gcalModalBg').classList.contains('show') ||
    document.getElementById('ncManageModalBg').classList.contains('show');
  if (anyModalOpen) return;

  document.getElementById('settingsPanel').classList.remove('show');
  hideContextMenu();
  hideDayPopover();
});

// 어디서든 우클릭 → 일정 모달도 닫음 (혹시 떠있을 때 깔끔하게)
// 단, 모달 안에서의 우클릭은 무시 (입력칸 우클릭 메뉴 사용 위해)
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.modal')) return;
  document.getElementById('settingsPanel').classList.remove('show');
  document.getElementById('eventModalBg').classList.remove('show');
  hideDayPopover();
});

// 창이 숨겨지는 순간(트레이로 들어가는 등)에도 패널 닫기
// → 다시 보일 때 깔끔한 상태로
// 단, 모달이 떠있으면 그대로 유지
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    const anyModalOpen =
      document.getElementById('eventModalBg').classList.contains('show') ||
      document.getElementById('ncModalBg').classList.contains('show') ||
      document.getElementById('gcalModalBg').classList.contains('show') ||
      document.getElementById('ncManageModalBg').classList.contains('show');
    if (anyModalOpen) return;

    document.getElementById('settingsPanel').classList.remove('show');
    hideContextMenu();
    hideDayPopover();
  }
});


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 메인 → 렌더러 이벤트 구독                                         ║
// ║                                                                  ║
// ║  메인 프로세스(main.js)가 보내오는 이벤트들:                          ║
// ║   - lock-state-changed: 다른 곳에서 잠금 상태 바뀜                  ║
// ║   - trigger-sync:       트레이 메뉴에서 "지금 동기화" 누름            ║
// ║   - open-settings:      트레이 메뉴 "설정 열기"                      ║
// ║   - sync-status:        동기화 진행 상태 메시지                      ║
// ║   - window-hidden:      창이 트레이로 숨겨졌음                       ║
// ╚══════════════════════════════════════════════════════════════════╝

if (isElectron) {
  // 잠금 상태가 바뀌면 (트레이 메뉴 등에서) UI 동기화
  // fromIPC=true로 호출 → 메인에 다시 setLock 안 보냄 (무한루프 방지)
  window.electronAPI.onLockStateChanged((locked) => {
    state.locked = locked;
    applyLock(true);
  });

  // 트레이 "지금 동기화" → triggerSyncAll
  window.electronAPI.onTriggerSync(() => triggerSyncAll());

  // 트레이 "설정 열기" → 설정 패널 표시
  window.electronAPI.onOpenSettings(() => {
    document.getElementById('settingsPanel').classList.add('show');
  });

  // 동기화 상태 메시지 (현재는 사용 안 하지만 향후 확장용)
  window.electronAPI.onSyncStatus((status) => {
    if (status.message) toast(status.message);
  });

  // 창이 숨겨질 때 패널들 정리
  // ?. 는 onWindowHidden 함수가 없으면 안 죽게 하는 안전장치
  // 단, 모달이 떠있으면 그대로 유지
  window.electronAPI.onWindowHidden?.(() => {
    const anyModalOpen =
      document.getElementById('eventModalBg').classList.contains('show') ||
      document.getElementById('ncModalBg').classList.contains('show') ||
      document.getElementById('gcalModalBg').classList.contains('show') ||
      document.getElementById('ncManageModalBg').classList.contains('show');
    if (anyModalOpen) return;

    document.getElementById('settingsPanel').classList.remove('show');
    hideContextMenu();
    hideDayPopover();
  });
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  ▼ 시작 (앱 부팅 시퀀스)                                            ║
// ║                                                                  ║
// ║  파일이 로드되면 즉시 실행되는 IIFE (즉시 실행 함수 표현식).           ║
// ║  화면이 보이기 전에 모든 데이터/설정/UI를 초기 상태로 맞춤.            ║
// ║                                                                  ║
// ║  순서:                                                             ║
// ║   1) 저장된 데이터 로드                                              ║
// ║   2) 잠금/투명도/폰트/레이아웃 적용 → 첫 렌더                         ║
// ║   3) 메모 렌더, 알람 스케줄                                          ║
// ║   4) 버전 표시, 알림 권한                                            ║
// ║   5) Google/NextCloud 인증 상태 확인                                 ║
// ║   6) 연결돼있으면 1.5~1.8초 후 첫 동기화 (UI 떠오른 뒤)               ║
// ║   7) 5분마다 자동 동기화 setInterval                                 ║
// ╚══════════════════════════════════════════════════════════════════╝

(async () => {
  // 1) 저장소에서 일정/메모/설정 로드
  await loadAll();

  // 2) state 값들을 화면에 반영
  await applyLock();    // 잠금 상태 → DOM + 메인 동기화
  applyOpacity();        // 투명도 → CSS 변수
  applyFontSize();       // 폰트 크기 → CSS 변수
  applyLayout();         // 레이아웃 → 그리드 종류 결정 + renderCalendar 호출

  // 3) 메모 렌더링 + 알람 예약
  renderMemos();
  scheduleAlarms();

  // 4) 버전 표시 (Electron이면)
  if (isElectron) {
    try {
      const v = await window.electronAPI.getAppVersion();
      document.getElementById('versionLabel').textContent = `v${v}`;
    } catch {}
  }

  // 5) 브라우저 모드면 알림 권한 요청
  // (Electron에서는 OS 알림이라 이거 필요없음)
  if (!isElectron && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // 6) Google + NextCloud 인증 상태 확인 (UI 반영)
  await refreshGoogleAuthStatus();
  await refreshNextcloudAuthStatus();

  // 7) 연결돼있으면 자동 첫 동기화 (조용히 = 토스트 없이)
  // 1.5초/1.8초 차이 둔 이유: 동시 호출 시 IPC 폭주 약간 분산
  if (state.googleAuthenticated) {
    setTimeout(() => syncFromGoogle({ silent: true }), 1500);
  }
  if (state.nextcloudAuthenticated) {
    setTimeout(() => syncFromNextcloud({ silent: true }), 1800);
  }

  // 🆕 8) 옵션A — 시작 시점에 "예전에 멀리 봤던" 범위도 백그라운드로 갱신
  //     기본 윈도우(±1주~8주)는 위 7)에서 정확히 동기화됨.
  //     그 외 영역은 단순 fetchRange (변경/삭제는 못 잡지만 새로 추가된 건 잡힘).
  //     기본 윈도우 동기화가 끝난 뒤 시작하도록 3초 지연.
  setTimeout(refreshExtendedRanges, 3000);

  // 9) 5분마다 자동 동기화 (기본 윈도우만)
  setInterval(() => {
    if (state.googleAuthenticated)    syncFromGoogle({ silent: true });
    if (state.nextcloudAuthenticated) syncFromNextcloud({ silent: true });
  }, 5 * 60 * 1000);
})();