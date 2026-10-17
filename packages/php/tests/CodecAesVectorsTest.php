<?php
// The AES v2 vectors of tests/codec/aes-vectors.json, each a data set named by its name: the aes hex host stages
// round-trip the plain text with the key, and the fixed envelope decodes to the plain text.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecAesVectorsTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Codec;
use Polyspec\Orm\OrmException;

#[Small]
final class CodecAesVectorsTest extends TestCase
{
    public static function vectors(): iterable
    {
        $file = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/tests/codec/aes-vectors.json'), true, 512, JSON_THROW_ON_ERROR);
        foreach ($file['vectors'] as $vector) {
            yield $vector['name'] => [$vector];
        }
    }

    #[DataProvider('vectors')]
    public function test_vector(array $vector): void
    {
        if (isset($vector['error'])) {
            // An error vector names the code of its op (encode, decode or blind_index) with an empty or wrong key.
            try {
                match ($vector['op']) {
                    'encode' => Codec::hostEncode($vector['plain'], ['aes', 'hex'], $vector['key']),
                    'decode' => Codec::hostDecode($vector['envelope_hex'], ['aes', 'hex'], $vector['key']),
                    default => Codec::blindIndex($vector['plain'], $vector['key']),
                };
            } catch (OrmException $error) {
                self::assertSame($vector['error'], $error->code_, $vector['op']);
                return;
            }
            self::fail($vector['op'] . ' raised no error');
        }
        $encoded = Codec::hostEncode($vector['plain'], ['aes', 'hex'], $vector['key']);
        self::assertSame($vector['plain'], Codec::hostDecode($encoded, ['aes', 'hex'], $vector['key']), 'round trip');
        self::assertSame($vector['plain'], Codec::hostDecode($vector['envelope_hex'], ['aes', 'hex'], $vector['key']), 'fixed envelope');
    }
}
