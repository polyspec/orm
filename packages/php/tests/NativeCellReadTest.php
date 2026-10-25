<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Assembly;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
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
}
