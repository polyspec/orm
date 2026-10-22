<?php

declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Codec;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\StyledValue;

#[Small]
final class StyledValueTest extends TestCase
{
    /** @return array<string, mixed> contracts/fixtures/styled_column_states.json */
    private static function fixture(): array
    {
        return json_decode(
            file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/styled_column_states.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
    }

    /** @return iterable<string, array{array<string, mixed>}> for each case of the fixture */
    public static function cases(): iterable
    {
        foreach (self::fixture()['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    public function testClassExists(): void
    {
        self::assertTrue(
            class_exists(StyledValue::class),
            'the PHP client declares no class Polyspec\\Orm\\StyledValue'
        );
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function testStyledValue(array $case): void
    {
        $id = $case['id'];
        // The Mermaid style name json and jsons of the fixture are both the dbspec codec stage ordered_json.
        $styles = [in_array($case['style'], ['json', 'jsons'], true) ? 'ordered_json' : $case['style']];
        if (!array_key_exists('stored_text', $case) && !array_key_exists('write_text', $case)) {
            // The case that testModelStates reads.
            self::assertContains($id, ['unselected', 'nonnull_sql_null'], "$id: fixture case has no codec operation");
            return;
        }
        if (array_key_exists('stored_text', $case)) {
            try {
                $decoded = Codec::decode($styles, $case['stored_text']);
                self::assertArrayNotHasKey('error', $case, "$id: decode accepted invalid storage");
                self::assertInstanceOf(StyledValue::class, $decoded);
                self::assertSame(
                    $case['getter'],
                    json_decode(Model::jsonText($decoded), true, 512, JSON_THROW_ON_ERROR),
                    "$id: decoded state differs from fixture"
                );
            } catch (OrmException $error) {
                self::assertSame($case['error'] ?? null, $error->code_, "$id: unexpected decode error {$error->code_}");
            }
        }
        if (array_key_exists('write_text', $case)) {
            $state = $case['input']['kind'] === 'sql-null'
                ? StyledValue::sqlNull()
                : StyledValue::value($case['input']['value']);
            self::assertSame(
                $case['write_text'],
                Codec::encode($styles, $state),
                "$id: encoded cell differs from fixture"
            );
        }
    }

    public function testModelStates(): void
    {
        $cases = array_column(self::fixture()['cases'], null, 'id');
        $probe = new class extends Model {
            public static function meta(): array
            {
                return [
                    'entity' => 'styled_probe', 'table' => 'styled_probe', 'pk' => [], 'identity' => '',
                    'updated' => '',
                    'soft_delete' => '',
                    'aes_version' => '',
                    'audit' => '',
                    'unique' => [],
                    'indexes' => [],
                    'columns' => [
                        'payload' => [
                            'name' => 'payload',
                            'type' => 'text',
                            'nullable' => false,
                            'default' => false,
                            'select' => true,
                        'codec' => ['ordered_json'], 'blind_index' => '', 'pk' => false, 'foreign_key' => false]],
                ];
            }

            public function getPayload(): StyledValue
            {
                return $this->readColumn('payload');
            }
            public function setPayload(StyledValue $value): static
            {
                return $this->writeColumn('payload', $value);
            }
        };
        try {
            $probe->getPayload();
            self::fail('unselected getter was accepted');
        } catch (OrmException $error) {
            self::assertSame($cases['unselected']['getter_error'], $error->code_);
        }
        try {
            $probe->setPayload(StyledValue::sqlNull());
            self::fail('non-null column accepted SQL NULL');
        } catch (OrmException $error) {
            self::assertSame($cases['nonnull_sql_null']['error'], $error->code_);
        }
        $probe->setPayload(StyledValue::value(\Polyspec\OrderedJson\parse('null')));
        self::assertSame(
            $cases['nonnull_value_null']['getter'],
            json_decode(Model::jsonText($probe->getPayload()), true, 512, JSON_THROW_ON_ERROR),
            'non-null column rejected JSON literal null'
        );
    }
}
