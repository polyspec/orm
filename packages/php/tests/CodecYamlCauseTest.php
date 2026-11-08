<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;

#[Large]
final class CodecYamlCauseTest extends TestCase
{
    public function testExpectedCauseIdentity(): void
    {
        require_once __DIR__ . '/CodecYamlProbe.php';
        $cases = [
            ['decode', 'parse', Code::CODEC_DECODE],
            ['decode', 'reference', Code::CODEC_DECODE],
            ['decode', 'policy', Code::CODEC_DECODE],
            ['dump', 'policy', Code::CODEC_ENCODE],
        ];
        foreach ($cases as [$operation, $failure, $code]) {
            $result = CodecYamlProbe::run($operation, $failure);
            self::assertSame(true, $result['wrapped'], "library $operation $failure is mapped");
            self::assertSame($code, $result['code'], "library $operation $failure code");
            self::assertSame(true, $result['previousSame'], "library $operation $failure retains exact cause");
        }
    }

    public function testEveryLibraryThrowableIsItsRule(): void
    {
        // No exception of the library leaves a codec call: a RuntimeException, a TypeError or an Error of the reader
        // is yaml-parse and of the writer yaml-text, with the throwable as its cause (COD-71).
        require_once __DIR__ . '/CodecYamlProbe.php';
        foreach (['decode' => Code::CODEC_DECODE, 'dump' => Code::CODEC_ENCODE] as $operation => $code) {
            foreach (['runtime', 'type', 'error'] as $failure) {
                $result = CodecYamlProbe::run($operation, $failure);
                self::assertSame(true, $result['wrapped'], "library $operation $failure is mapped");
                self::assertSame($code, $result['code'], "library $operation $failure code");
                self::assertSame(true, $result['previousSame'], "library $operation $failure retains exact cause");
            }
        }
    }
}
