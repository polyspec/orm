<?php
// A complex statement in three languages, one JSON document (docs/examples/complex-query.md
// shows the same product-domain shapes). Run:
//
//   php examples/complex/php/main.php /abs/ormd.sock /abs/schema/schema.json
declare(strict_types=1);

require dirname(__DIR__, 3) . '/clients/php/tests/autoload.php';

use App\Orm\Battle;
use App\Orm\BattleWhere;
use App\Orm\Service;
use App\Orm\ServiceMember;
use App\Orm\ServiceWhere;
use App\Orm\User;
use Orm\Config;
use Orm\Db;
use Orm\Orm;

Orm::init(new Config(socket: $argv[1], schemaPath: $argv[2], aesKey: 'bench-salt'));
$db = Db::mysql(getenv('ORM_MYSQL_DSN_PHP') ?: 'mysql:unix_socket=/tmp/mysql.sock;dbname=orm_bench;charset=utf8mb4', 'root', '');

// A join carrying its own ON and WHERE, a root group mixing a predicate with
// navigation into the joined entity, and three levels of relations with options.
$rows = Battle::query()
    ->selectNone()->selectName()
    ->joinService(Service::query()
        ->on(fn(ServiceWhere $w) => $w->seqGt(0))
        ->where(fn(ServiceWhere $w) => $w->name('service-7')))
    ->isClose(false)
    ->and(fn(BattleWhere $w) => $w->isDisplay(true)->or()->service(fn(ServiceWhere $s) => $s->seq(7)))
    ->relationUser(User::query()
        ->relationsBattles(Battle::query()->selectNone()->orderBySeqDesc()->limitPerParent(2)->dropChildKey()))
    ->relationService(Service::query()
        ->relationsMembers(ServiceMember::query()->selectNone()->orderBySeqAsc()->limitPerParent(2)->keyByUserSeq()))
    ->orderBySeqAsc()->limit(0, 2)
    ->using($db)->gets();
$items = [];
foreach ($rows as $b) {
    $items[] = $b->toArray();
}

// Aggregates over the same slice of data: a grouped count with HAVING, min/max, distinct.
$groups = Battle::query()->serviceSeq(7)->groupByUserSeq()
    ->having(fn(BattleWhere $w) => $w->expr('COUNT(*) > ?', [1]))->using($db)->getCount();

echo json_encode([
    'rows' => $items,
    'groups' => $groups,
    'min_seq' => Battle::query()->serviceSeq(7)->using($db)->minSeq(),
    'max_seq' => Battle::query()->serviceSeq(7)->using($db)->maxSeq(),
    'user_count' => Battle::query()->serviceSeq(7)->using($db)->countDistinctUserSeq(),
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
