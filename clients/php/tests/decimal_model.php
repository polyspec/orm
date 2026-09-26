<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\Decimal;
use Orm\OrmException;
use Polyspec\Orm\Tests\Model\Author;

$fixture = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/decimal_model.json'), true, 512, JSON_THROW_ON_ERROR);
$columns = [];
foreach ($fixture['columns'] as $column) {
    $columns[$column['id']] = $column;
}
foreach ($fixture['cases'] as $case) {
    $column = $columns[$case['column']] ?? throw new RuntimeException("unknown column {$case['column']}");
    try {
        $actual = Decimal::normalize($case['input'], $column['precision'], $column['scale']);
        if (isset($case['error'])) {
            throw new RuntimeException("{$case['id']}: expected {$case['error']}");
        }
        if ($actual !== $case['expected']) {
            throw new RuntimeException("{$case['id']}: got $actual; expected {$case['expected']}");
        }
        $stored = Decimal::scaled($case['input'], $column['precision'], $column['scale']);
        $decoded = Decimal::fromScaled($stored, $column['precision'], $column['scale']);
        if ($decoded !== $case['expected']) {
            throw new RuntimeException("{$case['id']}: SQLite round trip got $decoded");
        }
    } catch (OrmException $error) {
        if (($case['error'] ?? null) !== $error->code_) {
            throw new RuntimeException("{$case['id']}: unexpected {$error->code_}", 0, $error);
        }
    }
    echo "CASE {$case['id']} PASS\n";
}

$getter = (new ReflectionMethod(Author::class, 'getPrice'))->getReturnType();
$setter = (new ReflectionMethod(Author::class, 'setPrice'))->getParameters()[0]->getType();
if (!$getter instanceof ReflectionNamedType || !$setter instanceof ReflectionNamedType || $getter->getName() !== 'string' || $setter->getName() !== 'string') {
    throw new RuntimeException('generated decimal getter and setter must use nullable string');
}
echo "CASE generated_decimal_type PASS\n";
