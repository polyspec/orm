<?php

// The shared cases of the request hook (docs/operations/usage.md "Request hook") with the
// fixture contracts/fixtures/request_hook.dbs: without_hook, reads_params, read_filter,
// insert_assign, loaded_row_writes, invalid_param, restore_key,
// restore_condition, restore_no_key, restore_rewritten_key and
// restore_hook_set_key. A handle from
// Db::withRequestHook calls its hook with each request right before planning;
// the hook changes $r->ir in place and adds parameters with $r->param(). Each
// case installs the fixture on the empty database of a DSN. The unit test
// RequestHookTest.php runs them on SQLite files, and the feature coverage
// CoverageRequestHookTest.php on a case database of the selected database.
declare(strict_types=1);

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Request;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Tests\RequestHookCase\HookEntry;
use Polyspec\Orm\Tests\RequestHookCase\HookItem;
use Polyspec\Orm\Tests\RequestHookCase\HookUpsert;

/**
 * Generates the models of contracts/fixtures/request_hook.dbs into a work directory of the process, removed when the
 * process ends, and loads them; once per process.
 */
function requestHookModels(): void
{
    static $loaded = false;
    if ($loaded) {
        return;
    }
    $loaded = true;
    $work = sys_get_temp_dir() . '/orm-php-request-hook-' . getmypid();
    is_dir($work) || mkdir($work, 0o700, true);
    register_shutdown_function(static function () use ($work): void {
        exec('rm -rf ' . escapeshellarg($work));
    });
    $schemaText = (string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/request_hook.dbs');
    Generator::generate(
        RuntimeModel::build(RuntimeModel::parse(['request_hook.dbs' => $schemaText])),
        "$work/models",
        'Polyspec\\Orm\\Tests\\RequestHookCase'
    );
    requireGeneratedClasses("$work/models");
    require_once "$work/models/bootstrap.php";
}

const READ_KINDS = ['one', 'all', 'count', 'group_count', 'sum', 'avg', 'paginate'];

function hookCheck(bool $ok, string $message): void
{
    \PHPUnit\Framework\Assert::assertTrue($ok, $message);
}

/** The error a call raises, or null when it returns. */
function hookRaised(callable $f): ?Throwable
{
    try {
        $f();
    } catch (Throwable $e) {
        return $e;
    }
    return null;
}

/** A connection on a new SQLite file of the case with the fixture installed. */
function hookConnect(string $dsn): Db
{
    $db = Orm::connect($dsn, new Config());
    $db->utils()->schema()->install(\Polyspec\Orm\Tests\RequestHookCase\schema());
    return $db;
}

/** Adds the rows a1 and a2 of part a and b1 of part b through $db. */
function hookSeed(Db $db): void
{
    foreach ([['a', 'a1'], ['a', 'a2'], ['b', 'b1']] as [$part, $label]) {
        (new HookItem())($db)->setPart($part)->setLabel($label)->create();
    }
}

/** ANDs $pred into the where of query $q: an existing where becomes the first item, as a group. */
function hookAndWhere(array &$q, array $pred): void
{
    if (!isset($q['where']) || $q['where']['items'] === []) {
        $q['where'] = ['items' => [['pred' => $pred]]];
        return;
    }
    $q['where'] = ['items' => [['group' => $q['where']], ['pred' => ['conn' => 'and'] + $pred]]];
}

/** A hook that ANDs part = $part into the root where of every read. */
function readFilter(string $part): Closure
{
    return static function (Request $r) use ($part): void {
        if (requestIsRead($r)) {
            hookAndWhere($r->ir, ['column' => 'part', 'op' => 'eq', 'p' => $r->param($part)]);
        }
    };
}

/**
 * A service scope: ANDs part = $part into the where of the root of every read and of each of its relation queries,
 * nested relations included, as an application scopes every table of a request.
 */
function serviceScope(string $part): Closure
{
    $scope = static function (array &$query, Request $r) use ($part, &$scope): void {
        hookAndWhere($query, ['column' => 'part', 'op' => 'eq', 'p' => $r->param($part)]);
        foreach (array_keys($query['relations'] ?? []) as $i) {
            $scope($query['relations'][$i]['query'], $r);
        }
    };
    return static function (Request $r) use ($scope): void {
        if (requestIsRead($r)) {
            $scope($r->ir, $r);
        }
    };
}

function requestIsRead(Request $request): bool
{
    return in_array($request->ir['kind'], READ_KINDS, true);
}

/** The labels of rows, sorted. */
function hookLabels(iterable $rows): array
{
    $out = [];
    foreach ($rows as $row) {
        $out[] = $row->getLabel();
    }
    sort($out, SORT_STRING);
    return $out;
}

/** The hook reads an INSERT assignment value without changing the bound value that the ORM writes. */
function hookReadsParams(Db $db): void
{
    $seen = null;
    $hooked = $db->withRequestHook(static function (Request $r) use (&$seen): void {
        if ($r->ir['kind'] !== 'insert') {
            return;
        }
        foreach ($r->ir['set'] as $assignment) {
            if ($assignment['column'] === 'label') {
                $seen = $r->params[$assignment['p']];
                $r->params[$assignment['p']] = 'changed';
            }
        }
    });
    (new HookItem())($hooked)->setPart('r')->setLabel('read')->create();
    hookCheck($seen === 'read', 'the hook reads the label value of the INSERT assignment');
    hookCheck(
        in_array('read', hookLabels((new HookItem())($db)->gets()), true),
        'changing the parameter value the hook reads does not change the INSERT: '
            . json_encode(hookLabels((new HookItem())($db)->gets()))
    );
}

/** The native owner case installs the fixture on a SQLite file and checks request parameter readback. */
function readsParamsCase(string $dsn): void
{
    requestHookModels();
    $db = hookConnect($dsn);
    try {
        hookReadsParams($db);
    } finally {
        $db->close();
    }
}

/** The connection, and the connection after a hooked handle was derived from it, read every row. */
function withoutHook(string $dsn): void
{
    $db = hookConnect($dsn);
    hookSeed($db);
    hookCheck(hookLabels((new HookItem())($db)->gets()) === ['a1', 'a2', 'b1'], 'the connection reads every row');
    hookCheck((new HookItem())($db)->getCount() === 3, 'the connection counts every row');
    $db->withRequestHook(readFilter('a'));
    hookCheck(
        hookLabels((new HookItem())($db)->gets()) === ['a1', 'a2', 'b1'],
        'the connection reads every row after a hooked handle was derived'
    );
    hookCheck(
        (new HookItem())($db)->getCount() === 3,
        'the connection counts every row after a hooked handle was derived'
    );
    $db->close();
}

/** A predicate the hook adds filters a read, a count and a page; another hooked handle filters with its own value. */
function readFilterCase(string $dsn): void
{
    $db = hookConnect($dsn);
    hookSeed($db);
    $a = $db->withRequestHook(readFilter('a'));
    hookCheck(hookLabels((new HookItem())($a)->gets()) === ['a1', 'a2'], 'the hooked read returns the rows of part a');
    hookCheck((new HookItem())($a)->getCount() === 2, 'the hooked count is 2');
    $page = (new HookItem())($a)->getsPage(1, 10);
    hookCheck($page->totalCount === 2, "the hooked page total is 2, got {$page->totalCount}");
    hookCheck($page->items->count() === 2, 'the hooked page holds 2 rows');
    $b = $db->withRequestHook(readFilter('b'));
    hookCheck(hookLabels((new HookItem())($b)->gets()) === ['b1'], 'the handle hooked with b reads the row of part b');
    $db->close();
}

function sameHandleChildHookOnce(string $dsn): void
{
    $db = hookConnect($dsn);
    hookSeed($db);
    (new HookEntry())($db)->setPart('a')->setLabel('parent')->create();
    $calls = [];
    $hooked = $db->withRequestHook(static function (Request $r) use (&$calls): void {
        if (in_array($r->ir['kind'], READ_KINDS, true)) {
            $entity = $r->ir['entity'];
            $calls[$entity] = ($calls[$entity] ?? 0) + 1;
        }
    });
    $parent = (new HookEntry())($hooked)
        ->relations((new HookItem())($hooked)->matchPartWithPart())
        ->get();
    hookCheck($calls === ['hook_entry' => 1, 'hook_item' => 1], 'the root and explicitly connected child each run one hook: ' . json_encode($calls));
    hookCheck($parent instanceof HookEntry, 'the relation query returns its parent row');
    $children = hookLabels($parent->getHookItemModels());
    hookCheck($children === ['a1', 'a2'], 'the relation child returns the two matching rows: ' . json_encode($children));
    $db->close();
}


/**
 * relation() and relations() run under a service scope: a hook that scopes the root of every read and each of its
 * relation queries reads only the rows of its scope, with a relation child connected to the hooked handle (a request of
 * its own, which the hook scopes as a root) or not (a relation query of the parent's request). The parent a1 of part a
 * matches the items labeled a1 of parts a and b by label, and under the scope of part a it attaches only the item of
 * part a.
 */
function relationScope(string $dsn): void
{
    $db = hookConnect($dsn);
    hookSeed($db);
    (new HookItem())($db)->setPart('b')->setLabel('a1')->create();
    foreach ([['a', 'a1'], ['b', 'b1']] as [$part, $label]) {
        (new HookEntry())($db)->setPart($part)->setLabel($label)->create();
    }
    $parts = static function (iterable $rows): array {
        $out = [];
        foreach ($rows as $row) {
            $out[] = $row->getPart() . '/' . $row->getLabel();
        }
        sort($out, SORT_STRING);
        return $out;
    };
    $unscoped = (new HookEntry())($db)->label('a1')->relations((new HookItem())->matchLabelWithLabel())->get();
    hookCheck(
        $unscoped instanceof HookEntry && $parts($unscoped->getHookItemModels()) === ['a/a1', 'b/a1'],
        'without the scope the parent a1 matches the items a1 of both parts'
    );
    $scoped = $db->withRequestHook(serviceScope('a'));
    foreach ([static fn() => (new HookItem())($scoped), static fn() => new HookItem()] as $child) {
        $many = [];
        foreach ((new HookEntry())($scoped)->relations($child()->matchLabelWithLabel())->gets() as $row) {
            $many[] = [$row->getLabel(), $parts($row->getHookItemModels())];
        }
        hookCheck(
            $many === [['a1', ['a/a1']]],
            'relations() under the scope of part a reads the parent and the items of part a: ' . json_encode($many)
        );
        $one = [];
        foreach ((new HookEntry())($scoped)->relation($child()->matchLabelWithLabel())->gets() as $row) {
            $one[] = [$row->getLabel(), $row->getHookItemModel()?->getPart()];
        }
        hookCheck(
            $one === [['a1', 'a']],
            'relation() under the scope of part a attaches the item of part a: ' . json_encode($one)
        );
    }
    $db->close();
}

/** An assignment the hook adds is written by a single and a bulk insert. */
function insertAssign(string $dsn): void
{
    $db = hookConnect($dsn);
    $h = $db->withRequestHook(static function (Request $r): void {
        if ($r->ir['kind'] !== 'insert') {
            return;
        }
        $r->ir['set'][] = ['column' => 'part', 'p' => $r->param('h')];
        foreach (array_keys($r->ir['rows'] ?? []) as $i) {
            $r->ir['rows'][$i][] = $r->param('h');
        }
    });
    (new HookItem())($h)->setLabel('single')->create();
    $written = (new HookItem())($h)->creates(
        [(new HookItem())->setLabel('bulk1'), (new HookItem())->setLabel('bulk2')],
        2
    );
    hookCheck($written === 2, "the bulk insert writes 2 rows, got $written");
    $parts = [];
    foreach ((new HookItem())($db)->gets() as $row) {
        $parts[$row->getLabel()] = $row->getPart();
    }
    ksort($parts, SORT_STRING);
    hookCheck(
        $parts === ['bulk1' => 'h', 'bulk2' => 'h', 'single' => 'h'],
        'every inserted row holds the part the hook assigned: ' . json_encode($parts)
    );
    $db->close();
}

/**
 * The hook sets scope_col on the insert, and the conflict key (scope_col, name) of the upsert is checked after the
 * hook. The caller sets only name; the update sets hits. The first call inserts and the second updates the row.
 */
function upsertScope(string $dsn): void
{
    $db = hookConnect($dsn);
    $h = $db->withRequestHook(static function (Request $r): void {
        if ($r->ir['kind'] === 'insert') {
            $r->ir['set'][] = ['column' => 'scope_col', 'p' => $r->param('a')];
        }
    });
    for ($call = 1; $call <= 2; $call++) {
        (new HookUpsert())($h)->setName('k')->duplication((new HookUpsert())->setHits(7))->create();
    }
    $rows = [];
    foreach ((new HookUpsert())($db)->gets() as $row) {
        $rows[] = [$row->getScopeCol(), $row->getName(), $row->getHits()];
    }
    hookCheck($rows === [['a', 'k', 7]], 'the stored row holds scope_col a, name k and hits 7: ' . json_encode($rows));
    $db->close();
}

/** The update and the delete of a row loaded through a hooked handle pass the hook, also in a transaction. */
function loadedRowWrites(string $dsn): void
{
    $db = hookConnect($dsn);
    hookSeed($db);
    $kinds = [];
    $h = $db->withRequestHook(static function (Request $r) use (&$kinds): void {
        $kinds[] = $r->ir['kind'];
        if ($r->ir['kind'] === 'update' || $r->ir['kind'] === 'delete') {
            hookAndWhere($r->ir, ['column' => 'part', 'op' => 'eq', 'p' => $r->param('none')]);
        }
    });
    $rows = (new HookItem())($h)->gets();
    $row = null;
    foreach ($rows as $candidate) {
        if ($candidate->getLabel() === 'a1') {
            $row = $candidate;
        }
    }
    hookCheck($row !== null, 'the hooked read returns a1');
    if ($row === null) {
        $db->close();
        return;
    }
    hookCheck($row->connection() === $h, 'the loaded row keeps the hooked handle');
    $row->setLabel('changed')->update();
    hookCheck(
        in_array('update', $kinds, true),
        'the hook receives the update of the loaded row: ' . json_encode($kinds)
    );
    hookCheck(
        hookLabels((new HookItem())($db)->gets()) === ['a1', 'a2', 'b1'],
        'the predicate the hook adds keeps the update from changing a1'
    );
    $row->delete();
    hookCheck(
        in_array('delete', $kinds, true),
        'the hook receives the delete of the loaded row: ' . json_encode($kinds)
    );
    hookCheck((new HookItem())($db)->getCount() === 3, 'the predicate the hook adds keeps the delete from removing a1');
    $kinds = [];
    $h->transaction(static function (): void {
        (new HookItem())->gets();
    });
    hookCheck(
        $kinds === ['all'],
        'the hook receives the read of a model without a connection in a transaction of the hooked handle: '
            . json_encode(
                $kinds
            )
    );
    $db->close();
}

/** A parameter index outside the parameters fails with IR_INVALID before any statement. */
function invalidParam(string $dsn): void
{
    $db = hookConnect($dsn);
    $events = 0;
    $db->subscribe(static function () use (&$events): void {
        $events++;
    });
    $h = $db->withRequestHook(static function (Request $r): void {
        hookAndWhere($r->ir, ['column' => 'part', 'op' => 'eq', 'p' => count($r->params) + 5]);
    });
    $e = hookRaised(fn() => (new HookItem())($h)->getCount());
    hookCheck(
        $e instanceof OrmException && $e->code_ === Code::IR_INVALID,
        'the hooked count fails with IR_INVALID: ' . ($e === null ? 'nothing' : $e::class . ': ' . $e->getMessage())
    );
    hookCheck($events === 0, "the refused request sends no statement, got $events events");
    $db->close();
}

/** A hook that ANDs part = $part into the root where of every read and restore. */
function partScope(string $part): Closure
{
    return static function (Request $r) use ($part): void {
        if ($r->ir['kind'] === 'restore' || requestIsRead($r)) {
            hookAndWhere($r->ir, ['column' => 'part', 'op' => 'eq', 'p' => $r->param($part)]);
        }
    };
}

/**
 * Creates the hook_entry rows (a, x), (b, x) and (a, y) with note n0 through $db, soft deletes each and
 * returns their ids by part and label.
 */
function seedDeletedEntries(Db $db): array
{
    $ids = [];
    foreach ([['a', 'x'], ['b', 'x'], ['a', 'y']] as [$part, $label]) {
        $row = (new HookEntry())($db)->setPart($part)->setLabel($label)->setNote('n0')->create();
        $ids[$part . $label] = $row->getId();
        $row->delete();
    }
    return $ids;
}

/** The id and note of every hook_entry row that $db reads, which are the rows not deleted. */
function entryRows(Db $db): array
{
    $out = [];
    foreach ((new HookEntry())($db)->gets() as $row) {
        $out[] = [$row->getId(), $row->getNote()];
    }
    return $out;
}

/** The set names label and the hook's condition names part: together they cover the unique key. */
function restoreKeyCase(string $dsn): void
{
    $db = hookConnect($dsn);
    $ids = seedDeletedEntries($db);
    $row = (new HookEntry())($db->withRequestHook(partScope('a')))->setLabel('x')->setNote('n1')->restore();
    hookCheck(
        [$row->getId(), $row->getPart(), $row->getLabel(), $row->getNote()] === [$ids['ax'], 'a', 'x', 'n1'],
        'the restore returns (a, x) with note n1: ' . json_encode($row->toArray())
    );
    hookCheck(
        entryRows($db) === [[$ids['ax'], 'n1']],
        'the connection reads only (a, x) with note n1: ' . json_encode(entryRows($db))
    );
    $db->close();
}

/** The set names the primary key; the hook's condition narrows the restore to the rows of its part. */
function restoreConditionCase(string $dsn): void
{
    $db = hookConnect($dsn);
    $ids = seedDeletedEntries($db);
    $e = hookRaised(
        fn() => (new HookEntry())($db->withRequestHook(partScope('b')))->setId($ids['ay'])->setNote('n2')->restore()
    );
    hookCheck(
        $e instanceof OrmException && $e->code_ === Code::NO_ROWS,
        'the restore outside the hook condition fails with NO_ROWS: ' . (
            $e === null ? 'nothing' : $e::class . ': ' . $e->getMessage()
        )
    );
    hookCheck(
        entryRows($db) === [],
        'the restore outside the hook condition restores no row: ' . json_encode(entryRows($db))
    );
    $row = (new HookEntry())($db->withRequestHook(partScope('a')))->setId($ids['ay'])->setNote('n2')->restore();
    hookCheck(
        [$row->getId(), $row->getLabel(), $row->getNote()] === [$ids['ay'], 'y', 'n2'],
        'the restore inside the hook condition returns (a, y) with note n2: ' . json_encode($row->toArray())
    );
    $db->close();
}

/** Part from the hook and no label cover no key: IR_INVALID before any statement. */
function restoreNoKeyCase(string $dsn): void
{
    $db = hookConnect($dsn);
    seedDeletedEntries($db);
    $events = 0;
    $db->subscribe(static function () use (&$events): void {
        $events++;
    });
    $e = hookRaised(fn() => (new HookEntry())($db->withRequestHook(partScope('a')))->setNote('n3')->restore());
    hookCheck(
        $e instanceof OrmException && $e->code_ === Code::IR_INVALID,
        'the restore without a key fails with IR_INVALID: ' . (
            $e === null ? 'nothing' : $e::class . ': ' . $e->getMessage()
        )
    );
    hookCheck($events === 0, "the refused restore sends no statement, got $events events");
    $db->close();
}

/** The hook scopes the restore to part a and gives the model's label its own value y. */
function restoreRewrittenKeyCase(string $dsn): void
{
    $db = hookConnect($dsn);
    $ids = seedDeletedEntries($db);
    $scope = partScope('a');
    $h = $db->withRequestHook(static function (Request $r) use ($scope): void {
        if ($r->ir['kind'] === 'restore') {
            foreach (array_keys($r->ir['set']) as $i) {
                if ($r->ir['set'][$i]['column'] === 'label') {
                    $r->ir['set'][$i]['p'] = $r->param('y');
                }
            }
        }
        $scope($r);
    });
    $row = (new HookEntry())($h)->setLabel('x')->setNote('n4')->restore();
    hookCheck(
        [$row->getId(), $row->getLabel(), $row->getNote()] === [$ids['ay'], 'y', 'n4'],
        'the restore returns (a, y) with note n4: ' . json_encode($row->toArray())
    );
    hookCheck(
        entryRows($db) === [[$ids['ay'], 'n4']],
        'the connection reads only (a, y) with note n4: ' . json_encode(entryRows($db))
    );
    $db->close();
}

/** Runs one restore with a request mutation and case-specific result assertions. */
function restoreWithHook(string $dsn, string $note, \Closure $modify, \Closure $verify): void
{
    $db = hookConnect($dsn);
    $ids = seedDeletedEntries($db);
    try {
        $h = $db->withRequestHook(static function (Request $r) use ($modify): void {
            if ($r->ir['kind'] === 'restore') {
                $modify($r);
            }
        });
        $row = (new HookEntry())($h)->setLabel('x')->setNote($note)->restore();
        $verify($db, $ids, $row);
    } finally {
        $db->close();
    }
}

/** The hook puts part a first in the set; the model's label completes the unique key. */
function restoreHookSetKeyCase(string $dsn): void
{
    restoreWithHook(
        $dsn,
        'n5',
        static function (Request $r): void {
            array_unshift($r->ir['set'], ['column' => 'part', 'p' => $r->param('a')]);
        },
        static function (Db $db, array $ids, HookEntry $row): void {
            hookCheck(
                [$row->getId(), $row->getPart(), $row->getNote()] === [$ids['ax'], 'a', 'n5'],
                'the restore returns (a, x) with note n5: ' . json_encode($row->toArray())
            );
            hookCheck(
                entryRows($db) === [[$ids['ax'], 'n5']],
                'the connection reads only (a, x) with note n5: ' . json_encode(entryRows($db))
            );
        }
    );
}

/** The hook gives the model's label its own value y and sets part a after it, with no where parameter. */
function restoreRewrittenKeySetScopeCase(string $dsn): void
{
    restoreWithHook(
        $dsn,
        'n6',
        static function (Request $r): void {
            foreach ($r->ir['set'] as $i => $a) {
                if ($a['column'] === 'label') {
                    $r->ir['set'][$i]['p'] = $r->param('y');
                }
            }
            $r->ir['set'][] = ['column' => 'part', 'p' => $r->param('a')];
        },
        static function (Db $db, array $ids, HookEntry $row): void {
            hookCheck(
                [$row->getId(), $row->getLabel(), $row->getNote()] === [$ids['ay'], 'y', 'n6'],
                'the restore returns (a, y) with note n6: ' . json_encode($row->toArray())
            );
            hookCheck(
                entryRows($db) === [[$ids['ay'], 'n6']],
                'the connection reads only (a, y) with note n6: ' . json_encode(entryRows($db))
            );
        }
    );
}

/** The case functions by shared case ID; each takes the DSN of an empty database. */
const REQUEST_HOOK_CASES = [
    'without_hook' => 'withoutHook',
    'read_filter' => 'readFilterCase',
    'same_handle_child_hook_once' => 'sameHandleChildHookOnce',
    'relation_scope' => 'relationScope',
    'insert_assign' => 'insertAssign',
    'upsert_scope' => 'upsertScope',
    'loaded_row_writes' => 'loadedRowWrites',
    'invalid_param' => 'invalidParam',
    'restore_key' => 'restoreKeyCase',
    'restore_condition' => 'restoreConditionCase',
    'restore_no_key' => 'restoreNoKeyCase',
    'restore_rewritten_key' => 'restoreRewrittenKeyCase',
    'restore_hook_set_key' => 'restoreHookSetKeyCase',
    'restore_rewritten_key_set_scope' => 'restoreRewrittenKeySetScopeCase',
];

/** Runs case $id on the empty database of $dsn; a failed check of it fails the running PHPUnit test. */
function runRequestHookCase(string $id, string $dsn): void
{
    if (!isset(REQUEST_HOOK_CASES[$id])) {
        throw new RuntimeException(
            "unknown request hook case $id; the cases are " . implode(', ', array_keys(REQUEST_HOOK_CASES))
        );
    }
    requestHookModels();
    (REQUEST_HOOK_CASES[$id])($dsn);
}
