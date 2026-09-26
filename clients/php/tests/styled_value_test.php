<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\Codec;
use Orm\OrmException;
use Orm\StyledValue;

$root = dirname(__DIR__, 3);
$fixture = json_decode(file_get_contents("$root/contracts/fixtures/styled_column_states.json"), true, 512, JSON_THROW_ON_ERROR);
if (!class_exists(StyledValue::class)) {
    throw new RuntimeException('Orm\\StyledValue is required');
}

$tested = 0;
foreach ($fixture['cases'] as $case) {
    $id = $case['id'];
    $styles = [$case['style']];
    if (!array_key_exists('stored_text', $case) && !array_key_exists('write_text', $case)) {
        if (!in_array($id, ['unselected', 'nonnull_sql_null'], true)) {
            throw new RuntimeException("$id: fixture case has no codec operation");
        }
        continue;
    }
    $tested++;
    if (array_key_exists('stored_text', $case)) {
        try {
            $decoded = Codec::decode($styles, $case['stored_text']);
            if (isset($case['error'])) {
                throw new RuntimeException("$id: decode accepted invalid storage");
            }
            if (!$decoded instanceof StyledValue || json_decode(json_encode($decoded, JSON_THROW_ON_ERROR), true) !== $case['getter']) {
                throw new RuntimeException("$id: decoded state differs from fixture");
            }
        } catch (OrmException $error) {
            if (($case['error'] ?? null) !== $error->code_) {
                throw new RuntimeException("$id: unexpected decode error {$error->code_}", 0, $error);
            }
        }
    }
    if (array_key_exists('write_text', $case)) {
        $state = $case['input']['kind'] === 'sql-null'
            ? StyledValue::sqlNull()
            : StyledValue::value($case['input']['value']);
        $encoded = Codec::encode($styles, $state);
        if ($encoded !== $case['write_text']) {
            throw new RuntimeException("$id: encoded cell differs from fixture");
        }
    }
}

echo "styled codec fixture: $tested cases passed\n";
