<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Assembly;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;
use ReflectionMethod;
use ReflectionProperty;

#[Small]
final class NativeCellReadTest extends TestCase
{
    // Requirements: INT-5, PRT-69.
    public function testRowAssemblyPreservesBinaryDriverCellBytes(): void
    {
        $source = "\0\x7f\x80\xffA";
        $stream = fopen('php://temp', 'w+');
        self::assertIsResource($stream);
        try {
            fwrite($stream, $source);
            rewind($stream);

            $db = new Db(null, 'sqlite', new Config(), new DateTimeZone('UTC'));
            $assembly = new Assembly($db, null, []);
            $model = (new ReflectionMethod(Model::class, 'assembleRow'))->invoke(
                new NativeByteCellFixture(),
                $assembly,
                [
                    'node' => 48117,
                    'key' => [],
                    'children' => [],
                    'columns' => [['index' => 0, 'name' => 'body', 'column' => 'body', 'hidden' => false]],
                ],
                [$stream],
            );

            $values = (new ReflectionProperty(Model::class, 'values'))->getValue($model);
            self::assertSame($source, $values['body']);
        } finally {
            fclose($stream);
        }
    }

    public function testRowAssemblyRejectsNonFiniteFloatCells(): void
    {
        $db = new Db(null, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $assembly = new Assembly($db, null, []);
        $assembleRow = new ReflectionMethod(Model::class, 'assembleRow');
        foreach (['ratio', 'row_count'] as $offset => $name) {
            $declaration = [
                'node' => 48118 + $offset,
                'key' => [],
                'children' => [],
                'columns' => [['index' => 0, 'name' => $name, 'column' => $name, 'hidden' => false]],
            ];
            $valid = $assembleRow->invoke(new NativeByteCellFixture(), $assembly, $declaration, [1.25]);
            self::assertSame(1.25, (new ReflectionProperty(Model::class, 'values'))->getValue($valid)[$name]);

            foreach ([NAN, 'NaN'] as $raw) {
                try {
                    $assembleRow->invoke(new NativeByteCellFixture(), $assembly, $declaration, [$raw]);
                    self::fail("A non-finite $name float cell must fail decoding.");
                } catch (OrmException $error) {
                    self::assertSame(Code::CODEC_DECODE, $error->code_);
                }
            }
        }
    }
}
