<?php
// PDO::ATTR_EMULATE_PREPARES, decided by measurement (S5): the same three statements through the
// generated client with emulation off (server-side prepare, binary protocol) and on (client-side
// interpolation, text protocol). "warm" reuses the cached PDOStatement (execute only); "cold"
// prepares the statement every time — what a PHP-FPM request pays for each statement shape it
// runs, since the statement cache lives in the process. Types (ip = INET6_NTOA string, json =
// text) are printed for both modes so the codec path can be compared.
// Usage: php -d apc.enable_cli=0 clients/php/tests/bench_emulate.php /abs/ormd.sock /abs/schema.json [iterations]
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use App\Orm\Battle;
use Orm\Config;
use Orm\Db;
use Orm\Orm;

[$sock, $schema, $iters] = [$argv[1], $argv[2], (int) ($argv[3] ?? 3000)];
$order = ($argv[4] ?? 'off') === 'on' ? [true, false] : [false, true]; // which mode runs first (run both orders)
$last = ['sql' => '', 'binds' => []];
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index',
    onQuery: function (string $sql, array $binds, float $sec, string $planId, ?\Throwable $e) use (&$last): void {
        $last = ['sql' => $sql, 'binds' => array_map(fn($v) => $v === '$SECRET' ? 'bench-salt' : $v, $binds)];
    }));

function p50(int $iters, \Closure $f): float
{
    for ($i = 0; $i < 200; $i++) {
        $f($i);
    }
    $s = [];
    for ($i = 0; $i < $iters; $i++) {
        $t = hrtime(true);
        $f($i);
        $s[] = hrtime(true) - $t;
    }
    sort($s);
    return $s[intdiv($iters, 2)] / 1000;
}

$cases = [
    'pk get' => fn(Db $db, int $i) => Battle::query()->seqEq($i % 100000 + 1)->using($db)->get(),
    '100 rows' => fn(Db $db, int $i) => Battle::query()->serviceSeqEq($i % 100 + 1)->isCloseEq(false)->orderBySeqDesc()->limit(0, 100)->using($db)->gets(),
    'IN(8)' => fn(Db $db, int $i) => Battle::query()->seqIn([$i % 1000 + 1, 6, 106, 206, 306, 406, 506, 606])->orderBySeqAsc()->using($db)->gets(),
];

printf("%-12s %-8s %10s %10s\n", 'case', 'emulate', 'warm p50', 'cold p50');
$probe = Battle::query()->setName('bench-emulate')->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
    ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00')->setIp('10.1.2.3')->setJsonSetting(['k' => [1, 'x']])->setPrice(12.5)
    ->using(Db::mysql(orm_test_dsn(), 'root', '', persistent: false))->insert();
foreach ($order as $emulate) {
    $db = Db::mysql(orm_test_dsn(), 'root', '', persistent: false);
    $db->pdo->setAttribute(\PDO::ATTR_EMULATE_PREPARES, $emulate);
    foreach ($cases as $name => $f) {
        $warm = p50($iters, fn(int $i) => $f($db, $i));
        $f($db, 0);
        $sql = $last['sql'];
        $binds = $last['binds'];
        $cold = p50($iters, function () use ($db, $sql, $binds): void {
            $st = $db->pdo->prepare($sql);
            $st->execute($binds);
            $st->fetchAll(\PDO::FETCH_NUM);
        });
        printf("%-12s %-8s %8.1fµs %8.1fµs\n", $name, $emulate ? 'on' : 'off', $warm, $cold);
    }
    $r = Battle::query()->selectJsonSetting()->selectIp()->selectPrice()->seqEq($probe->getSeq())->using($db)->get();
    $raw = Battle::query()->raw('SELECT ip, json_setting, price, is_close, like_count FROM {table} WHERE seq = ?', [$probe->getSeq()])->using($db)->rawAll()[0];
    printf("types (emulate %s): ip=%s json_setting=%s price=%s is_close=%s | raw: %s\n", $emulate ? 'on' : 'off',
        var_export($r->getIp(), true), json_encode($r->getJsonSetting()), var_export($r->getPrice(), true), var_export($r->getIsClose(), true), json_encode($raw));
}
$probe->using(Db::mysql(orm_test_dsn(), 'root', '', persistent: false))->delete();
