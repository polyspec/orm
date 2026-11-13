<?php

// The collection key identity of tests/collection/keys.json: every value type has its own key, and a NULL key is
// CODEC_DECODE.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/CollectionIdentityTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Bytes;
use Polyspec\Orm\Collection;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;

#[Small]
class CollectionIdentityTest extends TestCase
{
    // Requirements: PRT-35.
    use CollectionIdentityCases;
    use CollectionWeakTypedKeyCases;

    /** @return array<string, mixed> */
    private static function fixture(): array
    {
        $src = file_get_contents(ormLegacyRoot() . '/tests/collection/keys.json');
        self::assertIsString(
            $src,
            'tests/collection/keys.json is unreadable; run make orm-check from the checkout root'
        );
        $fixture = json_decode($src, true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($fixture);
        return $fixture;
    }
}
