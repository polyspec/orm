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
        // Only the writer is a library: no library parses on the read path (COD-74), whose cause of yaml-parse is the
        // error of the reader (CodecErrorCauseTest).
        $result = CodecYamlProbe::run('dump', 'policy');
        self::assertSame(true, $result['wrapped'], 'library dump policy is mapped');
        self::assertSame(Code::CODEC_ENCODE, $result['code'], 'library dump policy code');
        self::assertSame(true, $result['previousSame'], 'library dump policy retains exact cause');
    }

    public function testEveryLibraryThrowableIsItsRule(): void
    {
        // No exception of the library leaves a codec call: a RuntimeException, a TypeError or an Error of the writer is
        // yaml-text, with the throwable as its cause (COD-71).
        require_once __DIR__ . '/CodecYamlProbe.php';
        foreach (['runtime', 'type', 'error'] as $failure) {
            $result = CodecYamlProbe::run('dump', $failure);
            self::assertSame(true, $result['wrapped'], "library dump $failure is mapped");
            self::assertSame(Code::CODEC_ENCODE, $result['code'], "library dump $failure code");
            self::assertSame(true, $result['previousSame'], "library dump $failure retains exact cause");
        }
    }
}
