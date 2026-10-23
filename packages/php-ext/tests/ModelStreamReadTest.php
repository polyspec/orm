<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use ErrorException;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Assembly;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Throwable;

final class ModelStreamFixture extends Model
{
    public static function meta(): array
    {
        return [
            'entity' => 'stream_fixture',
            'updated' => '',
            'columns' => [
                'title' => ['type' => 'text', 'codec' => [], 'nullable' => true],
                'active' => ['type' => 'bool', 'codec' => [], 'nullable' => true],
            ],
        ];
    }
}

final class ModelStreamWarningWrapper
{
    public $context;

    public function stream_open(string $path, string $mode, int $options, ?string &$openedPath): bool
    {
        return true;
    }

    public function stream_read(int $count): string|false
    {
        trigger_error('original stream read warning', E_USER_WARNING);
        return false;
    }

    public function stream_eof(): bool
    {
        return false;
    }

    public function stream_stat(): array|false
    {
        return [];
    }
}

#[Small]
final class ModelStreamReadTest extends TestCase
{
    private static function columnValue(array $column, mixed $value): mixed
    {
        return (new \ReflectionMethod(Model::class, 'columnValue'))
            ->invoke(null, $column, $value, new DateTimeZone('UTC'));
    }

    private static function assembly(): Assembly
    {
        $assembly = (new \ReflectionClass(Assembly::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(Assembly::class, 'db'))->setValue(
            $assembly,
            (new \ReflectionClass(Db::class))->newInstanceWithoutConstructor(),
        );
        (new \ReflectionProperty(Assembly::class, 'conn'))->setValue($assembly, null);
        (new \ReflectionProperty(Assembly::class, 'zone'))->setValue($assembly, new DateTimeZone('UTC'));
        (new \ReflectionProperty(Assembly::class, 'track'))->setValue($assembly, false);
        return $assembly;
    }

    /** @return array{resource, ErrorException} */
    private function warningStream(): array
    {
        self::assertTrue(stream_wrapper_register('ormreadwarning', ModelStreamWarningWrapper::class));
        $stream = fopen('ormreadwarning://source', 'r');
        if (!is_resource($stream)) {
            stream_wrapper_unregister('ormreadwarning');
            self::fail('The warning stream could not be opened.');
        }
        return [$stream, new ErrorException('stream warning converted by the caller')];
    }

    private function withThrowingWarningHandler(ErrorException $expected, callable $operation): Throwable
    {
        set_error_handler(static function () use ($expected): never { throw $expected; });
        try {
            try {
                $operation();
                self::fail('The original warning Throwable must escape.');
            } catch (Throwable $actual) {
                return $actual;
            }
        } finally {
            restore_error_handler();
        }
    }

    public function testSuccessfulColumnStreamsKeepStringAndBooleanConversions(): void
    {
        $text = fopen('php://temp', 'w+');
        self::assertIsResource($text);
        try {
            fwrite($text, 'hello');
            rewind($text);
            self::assertSame('hello', self::columnValue(['type' => 'text', 'codec' => []], $text));
        } finally {
            fclose($text);
        }

        $boolean = fopen('php://temp', 'w+');
        self::assertIsResource($boolean);
        try {
            fwrite($boolean, '0');
            rewind($boolean);
            self::assertFalse(self::columnValue(['type' => 'bool', 'codec' => []], $boolean));
        } finally {
            fclose($boolean);
        }
    }

    public function testColumnValuePreservesOriginalWarningThrowable(): void
    {
        [$stream, $expected] = $this->warningStream();
        try {
            self::assertSame(
                $expected,
                $this->withThrowingWarningHandler(
                    $expected,
                    static fn() => self::columnValue(['type' => 'text', 'codec' => []], $stream),
                ),
            );
        } finally {
            fclose($stream);
            stream_wrapper_unregister('ormreadwarning');
        }
    }

    public function testSqlNullDoesNotReadAResource(): void
    {
        [$stream, $expected] = $this->warningStream();
        try {
            self::assertNull(self::columnValue(['type' => 'text', 'codec' => []], null));
        } finally {
            fclose($stream);
            stream_wrapper_unregister('ormreadwarning');
        }
    }

    public function testSuccessfulNormalAndExtraRowsPreserveStreamText(): void
    {
        $model = new ModelStreamFixture();
        $assembleRow = new \ReflectionMethod(Model::class, 'assembleRow');
        $cases = [
            ['node' => 2, 'columns' => [['index' => 0, 'name' => 'title', 'column' => 'title', 'hidden' => false]], 'name' => 'title'],
            ['node' => 3, 'columns' => [['index' => 0, 'name' => 'extra_title', 'column' => '', 'type' => 'text']], 'name' => 'extra_title'],
        ];
        foreach ($cases as $case) {
            $stream = fopen('php://temp', 'w+');
            self::assertIsResource($stream);
            try {
                fwrite($stream, 'hello');
                rewind($stream);
                $row = $assembleRow->invoke($model, self::assembly(), [
                    'node' => $case['node'], 'key' => [], 'children' => [], 'columns' => $case['columns'],
                ], [$stream]);
                $property = new \ReflectionProperty(Model::class, $case['name'] === 'title' ? 'values' : 'row');
                $stored = $property->getValue($row);
                self::assertSame('hello', $case['name'] === 'title' ? $stored['title'] : $stored['extra']['extra_title']);
            } finally {
                fclose($stream);
            }
        }
    }

    public function testWarningThrowableEscapesNormalAndExtraRowsWithoutMutatingBuilder(): void
    {
        $model = new ModelStreamFixture();
        $assembleRow = new \ReflectionMethod(Model::class, 'assembleRow');
        $cases = [
            ['node' => 0, 'columns' => [['index' => 0, 'name' => 'title', 'column' => 'title', 'hidden' => false]]],
            ['node' => 1, 'columns' => [['index' => 0, 'name' => 'extra_title', 'column' => '', 'type' => 'text']]],
        ];
        foreach ($cases as $declaration) {
            [$stream, $expected] = $this->warningStream();
            try {
                $actual = $this->withThrowingWarningHandler(
                    $expected,
                    static fn() => $assembleRow->invoke(
                        $model,
                        self::assembly(),
                        ['key' => [], 'children' => []] + $declaration,
                        [$stream],
                    ),
                );
                self::assertSame($expected, $actual);
                self::assertSame([], (new \ReflectionProperty(Model::class, 'values'))->getValue($model));
                self::assertNull((new \ReflectionProperty(Model::class, 'row'))->getValue($model));
            } finally {
                fclose($stream);
                stream_wrapper_unregister('ormreadwarning');
            }
        }
    }
}
