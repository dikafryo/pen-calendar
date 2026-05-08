# HANDOFF — neisme calendar v26.5.8n

> **목적**: 컨텍스트가 다 찬 세션을 정리하고 다음 세션이 빠르게 이어가기 위한 시드 문서.
> 이 문서 + 사용자가 같은 메시지에 업로드한 실제 소스파일 묶음 (또는 git 클론) = 다음 세션 시작점.

---

## §0 다음 세션 Claude 에게 (Read me first)

새 세션이 시작되면 너는 이 문서를 먼저 읽고, 사용자가 같은 메시지(또는 바로 다음 메시지)에 업로드한 소스 또는 git 작업 폴더를 받게 된다.

### 환경 분기

이 문서는 **Claude Code (CLI)** 와 **claude.ai 웹 환경** 양쪽에서 쓰일 수 있다.

- **Claude Code (CLI, 권장)**: 작업 폴더는 `C:\developer\neisme-calendar` (Windows). Edit/Write 툴로 파일 그 자리에서 수정 → 사용자가 git diff 로 검토. `/mnt/...` 경로 / `present_files` 안 씀. 이 환경에선 영구 가이드 `CLAUDE.md` 가 매 세션 자동 로드되니 거기 적힌 컨벤션도 따른다.
- **claude.ai 웹 환경**: 사용자가 소스파일 업로드 → `/mnt/project/` 또는 `/mnt/user-data/uploads/`. 작업은 `/home/claude/work/` 에서 후 `/mnt/user-data/outputs/` 로 복사 → `present_files` 로 전달.

### 너가 처음에 할 일

1. **§1 현재 상태**, **§2 파일 구조**, **§3 최근 변경 요약** 을 흡수
2. 사용자가 업로드한 소스 / git 작업 폴더 확인
3. 사용자의 첫 요청이 오면, 필요한 파일만 부분 조회하면서 작업 (전체 파일 한꺼번에 읽지 말 것 — app.js 만 4200+ 줄)
4. 코드 변경 시 항상 **버전 bump** 동반 (`package.json` + lockfile 의 version 필드도 같이)

### 너가 모호한 시점에 사용자에게 짚어야 할 것

- 변경 폭이 큰 작업(여러 모듈, 새 기능 추가)을 시작하기 전에 1차 안 제시 후 동의 받기
- 사용자가 의도를 모호하게 적었을 때 가장 그럴듯한 해석 1~2개 짚고 진행
- 컨텍스트가 4~5개 버전 묶음 마무리 / 큰 파일 슬라이스 누적되는 시점에 핸드오프 만들 시점이라고 사용자에게 알리기

### 절대 하지 말 것

- 사용자 store 데이터를 깨뜨릴 수 있는 마이그레이션을 silent 로 추가 (반드시 사용자 동의 + console 로그)
- `state.layout`, `state.events` 같은 핵심 state 의 schema 를 사전 합의 없이 변경
- 핵심 ID 형식 (NextCloud `nc_<hash>_<uid>` / 분리 인스턴스 `<masterId>@<originalStart>`) 변경
- RRULE 모델의 `byday` (MONTHLY) ↔ `bydays` (WEEKLY) 별도 필드 컨벤션 무너뜨리지 않기 (8k 결정)

---

## §1 현재 상태

- **버전**: `v26.5.8n` (직전 시리즈: 8j → 8k → 8l → 8m → 8n)
- **플랫폼**: Electron 33 데스크톱 캘린더 위젯 (Windows 주 타깃, macOS/Linux 보조)
- **저장**: `electron-store` (localStorage 폴백).
  키: `cal_events_v4`, `cal_memos_v4`, `cal_settings_v4`, `cal_synced_range_v1`
- **외부 동기화**: Google Calendar / Google Tasks / NextCloud CalDAV
- **레이아웃 모드**: `'uniform'` (균일) | `'split'` (주말 압축) | `'week'` (주간 일정)

---

## §2 파일 디렉토리 구조

```
neisme-calendar/
├── google-config.json          # Google OAuth 클라이언트 시크릿 (gitignore)
├── LICENSE
├── README.md
├── CLAUDE.md                   # ★ Claude Code 영구 가이드 (매 세션 자동 로드)
├── HANDOFF-v26_5_8n.md         # ★ 이 문서 (gitignore 권장)
├── package.json                # ★ 버전 표시 — 변경 시 반드시 bump
├── package-lock.json           # ★ optionalDependencies 제거 (8m) 후로 stale 항목 정리됨
├── main.js                     # Electron 메인 프로세스
├── preload.js                  # contextBridge 로 노출되는 electronAPI
├── renderer/
│   ├── index.html              # 단일 페이지 UI (모달, 설정 패널 등 모두 여기)
│   ├── styles.css              # 복수형 컨벤션
│   └── app.js                  # 렌더러 본체 (~4200 라인)
└── sync/
    ├── google-auth.js
    ├── google-calendar.js
    ├── google-tasks.js
    ├── nextcloud-auth.js
    └── nextcloud-calendar.js
```

### 파일별 책임 요약

| 파일 | 핵심 책임 |
|---|---|
| `main.js` | 윈도우 생성, 트레이, IPC 핸들러, 잠금 상태, alarm 스케줄링, 설정 저장 |
| `preload.js` | `window.electronAPI` 의 모든 메서드 정의 (메인↔렌더러 다리) |
| `renderer/app.js` | UI 상태(`state`), 캘린더 렌더링, 일정 CRUD, 반복 일정 로직, 동기화 트리거 |
| `renderer/index.html` | 캘린더 그리드 / 모달 / 설정 패널 마크업 |
| `renderer/styles.css` | 레이아웃 그리드, 모달, 알람 칩, 요일 토글 등 |
| `sync/*.js` | 외부 동기화 (메인 프로세스에서 import 해 IPC 로 노출) |
| `CLAUDE.md` | Claude Code 가 매 세션 자동 로드하는 영구 가이드 (아키텍처/컨벤션 — 변경 시 같이 갱신) |

### 모듈 import 경로

- `main.js` → `require('./sync/google-auth')`, `require('./sync/nextcloud-calendar')` 등
- `renderer/app.js` 안에서는 외부 sync 직접 import 불가, 항상 `window.electronAPI` 경유

---

## §3 v26.5.8k ~ v26.5.8n 변경 요약

| 버전 | 핵심 변경 | 변경 파일 |
|---|---|---|
| **8k** | (1) 🆕 **WEEKLY+BYDAY 다중 토큰** — "매주 화·목" 같은 복수 요일 반복 가능<br>(2) RRULE 모델: 별도 필드 `bydays: number[]` 추가 (MONTHLY 의 `byday: {ordinal,dow}` 와 분리)<br>(3) `expandRruleDates` WEEKLY+bydays 전용 분기 — anchor=마스터 시작일, INTERVAL 주마다 점프, 한 7일 윈도우 안에서 days 매칭, 결과 정렬<br>(4) 시작일 요일 자동 포함 (시작일이 곧 첫 발생 보장)<br>(5) 모달에 요일 토글 7개 row (`#evRecurrenceWeeklyDays`), 시작일 요일은 active+disabled<br>(6) 새 헬퍼 4개: `getStartDow`, `setWeekdayToggles`, `syncWeeklyStartDay`, `getActiveWeeklyDays`<br>(7) `describeRrule` 한국어 ("매주 월·수·금요일")<br>(8) NextCloud sync 변경 불필요 (ICAL.Recur 가 BYDAY 다중 토큰 자연 통과, normalizeRruleFor/FromIcal 은 UNTIL 만 손댐) | `renderer/app.js`, `renderer/index.html`, `renderer/styles.css`, `package.json`, `CLAUDE.md` |
| **8l** | (1) `saveRecurrenceEdit` future 분기에 분리 인스턴스 cutoff 정리 추가 — `deleteEvent` future 분기와 동일한 filter<br>(2) 옛 마스터에 묶인 `originalStart >= ctx.instanceDate` 자식 제거 (orphan 방지)<br>(3) `masterRemoved=true` 케이스에서도 동일 filter (8f loadAll 마이그레이션 의존 대신 같은 세션 정리)<br>(4) NextCloud 는 마스터 push 가 ICS 통째 PUT 이므로 자식 누락 자동 반영 | `renderer/app.js`, `package.json` |
| **8m** | (1) `node-window-manager` optionalDependencies 제거 (실 미사용 — grep 검증)<br>(2) `package-lock.json` 동기화 — 종속물 `extract-file-icon`, `node-addon-api`, `node-gyp-build` 모두 정리<br>(3) lockfile 의 stale `26.5.8b` version 필드도 동기화<br>※ `node_modules` 디렉토리는 안 건드림 — 다음번 `npm install` 또는 `npm prune` 시 정리됨 | `package.json`, `package-lock.json` |
| **8n** | (1) `saveEvent` 일반 편집: 마스터 → 일반 변환 (RRULE 비움) 시 자식 분리 인스턴스 모두 제거 (orphan 방지). `wasMaster` 플래그로 식별<br>(2) `saveEvent` 일반 편집: 마스터 `source` 변경 시 자식의 source/메타 (googleId/etag/googleCalendarId/ncUid/ncUrl/ncEtag/ncCalendarUrl) 도 동기화 — v26.5.8b "자식 source 는 마스터 따라감" 컨벤션 일관성<br>(3) `saveRecurrenceEdit` 'all' scope: RRULE 비움 시 자식 정리<br>(4) 자식 filter 후 `idx` / `masterIdx` stale 위험 → `findIndex` 로 재계산 후 갱신<br>(5) NC push 의 `detachedInstances` 응답으로 새 source 메타가 자식들에게 자동 전파 | `renderer/app.js`, `package.json` |

### 8n 시점 누적 변경 파일

- `renderer/app.js`
- `renderer/index.html`
- `renderer/styles.css`
- `package.json`
- `package-lock.json`
- `CLAUDE.md`

---

## §4 알려진 이슈 / 다음 작업 후보

우선순위 순:

1. ⭐⭐⭐ **실기기 통합 검증 대기** — 8f~8n 누적분 모두 사용자 환경(Windows)에서 검증 받지 못한 상태. 회귀 모니터링:
   - 8k WEEKLY+BYDAY: NextCloud 양방향 round-trip (시작일 요일 자동 포함된 채로 push → fetch 시 BYDAY 보존되는지). COUNT 도달 시 한 주 안에서도 정확히 컷오프 되는지. INTERVAL>=2 + 다중 요일 점프 정확한지.
   - 8l: future scope 편집/삭제 시 NC 자식들도 ICS PUT 으로 정확히 정리되는지
   - 8m: 다음 `npm install` 또는 `npm prune` 시 `node_modules` 의 옛 디렉토리 (`extract-file-icon`, `node-window-manager` 등) 가 잘 정리되는지
   - 8n: source 변경 시 자식 메타 정리 + 새 source push 흐름이 정합한지. 마스터 → 일반 변환 후 자식 모두 사라지는지.
2. ⭐⭐ **MONTHLY 다중 BYDAY** — 8j 가 단일 토큰만. "1MO,3MO" (매월 첫째·셋째 월요일) 같은 패턴 미지원. 확장 시:
   - `parseRrule` MONTHLY 분기에서 다중 토큰 인식 (현재 `tokens.length === 1` 가드 풀기)
   - `r.byday` 를 `byday: [{ordinal,dow}, ...]` 또는 별도 `bydays_monthly` 필드로 확장 — 8k 에서 정한 `byday` (MONTHLY 단일) ↔ `bydays` (WEEKLY 다중) 분리 컨벤션과 어떻게 정합 맞출지 설계 필요
   - `expandRruleDates` MONTHLY 분기에 days 루프 추가 (이미 있는 `findNthWeekdayInMonth` 재사용)
   - 모달 UI 가 다중 ordinal+요일을 어떻게 노출할지 디자인 (현재 단일 `byday/bydaylast` select 만 있음)
3. ⭐ **WEEKLY+BYDAY 옛 시작일 처리** — 사용자가 시작일 변경 시 옛 시작일이 active 그대로 남음 (8k 보수적 설계, `syncWeeklyStartDay` 가 옛 시작일의 disabled 만 풀어주고 active 는 안 건드림). 이게 의도냐 vs 자동 정리냐 — 사용자 피드백 받아 결정.
4. ⭐ **NextCloud 마스터 `ncCalendarUrl` 변경** — 마스터를 다른 NC 캘린더로 이동하면 옛 캘린더의 ICS 가 그대로 남음. 현재 코드는 `if (old.source !== data.source)` 일 때만 `deleteNextcloudEvent` 호출. source 가 'nextcloud' 그대로면서 ncCalendarUrl 만 바뀐 케이스 미처리. `saveEvent` 의 source 변경 분기와 같은 위치에 ncCalendarUrl 변경 분기 추가 필요.
5. ⭐ **week (주간 일정) 모드 디자인 튜닝** — 사용자 피드백 받은 후:
   - 1주 옵션 토글 추가 여부
   - 첫째 주 위치 ("이번 주가 첫째 주" vs "지난 주 + 이번 주")
   - 셀당 일정 표시 개수 (`maxEvents` week 분기, 현재 10)
6. (8m 후속) **`node-schedule` 사용처 검증** — `package.json dependencies` 에 있지만 실제 require 여부 미확인. 미사용이면 8m 같은 패턴으로 정리.

---

## §5 다음 핸드오프 작성 가이드

### 트리거 (언제 만드나)

- 4~5개 버전 묶음 마무리 시 (8k~8n 같은 작업 시리즈 종료)
- 큰 파일 슬라이스 누적되어 새 세션이 더 가벼운 시점
- 사용자가 명시적으로 요청

### 포함할 것

1. **§0 다음 세션 안내** — Read me first + 환경 분기 (CLI vs 웹)
2. **§1 현재 상태** — 버전, 플랫폼, 저장 키
3. **§2 디렉토리 구조** — 사용자 환경 기준 트리 + 파일별 책임
4. **§3 변경 요약** — 직전 N개 버전, 표 형식, 변경 파일까지
5. **§4 알려진 이슈 / 다음 작업 후보** — 우선순위 매겨서, 완료된 항목은 제거
6. **§5 핸드오프 작성 가이드** — 이 섹션 자체 (다음 세션 Claude 가 또 핸드오프 만들 때 참고)
7. **§6 코드 컨벤션** — RRULE 지원 범위 같은 schema 변경 시 갱신

### 제외할 것

- **인라인 소스 코드** — 사용자가 다음 세션 시작에 실제 소스 또는 git 작업 폴더를 줌. 핸드오프 문서는 메타정보만.
- 너무 자세한 코드 위치 (line number) — 코드 변경 시 stale. 함수 이름 / 의도 중심으로.
- 사용자에게 이미 명확한 컨벤션 (한국어 주석 등)

### 작성 후 흐름

- **CLI 환경**: `C:\developer\neisme-calendar\HANDOFF-v26_5_8X.md` 로 저장. 사용자에게 위치만 알려주면 다음 세션에서 직접 읽음.
- **웹 환경**: `/mnt/user-data/outputs/HANDOFF-v26_5_8X.md` 로 저장 → `present_files` 로 전달.
- 전 핸드오프 (예: `HANDOFF-v26_5_8j.md`) 는 사용자 결정 — 보존하든 삭제하든. `.gitignore` 에 패턴 (`HANDOFF-v*.md`) 추가하면 깔끔.

---

## §6 코드 컨벤션 (참고)

- **언어**: 한국어 주석, 영어 식별자
- **버전 표기**: 코드 안 신규 변경엔 `🆕 v26.5.8X` 주석 + 의도 설명
- **에러 처리**: 동기화 실패는 toast + console.log, 앱 죽이지 않음
- **ID 형식**:
  - 로컬: `ev_<랜덤>` 또는 `e<timestamp><random>`
  - Google: `g_<calendarId>_<eventId>` (gcal 표시 안 함)
  - NextCloud 마스터: `nc_<calendarUrlHash>_<uid>`
  - 분리 인스턴스: 자체 uid (랜덤), `recurrenceId` 가 마스터 id 가리킴
  - 가상 인스턴스: `<masterId>:<dateStr>` (런타임 only, 저장 안 됨)
- **반복 일정 모델**:
  - 마스터: `recurrence: 'FREQ=...'`, `exdates: ['YYYY-MM-DD', ...]`
  - 분리 인스턴스: `recurrenceId: <masterId>`, `originalStart: 'YYYY-MM-DD'`, `originalMasterTime: 'HH:MM' | ''`
  - 가상 인스턴스: 런타임에 `expandRecurrencesForRange` 가 `{...master, _virtualOf, _instanceDate}` 로 생성
- **자식 source 컨벤션 (v26.5.8b)**: 분리 인스턴스 (자식) 의 source 는 항상 마스터 따라감. 8n 에서 source 변경 시 자식 메타까지 정리하도록 보완됨.
- **RRULE 지원 범위 (8n 기준)**:
  - `FREQ`: DAILY / WEEKLY / MONTHLY / YEARLY
  - `INTERVAL`: 1~99
  - `COUNT`: 1~999
  - `UNTIL`: YYYY-MM-DD (app.js 내부) ↔ YYYYMMDD[THHMMSSZ] (ICAL 표준, `normalizeRruleFor/FromIcal` 가 변환)
  - `BYDAY`:
    - **MONTHLY 한정 단일 ordinal+요일**: `r.byday = {ordinal, dow}` — 예: `3TH`, `-1FR`
    - **WEEKLY 다중 요일 (8k)**: `r.bydays = number[]` (정렬, 중복 제거) — 예: `MO,WE,FR` → `[1,3,5]`. 시작일 요일 자동 포함.
    - 두 필드는 별도. MONTHLY+다중 토큰 / WEEKLY+ordinal 혼재는 미지원 (parser 단계에서 무시).
  - `BYMONTHDAY`, `BYSETPOS`, `BYMONTH` 등 미지원
- **Sync 영향 일반 규칙**:
  - Google: `recurrence` 자체 push 안 함 (인스턴스로만 push). RRULE 변경은 Google 에 영향 없음.
  - NextCloud: `pushNcMasterWithInstances` 가 마스터 + detached 자식들 묶어 ICS 통째 PUT. `normalizeRruleForIcal/FromIcal` 가 UNTIL 만 손대고 BYDAY 는 ICAL.Recur 가 자연 통과.

---

**작성**: v26.5.8n 종료 시점 (2026-05-08, Asia/Seoul)
**다음 세션 시작**: 이 문서 + 실제 소스 / git 작업 폴더 → "이 컨텍스트로 작업 이어가자" 트리거 다음에 작업 진행
