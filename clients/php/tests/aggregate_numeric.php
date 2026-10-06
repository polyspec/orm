<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;

$path = dirname(__DIR__, 3) . '/contracts/fixtures/aggregate_numeric.json';
$fixture = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
$convert = new ReflectionMethod(Model::class, 'aggregateNumber');

foreach ($fixture['cases'] as $case) {
    testcase_begin("aggregate_numeric/{$case['id']}", TESTCASE_COMPUTE);
    $input = match ($case['input_type']) {
        'integer_text' => (int) $case['input'],
        'decimal_text' => $case['input'],
        'null' => null,
        default => throw new RuntimeException("unknown input type {$case['input_type']}"),
    };
    try {
        $number = $convert->invoke(null, $input);
        if (isset($case['expected']['error'])) {
            throw new RuntimeException("{$case['id']}: expected {$case['expected']['error']}, got a value");
        }
        $bits = bin2hex(pack('E', $number));
        if ($bits !== $case['expected']['bits']) {
            throw new RuntimeException("{$case['id']}: expected {$case['expected']['bits']}, got $bits");
        }
    } catch (OrmException $error) {
        if (($case['expected']['error'] ?? null) !== $error->code_) {
            throw new RuntimeException("{$case['id']}: unexpected {$error->code_}", 0, $error);
        }
    }
    testcase_end();
}
