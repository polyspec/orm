<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

#[Large]
final class CodecCauseTest extends TestCase
{
    public function testYamlExpectedCauseIdentity(): void
    {
        require_once dirname(__DIR__, 2) . '/php/tests/CodecYamlProbe.php';
        foreach (
            [
                ['decode', 'parse', \Polyspec\Orm\Code::CODEC_DECODE],
                ['decode', 'reference', \Polyspec\Orm\Code::CODEC_DECODE],
                ['decode', 'policy', \Polyspec\Orm\Code::CODEC_DECODE],
                ['dump', 'policy', \Polyspec\Orm\Code::CODEC_ENCODE],
            ] as [$operation, $failure, $code]
        ) {
            $result = CodecYamlProbe::run($operation, $failure, true);
            self::assertSame(true, $result['native'], 'the isolated child loaded the built native extension');
            self::assertSame(true, $result['wrapped'], "native $operation $failure is mapped");
            self::assertSame($code, $result['code'], "native $operation $failure code");
            self::assertSame(true, $result['previousSame'], "native $operation $failure retains exact cause");
        }
    }

    public function testYamlEveryLibraryThrowableIsItsRule(): void
    {
        // No exception of the library leaves a native codec call either (COD-71).
        require_once dirname(__DIR__, 2) . '/php/tests/CodecYamlProbe.php';
        $codes = ['decode' => \Polyspec\Orm\Code::CODEC_DECODE, 'dump' => \Polyspec\Orm\Code::CODEC_ENCODE];
        foreach ($codes as $operation => $code) {
            foreach (['runtime', 'type', 'error'] as $failure) {
                $result = CodecYamlProbe::run($operation, $failure, true);
                self::assertSame(true, $result['native'], 'the isolated child loaded the built native extension');
                self::assertSame(true, $result['wrapped'], "native $operation $failure is mapped");
                self::assertSame($code, $result['code'], "native $operation $failure code");
                self::assertSame(true, $result['previousSame'], "native $operation $failure retains exact cause");
            }
        }
    }
}
