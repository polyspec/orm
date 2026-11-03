<?php

// The native cases of the request hook (docs/operations/usage.md "Request hook") that a declarative step of
// contracts/fixtures/request_hook/request_hook.json cannot run (FCV-4): the hooked handle sharing the state of its
// connection, and a hook that reads the bound parameters. Each case installs the fixture request_hook/request_hook.dbs
// on the empty database of a DSN. A handle from Db::withRequestHook calls its hook with each request right before
// planning; the hook changes $r->ir in place and adds parameters with $r->param(). The unit test RequestHookTest.php
// runs them on SQLite files.
declare(strict_types=1);

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Request;
use Polyspec\Orm\Tests\RequestHookCase\HookEntry;
use Polyspec\Orm\Tests\RequestHookCase\HookItem;
use Polyspec\Orm\Tests\RequestHookCase\HookUpsert;

/**
 * Generates the models of contracts/fixtures/request_hook/request_hook.dbs into a work directory of the process,
 * removed when the process ends, and loads them; once per process.
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
    $schemaText = (string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/request_hook/request_hook.dbs');
    generateModels(
        ['request_hook.dbs' => $schemaText],
        "$work/source",
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

/** A connection on a new SQLite file of the case with the fixture installed. */
function hookConnect(string $dsn): Db
{
    $db = Orm::connect($dsn, new Config());
    $db->utils()->schema()->install(\Polyspec\Orm\Tests\RequestHookCase\schema());
    return $db;
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

/** The case functions by shared case ID; each takes the DSN of an empty database. */
const REQUEST_HOOK_CASES = [
    'reads_params' => 'readsParamsCase',
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
