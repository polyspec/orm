<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

#[Large]
final class CodecCauseTest extends TestCase
{
    private static function extensionPath(): string
    {
        $extension = dirname(__DIR__, 3) . '/var/php-ext/polyspec_orm.so';
        self::assertFileExists($extension, 'make build-php-ext publishes the extension at its declared output path');
        return $extension;
    }

    public function testYamlExpectedCauseIdentity(): void
    {
        require_once dirname(__DIR__, 2) . '/php/tests/CodecYamlProbe.php';
        foreach (
            [
                ['decode', 'parse', \Polyspec\Orm\Code::CODEC_DECODE],
                ['decode', 'reference', \Polyspec\Orm\Code::CODEC_DECODE],
                ['decode', 'policy', \Polyspec\Orm\Code::CODEC_DECODE],
                ['dump', 'dump', \Polyspec\Orm\Code::CODEC_ENCODE],
            ] as [$operation, $failure, $code]
        ) {
            $result = CodecYamlProbe::run($operation, $failure, self::extensionPath());
            self::assertSame(true, $result['native'], 'the isolated child loaded the built native extension');
            self::assertSame(true, $result['wrapped'], "native $operation $failure is mapped");
            self::assertSame($code, $result['code'], "native $operation $failure code");
            self::assertSame(true, $result['previousSame'], "native $operation $failure retains exact cause");
        }
    }

    public function testYamlUnexpectedThrowableIdentity(): void
    {
        require_once dirname(__DIR__, 2) . '/php/tests/CodecYamlProbe.php';
        foreach (['decode', 'dump'] as $operation) {
            foreach (['runtime', 'type', 'error'] as $failure) {
                $result = CodecYamlProbe::run($operation, $failure, self::extensionPath());
                self::assertSame(true, $result['native'], 'the isolated child loaded the built native extension');
                self::assertSame(true, $result['identity'], "native $operation $failure keeps exact throwable");
            }
        }
    }
}
