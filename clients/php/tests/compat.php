<?php
// PHP compatibility layer (docs/dsl.md §6 "PHP 호환층", checklist T4.6): every dynamic chain below is
// paired with its canonical spelling; the pair must produce byte-identical IR (Req::shape()) and the
// same rows from MySQL. Families follow the compatibility coverage checklist.
// Usage: php -d apc.enable_cli=0 clients/php/tests/compat.php /abs/ormd.sock /abs/schema.json
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use App\Orm\Battle;
use App\Orm\BattleWhere;
use App\Orm\Service;
use App\Orm\ServiceMember;
use App\Orm\ServiceModule;
use App\Orm\ServiceWhere;
use App\Orm\User;
use App\Orm\UserWhere;
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
$count = fn(Db $db) => fn(Q $q) => $q->bind($db)->count();
$getCount = fn(Db $db) => fn(Q $q) => $q->bind($db)->getCount();
$gets = fn(Db $db) => fn(Q $q) => $q->bind($db)->gets();
$all = fn(Db $db) => fn(Q $q) => $q->bind($db)->all();

// ---- 1. predicate and*/or*/condition* — implicit ops ----
same('andX → xEq', (new Battle)->andServiceSeq(7)->andIsClose(0), (new Battle)->serviceSeqEq(7)->isCloseEq(false), 'count', $getCount($db), $count($db));
same('conditionXAndY compound', (new Battle)->conditionServiceSeqAndIsClose(7, 0), (new Battle)->serviceSeqEq(7)->isCloseEq(false), 'count', $getCount($db), $count($db));
same('orX = or()->xEq', (new Battle)->conditionServiceSeq(7)->orSeq(42), (new Battle)->serviceSeqEq(7)->or()->seqEq(42), 'count', $getCount($db), $count($db));
same('andXOrY compound with or', (new Battle)->andServiceSeqOrSeq(7, 42), (new Battle)->serviceSeqEq(7)->or()->seqEq(42), 'count', $getCount($db), $count($db));
same('and(Name, v) / and(snake, v) forms', (new Battle)->and('ServiceSeq', 7)->and('is_close', 0)->or()->and('Seq', 42),
    (new Battle)->serviceSeqEq(7)->isCloseEq(false)->or()->seqEq(42), 'count', $getCount($db), $count($db));

// ---- 2. op-first names ----
same('gt/le/ne op-first', (new Battle)->andServiceSeq(7)->andGtSeq(100)->andLeSeq(20000)->andNeIsClose(1),
    (new Battle)->serviceSeqEq(7)->seqGt(100)->seqLte(20000)->isCloseNotEq(true), 'count', $getCount($db), $count($db));
same('ge/lt/eq op-first', (new Battle)->conditionGeSeqAndLtSeqAndEqServiceSeq(6, 5000, 7),
    (new Battle)->seqGte(6)->seqLt(5000)->serviceSeqEq(7), 'count', $getCount($db), $count($db));
same('lk → like %v% (wraps, no escaping)', (new Battle)->andServiceSeq(7)->andLkName('battle-4'),
    (new Battle)->serviceSeqEq(7)->nameLike('%battle-4%'), 'count', $getCount($db), $count($db));
same('lb → like_binary %v%', (new Battle)->andServiceSeq(7)->conditionLbName('battle-4'),
    (new Battle)->serviceSeqEq(7)->nameLikeBinary('%battle-4%'), 'count', $getCount($db), $count($db));
same('between [lo, hi]', (new Battle)->andBetweenSeq([6, 2000])->andServiceSeq(7), (new Battle)->seqBetween(6, 2000)->serviceSeqEq(7), 'count', $getCount($db), $count($db));
same('array → In', (new Battle)->andSeq([6, 106, 206]), (new Battle)->seqIn([6, 106, 206]), 'count', $getCount($db), $count($db));
same('null → IsNull, Ne null → IsNotNull, Ne array → NotIn', (new Battle)->andServiceSeq(7)->andPrice(null)->andNeDescription(null)->andNeSeq([6, 106]),
    (new Battle)->serviceSeqEq(7)->priceIsNull()->descriptionIsNotNull()->seqNotIn([6, 106]), 'count', $getCount($db), $count($db));
same('IsNull / NotNull op-first (no argument)', (new Battle)->andServiceSeq(7)->andIsNullPrice()->andNotNullStartDt(),
    (new Battle)->serviceSeqEq(7)->priceIsNull()->startDtIsNotNull(), 'count', $getCount($db), $count($db));
same('fulltext boolean', (new Battle)->conditionFulltextBooleanNameWithDescription('battle')->andServiceSeq(7),
    (new Battle)->nameWithDescriptionMatchBoolean('battle')->serviceSeqEq(7), 'count', $getCount($db), $count($db));
same('fulltext natural, or-connected', (new Battle)->andServiceSeqAndSeq(7, 42)->orFulltextNameWithDescription('desc'),
    (new Battle)->serviceSeqEq(7)->seqEq(42)->or()->nameWithDescriptionMatch('desc'), 'count', $getCount($db), $count($db));

// ---- 3. paren tokens and('(') … condition(')') ----
same('paren tokens nest groups like and(fn)',
    (new Battle)->andServiceSeq(7)->and('(')->conditionIsDisplay(1)->or('(')->conditionIsDisplay(0)->andLtDisplayStartDt($now)->condition(')')->condition(')')->andSeq([6, 106, 206, 306, 406])->orderBySeqDesc()->limit(0, 3),
    (new Battle)->serviceSeqEq(7)->and(fn(BattleWhere $w) => $w->isDisplayEq(true)->or()->and(fn(BattleWhere $w) => $w->isDisplayEq(false)->displayStartDtLt($now)))->seqIn([6, 106, 206, 306, 406])->orderBySeqDesc()->limit(0, 3),
    'all', $gets($db), $all($db));
same('or() between paren groups, condition(") ") with a stray space',
    (new Battle)->andServiceSeq(7)->condition('(')->conditionIsClose(0)->condition(') ')->or()->condition('(')->conditionIsDisplay(1)->andIsAllday(1)->condition(')'),
    (new Battle)->serviceSeqEq(7)->and(fn(BattleWhere $w) => $w->isCloseEq(false))->or()->and(fn(BattleWhere $w) => $w->isDisplayEq(true)->isAlldayEq(true)),
    'count', $getCount($db), $count($db));
same('or("(") as the connector of a group',
    (new Battle)->andServiceSeq(7)->andIsClose(0)->or('(')->conditionIsClose(1)->andIsDisplay(1)->condition(')'),
    (new Battle)->serviceSeqEq(7)->isCloseEq(false)->or()->and(fn(BattleWhere $w) => $w->isCloseEq(true)->isDisplayEq(true)),
    'count', $getCount($db), $count($db));

// ---- 4. brace-call form ->{'condition(…)'} ----
same('brace-call tokens',
    (new Battle)->andServiceSeq(7)->{'and('}()->{'condition(IsCloseAndLtStartDt)'}(0, $now)->{'or(IsDisplay)'}(1)->{'condition)'}(),
    (new Battle)->serviceSeqEq(7)->and(fn(BattleWhere $w) => $w->and(fn(BattleWhere $w) => $w->isCloseEq(false)->startDtLt($now))->or(fn(BattleWhere $w) => $w->isDisplayEq(true))),
    'count', $getCount($db), $count($db));
same('brace-call compound name with nested parens',
    (new Battle)->{'conditionServiceSeqAnd((IsCloseAndLtStartDt)Or(IsDisplay))'}(7, 0, $now, 1),
    (new Battle)->serviceSeqEq(7)->and(fn(BattleWhere $w) => $w->and(fn(BattleWhere $w) => $w->isCloseEq(false)->startDtLt($now))->or(fn(BattleWhere $w) => $w->isDisplayEq(true))),
    'count', $getCount($db), $count($db));
$q1 = (new Battle)->orderBySeqAsc()->limit(0, 4);
$q2 = (new Battle)->orderBySeqAsc()->limit(0, 4);
$r1 = $q1->bind($db)->{'getsByServiceSeqAnd((IsCloseAndLtStartDt)Or(IsDisplay))'}( 7, 0, $now, 1);
$r2 = $q2->serviceSeqEq(7)->and(fn(BattleWhere $w) => $w->and(fn(BattleWhere $w) => $w->isCloseEq(false)->startDtLt($now))->or(fn(BattleWhere $w) => $w->isDisplayEq(true)))->bind($db)->all();
same('getsBy with a brace-call compound name', $q1, $q2, 'all');
check(count($r1) === 4 && $r1->toArray() === $r2->toArray(), 'getsBy brace-call rows');

// ---- 5. getBy* / getsBy* / getCount* terminals ----
$q1 = (new Battle)->orderBySeqDesc()->limit(0, 5);
$q2 = (new Battle)->orderBySeqDesc()->limit(0, 5);
$r1 = $q1->bind($db)->getsByServiceSeqAndIsClose(7, 0);
$r2 = $q2->serviceSeqEq(7)->isCloseEq(false)->bind($db)->all();
same('getsByXAndY($db, a, b) → all', $q1, $q2, 'all');
check($r1 instanceof Collection && $r1->toArray() === $r2->toArray() && count($r1) === 5, 'getsBy rows and keys');
$q1 = new Battle;
$q2 = new Battle;
$r1 = $q1->bind($db)->getBySeq(42);
$r2 = $q2->seqEq(42)->bind($db)->one();
same('getByX($db, v) → one', $q1, $q2, 'one');
check($r1 !== null && $r1->toArray() === $r2->toArray() && $r1->getName() === 'battle-42', 'getBy row');
$q1 = (new Battle)->andIsClose(0);
$q2 = (new Battle)->isCloseEq(false);
$r1 = $q1->bind($db)->getCountByServiceSeq(7);
$r2 = $q2->serviceSeqEq(7)->bind($db)->count();
same('getCountByX after and*', $q1, $q2, 'count');
check($r1 === $r2 && $r1 > 0, 'getCountBy value');
same('getAllByX → selectAll + one', (new Battle)->andIsClose(1), (new Battle)->isCloseEq(true), 'one',
    fn(Q $q) => $q->bind($db)->getAllBySeq(42)?->getDescription(), fn(Q $q) => $q->selectAll()->seqEq(42)->bind($db)->one()?->getDescription());
$emptyGetsBy = (new Battle)->bind($db)->getsBySeq(0);
check($emptyGetsBy instanceof Collection && count($emptyGetsBy) === 0 && (new Battle)->bind($db)->getBySeq(0) === null && count((new Battle)->andSeq(0)->bind($db)->gets()) === 0, 'get()/getBy() are null and gets()/getsBy() are empty collections when nothing matches');
check((new Battle)->andServiceSeq(7)->bind($db)->getSumLikeCount() === (new Battle)->serviceSeqEq(7)->bind($db)->sumLikeCount(), 'getSum<Col>($db) → sum<Col>');
check((new Battle)->andServiceSeq(7)->bind($db)->getCount() === 1000, 'getCount → scalar count');
$bound = (new Battle)($db);
check($bound->andServiceSeq(7)->getCount() === 1000, '(new Model)($db)->getCount() → bound scalar count');
$boundCountBy = (new Battle)($db)->andIsClose(0)->getCountByServiceSeq(7);
$explicitCountBy = (new Battle)->isClose(false)->bind($db)->getCountByServiceSeq(7);
check($boundCountBy === $explicitCountBy && $boundCountBy > 0, 'invoke binding and bind() produce the same count');
code(fn() => (new Battle)->bind($db)->get($db), Code::IR_INVALID, 'get accepts no executor argument');
code(fn() => (new Battle)->bind($db)->getCountByServiceSeq(7, $db), Code::IR_INVALID, 'finder rejects extra arguments');
code(fn() => (new Battle)->getsCount(), Code::CONFIG, 'unbound group count fails before execution');
try {
    (new Battle)->bind($db)->getCountByServiceSeq($db, 7);
    check(false, 'finder accepts only a typed value');
} catch (\TypeError) {
    check(true, 'finder accepts only a typed value');
}
$grouped = (new Battle)($db)->andServiceSeq(7)->groupByUserSeq()->getsCount();
check($grouped instanceof Collection && count($grouped) > 0 && $grouped->first()?->getRowCount() > 0, 'getsCount → grouped rows with row_count');
$g1 = (new Battle)->andServiceSeq(7)->orderBySeqAsc()->limit(0, 2)->bind($db)->getsAll();
$g2 = (new Battle)->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 2)->selectAll()->bind($db)->all();
check($g1->toArray() === $g2->toArray() && str_starts_with((string) $g1->first()->getDescription(), 'desc-'), 'getsAll → selectAll + all');

// ---- 6. relation / relations with match<A>With<B> + alias ----
same('relation(match + alias) → relationRel',
    (new Battle)->relation((new User)->matchUserSeqWithSeq()->aliasUser())->andServiceSeq(7)->orderBySeqAsc()->limit(0, 3),
    (new Battle)->relationUser(new User)->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 3), 'all', $gets($db), $all($db));
same('relationAWithB(child) name form', (new Battle)->relationUserSeqWithSeq(new User)->andSeq(42), (new Battle)->relationUser(new User)->seqEq(42), 'one', fn(Q $q) => $q->bind($db)->get(), fn(Q $q) => $q->bind($db)->one());
same('relation → relations nesting with keyName/groupLimit/orderBy',
    (new Battle)->relation((new Service)->matchServiceSeqWithSeq()->aliasService()
        ->relations((new ServiceMember)->matchSeqWithServiceSeq()->aliasMembers()->orderBySeqDesc()->groupLimit(3)->keyNameUserSeq()))
        ->andServiceSeq(7)->orderBySeqAsc()->limit(0, 4),
    (new Battle)->relationService((new Service)
        ->relationsMembers((new ServiceMember)->orderBySeqDesc()->limitPerParent(3)->keyByUserSeq()))
        ->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 4), 'all', $gets($db), $all($db));
$rows = (new Battle)->relation((new User)->matchUserSeqWithSeq()->aliasUser())->bind($db)->getsByServiceSeqAndSeq(7, [6, 106]);
check($rows[6]->getUserModel()->getName() === 'user-' . $rows[6]->getUserSeq() && $rows[6]->getUser() === $rows[6]->getUserModel(), 'get<Rel>Model() reaches the relation');
same('parentNode → flatten',
    (new ServiceMember)->andServiceSeq(7)->orderBySeqAsc()->limit(0, 2)->relation((new User)->matchUserSeqWithSeq()->parentNode()),
    (new ServiceMember)->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 2)->relationUser((new User)->flatten()), 'all', $gets($db), $all($db));
same('possibleX(v) → ifParentXEq',
    (new Battle)->andSeq([7, 8, 14])->orderBySeqAsc()->relation((new User)->possibleIsClose(true)->matchUserSeqWithSeq()),
    (new Battle)->seqIn([7, 8, 14])->orderBySeqAsc()->relationUser((new User)->ifParentIsCloseEq(true)), 'all', $gets($db), $all($db));
same('matchAWithB(false) → dropChildKey; deleteLock → noCascadeDelete',
    (new Service)->andSeq(7)->relations((new ServiceMember)->matchSeqWithServiceSeq(false)->keyNameUserSeq()->deleteLock()->orderBySeqAsc()->groupLimit(2)),
    (new Service)->seqEq(7)->relationsMembers((new ServiceMember)->noCascadeDelete()->orderBySeqAsc()->limitPerParent(2)->keyByUserSeq()->dropChildKey()), 'one',
    fn(Q $q) => $q->bind($db)->get(), fn(Q $q) => $q->bind($db)->one());
same('matchAll<A>With<B> → selectAll + match',
    (new Battle)->andSeq(42)->relation((new User)->matchAllUserSeqWithSeq()),
    (new Battle)->seqEq(42)->relationUser((new User)->selectAll()), 'one', fn(Q $q) => $q->bind($db)->get(), fn(Q $q) => $q->bind($db)->one());

// ---- 7. join<A>With<B> / leftJoin<A>With<B>: and* on the child = where(fn), on* = on(fn) ----
same('join child and* → where(fn); leftJoin child on* → on(fn); navigation stays canonical',
    (new Battle)->joinServiceSeqWithSeq((new Service)->andName('service-7'))->leftJoinUserSeqWithSeq((new User)->onLkName('user'))->andIsClose(0)
        ->and(fn(BattleWhere $w) => $w->isDisplayEq(true)->or()->service(fn(ServiceWhere $s) => $s->seqGt(1000))),
    (new Battle)->joinService((new Service)->where(fn(ServiceWhere $w) => $w->nameEq('service-7')))->leftJoinUser((new User)->on(fn(UserWhere $w) => $w->nameLike('%user%')))->isCloseEq(false)
        ->and(fn(BattleWhere $w) => $w->isDisplayEq(true)->or()->service(fn(ServiceWhere $s) => $s->seqGt(1000))),
    'count', $getCount($db), $count($db));
same('onAOrB compound in ON, relation off a join child',
    (new Battle)->andSeq([6, 106])->orderBySeqAsc()->joinServiceSeqWithSeq((new Service)->onSeqOrName(7, 'x')->relations((new ServiceModule)->matchSeqWithServiceSeq()->aliasModules())),
    (new Battle)->seqIn([6, 106])->orderBySeqAsc()->joinService((new Service)->on(fn(ServiceWhere $w) => $w->seqEq(7)->or()->nameEq('x'))->relationsModules(new ServiceModule)),
    'all', $gets($db), $all($db));

// ---- 8. columns: addColumn* / addAllColumns / removeAllColumns / removeColumn* ----
same('addColumnX / removeColumnX / addColumnXAliasY / format → selectExpr',
    (new Battle)->addColumnDescription()->removeColumnName()->addColumnSeqAliasBattleSeq()->addColumnSeqAliasDoubled('%s * 2')->addColumn('uuid', 'u')->andSeq(42),
    (new Battle)->selectDescription()->unselectName()->selectSeqAs('battle_seq')->selectExpr('doubled', '`seq` * 2')->selectUuidAs('u')->seqEq(42), 'one',
    fn(Q $q) => $q->bind($db)->get(), fn(Q $q) => $q->bind($db)->one());
same('addAllColumns → selectAll', (new Battle)->addAllColumns()->andSeq(42), (new Battle)->selectAll()->seqEq(42), 'one', fn(Q $q) => $q->bind($db)->get(), fn(Q $q) => $q->bind($db)->one());
same('removeAllColumns + addColumn → selectNone + select', (new Battle)->removeAllColumns()->addColumnName()->addColumns(['uuid'])->andSeq(42),
    (new Battle)->selectNone()->selectName()->selectUuid()->seqEq(42), 'one', fn(Q $q) => $q->bind($db)->get(), fn(Q $q) => $q->bind($db)->one());
same('onlyColumns / removeColumns / addRawColumnX', (new Battle)->onlyColumns(['name'])->removeColumns(['uuid'])->addRawColumnHalf('`seq` / 2')->andSeq(42),
    (new Battle)->selectNone()->selectName()->unselectUuid()->selectExpr('half', '`seq` / 2')->seqEq(42), 'one', fn(Q $q) => $q->bind($db)->get(), fn(Q $q) => $q->bind($db)->one());

// ---- 9. orderBy / groupBy / forceIndex ----
same('orderByX (no suffix = Asc), orderByXAndYDesc, orderBy(sql)',
    (new Battle)->andServiceSeq(7)->orderByIsClose()->orderByServiceSeqAndSeqDesc()->orderBy('`seq` % 3')->limit(0, 5),
    (new Battle)->serviceSeqEq(7)->orderByIsCloseAsc()->orderByServiceSeqAsc()->orderBySeqDesc()->orderByExpr('`seq` % 3')->limit(0, 5), 'all', $gets($db), $all($db));
same('groupByXAndY → two groupBy', (new Battle)->andServiceSeq(7)->groupByUserSeqAndIsClose(), (new Battle)->serviceSeqEq(7)->groupByUserSeq()->groupByIsClose(), 'count', $getCount($db), $count($db));
same('forceIndex(name) → forceIndex<Name>', (new Battle)->forceIndex('ix_service')->andServiceSeq(7), (new Battle)->forceIndexIxService()->serviceSeqEq(7), 'count', $getCount($db), $count($db));

// ---- 10. raw fragments (named binds → positional) ----
same('and(sql, [:name => v]) → expr(sql ?, [v])', (new Battle)->andServiceSeq(7)->and('`seq` % 2 = :m', [':m' => 0])->or('`seq` = :s AND `is_close` = :c', ['s' => 42, 'c' => 1]),
    (new Battle)->serviceSeqEq(7)->expr('`seq` % 2 = ?', [0])->or()->expr('`seq` = ? AND `is_close` = ?', [42, 1]), 'count', $getCount($db), $count($db));

// ---- 11. Where-builder compat inside canonical closures ----
same('and*/or*/paren tokens inside and(fn)',
    (new Battle)->serviceSeqEq(7)->and(fn(BattleWhere $w) => $w->andIsDisplay(1)->orIsDisplay(0)->and('(')->conditionIsClose(0)->orLtStartDt($now)->condition(')')),
    (new Battle)->serviceSeqEq(7)->and(fn(BattleWhere $w) => $w->isDisplayEq(true)->or()->isDisplayEq(false)->and(fn(BattleWhere $w) => $w->isCloseEq(false)->or()->startDtLt($now))),
    'count', $getCount($db), $count($db));
same('or(fn) = or()->and(fn) on query and Where',
    (new Battle)->serviceSeqEq(7)->isCloseEq(false)->or(fn(BattleWhere $w) => $w->isDisplayEq(true)->or(fn(BattleWhere $w) => $w->isAlldayEq(true))),
    (new Battle)->serviceSeqEq(7)->isCloseEq(false)->or()->and(fn(BattleWhere $w) => $w->isDisplayEq(true)->or()->and(fn(BattleWhere $w) => $w->isAlldayEq(true))),
    'count', $getCount($db), $count($db));

// ---- 12. keyName / fetchKey on the root → client-side keying ----
$k1 = (new Battle)->andServiceSeq(7)->orderBySeqAsc()->limit(0, 3)->keyNameUserSeq();
$k2 = (new Battle)->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 3)->keyByFn(fn(Row $r) => $r->getUserSeq());
$r1 = $k1->bind($db)->gets();
$r2 = $k2->bind($db)->all();
same('keyName<Col> on the root', $k1, $k2, 'all');
check($r1->keys() === $r2->keys() && $r1->keys() === array_map(fn(Row $r) => $r->getUserSeq(), array_values(iterator_to_array($r2))), 'root keyName keys the collection by the column');
$r3 = (new Battle)->andServiceSeq(7)->orderBySeqAsc()->limit(0, 3)->fetchKey(fn(Row $r) => 'b' . $r->getSeq())->bind($db)->gets();
check($r3->keys() === ['b6', 'b106', 'b206'], 'fetchKey(fn) → keyByFn');
$r4 = (new Battle)->andServiceSeq(7)->orderBySeqAsc()->limit(0, 2)->keyName('uuid')->bind($db)->gets();
check($r4 !== null && array_keys($r4->toArray()) === array_map(fn(array $r) => $r['uuid'], array_values($r4->toArray())), 'keyName(string)');

// ---- 13. writes: create, duplication, setRaw*, delete($db, true) ----
$draft = fn(string $name) => (new Battle)
    ->setName($name)->setReadCount(1)
    ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
    ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00');
$c1 = $draft('compat-create');
$c2 = $draft('compat-create');
same('create($db) → insert($db)', $c1, $c2, 'insert');
$r1 = $c1->bind($db)->create();
$r2 = $c2->bind($db)->insert();
check($r1 !== null && $r2 !== null && $r1->getName() === 'compat-create' && $r2->getSeq() > $r1->getSeq(), 'create inserts');
$r1->bind($db)->delete();
$r2->bind($db)->delete();

$u1 = $draft('compat-u1')->setUuid('compat-upsert')->duplication((new Battle)->setName('compat-u2')->plusReadCount(5)->setDescription(null)->setNameExpr('CONCAT(`name`, ?)', ['!']));
$u2 = $draft('compat-u1')->setUuid('compat-upsert')->onDuplicateSetName('compat-u2')->onDuplicatePlusReadCount(5)->onDuplicateSetDescription(null)->onDuplicateSetNameExpr('CONCAT(`name`, ?)', ['!']);
same('duplication(model) → onDuplicate*', $u1, $u2, 'insert');
$first = $u1->bind($db)->create();
$second = $u2->bind($db)->insert();
check($first !== null && $second !== null && $second->getSeq() === $first->getSeq() && $second->getName() === 'compat-u2!' && $second->getReadCount() === 6, 'duplication updates the existing row');
$d1 = $draft('compat-dup-arr')->setUuid('compat-upsert')->duplication(['name' => 'compat-u3', 'like_count' => 9]);
$d2 = $draft('compat-dup-arr')->setUuid('compat-upsert')->onDuplicateSetName('compat-u3')->onDuplicateSetLikeCount(9);
same('duplication([col => v])', $d1, $d2, 'insert');
$third = $d1->bind($db)->create();
check($third->getSeq() === $first->getSeq() && $third->getName() === 'compat-u3' && $third->getLikeCount() === 9, 'duplication array applied');

$s1 = (new Battle)->andSeq($first->getSeq())->setRawName('CONCAT(:a, :b)', [':a' => 'raw-', ':b' => 'x'])->plusReadCount(2);
$s2 = (new Battle)->seqEq($first->getSeq())->setNameExpr('CONCAT(?, ?)', ['raw-', 'x'])->plusReadCount(2);
same('setRawX(expr, named binds) → setXExpr', $s1, $s2, 'update');
check($s1->bind($db)->update() === 1 && (new Battle)->bind($db)->getBySeq($first->getSeq())->getName() === 'raw-x', 'setRaw applied');
check($s2->bind($db)->update() === 1 && (new Battle)->bind($db)->getBySeq($first->getSeq())->getReadCount() === 10, 'canonical twin applied too');
check((new Battle)->andUuid('compat-upsert')->bind($db)->delete() === 1, 'cleanup');

$svc = $db->transaction(function (Tx $tx) {
    $s = (new Service)->setName('compat-cascade')->bind($tx)->create();
    foreach ([1, 2] as $u) {
        (new ServiceMember)->setServiceSeq($s->getSeq())->setUserSeq($u)->bind($tx)->create();
    }
    (new ServiceModule)->setServiceSeq($s->getSeq())->setName('compat-cascade-mod')->bind($tx)->create();
    return $s;
});
$l1 = (new Service)->relations((new ServiceMember)->matchSeqWithServiceSeq()->aliasMembers()->orderBySeqAsc()->relation((new User)->matchUserSeqWithSeq()))
    ->relations((new ServiceModule)->matchSeqWithServiceSeq()->deleteLock());
$l2 = (new Service)->relationsMembers((new ServiceMember)->orderBySeqAsc()->relationUser(new User))->relationsModules((new ServiceModule)->noCascadeDelete());
$loaded = $l1->bind($db)->getBySeq($svc->getSeq());
$l2->seqEq($svc->getSeq());
same('relation tree with deleteLock', $l1, $l2, 'one');
$n0 = count($log);
$loaded->bind($db)->delete(true);
check(count($log) - $n0 === 3 && str_starts_with($log[$n0], 'DELETE FROM `service_member`') && str_starts_with($log[$n0 + 2], 'DELETE FROM `service`'), 'delete($db, true) = deleteCascade: members first, then the service; deleteLock keeps the modules');
check((new ServiceMember)->andServiceSeq($svc->getSeq())->bind($db)->getCount() === 0 && (new Service)->bind($db)->getBySeq($svc->getSeq()) === null
    && (new ServiceModule)->andServiceSeq($svc->getSeq())->bind($db)->getCount() === 1 && (new User)->andSeq([1, 2])->bind($db)->getCount() === 2, 'delete(true) result');
check((new ServiceModule)->andServiceSeq($svc->getSeq())->bind($db)->delete() === 1, 'cascade cleanup');

// ---- 14. memoization: the same (class, name) decodes once; a second chain is identical ----
$m1 = (new Battle)->conditionServiceSeqAndIsClose(7, 0);
$m2 = (new Battle)->conditionServiceSeqAndIsClose(7, 0);
check(shape($m1, 'count') === shape($m2, 'count') && Compat::decode(Battle::class, 'battle', 'conditionServiceSeqAndIsClose') === Compat::decode(Battle::class, 'battle', 'conditionServiceSeqAndIsClose'), 'memoized decode is stable');

// ---- 15. errors ----
code(fn() => (new Battle)->and('(')->conditionIsDisplay(1)->leftJoinUserSeqWithSeq((new User)->onLkName('u')->condition(')'))->bind($db)->getCount(),
    Code::PAREN_ACROSS_MODELS, 'join child closes the parent\'s paren', "')' in the user chain closes a '(' opened in the battle chain");
code(fn() => (new Battle)->relation((new User)->matchUserSeqWithSeq()->and('(')->conditionSeq(1))->bind($db)->getCount(),
    Code::PAREN_ACROSS_MODELS, 'relation child attached with an open paren', "'(' opened in the user chain is still open when battle attaches it");
code(fn() => (new Battle)->and('(')->conditionIsDisplay(1)->bind($db)->getCount(), Code::PAREN_ACROSS_MODELS, 'root paren never closed', 'never closed');
code(fn() => (new Battle)->conditionIsDisplay(1)->condition(')')->bind($db)->getCount(), Code::PAREN_ACROSS_MODELS, 'root closes nothing', "closes no '('");
code(fn() => (new Battle)->serviceSeqEq(7)->and(fn(BattleWhere $w) => $w->andIsClose(0)->condition(')')), Code::PAREN_ACROSS_MODELS, 'Where closure closes nothing');
code(fn() => (new Battle)->andIsClos(1), Code::COLUMN_UNKNOWN, 'unknown column lists candidates', 'is_close, is_display');
code(fn() => (new Battle)->andGtNope(1), Code::COLUMN_UNKNOWN, 'unknown column after an op word', 'nope');
code(fn() => (new Battle)->relations((new User)->matchUserSeqWithSeq()), Code::RELATION_UNKNOWN, 'relations() on a 1:1 relation', 'relation (1:1), not relations');
code(fn() => (new Battle)->relation((new User)->matchSeqWithSeq()), Code::RELATION_UNKNOWN, 'unknown FK pair', 'no relation to user on battle.seq = user.seq');
code(fn() => (new Battle)->relation((new User)->matchUserSeqWithSeq()->aliasOwner()->relation((new Service)->matchSeqWithSeq())), Code::RELATION_UNKNOWN, 'unknown pair deeper in the tree');
code(fn() => (new Battle)->joinSeqWithSeq(new Service), Code::RELATION_UNKNOWN, 'join on an undeclared pair');
code(fn() => (new Battle)->conditionServiceSeqAndIsClose(7), Code::IR_INVALID, 'argument count', 'expects 2 argument(s), 1 given');
code(fn() => (new Battle)->andServiceSeq(7)->gets(), Code::CONFIG, 'gets() without binding', 'bind a database');
code(fn() => (new Battle)->andSeqWithUserSeq(new User), Code::IR_INVALID, 'column-to-column compat name is not translated', 'EqCol');
code(fn() => (new Battle)->joinServiceSeqWithSeq(new Service, new User), Code::IR_INVALID, 'join off another joined model', 'nest the join');
code(fn() => (new Battle)->addColumn('name', fn() => 1), Code::IR_INVALID, 'callback column', 'compute it on the rows');
try {
    (new Battle)->frobnicate(1);
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
