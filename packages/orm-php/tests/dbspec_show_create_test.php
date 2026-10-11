<?php
declare(strict_types=1);
// MysqlCatalog::createChecks, the reader of a SHOW CREATE TABLE statement (T62-4-8), reads every case of
// tests/dbspec/show-create.json to the body that the case expects in CHECK_CLAUSE form, or to no body for a
// name the statement does not have.
// Usage: php packages/orm-php/tests/dbspec_show_create_test.php
require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Dbspec\MysqlCatalog;

$data = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/show-create.json'), true, 512, JSON_THROW_ON_ERROR);
$reader = new ReflectionMethod(MysqlCatalog::class, 'createChecks');

$cases = new TestCases();
foreach ($data['cases'] as $case) {
    $cases->run('dbspec/show-create ' . $case['id'], TESTCASE_COMPUTE, function (callable $step) use ($case, $reader): void {
        $step('read the CHECK ' . $case['name']);
        $checks = $reader->invoke(null, implode("\n", $case['create']) . "\n");
        $got = $checks[$case['name']] ?? null;
        if ($case['expected'] === 'not found') {
            if ($got !== null) {
                throw new RuntimeException("createChecks reads {$case['name']} as " . var_export($got, true) . ', want not found');
            }
            return;
        }
        if ($got !== $case['expected']) {
            throw new RuntimeException("createChecks reads {$case['name']} as " . var_export($got, true) . ', want ' . var_export($case['expected'], true));
        }
    });
}
$cases->finish();
