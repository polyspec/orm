<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Codec;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\StyledValue;

#[Small]
final class StyledValueTest extends TestCase
{
    use DatabaseTestAssertions;

    /** @return array<string, mixed> contracts/fixtures/styled_column_states.json */
    private static function fixture(): array
    {
        return self::readJsonFixture(
            dirname(__DIR__, 3) . '/contracts/fixtures/styled_column_states.json',
        );
    }

    /** @return iterable<string, array{array<string, mixed>}> for each case of the fixture */
    public static function cases(): iterable
    {
        yield from self::fixtureCases(self::fixture());
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
        if ($id === 'sql_null') {
            self::assertSame(
                ['kind' => 'sql-null'],
                json_decode(json_encode(StyledValue::sqlNull(), JSON_THROW_ON_ERROR), true),
            );
            try {
                StyledValue::sqlNull()->payload();
                self::fail('SQL NULL has no value payload');
            } catch (OrmException $exception) {
                self::assertSame(Code::CODEC_DECODE, $exception->code_);
            }
        }
        $styles = [self::stage($case['style'])];
        if (array_key_exists('input', $case)) {
            $this->assertSetterCase($case);
        }
        if (!array_key_exists('stored_text', $case) && !array_key_exists('write_text', $case)) {
            if (!array_key_exists('input', $case) || in_array($case['id'], self::MODEL_STATE_CASES, true)) {
                $this->assertModelStateCase(self::modelStateProbe(), $case);
            }
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

    /** The cases of the fixture that the model-state probe runs (COD-20, COD-25). */
    private const array MODEL_STATE_CASES = ['unselected', 'nonnull_sql_null', 'nonnull_value_null'];

    // Requirements: COD-20, COD-25.
    public function testModelStates(): void
    {
        $cases = array_column(self::fixture()['cases'], null, 'id');
        $probe = self::modelStateProbe();
        foreach (self::MODEL_STATE_CASES as $id) {
            $this->assertModelStateCase($probe, $cases[$id]);
        }
    }

    /** The codec stage of a style of the fixture: the Mermaid styles json and jsons are both ordered_json. */
    private static function stage(string $style): string
    {
        return in_array($style, ['json', 'jsons'], true) ? 'ordered_json' : $style;
    }

    /** The column of the setter probe of a style, nullable or not. */
    private static function setterColumn(string $style, bool $nullable): string
    {
        return self::stage($style) . ($nullable ? '_nullable' : '_required');
    }

    /**
     * The setter of a styled column runs on a column of the style of the case (COD-20, COD-73): a case whose error has
     * no stored text is the setter's, with its whole message where the case states one, and the setter of another case
     * accepts its input.
     *
     * @param array<string, mixed> $case
     */
    private function assertSetterCase(array $case): void
    {
        $id = $case['id'];
        $state = $case['input']['kind'] === 'sql-null'
            ? StyledValue::sqlNull()
            : StyledValue::value($case['input']['value']);
        $column = self::setterColumn($case['style'], $case['nullable']);
        $error = null;
        try {
            self::setterProbe()->set($column, $state);
        } catch (OrmException $thrown) {
            $error = $thrown;
        }
        if (!array_key_exists('error', $case) || array_key_exists('stored_text', $case)) {
            self::assertNull($error, "$id: the setter refused the value: " . $error?->getMessage());
            return;
        }
        self::assertNotNull($error, "$id: the setter accepted the value, want {$case['error']}");
        self::assertSame($case['error'], $error->code_, "$id: setter error code");
        if (array_key_exists('message', $case)) {
            self::assertSame($case['message'], $error->getMessage(), "$id: setter error message");
        }
    }

    /** A model with a styled column of each value stage, nullable and not, whose setter takes a column name. */
    private static function setterProbe(): Model
    {
        return new class extends Model {
            public static function meta(): array
            {
                $columns = [];
                foreach (['ordered_json', 'serialize', 'yaml'] as $stage) {
                    foreach ([true, false] as $nullable) {
                        $name = $stage . ($nullable ? '_nullable' : '_required');
                        $columns[$name] = [
                            'name' => $name,
                            'type' => 'text',
                            'nullable' => $nullable,
                            'default' => false,
                            'select' => true,
                            'codec' => [$stage],
                            'blind_index' => '',
                            'pk' => false,
                            'foreign_key' => false,
                        ];
                    }
                }
                return [
                    'entity' => 'styled_setter_probe', 'table' => 'styled_setter_probe', 'pk' => [], 'identity' => '',
                    'updated' => '',
                    'soft_delete' => '',
                    'aes_version' => '',
                    'audit' => '',
                    'unique' => [],
                    'indexes' => [],
                    'columns' => $columns,
                ];
            }

            public function set(string $column, StyledValue $value): static
            {
                return $this->writeColumn($column, $value);
            }
        };
    }

    private static function modelStateProbe(): Model
    {
        return new class extends Model {
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
                            'codec' => ['ordered_json'],
                            'blind_index' => '',
                            'pk' => false,
                            'foreign_key' => false,
                        ],
                    ],
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
    }

    /** @param array<string, mixed> $case */
    private function assertModelStateCase(Model $probe, array $case): void
    {
        switch ($case['id']) {
            case 'unselected':
                try {
                    $probe->getPayload();
                    self::fail('unselected getter was accepted');
                } catch (OrmException $error) {
                    self::assertSame($case['getter_error'], $error->code_);
                }
                return;
            case 'nonnull_sql_null':
                try {
                    $probe->setPayload(StyledValue::sqlNull());
                    self::fail('non-null column accepted SQL NULL');
                } catch (OrmException $error) {
                    self::assertSame($case['error'], $error->code_);
                }
                return;
            case 'nonnull_value_null':
                $probe->setPayload(StyledValue::value(\Polyspec\OrderedJson\parse('null')));
                self::assertSame(
                    $case['getter'],
                    json_decode(Model::jsonText($probe->getPayload()), true, 512, JSON_THROW_ON_ERROR),
                    'non-null column rejected JSON literal null'
                );
                return;
            default:
                self::fail("{$case['id']}: case has no model-state operation");
        }
    }
}
