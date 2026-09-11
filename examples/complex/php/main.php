<?php
// A complex statement in three languages, one JSON document (docs/examples/complex-query.md
// shows the same shapes against the example schema). Run:
//
//   php examples/complex/php/main.php /abs/ormd.sock /abs/schema/schema.json
declare(strict_types=1);

require dirname(__DIR__, 3) . '/clients/php/tests/autoload.php';

use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\AuthorWhere;
use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Tests\Model\ServiceMember;
use Polyspec\Orm\Tests\Model\ServiceWhere;
use Polyspec\Orm\Tests\Model\User;
use Orm\Config;
use Orm\Db;
use Orm\Orm;

Orm::init(new Config(socket: $argv[1], schemaPath: $argv[2], aesKey: 'bench-salt'));
$db = Db::mysql(getenv('ORM_MYSQL_DSN_PHP') ?: 'mysql:unix_socket=/tmp/mysql.sock;dbname=orm_bench;charset=utf8mb4', 'root', '');

// A join carrying its own ON and WHERE, a root group mixing a predicate with
// navigation into the joined entity, and three levels of relations with options.
$rows = (new Author)
    ->selectNone()->selectName()
    ->joinService((new Service)
        ->on(fn(ServiceWhere $w) => $w->seqGt(0))
        ->where(fn(ServiceWhere $w) => $w->nameEq('service-7')))
    ->isCloseEq(false)
    ->and(fn(AuthorWhere $w) => $w->isDisplayEq(true)->or()->service(fn(ServiceWhere $s) => $s->seqEq(7)))
    ->relationUser((new User)
        ->relationsAuthors((new Author)->selectNone()->orderBySeqDesc()->limitPerParent(2)->dropChildKey()))
    ->relationService((new Service)
        ->relationsMembers((new ServiceMember)->selectNone()->orderBySeqAsc()->limitPerParent(2)->keyByUserSeq()))
    ->orderBySeqAsc()->limit(0, 2)
    ->all($db);
$items = [];
foreach ($rows as $b) {
    $items[] = $b->toArray();
}

// Aggregates over the same slice of data: a grouped count with HAVING, min/max, distinct.
$groups = (new Author)->serviceSeqEq(7)->groupByUserSeq()
    ->having(fn(AuthorWhere $w) => $w->expr('COUNT(*) > ?', [1]))->count($db);

echo json_encode([
    'rows' => $items,
    'groups' => $groups,
    'min_seq' => (new Author)->serviceSeqEq(7)->minSeq($db),
    'max_seq' => (new Author)->serviceSeqEq(7)->maxSeq($db),
    'user_count' => (new Author)->serviceSeqEq(7)->countDistinctUserSeq($db),
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
