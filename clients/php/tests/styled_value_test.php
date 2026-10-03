<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

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
    testcase_begin("styled_value/$id", TESTCASE_COMPUTE);
    // fixture의 Mermaid style 이름 json과 jsons는 둘 다 dbspec codec stage ordered_json이다.
    $styles = [in_array($case['style'], ['json', 'jsons'], true) ? 'ordered_json' : $case['style']];
    if (!array_key_exists('stored_text', $case) && !array_key_exists('write_text', $case)) {
        if (!in_array($id, ['unselected', 'nonnull_sql_null'], true)) {
            throw new RuntimeException("$id: fixture case has no codec operation");
        }
        testcase_end();
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
    testcase_end();
}

testcase_begin('styled_value/model-states', TESTCASE_COMPUTE);
$probe = new class extends Model {
    public static function meta(): array
    {
        return [
            'entity' => 'styled_probe', 'table' => 'styled_probe', 'pk' => [], 'identity' => '',
            'updated' => '', 'soft_delete' => '', 'aes_version' => '', 'audit' => '', 'unique' => [], 'indexes' => [],
            'columns' => ['payload' => ['name' => 'payload', 'type' => 'text', 'nullable' => false, 'default' => false, 'select' => true,
                'codec' => ['ordered_json'], 'blind_index' => '', 'pk' => false, 'foreign_key' => false]],
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

testcase_end();
