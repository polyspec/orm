<?php
declare(strict_types=1);

require dirname(__DIR__, 2) . '/clients/php/tests/autoload.php';
require __DIR__ . '/result_php_helpers.php';
require_once dirname(__DIR__) . '/testcase.php';

use Polyspec\Orm\Model;

// result check는 memory 안에서 result 값 몇 개를 쓰고 비교하는 case 하나다.
testcase_begin('conformance_result_php', TESTCASE_COMPUTE);
$result = [
    'exact' => Polyspec\OrderedJson\parse('9007199254740993'),
    'styled' => ['kind' => 'value', 'value' => Polyspec\OrderedJson\parse('{"n":9007199254740993}')],
    'sqlNull' => ['kind' => 'sql-null'],
];
$want = '{"exact":9007199254740993,"styled":{"kind":"value","value":{"n":9007199254740993}},"sqlNull":{"kind":"sql-null"}}';
if (Model::jsonText($result) !== $want) {
    throw new RuntimeException('conformance result changed an ordered-json number or styled state');
}
if (derivedInteger(2) !== 2 || derivedInteger('2') !== 2) {
    throw new RuntimeException('valid derived integer changed');
}
foreach ([null, true, '', 'bad', '2.0', '2.5', 2.5, INF] as $invalid) {
    try {
        derivedInteger($invalid);
        throw new RuntimeException('invalid derived integer was accepted');
    } catch (InvalidArgumentException) {
        // The invalid value was rejected.
    }
}
$cause = new DomainException('invalid row');
try {
    executeVector('invalid', static fn(): never => throw $cause);
    throw new RuntimeException('unexpected vector error was accepted');
} catch (RuntimeException $error) {
    if ($error->getPrevious() !== $cause || !str_contains($error->getMessage(), 'invalid')) {
        throw new RuntimeException('unexpected vector error was altered');
    }
}
$transactionCalled = false;
$value = executeVector('write', static fn(): int => 7, static function (callable $task) use (&$transactionCalled): int {
    $transactionCalled = true;
    return $task();
});
if (!$transactionCalled || $value !== 7) {
    throw new RuntimeException('write vector did not use its transaction');
}
testcase_end();
