<?php
// S0: PHP paths. (i) PDO direct + PHP-side assembly, (ii)/(iii) ormd executes, msgpack back.
// Usage: php native.php /abs/ormd.sock [iters]
declare(strict_types=1);
require dirname(__DIR__, 2) . '/clients/php/tests/autoload.php';

use Orm\Codec;

$sock  = $argv[1] ?? die("socket path required\n");
$iters = (int)($argv[2] ?? 3000);

function stats(string $name, array $s): void {
    sort($s); $n = count($s);
    $p = fn(float $q) => $s[(int)(($n - 1) * $q)];
    printf("%-36s n=%-6d mean=%8.0fns p50=%8dns p90=%8dns p99=%8dns\n", $name, $n, array_sum($s) / $n, $p(0.5), $p(0.9), $p(0.99));
}
function bench(string $name, int $iters, callable $f): void {
    for ($i = 0; $i < 200; $i++) { $f($i); }
    $s = [];
    for ($i = 0; $i < $iters; $i++) { $t = hrtime(true); $f($i); $s[] = hrtime(true) - $t; }
    stats($name, $s);
}

const COLS = "`a`.`seq`, `a`.`name`, `a`.`created_ts`, `a`.`updated_ts`, `a`.`is_close`, `a`.`is_display`, `a`.`display_start_dt`, `a`.`display_end_dt`, `a`.`is_allday`, `a`.`target_team_player_count`, `a`.`success_count`, `a`.`player_count`, `a`.`read_count`, `a`.`cover_url`, `a`.`user_seq`, `a`.`service_seq`, `a`.`service_module_seq`, `a`.`service_member_seq`, `a`.`start_dt`, `a`.`end_dt`, `a`.`uuid`, `a`.`is_single_play`, `a`.`like_count`, `a`.`aes_hex_email`, `a`.`aes_hex_phone`, `a`.`price`, `a`.`ip`";

// ---------- (i) PDO direct ----------
$pdo = new PDO('mysql:unix_socket=/tmp/mysql.sock;dbname=orm_bench;charset=utf8mb4', 'root', '', [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES => true,
    PDO::ATTR_STRINGIFY_FETCHES => false, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    Pdo\Mysql::ATTR_FOUND_ROWS => true, PDO::ATTR_PERSISTENT => true,
]);
$stPk   = $pdo->prepare("SELECT " . COLS . " FROM `battle` AS `a` WHERE `a`.`seq` = ? LIMIT 0, 1");
$stList = $pdo->prepare("SELECT " . COLS . " FROM `battle` AS `a` WHERE `a`.`service_seq` = ? AND `a`.`is_close` = ? ORDER BY `a`.`seq` DESC LIMIT 0, 100");
$stIns  = $pdo->prepare("INSERT INTO `battle` (`name`, `user_seq`, `service_seq`, `service_module_seq`, `service_member_seq`, `start_dt`, `end_dt`, `aes_hex_email`, `aes_key_version`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
$stP20  = $pdo->prepare("SELECT " . COLS . " FROM `battle` AS `a` WHERE `a`.`service_seq` = ? ORDER BY `a`.`seq` DESC LIMIT 0, 20");

echo "== (i) PDO direct ==\n";
bench('pdo pk get', $iters, function ($i) use ($stPk) { $stPk->execute([$i % 100000 + 1]); $r = $stPk->fetch(\PDO::FETCH_NUM); $stPk->closeCursor(); if (!$r) throw new RuntimeException('no row'); });
bench('pdo list100', $iters, function ($i) use ($stList) { $stList->execute(['bench-salt', 'bench-salt', $i % 100 + 1, 0]); $rows = $stList->fetchAll(\PDO::FETCH_NUM); if (count($rows) === 0) throw new RuntimeException('empty'); });
bench('pdo insert', 1000, function ($i) use ($stIns) { $stIns->execute(["bench-insert-$i", 1, 999, 1, 1, '2026-06-01', '2026-12-31', (string) Codec::hostEncode('ins@example.com', ['aes', 'hex'], 'bench-salt'), 1]); });
$pdo->exec("DELETE FROM `battle` WHERE `service_seq` = 999");
bench('pdo relation4 + php assembly', $iters, function ($i) use ($pdo, $stP20) {
    $stP20->execute(['bench-salt', 'bench-salt', $i % 100 + 1]);
    $parents = $stP20->fetchAll();
    $keys = array_values(array_unique(array_column($parents, 'user_seq')));
    $ph = implode(', ', array_fill(0, count($keys), '?'));
    $children = [];
    for ($step = 0; $step < 3; $step++) {
        $st = $pdo->prepare("SELECT " . COLS . " FROM `battle` AS `a` WHERE `a`.`user_seq` IN ($ph) AND `a`.`is_close` = 0 ORDER BY `a`.`seq` DESC LIMIT 0, 200");
        $st->execute(array_merge(['bench-salt', 'bench-salt'], $keys));
        foreach ($st->fetchAll() as $row) { $children[$row['user_seq']][] = $row; }
    }
    // attach: parent[alias] = keyed child map
    foreach ($parents as &$p) { $p['children'] = $children[$p['user_seq']] ?? []; }
});

// ---------- (ii)/(iii) ormd executes, msgpack back ----------
$fp = stream_socket_client("unix://$sock", $errno, $errstr, 1.0, STREAM_CLIENT_CONNECT | STREAM_CLIENT_PERSISTENT);
if (!$fp) { die("connect: $errstr\n"); }
function call($fp, string $frame): string {
    fwrite($fp, pack('N', strlen($frame)) . $frame);
    $len = unpack('N', stream_get_contents($fp, 4))[1];
    $b = ''; while (strlen($b) < $len) { $b .= fread($fp, $len - strlen($b)); }
    return $b;
}
$sqlPk   = "SELECT " . COLS . " FROM `battle` AS `a` WHERE `a`.`seq` = ? LIMIT 0, 1";
$sqlList = "SELECT " . COLS . " FROM `battle` AS `a` WHERE `a`.`service_seq` = ? AND `a`.`is_close` = ? ORDER BY `a`.`seq` DESC LIMIT 0, 100";

// The S0 paths (ii)/(iii) measured an ormd that executed SQL; decision R3 removed that op
// (docs/perf.md §5), so this file is the PDO baseline only. The client numbers come from
// clients/php/tests/bench.php.
