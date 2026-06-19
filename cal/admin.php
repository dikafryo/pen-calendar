<?php
declare(strict_types=1);

if (!defined('CAL_APP')) {
    http_response_code(404);
    exit;
}

function admin_documents(): array
{
    $rows = [];
    foreach (glob(DATA_DIR . '/*', GLOB_ONLYDIR) ?: [] as $dir) {
        $hash = basename($dir);
        if ($hash === '' || $hash !== clean_hash($hash)) {
            continue;
        }

        $metaPath = $dir . '/meta.json';
        $jsonFiles = glob($dir . '/*.json') ?: [];
        if ($jsonFiles === []) {
            continue;
        }

        $meta = read_json_file($metaPath, default_meta($hash));
        $meta = is_array($meta) ? $meta : default_meta($hash);

        $eventCount = 0;
        $monthCount = 0;
        $latestMtime = is_file($metaPath) ? (int) filemtime($metaPath) : (int) filemtime($dir);
        foreach ($jsonFiles as $file) {
            if (basename($file) === 'meta.json') {
                continue;
            }
            $events = read_json_file($file, []);
            if (is_array($events)) {
                $eventCount += count($events);
            }
            $monthCount++;
            $latestMtime = max($latestMtime, (int) filemtime($file));
        }

        $rows[] = [
            'hash' => $hash,
            'title' => (string) ($meta['title'] ?? '부서 일정표'),
            'teams' => is_array($meta['teams'] ?? null) ? $meta['teams'] : [],
            'alias' => alias_for_hash($hash),
            'updatedAt' => (string) ($meta['updatedAt'] ?? ''),
            'eventCount' => $eventCount,
            'monthCount' => $monthCount,
            'mtime' => $latestMtime,
        ];
    }

    usort($rows, static fn(array $a, array $b): int => ($b['mtime'] ?? 0) <=> ($a['mtime'] ?? 0));
    return $rows;
}

function admin_delete_doc(string $hash): bool
{
    $dir = DATA_DIR . '/' . $hash;
    if (!is_dir($dir)) {
        return false;
    }
    foreach (glob($dir . '/*') ?: [] as $file) {
        if (is_file($file)) {
            unlink($file);
        }
    }
    return rmdir($dir);
}

function ensure_admin_document(string $hash): void
{
    doc_dir($hash);
    $path = meta_path($hash);
    if (!is_file($path)) {
        write_json_file($path, default_meta($hash));
    }
}

function admin_clean_teams(string $teamsText): array
{
    return array_values(array_unique(array_filter(array_map(
        static fn($team) => mb_substr(trim($team), 0, 80),
        preg_split('/\R/u', $teamsText) ?: []
    ))));
}

function save_admin_meta(string $hash, string $title, string $teamsText): void
{
    $path = meta_path($hash);
    $meta = read_json_file($path, default_meta($hash));
    $meta = is_array($meta) ? $meta : default_meta($hash);
    $teams = admin_clean_teams($teamsText);

    write_json_file($path, [
        'hash' => $hash,
        'title' => mb_substr(trim($title) !== '' ? trim($title) : (string) ($meta['title'] ?? '부서 일정표'), 0, 80),
        'teams' => $teams,
        'updatedAt' => date(DATE_ATOM),
    ]);
}

function admin_valid_month(string $month): string
{
    return preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $month) ? $month : date('Y-m');
}

function admin_month_range(string $fromMonth, string $toMonth): array
{
    $from = admin_valid_month($fromMonth);
    $to = admin_valid_month($toMonth);
    if ($from > $to) {
        [$from, $to] = [$to, $from];
    }
    $months = [];
    $cursor = new DateTimeImmutable($from . '-01');
    $last = new DateTimeImmutable($to . '-01');
    while ($cursor <= $last) {
        $months[] = $cursor->format('Y-m');
        $cursor = $cursor->modify('+1 month');
    }
    return $months;
}

function admin_download_csv(string $hash, string $fromMonth, string $toMonth): never
{
    $safeHash = clean_hash($hash);
    if ($safeHash === '') {
        json_response(['error' => '달력 URL이 올바르지 않습니다.'], 400);
    }
    $meta = read_json_file(meta_path($safeHash), default_meta($safeHash));
    $meta = is_array($meta) ? $meta : default_meta($safeHash);
    $months = admin_month_range($fromMonth, $toMonth);

    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $safeHash . '-' . $months[0] . '-to-' . end($months) . '.csv"');

    $out = fopen('php://output', 'wb');
    if (!$out) {
        exit;
    }
    fwrite($out, "\xEF\xBB\xBF");
    fputcsv($out, ['달력URL', '부서명', '날짜', '시작', '종료', '행사명', '장소', '참석대상', '팀', '담당자', '수정자', '수정일', '일정ID']);

    foreach ($months as $month) {
        $events = read_json_file(month_path($safeHash, $month), []);
        if (!is_array($events)) {
            continue;
        }
        foreach ($events as $event) {
            if (!is_array($event)) {
                continue;
            }
            $targets = $event['targets'] ?? [];
            fputcsv($out, [
                $safeHash,
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
            ]);
        }
    }
    fclose($out);
    exit;
}

// ── admin.html 전용 JSON API ─────────────────────────────────────────
// Authorization: Bearer <password> 헤더로 인증. 세션 불필요.

function admin_check_auth(): void
{
    $auth = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? '');
    $token = str_starts_with($auth, 'Bearer ') ? substr($auth, 7) : '';
    if (!hash_equals(ADMIN_PASSWORD, $token)) {
        json_response(['error' => '인증이 필요합니다.'], 401);
    }
}

function handle_admin_api(): void
{
    $act = (string) ($_GET['api'] ?? '');
    if ($act === '') return;

    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Headers: Authorization, Content-Type');
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

    admin_check_auth();

    switch ($act) {
        case 'list':
            json_response(admin_documents());

        case 'create':
            $body = read_input();
            $hash = clean_hash((string) ($body['hash'] ?? ''));
            if ($hash === '') json_response(['error' => '달력 URL이 필요합니다.'], 400);
            if (is_aggregate_hash($hash)) json_response(['error' => '예약된 해시입니다.'], 400);
            ensure_admin_document($hash);
            $title = (string) ($body['title'] ?? '');
            $teams = is_array($body['teams'] ?? null) ? implode("\n", $body['teams']) : (string) ($body['teams'] ?? '');
            if (trim($title) !== '' || trim($teams) !== '') {
                save_admin_meta($hash, $title, $teams);
            }
            json_response(['ok' => true, 'hash' => $hash]);

        case 'update':
            $hash = clean_hash((string) ($_GET['doc'] ?? ''));
            if ($hash === '') json_response(['error' => '달력 URL이 필요합니다.'], 400);
            if (is_aggregate_hash($hash)) json_response(['error' => '간부일정은 수정할 수 없습니다.'], 403);
            $body = read_input();
            $title = (string) ($body['title'] ?? '');
            $teams = is_array($body['teams'] ?? null) ? implode("\n", $body['teams']) : (string) ($body['teams'] ?? '');
            ensure_admin_document($hash);
            save_admin_meta($hash, $title, $teams);
            json_response(['ok' => true]);

        case 'delete':
            $hash = clean_hash((string) ($_GET['doc'] ?? ''));
            if ($hash === '') json_response(['error' => '달력 URL이 필요합니다.'], 400);
            if (is_aggregate_hash($hash)) json_response(['error' => '간부일정은 삭제할 수 없습니다.'], 403);
            $dir = DATA_DIR . '/' . $hash;
            $eventCount = 0;
            foreach (glob($dir . '/????-??.json') ?: [] as $f) {
                $ev = read_json_file($f, []);
                if (is_array($ev)) $eventCount += count($ev);
            }
            if ($eventCount > 0) json_response(['error' => '일정이 있는 달력은 삭제할 수 없습니다.'], 400);
            admin_delete_doc($hash);
            json_response(['ok' => true]);

        case 'page':
            // admin.html 서비스 (admin 경로 페이지 요청 시)
            header('Content-Type: text/html; charset=utf-8');
            readfile(__DIR__ . '/admin.html');
            exit;

        default:
            json_response(['error' => '알 수 없는 API입니다.'], 404);
    }
}

function render_admin_page(?string $error = null): never
{
    // JSON API 요청이면 admin.html 프론트엔드를 위한 API로 처리
    if (isset($_GET['api'])) {
        handle_admin_api();
    }

    // 페이지 요청(api 없음)이면 admin.html 직접 서비스
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && !isset($_POST['password']) && !isset($_GET['logout'])) {
        header('Content-Type: text/html; charset=utf-8');
        readfile(__DIR__ . '/admin.html');
        exit;
    }

    if (session_status() !== PHP_SESSION_ACTIVE) {
        session_start();
    }

    if (isset($_GET['logout'])) {
        $_SESSION = [];
        session_destroy();
        header('Location: /admin');
        exit;
    }

    $loggedIn = ($_SESSION['cal_admin'] ?? false) === true;

    if ($_SERVER['REQUEST_METHOD'] === 'POST' && $loggedIn && ($_POST['action'] ?? '') === 'create_doc') {
        $newHash = clean_hash((string) ($_POST['doc_hash'] ?? ''));
        if ($newHash === '') {
            $error = '달력 URL을 입력하세요.';
        } else {
            ensure_admin_document($newHash);
            $title = (string) ($_POST['title'] ?? '');
            $teams = (string) ($_POST['teams'] ?? '');
            if (trim($title) !== '' || trim($teams) !== '') {
                save_admin_meta($newHash, $title, $teams);
            }
            header('Location: /?' . rawurlencode($newHash));
            exit;
        }
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST' && $loggedIn && ($_POST['action'] ?? '') === 'update_doc') {
        $targetHash = clean_hash((string) ($_POST['doc_hash'] ?? ''));
        if ($targetHash === '') {
            $error = '수정할 달력 URL이 없습니다.';
        } elseif (is_aggregate_hash($targetHash)) {
            $error = '간부일정은 특수(집계) 달력이라 제목·팀을 수정할 수 없습니다.';
        } else {
            ensure_admin_document($targetHash);
            save_admin_meta($targetHash, (string) ($_POST['title'] ?? ''), (string) ($_POST['teams'] ?? ''));
            header('Location: /admin');
            exit;
        }
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST' && $loggedIn && ($_POST['action'] ?? '') === 'delete_doc') {
        $targetHash = clean_hash((string) ($_POST['doc_hash'] ?? ''));
        if ($targetHash === '') {
            $error = '삭제할 달력 URL이 없습니다.';
        } elseif (is_aggregate_hash($targetHash)) {
            $error = '간부일정은 특수(집계) 달력이라 삭제할 수 없습니다.';
        } else {
            $docDir = DATA_DIR . '/' . $targetHash;
            $eventCount = 0;
            foreach (glob($docDir . '/????-??.json') ?: [] as $f) {
                $ev = read_json_file($f, []);
                if (is_array($ev)) {
                    $eventCount += count($ev);
                }
            }
            if ($eventCount > 0) {
                $error = '일정이 있는 달력은 삭제할 수 없습니다.';
            } else {
                admin_delete_doc($targetHash);
                header('Location: /admin');
                exit;
            }
        }
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST' && $loggedIn && ($_POST['action'] ?? '') === 'download_csv') {
        admin_download_csv(
            (string) ($_POST['doc_hash'] ?? ''),
            (string) ($_POST['from_month'] ?? date('Y-m')),
            (string) ($_POST['to_month'] ?? date('Y-m'))
        );
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST' && !$loggedIn) {
        $password = (string) ($_POST['password'] ?? '');
        if (hash_equals(ADMIN_PASSWORD, $password)) {
            $_SESSION['cal_admin'] = true;
            header('Location: /admin');
            exit;
        }
        $error = '비밀번호가 맞지 않습니다.';
    }

    $documents = $loggedIn ? admin_documents() : [];
    $totalEvents = array_sum(array_map(static fn(array $row): int => (int) $row['eventCount'], $documents));
    ?>
<!doctype html>
<html lang="ko">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>일정표 관리자</title>
    <style>
        :root {
            color-scheme: light;
            --bg: #f4f6f8;
            --panel: #fff;
            --line: #d9e0e7;
            --text: #1f2933;
            --muted: #667085;
            --accent: #0f766e;
            --danger: #b42318;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            background: var(--bg);
            color: var(--text);
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        a { color: var(--accent); text-decoration: none; font-weight: 700; }
        a:hover { text-decoration: underline; }
        button, input, textarea { font: inherit; }
        button {
            min-height: 38px;
            border: 1px solid var(--accent);
            border-radius: 6px;
            padding: 0 14px;
            background: var(--accent);
            color: #fff;
            cursor: pointer;
            font-weight: 700;
        }
        input, textarea {
            width: 100%;
            min-height: 42px;
            border: 1px solid var(--line);
            border-radius: 6px;
            padding: 8px 10px;
            background: #fff;
        }
        textarea {
            min-height: 88px;
            resize: vertical;
        }
        .app { width: min(1180px, 100%); margin: 0 auto; padding: 18px; }
        .topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 14px;
        }
        h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
        .panel {
            background: var(--panel);
            border: 1px solid var(--line);
            border-radius: 8px;
            padding: 16px;
        }
        .login {
            width: min(420px, calc(100% - 24px));
            margin: 12vh auto 0;
        }
        .login h1 { margin-bottom: 16px; }
        .login form { display: grid; gap: 10px; }
        .error {
            margin: 0 0 10px;
            color: var(--danger);
            font-size: 14px;
            font-weight: 700;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 10px;
            margin-bottom: 14px;
        }
        .stat {
            background: var(--panel);
            border: 1px solid var(--line);
            border-radius: 8px;
            padding: 14px;
        }
        .stat b { display: block; font-size: 24px; }
        .stat span { color: var(--muted); font-size: 13px; font-weight: 700; }
        .create-doc {
            display: grid;
            grid-template-columns: minmax(160px, 1fr) minmax(180px, 1fr) minmax(220px, 1.2fr) auto;
            gap: 8px;
            align-items: end;
            margin-bottom: 14px;
        }
        .download-box {
            display: grid;
            grid-template-columns: minmax(160px, 1fr) minmax(140px, 1fr) minmax(140px, 1fr) auto;
            gap: 8px;
            align-items: end;
            margin-bottom: 14px;
        }
        .create-doc label, .doc-edit label {
            display: grid;
            gap: 5px;
            color: var(--muted);
            font-size: 13px;
            font-weight: 700;
        }
        .create-doc .error {
            grid-column: 1 / -1;
            margin-bottom: 2px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
        }
        th, td {
            border-bottom: 1px solid var(--line);
            padding: 10px 8px;
            text-align: left;
            vertical-align: top;
            word-break: break-word;
        }
        th {
            color: var(--muted);
            font-size: 13px;
            white-space: nowrap;
        }
        td.num { text-align: right; white-space: nowrap; }
        .teams {
            color: var(--muted);
            font-size: 13px;
            line-height: 1.45;
        }
        .doc-edit {
            display: grid;
            grid-template-columns: minmax(180px, 1fr) minmax(220px, 1.3fr) auto;
            gap: 8px;
            align-items: end;
        }
        .doc-edit button {
            white-space: nowrap;
        }
        .empty {
            color: var(--muted);
            padding: 20px 0;
            text-align: center;
        }
        .links {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
            flex-wrap: wrap;
        }
        @media (max-width: 760px) {
            .topbar, .links { align-items: flex-start; justify-content: flex-start; }
            .topbar { flex-direction: column; }
            .stats { grid-template-columns: 1fr; }
            .create-doc { grid-template-columns: 1fr; }
            .download-box { grid-template-columns: 1fr; }
            .doc-edit { grid-template-columns: 1fr; }
            .panel { overflow-x: auto; }
            table { min-width: 900px; }
        }
    </style>
</head>
<body>
<?php if (!$loggedIn): ?>
    <main class="login panel">
        <h1>일정표 관리자</h1>
        <?php if ($error): ?><p class="error"><?= h($error) ?></p><?php endif; ?>
        <form method="post" action="/admin" autocomplete="off">
            <input type="password" name="password" placeholder="비밀번호" required autofocus>
            <button type="submit">로그인</button>
        </form>
    </main>
<?php else: ?>
    <main class="app">
        <header class="topbar">
            <h1>일정표 관리자</h1>
            <nav class="links">
                <a href="/">일정표</a>
                <a href="/admin?logout=1">로그아웃</a>
            </nav>
        </header>

        <section class="stats">
            <div class="stat"><b><?= count($documents) ?></b><span>문서</span></div>
            <div class="stat"><b><?= $totalEvents ?></b><span>전체 일정</span></div>
            <div class="stat"><b><?= h(date('Y-m-d H:i')) ?></b><span>확인 시각</span></div>
        </section>

        <form class="panel create-doc" method="post" action="/admin" autocomplete="off">
            <?php if ($error): ?><p class="error"><?= h($error) ?></p><?php endif; ?>
            <input type="hidden" name="action" value="create_doc">
            <label>달력 URL
                <input name="doc_hash" placeholder="예: digital_future" required autofocus>
            </label>
            <label>부서명 (한글 주소로도 접속됨)
                <input name="title" placeholder="예: 디지털미래교육과">
            </label>
            <label>팀 이름
                <textarea name="teams" rows="2" placeholder="한 줄에 하나씩 입력"></textarea>
            </label>
            <button type="submit">달력 만들기</button>
        </form>

        <form class="panel download-box" method="post" action="/admin" autocomplete="off">
            <input type="hidden" name="action" value="download_csv">
            <label>달력 URL
                <input name="doc_hash" placeholder="예: digital_future" required>
            </label>
            <label>시작월
                <input type="month" name="from_month" value="<?= h(date('Y-m')) ?>" required>
            </label>
            <label>종료월
                <input type="month" name="to_month" value="<?= h(date('Y-m')) ?>" required>
            </label>
            <button type="submit">데이터 내려받기</button>
        </form>

        <section class="panel">
            <?php if (!$documents): ?>
                <div class="empty">생성된 문서가 없습니다.</div>
            <?php else: ?>
                <table>
                    <thead>
                    <tr>
                        <th style="width: 18%;">달력 URL</th>
                        <th>부서명 / 팀 이름</th>
                        <th style="width: 90px;">일정</th>
                        <th style="width: 18%;">최근 수정</th>
                        <th style="width: 100px;">열기</th>
                    </tr>
                    </thead>
                    <tbody>
                    <?php foreach ($documents as $doc): ?>
                        <tr>
                            <td>
                                <code><?= h($doc['hash']) ?></code>
                                <?php if ($doc['alias'] !== ''): ?>
                                    <div class="teams" style="margin-top:6px;">한글 주소:
                                        <a href="/<?= rawurlencode($doc['alias']) ?>"><?= h($doc['alias']) ?></a>
                                    </div>
                                <?php endif; ?>
                            </td>
                            <td>
                                <form class="doc-edit" method="post" action="/admin">
                                    <input type="hidden" name="action" value="update_doc">
                                    <input type="hidden" name="doc_hash" value="<?= h($doc['hash']) ?>">
                                    <label>부서명
                                        <input name="title" value="<?= h($doc['title']) ?>" maxlength="80">
                                    </label>
                                    <label>팀 이름
                                        <textarea name="teams" rows="3"><?= h(implode("\n", array_map('strval', $doc['teams']))) ?></textarea>
                                    </label>
                                    <button type="submit">저장</button>
                                </form>
                            </td>
                            <td class="num"><?= (int) $doc['eventCount'] ?></td>
                            <td><?= h($doc['updatedAt'] !== '' ? $doc['updatedAt'] : date(DATE_ATOM, (int) $doc['mtime'])) ?></td>
                            <td>
                                <a href="/?<?= rawurlencode($doc['hash']) ?>">열기</a>
                                <?php if ($doc['eventCount'] === 0): ?>
                                <form method="post" action="/admin" style="margin-top:6px;">
                                    <input type="hidden" name="action" value="delete_doc">
                                    <input type="hidden" name="doc_hash" value="<?= h($doc['hash']) ?>">
                                    <button type="submit"
                                            style="background:var(--danger);border-color:var(--danger);font-size:13px;min-height:28px;padding:0 10px;"
                                            onclick="return confirm('<?= h($doc['hash']) ?> 달력을 삭제하시겠습니까?')">삭제</button>
                                </form>
                                <?php endif; ?>
                            </td>
                        </tr>
                    <?php endforeach; ?>
                    </tbody>
                </table>
            <?php endif; ?>
        </section>
    </main>
<?php endif; ?>
</body>
</html>
    <?php
    exit;
}
