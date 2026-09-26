<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\Codec;
use Orm\Model;
use Orm\OrmException;
use Orm\StyledValue;

$root = dirname(__DIR__, 3);
$fixture = json_decode(file_get_contents("$root/contracts/fixtures/styled_column_states.json"), true, 512, JSON_THROW_ON_ERROR);
$cases = array_column($fixture['cases'], null, 'id');
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
            if (!$decoded instanceof StyledValue || json_decode(Model::jsonText($decoded), true, 512, JSON_THROW_ON_ERROR) !== $case['getter']) {
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

$probe = new class extends Model {
    public static function meta(): array
    {
        return [
            'entity' => 'styled_probe', 'table' => 'styled_probe', 'pk' => [], 'auto' => '',
            'updated' => '', 'aes_version' => '', 'fulltext' => [], 'indexes' => [],
            'columns' => ['payload' => ['type' => 'jsontext', 'nullable' => false, 'styles' => ['json']]],
        ];
    }

    public function getPayload(): StyledValue { return $this->readColumn('payload'); }
    public function setPayload(StyledValue $value): static { return $this->writeColumn('payload', $value); }
};
try {
    $probe->getPayload();
    throw new RuntimeException('unselected getter was accepted');
} catch (OrmException $error) {
    if ($error->code_ !== $cases['unselected']['getter_error']) throw $error;
}
try {
    $probe->setPayload(StyledValue::sqlNull());
    throw new RuntimeException('non-null column accepted SQL NULL');
} catch (OrmException $error) {
    if ($error->code_ !== $cases['nonnull_sql_null']['error']) throw $error;
}
$probe->setPayload(StyledValue::value(\OrderedJson\parse('null')));
if (json_decode(Model::jsonText($probe->getPayload()), true, 512, JSON_THROW_ON_ERROR) !== $cases['nonnull_value_null']['getter']) {
    throw new RuntimeException('non-null column rejected JSON literal null');
}

echo "styled value fixture: $tested codec cases and 3 model states passed\n";
