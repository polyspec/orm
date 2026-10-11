<?php
// The request hook of the PHP client (docs/usage.md "Request hook") on SQLite,
// with the shared fixture contracts/fixtures/request_hook.dbs. A handle from
// Db::withRequestHook calls its hook with each request right before planning;
// the hook changes $r->ir in place and adds parameters with $r->param(). The
// cases are the shared cases every client runs: without_hook, read_filter,
// insert_assign, loaded_row_writes and invalid_param. Each case runs on a
// SQLite file of its own under a temporary directory that the test removes on
// every path.
// Usage: php packages/orm-php/tests/request_hook_test.php [case ...]
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Request;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Tests\RequestHookCase\HookItem;

$work = sys_get_temp_dir() . '/orm-php-request-hook-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$schemaText = (string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/request_hook.dbs');
Generator::generate(RuntimeModel::build(RuntimeModel::parse(['request_hook.dbs' => $schemaText])), "$work/models", 'Polyspec\\Orm\\Tests\\RequestHookCase');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\RequestHookCase\\')) {
        require "$work/models/" . substr($class, strlen('Polyspec\\Orm\\Tests\\RequestHookCase\\')) . '.php';
    }
});
require "$work/models/bootstrap.php";

const READ_KINDS = ['one', 'all', 'count', 'group_count', 'sum', 'avg', 'paginate'];

$failures = 0;
$current = '';
$databases = 0;

function check(bool $ok, string $message): void
{
    global $failures, $current;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $message\n");
    }
}

/** The error a call raises, or null when it returns. */
function raised(callable $f): ?Throwable
{
    try {
        $f();
    } catch (Throwable $e) {
        return $e;
    }
    return null;
}

/** A connection on a new SQLite file of the case with the fixture installed. */
function connect(): Db
{
    global $work, $databases;
    $databases++;
    $db = Orm::connect("sqlite://$work/case-$databases.sqlite", new Config());
    $db->utils()->schema()->install(\Polyspec\Orm\Tests\RequestHookCase\schema());
    return $db;
}

/** Adds the rows a1 and a2 of part a and b1 of part b through $db. */
function seed(Db $db): void
{
    foreach ([['a', 'a1'], ['a', 'a2'], ['b', 'b1']] as [$part, $label]) {
        (new HookItem)($db)->setPart($part)->setLabel($label)->create();
    }
}

/** ANDs $pred into the where of query $q: an existing where becomes the first item, as a group. */
function andWhere(array &$q, array $pred): void
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
        if (in_array($r->ir['kind'], READ_KINDS, true)) {
            andWhere($r->ir, ['column' => 'part', 'op' => 'eq', 'p' => $r->param($part)]);
        }
    };
}

/** The labels of rows, sorted. */
function labels(iterable $rows): array
{
    $out = [];
    foreach ($rows as $row) {
        $out[] = $row->getLabel();
    }
    sort($out, SORT_STRING);
    return $out;
}

/** The connection, and the connection after a hooked handle was derived from it, read every row. */
function withoutHook(): void
{
    $db = connect();
    seed($db);
    check(labels((new HookItem)($db)->gets()) === ['a1', 'a2', 'b1'], 'the connection reads every row');
    check((new HookItem)($db)->getCount() === 3, 'the connection counts every row');
    $db->withRequestHook(readFilter('a'));
    check(labels((new HookItem)($db)->gets()) === ['a1', 'a2', 'b1'], 'the connection reads every row after a hooked handle was derived');
    check((new HookItem)($db)->getCount() === 3, 'the connection counts every row after a hooked handle was derived');
    $db->close();
}

/** A predicate the hook adds filters a read, a count and a page; another hooked handle filters with its own value. */
function readFilterCase(): void
{
    $db = connect();
    seed($db);
    $a = $db->withRequestHook(readFilter('a'));
    check(labels((new HookItem)($a)->gets()) === ['a1', 'a2'], 'the hooked read returns the rows of part a');
    check((new HookItem)($a)->getCount() === 2, 'the hooked count is 2');
    $page = (new HookItem)($a)->getsPage(1, 10);
    check($page->totalCount === 2, "the hooked page total is 2, got {$page->totalCount}");
    check($page->items->count() === 2, 'the hooked page holds 2 rows');
    $b = $db->withRequestHook(readFilter('b'));
    check(labels((new HookItem)($b)->gets()) === ['b1'], 'the handle hooked with b reads the row of part b');
    $db->close();
}

/** An assignment the hook adds is written by a single and a bulk insert. */
function insertAssign(): void
{
    $db = connect();
    $h = $db->withRequestHook(static function (Request $r): void {
        if ($r->ir['kind'] !== 'insert') {
            return;
        }
        $r->ir['set'][] = ['column' => 'part', 'p' => $r->param('h')];
        foreach (array_keys($r->ir['rows'] ?? []) as $i) {
            $r->ir['rows'][$i][] = $r->param('h');
        }
    });
    (new HookItem)($h)->setLabel('single')->create();
    $written = (new HookItem)($h)->creates([(new HookItem)->setLabel('bulk1'), (new HookItem)->setLabel('bulk2')]);
    check($written === 2, "the bulk insert writes 2 rows, got $written");
    $parts = [];
    foreach ((new HookItem)($db)->gets() as $row) {
        $parts[$row->getLabel()] = $row->getPart();
    }
    ksort($parts, SORT_STRING);
    check($parts === ['bulk1' => 'h', 'bulk2' => 'h', 'single' => 'h'], 'every inserted row holds the part the hook assigned: ' . json_encode($parts));
    $db->close();
}

/** The update and the delete of a row loaded through a hooked handle pass the hook, also in a transaction. */
function loadedRowWrites(): void
{
    $db = connect();
    seed($db);
    $kinds = [];
    $h = $db->withRequestHook(static function (Request $r) use (&$kinds): void {
        $kinds[] = $r->ir['kind'];
        if ($r->ir['kind'] === 'update' || $r->ir['kind'] === 'delete') {
            andWhere($r->ir, ['column' => 'part', 'op' => 'eq', 'p' => $r->param('none')]);
        }
    });
    $rows = (new HookItem)($h)->gets();
    $row = null;
    foreach ($rows as $candidate) {
        if ($candidate->getLabel() === 'a1') {
            $row = $candidate;
        }
    }
    check($row !== null, 'the hooked read returns a1');
    if ($row === null) {
        $db->close();
        return;
    }
    check($row->connection() === $h, 'the loaded row keeps the hooked handle');
    $row->setLabel('changed')->update();
    check(in_array('update', $kinds, true), 'the hook receives the update of the loaded row: ' . json_encode($kinds));
    check(labels((new HookItem)($db)->gets()) === ['a1', 'a2', 'b1'], 'the predicate the hook adds keeps the update from changing a1');
    $row->delete();
    check(in_array('delete', $kinds, true), 'the hook receives the delete of the loaded row: ' . json_encode($kinds));
    check((new HookItem)($db)->getCount() === 3, 'the predicate the hook adds keeps the delete from removing a1');
    $kinds = [];
    $h->transaction(static function (): void {
        (new HookItem)->gets();
    });
    check($kinds === ['all'], 'the hook receives the read of a model without a connection in a transaction of the hooked handle: ' . json_encode($kinds));
    $db->close();
}

/** A parameter index outside the parameters fails with IR_INVALID before any statement. */
function invalidParam(): void
{
    $db = connect();
    $events = 0;
    $db->subscribe(static function () use (&$events): void {
        $events++;
    });
    $h = $db->withRequestHook(static function (Request $r): void {
        andWhere($r->ir, ['column' => 'part', 'op' => 'eq', 'p' => count($r->params) + 5]);
    });
    $e = raised(fn() => (new HookItem)($h)->getCount());
    check($e instanceof OrmException && $e->code_ === Code::IR_INVALID, 'the hooked count fails with IR_INVALID: ' . ($e === null ? 'nothing' : $e::class . ': ' . $e->getMessage()));
    check($events === 0, "the refused request sends no statement, got $events events");
    $db->close();
}

$cases = [
    'without_hook' => withoutHook(...),
    'read_filter' => readFilterCase(...),
    'insert_assign' => insertAssign(...),
    'loaded_row_writes' => loadedRowWrites(...),
    'invalid_param' => invalidParam(...),
];
$selected = array_slice($argv, 1) ?: array_keys($cases);
foreach ($selected as $case) {
    if (!isset($cases[$case])) {
        throw new RuntimeException("unknown case $case");
    }
    $before = $failures;
    $current = $case;
    $passed = testcase_run("request-hook/$case", TESTCASE_DATABASE, static function (callable $step) use ($cases, $case, $before): void {
        $cases[$case]();
        if ($GLOBALS['failures'] > $before) {
            throw new RuntimeException(($GLOBALS['failures'] - $before) . ' check(s) failed; each FAIL line above names one');
        }
    });
    if (!$passed && $failures === $before) {
        $failures++;
    }
}
if ($failures > 0) {
    exit(1);
}
