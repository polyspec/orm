<?php
// The AES v2 vectors of tests/codec/aes-vectors.json, each a data set named by its key: the aes hex host stages
// round-trip the plain text with the key, and the fixed envelope decodes to the plain text.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecAesVectorsTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Codec;

#[Small]
final class CodecAesVectorsTest extends TestCase
{
    public static function vectors(): iterable
    {
        $file = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/tests/codec/aes-vectors.json'), true, 512, JSON_THROW_ON_ERROR);
        foreach ($file['vectors'] as $vector) {
            yield $vector['key'] => [$vector];
        }
    }

    #[DataProvider('vectors')]
    public function test_vector(array $vector): void
    {
        $encoded = Codec::hostEncode($vector['plain'], ['aes', 'hex'], $vector['key']);
        self::assertSame($vector['plain'], Codec::hostDecode($encoded, ['aes', 'hex'], $vector['key']), 'round trip');
        self::assertSame($vector['plain'], Codec::hostDecode($vector['envelope_hex'], ['aes', 'hex'], $vector['key']), 'fixed envelope');
    }
}
