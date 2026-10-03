<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Orm\Decimal;
use Orm\OrmException;
use Polyspec\Orm\Tests\Model\Author;

$fixture = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/decimal_model.json'), true, 512, JSON_THROW_ON_ERROR);
$columns = [];
foreach ($fixture['columns'] as $column) {
    $columns[$column['id']] = $column;
}
foreach ($fixture['cases'] as $case) {
    testcase_begin("decimal_model/{$case['id']}", TESTCASE_COMPUTE);
    $column = $columns[$case['column']] ?? throw new RuntimeException("unknown column {$case['column']}");
    try {
        $actual = Decimal::normalize($case['input'], $column['precision'], $column['scale']);
        if (isset($case['expected']['error'])) {
            throw new RuntimeException("{$case['id']}: expected {$case['expected']['error']}");
        }
        if ($actual !== $case['expected']['value']) {
            throw new RuntimeException("{$case['id']}: got $actual; expected {$case['expected']['value']}");
        }
        $stored = Decimal::scaled($case['input'], $column['precision'], $column['scale']);
        $decoded = Decimal::fromScaled($stored, $column['precision'], $column['scale']);
        if ($decoded !== $case['expected']['value']) {
            throw new RuntimeException("{$case['id']}: SQLite round trip got $decoded");
        }
    } catch (OrmException $error) {
        if (($case['expected']['error'] ?? null) !== $error->code_) {
            throw new RuntimeException("{$case['id']}: unexpected {$error->code_}", 0, $error);
        }
    }
    testcase_end();
}

testcase_begin('decimal_model/generated_decimal_type', TESTCASE_COMPUTE);
$getter = (new ReflectionMethod(Author::class, 'getPrice'))->getReturnType();
$setter = (new ReflectionMethod(Author::class, 'setPrice'))->getParameters()[0]->getType();
if (!$getter instanceof ReflectionNamedType || !$setter instanceof ReflectionNamedType || $getter->getName() !== 'string' || $setter->getName() !== 'string') {
    throw new RuntimeException('generated decimal getter and setter must use nullable string');
}
testcase_end();
