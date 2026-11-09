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
        // Only the writer is a library: the extension reads with the YAML reader of orm in C (COD-74), whose cause of
        // yaml-parse CodecErrorCauseTest states, as for PHP.
        require_once dirname(__DIR__, 2) . '/php/tests/CodecYamlProbe.php';
        $result = CodecYamlProbe::run('dump', 'policy', true);
        self::assertSame(true, $result['native'], 'the isolated child loaded the built native extension');
        self::assertSame(true, $result['wrapped'], 'native dump policy is mapped');
        self::assertSame(\Polyspec\Orm\Code::CODEC_ENCODE, $result['code'], 'native dump policy code');
        self::assertSame(true, $result['previousSame'], 'native dump policy retains exact cause');
    }

    public function testYamlEveryLibraryThrowableIsItsRule(): void
    {
        // No exception of the writer leaves a native codec call either (COD-71).
        require_once dirname(__DIR__, 2) . '/php/tests/CodecYamlProbe.php';
        foreach (['runtime', 'type', 'error'] as $failure) {
            $result = CodecYamlProbe::run('dump', $failure, true);
            self::assertSame(true, $result['native'], 'the isolated child loaded the built native extension');
            self::assertSame(true, $result['wrapped'], "native dump $failure is mapped");
            self::assertSame(\Polyspec\Orm\Code::CODEC_ENCODE, $result['code'], "native dump $failure code");
            self::assertSame(true, $result['previousSame'], "native dump $failure retains exact cause");
        }
    }
}
