<?php
// PHP compatibility layer (docs/dsl.md §6 "PHP 호환층", checklist T4.6): every dynamic chain below is
// paired with its canonical spelling; the pair must produce byte-identical IR (Req::shape()) and the
// same rows from MySQL. Families follow the compatibility coverage checklist.
// Usage: php -d apc.enable_cli=0 clients/php/tests/compat.php /abs/ormd.sock /abs/schema.json
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\AuthorWhere;
use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Tests\Model\ServiceMember;
use Polyspec\Orm\Tests\Model\ServiceRegion;
use Polyspec\Orm\Tests\Model\ServiceWhere;
use Polyspec\Orm\Tests\Model\User;
use Polyspec\Orm\Tests\Model\UserWhere;
use Orm\Code;
use Orm\Collection;
use Orm\Compat;
use Orm\Config;
use Orm\Db;
use Orm\Orm;
use Orm\OrmException;
use Orm\Q;
use Orm\Registry;
use Orm\Row;
use Orm\Tx;

$sock = $argv[1] ?? die("usage: compat.php /abs/ormd.sock /abs/schema.json\n");
$schema = $argv[2] ?? die("schema.json required\n");
$log = [];
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt',
    onQuery: function (string $sql) use (&$log): void { $log[] = $sql; }));
$db = Db::mysql(orm_test_dsn(), 'root', '');

$fail = 0;
$pairs = 0;
function check(bool $ok, string $what): void { global $fail; if (!$ok) { $fail++; fwrite(STDERR, "FAIL: $what\n"); } }
function shape(Q $q, string $kind): string { return json_encode($q->req->shape($kind), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE); }
function norm(mixed $v): mixed
{
    return match (true) {
        $v instanceof Collection => $v->toArray(),
        $v instanceof Row => $v->toArray(),
        default => $v,
    };
}
/** Same IR bytes, then (when runners are given) the same result from the database. */
function same(string $what, Q $compat, Q $canonical, string $kind, ?\Closure $runCompat = null, ?\Closure $runCanonical = null): void
{
    global $pairs;
    $pairs++;
    $a = shape($compat, $kind);
    $b = shape($canonical, $kind);
    check($a === $b, "$what: IR differs\n  compat    $a\n  canonical $b");
    if ($runCompat !== null) {
        $ra = norm($runCompat($compat));
        $rb = norm($runCanonical($canonical));
        check($ra === $rb, "$what: results differ\n  compat    " . json_encode($ra) . "\n  canonical " . json_encode($rb));
        check($ra !== null && $ra !== [] && $ra !== 0, "$what: the chain matched nothing, the comparison is vacuous");
    }
}
function code(\Closure $fn, string $code, string $what, string $contains = ''): void
{
    try {
        $fn();
        check(false, "$what: expected $code");
    } catch (OrmException $e) {
        check($e->code_ === $code && ($contains === '' || str_contains($e->getMessage(), $contains)), "$what: expected $code" . ($contains === '' ? '' : " with '$contains'") . ", got " . $e->getMessage());
    }
}

$now = '2026-09-11 00:00:00';
$count = fn(Db $db) => fn(Q $q) => $q->using($db)->count();
$getCount = fn(Db $db) => fn(Q $q) => $q->using($db)->getCount();
$gets = fn(Db $db) => fn(Q $q) => $q->using($db)->gets();
$all = fn(Db $db) => fn(Q $q) => $q->using($db)->all();

// ---- 1. predicate and*/or*/condition* — implicit ops ----
same('andX → xEq', Author::query()->andServiceSeq(7)->andIsClose(0), Author::query()->serviceSeqEq(7)->isCloseEq(false), 'count', $getCount($db), $count($db));
same('conditionXAndY compound', Author::query()->conditionServiceSeqAndIsClose(7, 0), Author::query()->serviceSeqEq(7)->isCloseEq(false), 'count', $getCount($db), $count($db));
same('orX = or()->xEq', Author::query()->conditionServiceSeq(7)->orSeq(42), Author::query()->serviceSeqEq(7)->or()->seqEq(42), 'count', $getCount($db), $count($db));
same('andXOrY compound with or', Author::query()->andServiceSeqOrSeq(7, 42), Author::query()->serviceSeqEq(7)->or()->seqEq(42), 'count', $getCount($db), $count($db));
same('and(Name, v) / and(snake, v) forms', Author::query()->and('ServiceSeq', 7)->and('is_close', 0)->or()->and('Seq', 42),
    Author::query()->serviceSeqEq(7)->isCloseEq(false)->or()->seqEq(42), 'count', $getCount($db), $count($db));

// ---- 2. op-first names ----
same('gt/le/ne op-first', Author::query()->andServiceSeq(7)->andGtSeq(100)->andLeSeq(20000)->andNeIsClose(1),
    Author::query()->serviceSeqEq(7)->seqGt(100)->seqLte(20000)->isCloseNotEq(true), 'count', $getCount($db), $count($db));
same('ge/lt/eq op-first', Author::query()->conditionGeSeqAndLtSeqAndEqServiceSeq(6, 5000, 7),
    Author::query()->seqGte(6)->seqLt(5000)->serviceSeqEq(7), 'count', $getCount($db), $count($db));
same('lk → like %v% (wraps, no escaping)', Author::query()->andServiceSeq(7)->andLkName('author-4'),
    Author::query()->serviceSeqEq(7)->nameLike('%author-4%'), 'count', $getCount($db), $count($db));
same('lb → like_binary %v%', Author::query()->andServiceSeq(7)->conditionLbName('author-4'),
    Author::query()->serviceSeqEq(7)->nameLikeBinary('%author-4%'), 'count', $getCount($db), $count($db));
same('between [lo, hi]', Author::query()->andBetweenSeq([6, 2000])->andServiceSeq(7), Author::query()->seqBetween(6, 2000)->serviceSeqEq(7), 'count', $getCount($db), $count($db));
same('array → In', Author::query()->andSeq([6, 106, 206]), Author::query()->seqIn([6, 106, 206]), 'count', $getCount($db), $count($db));
same('null → IsNull, Ne null → IsNotNull, Ne array → NotIn', Author::query()->andServiceSeq(7)->andPrice(null)->andNeDescription(null)->andNeSeq([6, 106]),
    Author::query()->serviceSeqEq(7)->priceIsNull()->descriptionIsNotNull()->seqNotIn([6, 106]), 'count', $getCount($db), $count($db));
same('IsNull / NotNull op-first (no argument)', Author::query()->andServiceSeq(7)->andIsNullPrice()->andNotNullStartDt(),
    Author::query()->serviceSeqEq(7)->priceIsNull()->startDtIsNotNull(), 'count', $getCount($db), $count($db));
same('fulltext boolean', Author::query()->conditionFulltextBooleanNameWithDescription('author')->andServiceSeq(7),
    Author::query()->nameWithDescriptionMatchBoolean('author')->serviceSeqEq(7), 'count', $getCount($db), $count($db));
same('fulltext natural, or-connected', Author::query()->andServiceSeqAndSeq(7, 42)->orFulltextNameWithDescription('desc'),
    Author::query()->serviceSeqEq(7)->seqEq(42)->or()->nameWithDescriptionMatch('desc'), 'count', $getCount($db), $count($db));

// ---- 3. paren tokens and('(') … condition(')') ----
same('paren tokens nest groups like and(fn)',
    Author::query()->andServiceSeq(7)->and('(')->conditionIsDisplay(1)->or('(')->conditionIsDisplay(0)->andLtDisplayStartDt($now)->condition(')')->condition(')')->andSeq([6, 106, 206, 306, 406])->orderBySeqDesc()->limit(0, 3),
    Author::query()->serviceSeqEq(7)->and(fn(AuthorWhere $w) => $w->isDisplayEq(true)->or()->and(fn(AuthorWhere $w) => $w->isDisplayEq(false)->displayStartDtLt($now)))->seqIn([6, 106, 206, 306, 406])->orderBySeqDesc()->limit(0, 3),
    'all', $gets($db), $all($db));
same('or() between paren groups, condition(") ") with a stray space',
    Author::query()->andServiceSeq(7)->condition('(')->conditionIsClose(0)->condition(') ')->or()->condition('(')->conditionIsDisplay(1)->andIsAllday(1)->condition(')'),
    Author::query()->serviceSeqEq(7)->and(fn(AuthorWhere $w) => $w->isCloseEq(false))->or()->and(fn(AuthorWhere $w) => $w->isDisplayEq(true)->isAlldayEq(true)),
    'count', $getCount($db), $count($db));
same('or("(") as the connector of a group',
    Author::query()->andServiceSeq(7)->andIsClose(0)->or('(')->conditionIsClose(1)->andIsDisplay(1)->condition(')'),
    Author::query()->serviceSeqEq(7)->isCloseEq(false)->or()->and(fn(AuthorWhere $w) => $w->isCloseEq(true)->isDisplayEq(true)),
    'count', $getCount($db), $count($db));

// ---- 4. brace-call form ->{'condition(…)'} ----
same('brace-call tokens',
    Author::query()->andServiceSeq(7)->{'and('}()->{'condition(IsCloseAndLtStartDt)'}(0, $now)->{'or(IsDisplay)'}(1)->{'condition)'}(),
    Author::query()->serviceSeqEq(7)->and(fn(AuthorWhere $w) => $w->and(fn(AuthorWhere $w) => $w->isCloseEq(false)->startDtLt($now))->or(fn(AuthorWhere $w) => $w->isDisplayEq(true))),
    'count', $getCount($db), $count($db));
same('brace-call compound name with nested parens',
    Author::query()->{'conditionServiceSeqAnd((IsCloseAndLtStartDt)Or(IsDisplay))'}(7, 0, $now, 1),
    Author::query()->serviceSeqEq(7)->and(fn(AuthorWhere $w) => $w->and(fn(AuthorWhere $w) => $w->isCloseEq(false)->startDtLt($now))->or(fn(AuthorWhere $w) => $w->isDisplayEq(true))),
    'count', $getCount($db), $count($db));
$q1 = Author::query()->orderBySeqAsc()->limit(0, 4);
$q2 = Author::query()->orderBySeqAsc()->limit(0, 4);
$r1 = $q1->using($db)->{'getsByServiceSeqAnd((IsCloseAndLtStartDt)Or(IsDisplay))'}( 7, 0, $now, 1);
$r2 = $q2->serviceSeqEq(7)->and(fn(AuthorWhere $w) => $w->and(fn(AuthorWhere $w) => $w->isCloseEq(false)->startDtLt($now))->or(fn(AuthorWhere $w) => $w->isDisplayEq(true)))->using($db)->all();
same('getsBy with a brace-call compound name', $q1, $q2, 'all');
check(count($r1) === 4 && $r1->toArray() === $r2->toArray(), 'getsBy brace-call rows');

// ---- 5. getBy* / getsBy* / getCount* terminals ----
$q1 = Author::query()->orderBySeqDesc()->limit(0, 5);
$q2 = Author::query()->orderBySeqDesc()->limit(0, 5);
$r1 = $q1->using($db)->getsByServiceSeqAndIsClose(7, 0);
$r2 = $q2->serviceSeqEq(7)->isCloseEq(false)->using($db)->all();
same('getsByXAndY($db, a, b) → all', $q1, $q2, 'all');
check($r1 instanceof Collection && $r1->toArray() === $r2->toArray() && count($r1) === 5, 'getsBy rows and keys');
$q1 = Author::query();
$q2 = Author::query();
$r1 = $q1->using($db)->getBySeq(42);
$r2 = $q2->seqEq(42)->using($db)->one();
same('getByX($db, v) → one', $q1, $q2, 'one');
check($r1 !== null && $r1->toArray() === $r2->toArray() && $r1->getName() === 'author-42', 'getBy row');
$q1 = Author::query()->andIsClose(0);
$q2 = Author::query()->isCloseEq(false);
$r1 = $q1->using($db)->getCountByServiceSeq(7);
$r2 = $q2->serviceSeqEq(7)->using($db)->count();
same('getCountByX after and*', $q1, $q2, 'count');
check($r1 === $r2 && $r1 > 0, 'getCountBy value');
same('getAllByX → selectAll + one', Author::query()->andIsClose(1), Author::query()->isCloseEq(true), 'one',
    fn(Q $q) => $q->using($db)->getAllBySeq(42)?->getDescription(), fn(Q $q) => $q->selectAll()->seqEq(42)->using($db)->one()?->getDescription());
$emptyGetsBy = Author::query()->using($db)->getsBySeq(0);
check($emptyGetsBy instanceof Collection && count($emptyGetsBy) === 0 && Author::query()->using($db)->getBySeq(0) === null && count(Author::query()->andSeq(0)->using($db)->gets()) === 0, 'get()/getBy() are null and gets()/getsBy() are empty collections when nothing matches');
check(Author::query()->andServiceSeq(7)->using($db)->getSumLikeCount() === Author::query()->serviceSeqEq(7)->using($db)->sumLikeCount(), 'getSum<Col>($db) → sum<Col>');
check(Author::query()->andServiceSeq(7)->using($db)->getCount() === 1000, 'getCount → scalar count');
$bound = Author::query()($db);
check($bound->andServiceSeq(7)->getCount() === 1000, '(new Model)($db)->getCount() → bound scalar count');
$boundCountBy = Author::query()($db)->andIsClose(0)->getCountByServiceSeq(7);
$explicitCountBy = Author::query()->isClose(false)->using($db)->getCountByServiceSeq(7);
check($boundCountBy === $explicitCountBy && $boundCountBy > 0, 'invoke binding and bind() produce the same count');
code(fn() => Author::query()->using($db)->get($db), Code::IR_INVALID, 'get accepts no executor argument');
code(fn() => Author::query()->using($db)->getCountByServiceSeq(7, $db), Code::IR_INVALID, 'finder rejects extra arguments');
code(fn() => Author::query()->getsCount(), Code::CONFIG, 'unbound group count fails before execution');
try {
    Author::query()->using($db)->getCountByServiceSeq($db, 7);
    check(false, 'finder accepts only a typed value');
} catch (\TypeError) {
    check(true, 'finder accepts only a typed value');
}
$grouped = Author::query()($db)->andServiceSeq(7)->groupByUserSeq()->getsCount();
check($grouped instanceof Collection && count($grouped) > 0 && $grouped->first()?->getRowCount() > 0, 'getsCount → grouped rows with row_count');
$g1 = Author::query()->andServiceSeq(7)->orderBySeqAsc()->limit(0, 2)->using($db)->getsAll();
$g2 = Author::query()->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 2)->selectAll()->using($db)->all();
check($g1->toArray() === $g2->toArray() && str_starts_with((string) $g1->first()->getDescription(), 'desc-'), 'getsAll → selectAll + all');

// ---- 6. relation / relations with match<A>With<B> + alias ----
same('relation(match + alias) → relationRel',
    Author::query()->relation(User::query()->matchUserSeqWithSeq()->aliasUser())->andServiceSeq(7)->orderBySeqAsc()->limit(0, 3),
    Author::query()->relation(User::query())->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 3), 'all', $gets($db), $all($db));
same('relationAWithB(child) name form', Author::query()->relationUserSeqWithSeq(User::query())->andSeq(42), Author::query()->relation(User::query())->seqEq(42), 'one', fn(Q $q) => $q->using($db)->get(), fn(Q $q) => $q->using($db)->one());
same('generic relation + matchAWithB equals relationAWithB',
    Author::query()->relation(User::query()->matchUserSeqWithSeq())->andSeq(42),
    Author::query()->relationUserSeqWithSeq(User::query())->andSeq(42), 'one');
same('generic leftJoin + onAWithB equals leftJoinAWithB',
    Author::query()->leftJoin(User::query()->onUserSeqWithSeq())->andSeq(42),
    Author::query()->leftJoinUserSeqWithSeq(User::query())->andSeq(42), 'all');
same('relation → relations nesting with keyName/groupLimit/orderBy',
    Author::query()->relation(Service::query()->matchServiceSeqWithSeq()->aliasService()
        ->relations(ServiceMember::query()->matchSeqWithServiceSeq()->aliasMembers()->orderBySeqDesc()->groupLimit(3)->keyNameUserSeq()))
        ->andServiceSeq(7)->orderBySeqAsc()->limit(0, 4),
    Author::query()->relation(Service::query()
        ->relations(ServiceMember::query()->orderBySeqDesc()->limitPerParent(3)->keyByUserSeq()))
        ->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 4), 'all', $gets($db), $all($db));
$rows = Author::query()->relation(User::query()->matchUserSeqWithSeq()->aliasUser())->using($db)->getsByServiceSeqAndSeq(7, [6, 106]);
check($rows[6]->getUserModel()->getName() === 'user-' . $rows[6]->getUserSeq() && $rows[6]->getUser() === $rows[6]->getUserModel(), 'get<Rel>Model() reaches the relation');
same('parentNode → flatten',
    ServiceMember::query()->andServiceSeq(7)->orderBySeqAsc()->limit(0, 2)->relation(User::query()->matchUserSeqWithSeq()->parentNode()),
    ServiceMember::query()->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 2)->relation(User::query()->flatten()), 'all', $gets($db), $all($db));
same('possibleX(v) → ifParentXEq',
    Author::query()->andSeq([7, 8, 14])->orderBySeqAsc()->relation(User::query()->possibleIsClose(true)->matchUserSeqWithSeq()),
    Author::query()->seqIn([7, 8, 14])->orderBySeqAsc()->relation(User::query()->ifParentIsCloseEq(true)), 'all', $gets($db), $all($db));
same('matchAWithB(false) → dropChildKey; deleteLock → noCascadeDelete',
    Service::query()->andSeq(7)->relations(ServiceMember::query()->matchSeqWithServiceSeq(false)->keyNameUserSeq()->deleteLock()->orderBySeqAsc()->groupLimit(2)),
    Service::query()->seqEq(7)->relations(ServiceMember::query()->noCascadeDelete()->orderBySeqAsc()->limitPerParent(2)->keyByUserSeq()->dropChildKey()), 'one',
    fn(Q $q) => $q->using($db)->get(), fn(Q $q) => $q->using($db)->one());
same('matchAll<A>With<B> → selectAll + match',
    Author::query()->andSeq(42)->relation(User::query()->matchAllUserSeqWithSeq()),
    Author::query()->seqEq(42)->relation(User::query()->selectAll()), 'one', fn(Q $q) => $q->using($db)->get(), fn(Q $q) => $q->using($db)->one());

// ---- 7. join<A>With<B> / leftJoin<A>With<B>: and* on the child = where(fn), on* = on(fn) ----
same('join child and* → where(fn); leftJoin child on* → on(fn); navigation stays canonical',
    Author::query()->joinServiceSeqWithSeq(Service::query()->andName('service-7'))->leftJoinUserSeqWithSeq(User::query()->onLkName('user'))->andIsClose(0)
        ->and(fn(AuthorWhere $w) => $w->isDisplayEq(true)->or()->service(fn(ServiceWhere $s) => $s->seqGt(1000))),
    Author::query()->join(Service::query()->where(fn(ServiceWhere $w) => $w->nameEq('service-7')))->leftJoin(User::query()->on(fn(UserWhere $w) => $w->nameLike('%user%')))->isCloseEq(false)
        ->and(fn(AuthorWhere $w) => $w->isDisplayEq(true)->or()->service(fn(ServiceWhere $s) => $s->seqGt(1000))),
    'count', $getCount($db), $count($db));
same('onAOrB compound in ON, relation off a join child',
    Author::query()->andSeq([6, 106])->orderBySeqAsc()->joinServiceSeqWithSeq(Service::query()->onSeqOrName(7, 'x')->relations(ServiceRegion::query()->matchSeqWithServiceSeq()->aliasModules())),
    Author::query()->seqIn([6, 106])->orderBySeqAsc()->join(Service::query()->on(fn(ServiceWhere $w) => $w->seqEq(7)->or()->nameEq('x'))->relations(ServiceRegion::query())),
    'all', $gets($db), $all($db));

// ---- 8. columns: addColumn* / addAllColumns / removeAllColumns / removeColumn* ----
same('addColumnX / removeColumnX / addColumnXAliasY / format → selectExpr',
    Author::query()->addColumnDescription()->removeColumnName()->addColumnSeqAliasAuthorSeq()->addColumnSeqAliasDoubled('%s * 2')->addColumn('uuid', 'u')->andSeq(42),
    Author::query()->selectDescription()->unselectName()->selectSeqAs('author_seq')->selectExpr('doubled', '`seq` * 2')->selectUuidAs('u')->seqEq(42), 'one',
    fn(Q $q) => $q->using($db)->get(), fn(Q $q) => $q->using($db)->one());
same('addAllColumns → selectAll', Author::query()->addAllColumns()->andSeq(42), Author::query()->selectAll()->seqEq(42), 'one', fn(Q $q) => $q->using($db)->get(), fn(Q $q) => $q->using($db)->one());
same('removeAllColumns + addColumn → selectNone + select', Author::query()->removeAllColumns()->addColumnName()->addColumns(['uuid'])->andSeq(42),
    Author::query()->selectNone()->selectName()->selectUuid()->seqEq(42), 'one', fn(Q $q) => $q->using($db)->get(), fn(Q $q) => $q->using($db)->one());
same('onlyColumns / removeColumns / addRawColumnX', Author::query()->onlyColumns(['name'])->removeColumns(['uuid'])->addRawColumnHalf('`seq` / 2')->andSeq(42),
    Author::query()->selectNone()->selectName()->unselectUuid()->selectExpr('half', '`seq` / 2')->seqEq(42), 'one', fn(Q $q) => $q->using($db)->get(), fn(Q $q) => $q->using($db)->one());

// ---- 9. orderBy / groupBy / forceIndex ----
same('orderByX (no suffix = Asc), orderByXAndYDesc, orderBy(sql)',
    Author::query()->andServiceSeq(7)->orderByIsClose()->orderByServiceSeqAndSeqDesc()->orderBy('`seq` % 3')->limit(0, 5),
    Author::query()->serviceSeqEq(7)->orderByIsCloseAsc()->orderByServiceSeqAsc()->orderBySeqDesc()->orderByExpr('`seq` % 3')->limit(0, 5), 'all', $gets($db), $all($db));
same('groupByXAndY → two groupBy', Author::query()->andServiceSeq(7)->groupByUserSeqAndIsClose(), Author::query()->serviceSeqEq(7)->groupByUserSeq()->groupByIsClose(), 'count', $getCount($db), $count($db));
same('forceIndex(name) → forceIndex<Name>', Author::query()->forceIndex('ix_service')->andServiceSeq(7), Author::query()->forceIndexIxService()->serviceSeqEq(7), 'count', $getCount($db), $count($db));

// ---- 10. raw fragments (named binds → positional) ----
same('and(sql, [:name => v]) → expr(sql ?, [v])', Author::query()->andServiceSeq(7)->and('`seq` % 2 = :m', [':m' => 0])->or('`seq` = :s AND `is_close` = :c', ['s' => 42, 'c' => 1]),
    Author::query()->serviceSeqEq(7)->expr('`seq` % 2 = ?', [0])->or()->expr('`seq` = ? AND `is_close` = ?', [42, 1]), 'count', $getCount($db), $count($db));

// ---- 11. Where-builder compat inside canonical closures ----
same('and*/or*/paren tokens inside and(fn)',
    Author::query()->serviceSeqEq(7)->and(fn(AuthorWhere $w) => $w->andIsDisplay(1)->orIsDisplay(0)->and('(')->conditionIsClose(0)->orLtStartDt($now)->condition(')')),
    Author::query()->serviceSeqEq(7)->and(fn(AuthorWhere $w) => $w->isDisplayEq(true)->or()->isDisplayEq(false)->and(fn(AuthorWhere $w) => $w->isCloseEq(false)->or()->startDtLt($now))),
    'count', $getCount($db), $count($db));
same('or(fn) = or()->and(fn) on query and Where',
    Author::query()->serviceSeqEq(7)->isCloseEq(false)->or(fn(AuthorWhere $w) => $w->isDisplayEq(true)->or(fn(AuthorWhere $w) => $w->isAlldayEq(true))),
    Author::query()->serviceSeqEq(7)->isCloseEq(false)->or()->and(fn(AuthorWhere $w) => $w->isDisplayEq(true)->or()->and(fn(AuthorWhere $w) => $w->isAlldayEq(true))),
    'count', $getCount($db), $count($db));

// ---- 12. keyName / fetchKey on the root → client-side keying ----
$k1 = Author::query()->andServiceSeq(7)->orderBySeqAsc()->limit(0, 3)->keyNameUserSeq();
$k2 = Author::query()->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 3)->keyByFn(fn(Row $r) => $r->getUserSeq());
$r1 = $k1->using($db)->gets();
$r2 = $k2->using($db)->all();
same('keyName<Col> on the root', $k1, $k2, 'all');
check($r1->keys() === $r2->keys() && $r1->keys() === array_map(fn(Row $r) => $r->getUserSeq(), array_values(iterator_to_array($r2))), 'root keyName keys the collection by the column');
$r3 = Author::query()->andServiceSeq(7)->orderBySeqAsc()->limit(0, 3)->fetchKey(fn(Row $r) => 'b' . $r->getSeq())->using($db)->gets();
check($r3->keys() === ['b6', 'b106', 'b206'], 'fetchKey(fn) → keyByFn');
$r4 = Author::query()->andServiceSeq(7)->orderBySeqAsc()->limit(0, 2)->keyName('uuid')->using($db)->gets();
check($r4 !== null && array_keys($r4->toArray()) === array_map(fn(array $r) => $r['uuid'], array_values($r4->toArray())), 'keyName(string)');

// ---- 13. writes: create, duplication, setRaw*, delete($db, true) ----
$draft = fn(string $name) => Author::query()
    ->setName($name)->setReadCount(1)
    ->setUserSeq(1)->setServiceSeq(999)->setServiceRegionSeq(1)->setServiceMemberSeq(1)
    ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00');
$c1 = $draft('compat-create');
$c2 = $draft('compat-create');
same('create($db) → insert($db)', $c1, $c2, 'insert');
$r1 = $c1->using($db)->create();
$r2 = $c2->using($db)->insert();
check($r1 !== null && $r2 !== null && $r1->getName() === 'compat-create' && $r2->getSeq() > $r1->getSeq(), 'create inserts');
$r1->using($db)->delete();
$r2->using($db)->delete();

$u1 = $draft('compat-u1')->setUuid('compat-upsert')->duplication(Author::query()->setName('compat-u2')->plusReadCount(5)->setDescription(null)->setNameExpr('CONCAT(`name`, ?)', ['!']));
$u2 = $draft('compat-u1')->setUuid('compat-upsert')->onDuplicateSetName('compat-u2')->onDuplicatePlusReadCount(5)->onDuplicateSetDescription(null)->onDuplicateSetNameExpr('CONCAT(`name`, ?)', ['!']);
same('duplication(model) → onDuplicate*', $u1, $u2, 'insert');
$first = $u1->using($db)->create();
$second = $u2->using($db)->insert();
check($first !== null && $second !== null && $second->getSeq() === $first->getSeq() && $second->getName() === 'compat-u2!' && $second->getReadCount() === 6, 'duplication updates the existing row');
$d1 = $draft('compat-dup-arr')->setUuid('compat-upsert')->duplication(['name' => 'compat-u3', 'like_count' => 9]);
$d2 = $draft('compat-dup-arr')->setUuid('compat-upsert')->onDuplicateSetName('compat-u3')->onDuplicateSetLikeCount(9);
same('duplication([col => v])', $d1, $d2, 'insert');
$third = $d1->using($db)->create();
check($third->getSeq() === $first->getSeq() && $third->getName() === 'compat-u3' && $third->getLikeCount() === 9, 'duplication array applied');

$s1 = Author::query()->andSeq($first->getSeq())->setRawName('CONCAT(:a, :b)', [':a' => 'raw-', ':b' => 'x'])->plusReadCount(2);
$s2 = Author::query()->seqEq($first->getSeq())->setNameExpr('CONCAT(?, ?)', ['raw-', 'x'])->plusReadCount(2);
same('setRawX(expr, named binds) → setXExpr', $s1, $s2, 'update');
check($s1->using($db)->update() === 1 && Author::query()->using($db)->getBySeq($first->getSeq())->getName() === 'raw-x', 'setRaw applied');
check($s2->using($db)->update() === 1 && Author::query()->using($db)->getBySeq($first->getSeq())->getReadCount() === 10, 'canonical twin applied too');
check(Author::query()->andUuid('compat-upsert')->using($db)->delete() === 1, 'cleanup');

$svc = $db->transaction(function (Tx $tx) {
    $s = Service::query()->setName('compat-cascade')->using($tx)->create();
    foreach ([1, 2] as $u) {
        ServiceMember::query()->setServiceSeq($s->getSeq())->setUserSeq($u)->using($tx)->create();
    }
    ServiceRegion::query()->setServiceSeq($s->getSeq())->setName('compat-cascade-mod')->using($tx)->create();
    return $s;
});
$l1 = Service::query()->relations(ServiceMember::query()->matchSeqWithServiceSeq()->aliasMembers()->orderBySeqAsc()->relation(User::query()->matchUserSeqWithSeq()))
    ->relations(ServiceRegion::query()->matchSeqWithServiceSeq()->deleteLock());
$l2 = Service::query()->relations(ServiceMember::query()->orderBySeqAsc()->relation(User::query()))->relations(ServiceRegion::query()->noCascadeDelete());
$loaded = $l1->using($db)->getBySeq($svc->getSeq());
$l2->seqEq($svc->getSeq());
same('relation tree with deleteLock', $l1, $l2, 'one');
$n0 = count($log);
$loaded->using($db)->delete(true);
check(count($log) - $n0 === 3 && str_starts_with($log[$n0], 'DELETE FROM `service_member`') && str_starts_with($log[$n0 + 2], 'DELETE FROM `service`'), 'delete($db, true) = deleteCascade: members first, then the service; deleteLock keeps the modules');
check(ServiceMember::query()->andServiceSeq($svc->getSeq())->using($db)->getCount() === 0 && Service::query()->using($db)->getBySeq($svc->getSeq()) === null
    && ServiceRegion::query()->andServiceSeq($svc->getSeq())->using($db)->getCount() === 1 && User::query()->andSeq([1, 2])->using($db)->getCount() === 2, 'delete(true) result');
check(ServiceRegion::query()->andServiceSeq($svc->getSeq())->using($db)->delete() === 1, 'cascade cleanup');

// ---- 14. memoization: the same (class, name) decodes once; a second chain is identical ----
$m1 = Author::query()->conditionServiceSeqAndIsClose(7, 0);
$m2 = Author::query()->conditionServiceSeqAndIsClose(7, 0);
check(shape($m1, 'count') === shape($m2, 'count') && Compat::decode(Author::class, 'author', 'conditionServiceSeqAndIsClose') === Compat::decode(Author::class, 'author', 'conditionServiceSeqAndIsClose'), 'memoized decode is stable');

// ---- 15. errors ----
code(fn() => Author::query()->and('(')->conditionIsDisplay(1)->leftJoinUserSeqWithSeq(User::query()->onLkName('u')->condition(')'))->using($db)->getCount(),
    Code::PAREN_ACROSS_MODELS, 'join child closes the parent\'s paren', "')' in the user chain closes a '(' opened in the author chain");
code(fn() => Author::query()->relation(User::query()->matchUserSeqWithSeq()->and('(')->conditionSeq(1))->using($db)->getCount(),
    Code::PAREN_ACROSS_MODELS, 'relation child attached with an open paren', "'(' opened in the user chain is still open when author attaches it");
code(fn() => Author::query()->and('(')->conditionIsDisplay(1)->using($db)->getCount(), Code::PAREN_ACROSS_MODELS, 'root paren never closed', 'never closed');
code(fn() => Author::query()->conditionIsDisplay(1)->condition(')')->using($db)->getCount(), Code::PAREN_ACROSS_MODELS, 'root closes nothing', "closes no '('");
code(fn() => Author::query()->serviceSeqEq(7)->and(fn(AuthorWhere $w) => $w->andIsClose(0)->condition(')')), Code::PAREN_ACROSS_MODELS, 'Where closure closes nothing');
code(fn() => Author::query()->andIsClos(1), Code::COLUMN_UNKNOWN, 'unknown column lists candidates', 'is_close, is_display');
code(fn() => Author::query()->andGtNope(1), Code::COLUMN_UNKNOWN, 'unknown column after an op word', 'nope');
code(fn() => Author::query()->relations(User::query()->matchUserSeqWithSeq()), Code::RELATION_UNKNOWN, 'relations() on a 1:1 relation', 'relation (1:1), not relations');
code(fn() => Author::query()->relation(User::query()->matchSeqWithSeq()), Code::RELATION_UNKNOWN, 'unknown FK pair', 'no relation to user on author.seq = user.seq');
code(fn() => Author::query()->relation(User::query()->matchUserSeqWithSeq()->aliasOwner()->relation(Service::query()->matchSeqWithSeq())), Code::RELATION_UNKNOWN, 'unknown pair deeper in the tree');
code(fn() => Author::query()->joinSeqWithSeq(Service::query()), Code::RELATION_UNKNOWN, 'join on an undeclared pair');
code(fn() => Author::query()->conditionServiceSeqAndIsClose(7), Code::IR_INVALID, 'argument count', 'expects 2 argument(s), 1 given');
code(fn() => Author::query()->andServiceSeq(7)->gets(), Code::CONFIG, 'gets() without binding', 'bind a database');
code(fn() => Author::query()->andSeqWithUserSeq(User::query()), Code::IR_INVALID, 'column-to-column compat name is not translated', 'EqCol');
code(fn() => Author::query()->joinServiceSeqWithSeq(Service::query(), User::query()), Code::IR_INVALID, 'generated join rejects a second target', 'join expects one child query');
code(fn() => Author::query()->addColumn('name', fn() => 1), Code::IR_INVALID, 'callback column', 'compute it on the rows');
try {
    Author::query()->frobnicate(1);
    check(false, 'unknown method should throw');
} catch (\BadMethodCallException $e) {
    check(str_contains($e->getMessage(), 'frobnicate'), 'unknown method → BadMethodCallException');
}

/** An entity whose column table makes InStock ambiguous: column in_stock (no op) or In on column stock. */
final class FakeRow extends Row
{
    public static function entity(): string { return 'fake'; }
    public static function pk(): string { return 'seq'; }
    public static function columns(): array { return ['seq' => 'i64', 'stock' => 'i64', 'in_stock' => 'i64']; }
    public static function relations(): array { return []; }
}
Registry::register('fake', FakeRow::class);
code(fn() => Compat::decode('Fake', 'fake', 'andInStock'), Code::COLUMN_UNKNOWN, 'ambiguous op/column reading', 'ambiguous: column in_stock (=) or in on column stock');
check(Compat::decode('Fake', 'fake', 'andSeqAndStock')['n'] === 2 && Compat::decode('Fake', 'fake', 'andSeqAndEqStock')['n'] === 2, 'unambiguous readings of the same table: stock (=), Eq + stock');

if ($fail === 0) {
    echo "ok — $pairs compat/canonical pairs identical, " . count($log) . " statements\n";
    exit(0);
}
exit(1);
