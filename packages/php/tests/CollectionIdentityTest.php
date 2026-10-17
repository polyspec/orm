<?php
// The collection key identity of tests/collection/keys.json: every value type has its own key, and a NULL key is CODEC_DECODE.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/CollectionIdentityTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Bytes;
use Polyspec\Orm\Collection;
use Polyspec\Orm\OrmException;

#[Small]
final class CollectionIdentityTest extends TestCase
{
    /** @return array{null: array{code: string, message: string}, keys: list<array<string, mixed>>} */
    private static function fixture(): array
    {
        $src = file_get_contents(__DIR__ . '/../../../tests/collection/keys.json');
        self::assertIsString($src, 'tests/collection/keys.json is unreadable; run make check from the checkout root');
        $fixture = json_decode($src, true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($fixture);
        return $fixture;
    }

    /** The PHP value of one fixture entry, with the type that the client reads from a column. */
    private static function valueOf(array $entry): mixed
    {
        return match ($entry['type']) {
            'text' => $entry['value'],
            'bool' => $entry['value'],
            'int' => $entry['value'],
            'bytes' => new Bytes(hex2bin($entry['hex'])),
            'datetime' => new \DateTimeImmutable($entry['value']),
            default => self::fail("fixture {$entry['name']} has unknown type {$entry['type']}"),
        };
    }

    public function test_every_fixture_key_has_its_own_stable_identity(): void
    {
        $seen = [];
        foreach (self::fixture()['keys'] as $entry) {
            $identity = Collection::identityOf(self::valueOf($entry));
            self::assertSame($identity, Collection::identityOf(self::valueOf($entry)), "key {$entry['name']} has no stable identity");
            if (isset($entry['same_as'])) {
                self::assertSame($seen[$entry['same_as']], $identity, "key {$entry['name']} differs from {$entry['same_as']}");
                continue;
            }
            foreach ($seen as $other => $otherIdentity) {
                self::assertNotSame($otherIdentity, $identity, "keys $other and {$entry['name']} have the same identity");
            }
            $seen[$entry['name']] = $identity;
        }
    }

    public function test_a_null_key_is_codec_decode(): void
    {
        $expected = self::fixture()['null'];
        try {
            Collection::keyOf(null);
            self::fail('a NULL collection key was accepted');
        } catch (OrmException $e) {
            self::assertSame($expected['code'], $e->code_);
            self::assertSame($expected['code'] . ': ' . $expected['message'], $e->getMessage());
        }
    }
}
