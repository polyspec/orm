<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\StyledValue;

#[Small]
final class StyledValueTest extends TestCase
{
    public function testClassExists(): void
    {
        self::assertTrue(
            class_exists(StyledValue::class),
            'the PHP client declares no class Polyspec\\Orm\\StyledValue'
        );
    }

    // The generated getter and setter of a non-null styled column (COD-20, COD-25): an unselected getter is
    // COLUMN_UNSELECTED, SQL NULL is refused with CODEC_ENCODE and JSON literal null is a value.
    // Requirements: COD-20, COD-25.
    public function testModelStates(): void
    {
        $probe = self::modelStateProbe();
        try {
            $probe->getPayload();
            self::fail('unselected getter was accepted');
        } catch (OrmException $error) {
            self::assertSame('COLUMN_UNSELECTED', $error->code_);
        }
        try {
            $probe->setPayload(StyledValue::sqlNull());
            self::fail('non-null column accepted SQL NULL');
        } catch (OrmException $error) {
            self::assertSame('CODEC_ENCODE', $error->code_);
        }
        $probe->setPayload(StyledValue::value(\Polyspec\OrderedJson\parse('null')));
        self::assertSame(
            ['kind' => 'value', 'value' => null],
            json_decode(Model::jsonText($probe->getPayload()), true, 512, JSON_THROW_ON_ERROR),
            'non-null column rejected JSON literal null'
        );
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
}
