<?php
// PHP hot-path gate: generated client vs PDO baseline (bench/php/native.php numbers).
declare(strict_types=1);
require __DIR__ . '/autoload.php';
use App\Orm\Battle; use Orm\Config; use Orm\Db; use Orm\Orm;
[$sock, $schema, $iters] = [$argv[1], $argv[2], (int)($argv[3] ?? 3000)];
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index'));
$db = Db::mysql(orm_test_dsn(), 'root', '');
function stats(string $name, array $s): void { sort($s); $n = count($s); $p = fn($q) => $s[(int)(($n-1)*$q)];
    printf("%-30s n=%-6d mean=%8.0fns p50=%8dns p90=%8dns p99=%8dns\n", $name, $n, array_sum($s)/$n, $p(.5), $p(.9), $p(.99)); }
function bench(string $name, int $iters, callable $f): void { for ($i=0;$i<200;$i++) $f($i); $s=[]; for ($i=0;$i<$iters;$i++){ $t=hrtime(true); $f($i); $s[]=hrtime(true)-$t; } stats($name,$s); }
bench('client pk get', $iters, function ($i) use ($db) { $r = Battle::query()->seqEq($i % 100000 + 1)->using($db)->get(); if ($r === null) throw new RuntimeException('no row'); });
bench('client list100', $iters, function ($i) use ($db) { $c = Battle::query()->serviceSeqEq($i % 100 + 1)->isCloseEq(false)->orderBySeqDesc()->limit(0, 100)->using($db)->gets(); if (count($c) === 0) throw new RuntimeException('empty'); });
bench('client list100 + getName x100', $iters, function ($i) use ($db) { $c = Battle::query()->serviceSeqEq($i % 100 + 1)->isCloseEq(false)->orderBySeqDesc()->limit(0, 100)->using($db)->gets(); foreach ($c as $r) { $r->getName(); } });
bench('plan cache hit (no db)', $iters, function ($i) { $q = Battle::query()->serviceSeqEq($i)->isCloseEq(false)->orderBySeqDesc()->limit(0, 100); Orm::transport()->planFor($q->req, 'all'); });
