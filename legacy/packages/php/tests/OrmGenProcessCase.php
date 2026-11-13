<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\TestCase;

/** A test class that generates the models of one document under a work directory and reads them in a new process. */
trait OrmGenProcessCase
{
    private static string $work;

    /** The prefix of the work directory of the test class. */
    abstract protected static function workPrefix(): string;

    public static function setUpBeforeClass(): void
    {
        self::$work = OrmGenTestSupport::createWorkDirectory(static::workPrefix());
    }

    public static function tearDownAfterClass(): void
    {
        OrmGenTestSupport::removeWorkDirectory(self::$work);
    }

    /** Generates the models of the document $text into a new directory and returns the directory of the models. */
    private static function generateDocument(string $name, string $file, string $text, string $namespace): string
    {
        $dir = self::$work . "/$name";
        mkdir("$dir/model", 0o700, true);
        file_put_contents("$dir/$file", $text);
        [$code, $out, $err] = OrmGenTestSupport::run([
            'gen', '--set', OrmGenTestSupport::setFile($dir, [$file]),
            '--out', "$dir/model", '--namespace', $namespace,
        ]);
        TestCase::assertSame(0, $code, "$out $err");
        return "$dir/model";
    }

    /** Runs the reader text in a new process on the models of $model and returns the JSON that it printed. */
    private static function readInProcess(string $model, string $text, array $arguments): array
    {
        $reader = dirname($model) . '/reader.php';
        file_put_contents($reader, $text);
        $root = ormLegacyRoot();
        $result = OrmGenTestSupport::runProcess(
            [PHP_BINARY, $reader, ormRepositoryRoot() . '/vendor-php/autoload.php', $model, ...$arguments],
            $root
        ) ?? throw new \RuntimeException('cannot start the reader');
        [$code, $out, $err] = $result;
        TestCase::assertSame(0, $code, "$out $err");
        return json_decode($out, true, 512, JSON_THROW_ON_ERROR);
    }
}
