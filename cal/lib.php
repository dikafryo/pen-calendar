<?php
declare(strict_types=1);

define('CAL_APP', true);

date_default_timezone_set('Asia/Seoul');

const DATA_DIR = __DIR__ . '/data';
const ADMIN_PASSWORD = 'elwlxjf';
const GOOGLE_SHEET_PUSH_URL = '';
const GOOGLE_SHEET_ID = '1fXlUHo_-AQ0McyKmPD8jpbaF97So1gr0WNHaJwyGJho';
const GOOGLE_SHEET_GID = '769698193';

function json_response(mixed $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

function read_input(): array
{
    $raw = file_get_contents('php://input') ?: '';
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function clean_actor(mixed $actor): string
{
    return mb_substr(trim((string) $actor), 0, 60);
}

function clean_hash(string $hash): string
{
    $hash = trim(rawurldecode($hash));
    $hash = preg_replace('/[^a-zA-Z0-9_\-가-힣]/u', '', $hash) ?: '';
    return mb_substr($hash, 0, 80);
}

// Raw hash candidate from the request, before alias resolution.
// Looks at ?doc=, a bare query string (?digital_future), and finally the
// URL path (/디지털미래교육과). Returns '' when nothing was specified.
function raw_query_hash(): string
{
    if (isset($_GET['doc'])) {
        return clean_hash((string) $_GET['doc']);
    }

    $query = (string) ($_SERVER['QUERY_STRING'] ?? '');
    parse_str($query, $parsed);
    foreach (['api', 'doc', 'month', 'year'] as $key) {
        unset($parsed[$key]);
    }

    if ($query !== '' && !str_contains($query, '=') && !str_contains($query, '&')) {
        return clean_hash($query);
    }

    foreach ($parsed as $key => $value) {
        if ($value === '' || $value === null) {
            return clean_hash((string) $key);
        }
    }

    // Path-based access: /<hash> or /<별칭> (nginx try_files routes it here)
    $path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    $segment = trim($path, '/');
    if ($segment !== '' && !str_contains($segment, '/')) {
        $candidate = clean_hash($segment);
        if ($candidate !== '' && $candidate !== 'indexphp' && $candidate !== 'admin') {
            return $candidate;
        }
    }

    return '';
}

function query_hash(): string
{
    $raw = raw_query_hash();
    return $raw === '' ? 'default' : resolve_hash($raw);
}

// Resolve a hash candidate to its canonical hash. A real calendar URL always
// wins; otherwise the candidate is matched against department names (meta.title),
// so /디지털미래교육과 resolves to the calendar titled "디지털미래교육과".
function resolve_hash(string $hash): string
{
    if ($hash === '' || is_dir(DATA_DIR . '/' . $hash)) {
        return $hash;
    }

    foreach (glob(DATA_DIR . '/*', GLOB_ONLYDIR) ?: [] as $dir) {
        $candidate = basename($dir);
        if ($candidate === '' || $candidate !== clean_hash($candidate)) {
            continue;
        }
        $meta = read_json_file($dir . '/meta.json', null);
        if (!is_array($meta)) {
            continue;
        }
        if (clean_hash((string) ($meta['title'] ?? '')) === $hash) {
            return $candidate;
        }
    }

    return $hash;
}

// The auto alias URL (cleaned department name) for a calendar, or '' if it
// equals the hash or the title is empty.
function alias_for_hash(string $hash): string
{
    $meta = read_json_file(meta_path($hash), null);
    $title = is_array($meta) ? clean_hash((string) ($meta['title'] ?? '')) : '';
    return ($title !== '' && $title !== $hash) ? $title : '';
}

// ── 간부일정 (aggregate / virtual calendar) ────────────────────────────────
// A read-only calendar that gathers, across every real department calendar,
// only the events that 교육감 / 부교육감 / 국장 attend. It stores nothing of its
// own; every read is computed live from the source calendars.
const AGGREGATE_HASH = 'boss_schedule';
const AGGREGATE_TITLE = '간부일정';
const AGGREGATE_TARGETS = ['교육감', '부교육감', '국장'];
// Calendars NOT treated as a source department (self + test/system folders).
const AGGREGATE_EXCLUDE = ['boss_schedule', 'default', '_backup'];

function is_aggregate_hash(string $hash): bool
{
    return $hash === AGGREGATE_HASH;
}

function aggregate_meta(): array
{
    return [
        'hash' => AGGREGATE_HASH,
        'title' => AGGREGATE_TITLE,
        'teams' => [],
        'readonly' => true,
        'updatedAt' => date(DATE_ATOM),
    ];
}

// Real department calendars to gather from: [hash => title].
function aggregate_source_dirs(): array
{
    $sources = [];
    foreach (glob(DATA_DIR . '/*', GLOB_ONLYDIR) ?: [] as $dir) {
        $hash = basename($dir);
        if ($hash === '' || $hash !== clean_hash($hash) || in_array($hash, AGGREGATE_EXCLUDE, true)) {
            continue;
        }
        $meta = read_json_file($dir . '/meta.json', null);
        if (!is_array($meta)) {
            continue; // only real calendars (with meta.json) count
        }
        $sources[$hash] = (string) ($meta['title'] ?? $hash);
    }
    return $sources;
}

// True when an event has at least one 간부 (교육감/부교육감/국장) among its targets.
function event_has_executive(array $event): bool
{
    $targets = $event['targets'] ?? [];
    return is_array($targets) && array_intersect(AGGREGATE_TARGETS, $targets) !== [];
}

// Tag a source event with its department for the aggregate view, and namespace
// its id so identical ids from different departments never collide.
function aggregate_decorate(array $event, string $srcHash, string $srcTitle): array
{
    $event['dept'] = $srcTitle;
    $event['deptHash'] = $srcHash;
    $event['id'] = $srcHash . '::' . (string) ($event['id'] ?? '');
    return $event;
}

// All executive events for a given month across every source department.
function aggregate_events(string $month): array
{
    $month = valid_month($month);
    $events = [];
    foreach (aggregate_source_dirs() as $hash => $title) {
        $monthEvents = read_json_file(DATA_DIR . '/' . $hash . '/' . $month . '.json', []);
        if (!is_array($monthEvents)) {
            continue;
        }
        foreach ($monthEvents as $event) {
            if (is_array($event) && event_has_executive($event)) {
                $events[] = aggregate_decorate($event, $hash, $title);
            }
        }
    }
    sort_events($events);
    return $events;
}

// Search across every source department, executive events only.
function aggregate_search(string $q, int $limit): array
{
    $results = [];
    foreach (aggregate_source_dirs() as $hash => $title) {
        foreach (glob(DATA_DIR . '/' . $hash . '/????-??.json') ?: [] as $path) {
            $monthEvents = read_json_file($path, []);
            if (!is_array($monthEvents)) {
                continue;
            }
            foreach ($monthEvents as $event) {
                if (!is_array($event) || !event_has_executive($event)) {
                    continue;
                }
                $haystack = mb_strtolower(implode(' ', array_filter([
                    (string) ($event['title'] ?? ''),
                    (string) ($event['place'] ?? ''),
                    (string) ($event['manager'] ?? ''),
                    (string) ($event['team'] ?? ''),
                    $title,
                ])));
                if (mb_strpos($haystack, $q) !== false) {
                    $results[] = aggregate_decorate($event, $hash, $title);
                }
            }
        }
    }
    sort_events($results);
    return array_slice($results, 0, $limit);
}

// Version history, newest first. Version names are date-based (v<YY>.<M>.<D>);
// multiple releases on the same day get a, b, c… suffixes.
// Add new releases to the TOP of this array.
function changelog(): array
{
    return [
        [
            'version' => 'v26.6.15',
            'date' => '2026-06-15',
            'changes' => [
                '“간부일정” 달력 추가 — /간부일정 또는 /?boss_schedule 로 접속.',
                '전 부서 일정 중 교육감·부교육감·국장이 참석하는 일정만 자동으로 모아서 보여줍니다(읽기 전용).',
                '일정마다 출처 부서명을 표시하고 부서별 색으로 구분.',
            ],
        ],
        [
            'version' => 'v26.6.14b',
            'date' => '2026-06-14',
            'changes' => [
                '버전 업데이트 기록(?) 기능 추가 — 검색 옆 ? 버튼으로 개선 내역을 볼 수 있습니다.',
            ],
        ],
        [
            'version' => 'v26.6.14a',
            'date' => '2026-06-14',
            'changes' => [
                '한글 부서명 주소 지원 — cal2.sw4u.kr/부서명 처럼 한글로도 접속할 수 있습니다.',
                '영문 주소(예: ?digital_future)도 기존대로 그대로 동작합니다.',
            ],
        ],
        [
            'version' => 'v26.6.8b',
            'date' => '2026-06-08',
            'changes' => [
                '목록보기에서도 이동 버튼(◀◀ ◀ 오늘 ▶ ▶▶)이 동작하도록 개선.',
                '우측 버튼(달력보기·목록보기·팀 필터·검색)을 한 줄로 가로 정렬.',
                '“스크롤하면 자동 로딩됩니다” 안내 문구 제거(안써도 직관적으로 알수있는 내용).',
            ],
        ],
        [
            'version' => 'v26.6.8a',
            'date' => '2026-06-08',
            'changes' => [
                '상단 제목을 “부서명(연·월)” 형식으로 한 줄에 통합 표시.',
                '이동 버튼을 ◀◀ ◀ 오늘 ▶ ▶▶ 순서로 가운데 배치.',
                '동작하지 않던 달력 아이콘(연월 선택)을 제거.',
            ],
        ],
        [
            'version' => 'v26.6.2',
            'date' => '2026-06-02',
            'changes' => [
                '부서별 달력 추가 개설 및 운영 안정화.',
            ],
        ],
        [
            'version' => 'v26.5.28',
            'date' => '2026-05-28',
            'changes' => [
                '부서 일정표 최초 출시.',
                '부서별(멀티테넌트) 달력 — 부서마다 독립된 일정을 운영.',
                '월간 보기 / 목록 보기 전환, 일정 등록·수정·삭제.',
                '팀 색상 구분, 참석 대상(교육감·부교육감·국장·과장) 표시.',
                '일정 검색, 부서 로고 업로드.',
                '구글 시트 / CSV 내보내기, 관리자 페이지.',
            ],
        ],
    ];
}

function doc_dir(string $hash): string
{
    $dir = DATA_DIR . '/' . $hash;
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        json_response(['error' => '데이터 디렉터리를 만들 수 없습니다.'], 500);
    }
    return $dir;
}

function valid_month(string $month): string
{
    if (!preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $month)) {
        return date('Y-m');
    }
    return $month;
}

function read_json_file(string $path, mixed $default): mixed
{
    if (!is_file($path)) {
        return $default;
    }
    $fp = fopen($path, 'rb');
    if (!$fp) {
        return $default;
    }
    flock($fp, LOCK_SH);
    $raw = stream_get_contents($fp) ?: '';
    flock($fp, LOCK_UN);
    fclose($fp);

    $data = json_decode($raw, true);
    return $data === null ? $default : $data;
}

function write_json_file(string $path, mixed $data): void
{
    $tmp = $path . '.tmp';
    $fp = fopen($tmp, 'wb');
    if (!$fp) {
        json_response(['error' => '데이터 파일을 쓸 수 없습니다.'], 500);
    }
    flock($fp, LOCK_EX);
    fwrite($fp, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    rename($tmp, $path);
}

function meta_path(string $hash): string
{
    return doc_dir($hash) . '/meta.json';
}

function month_path(string $hash, string $month): string
{
    return doc_dir($hash) . '/' . $month . '.json';
}

function audit_log_path(string $hash): string
{
    return doc_dir($hash) . '/audit.log';
}

function append_audit_log(string $hash, string $action, string $actor, ?array $event, ?array $before = null): void
{
    $entry = [
        'time' => date(DATE_ATOM),
        'ip' => (string) ($_SERVER['HTTP_X_REAL_IP'] ?? $_SERVER['REMOTE_ADDR'] ?? ''),
        'action' => $action,
        'actor' => $actor,
        'eventId' => (string) ($event['id'] ?? $before['id'] ?? ''),
        'date' => (string) ($event['date'] ?? $before['date'] ?? ''),
        'title' => (string) ($event['title'] ?? $before['title'] ?? ''),
        'event' => $event,
        'before' => $before,
    ];
    file_put_contents(
        audit_log_path($hash),
        json_encode($entry, JSON_UNESCAPED_UNICODE) . PHP_EOL,
        FILE_APPEND | LOCK_EX
    );
}

function default_meta(string $hash): array
{
    return [
        'hash' => $hash,
        'title' => '부서 일정표',
        'teams' => ['총무팀', '기획팀', '운영팀'],
        'updatedAt' => date(DATE_ATOM),
    ];
}

function normalize_time_value(mixed $value): string
{
    $time = trim((string) $value);
    if ($time === '') {
        return '';
    }

    if (preg_match('/^([01]?\d|2[0-3]):?([0-5]\d)$/', $time, $matches)) {
        return sprintf('%02d:%02d', (int) $matches[1], (int) $matches[2]);
    }

    if (preg_match('/^([01]?\d|2[0-3])$/', $time, $matches)) {
        return sprintf('%02d:00', (int) $matches[1]);
    }

    return '';
}

function normalize_event(array $event): array
{
    $id = trim((string) ($event['id'] ?? ''));
    if ($id === '') {
        $id = bin2hex(random_bytes(8));
    }

    $date = (string) ($event['date'] ?? date('Y-m-d'));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        $date = date('Y-m-d');
    }

    $targets = $event['targets'] ?? [];
    $allowedTargets = ['교육감', '부교육감', '국장', '과장'];
    $targets = array_values(array_intersect($allowedTargets, is_array($targets) ? $targets : []));

    return [
        'id' => $id,
        'date' => $date,
        'start' => normalize_time_value($event['start'] ?? ''),
        'end' => normalize_time_value($event['end'] ?? ''),
        'title' => mb_substr(trim((string) ($event['title'] ?? '')), 0, 120),
        'place' => mb_substr(trim((string) ($event['place'] ?? '')), 0, 120),
        'targets' => $targets,
        'team' => mb_substr(trim((string) ($event['team'] ?? '')), 0, 80),
        'manager' => mb_substr(trim((string) ($event['manager'] ?? '')), 0, 60),
        'modifiedBy' => mb_substr(trim((string) ($event['modifiedBy'] ?? '')), 0, 60),
        'updatedAt' => date(DATE_ATOM),
    ];
}

function sort_events(array &$events): void
{
    usort($events, static function (array $a, array $b): int {
        return [$a['date'] ?? '', $a['start'] ?? '', $a['end'] ?? '', $a['title'] ?? '']
            <=> [$b['date'] ?? '', $b['start'] ?? '', $b['end'] ?? '', $b['title'] ?? ''];
    });
}

function read_all_events(string $hash): array
{
    $dir = doc_dir($hash);
    $events = [];
    foreach (glob($dir . '/????-??.json') ?: [] as $path) {
        $monthEvents = read_json_file($path, []);
        if (!is_array($monthEvents)) {
            continue;
        }
        foreach ($monthEvents as $event) {
            if (is_array($event)) {
                $events[] = $event;
            }
        }
    }
    sort_events($events);
    return $events;
}

function sheet_rows(string $hash, array $meta, array $events): array
{
    $rows = [[
        '문서해시',
        '일정표이름',
        '날짜',
        '시작',
        '종료',
        '행사명',
        '장소',
        '참석대상',
        '팀',
        '담당자',
        '수정자',
        '수정일',
        '일정ID',
    ]];

    foreach ($events as $event) {
        $targets = $event['targets'] ?? [];
        $rows[] = [
            $hash,
            (string) ($meta['title'] ?? ''),
            (string) ($event['date'] ?? ''),
            (string) ($event['start'] ?? ''),
            (string) ($event['end'] ?? ''),
            (string) ($event['title'] ?? ''),
            (string) ($event['place'] ?? ''),
            implode(', ', is_array($targets) ? $targets : []),
            (string) ($event['team'] ?? ''),
            (string) ($event['manager'] ?? ''),
            (string) ($event['modifiedBy'] ?? ''),
            (string) ($event['updatedAt'] ?? ''),
            (string) ($event['id'] ?? ''),
        ];
    }

    return $rows;
}

function rows_to_csv(array $rows): string
{
    $fp = fopen('php://temp', 'r+');
    if (!$fp) {
        return '';
    }
    fwrite($fp, "\xEF\xBB\xBF");
    foreach ($rows as $row) {
        fputcsv($fp, $row);
    }
    rewind($fp);
    $csv = stream_get_contents($fp) ?: '';
    fclose($fp);
    return $csv;
}

function post_json(string $url, array $payload): array
{
    $body = json_encode($payload, JSON_UNESCAPED_UNICODE);
    if ($body === false) {
        return ['ok' => false, 'error' => '전송 데이터를 만들 수 없습니다.'];
    }

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json; charset=utf-8'],
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20,
        ]);
        $response = curl_exec($ch);
        $error = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return [
            'ok' => $error === '' && $status >= 200 && $status < 300,
            'status' => $status,
            'response' => (string) $response,
            'error' => $error,
        ];
    }

    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json; charset=utf-8\r\n",
            'content' => $body,
            'timeout' => 20,
            'ignore_errors' => true,
        ],
    ]);
    $response = file_get_contents($url, false, $context);
    $status = 0;
    foreach (($http_response_header ?? []) as $header) {
        if (preg_match('/^HTTP\/\S+\s+(\d+)/', $header, $matches)) {
            $status = (int) $matches[1];
            break;
        }
    }
    return [
        'ok' => $response !== false && $status >= 200 && $status < 300,
        'status' => $status,
        'response' => (string) $response,
        'error' => $response === false ? '전송 요청에 실패했습니다.' : '',
    ];
}

function h(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}

function doc_exists(string $hash): bool
{
    if ($hash === '') {
        return false;
    }
    $dir = DATA_DIR . '/' . $hash;
    return is_dir($dir) && (glob($dir . '/*.json') ?: []) !== [];
}

/**
 * 존재하지 않는 달력을 첫 접속 시 자동 생성.
 * 기관/학교 해시를 그대로 제목으로 사용하며, 생성 후 바로 사용 가능.
 */
function auto_create_doc(string $hash): void
{
    if (doc_exists($hash)) {
        return;
    }
    $meta = [
        'hash'      => $hash,
        'title'     => $hash,   // 기관명 또는 기관명_부서명 이 제목. 관리자가 나중에 변경 가능.
        'teams'     => [],
        'updatedAt' => date(DATE_ATOM),
    ];
    write_json_file(meta_path($hash), $meta);
}

function is_admin_path(): bool
{
    $path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    return $path === '/admin' || str_starts_with($path, '/admin/');
}
