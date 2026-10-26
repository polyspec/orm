<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Collection;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use ReflectionClass;

const COMPOSITE_NATIVE_TENANT = 990004;
const COMPOSITE_NATIVE_OTHER_TENANT = 990006;

#[Medium]
final class CoverageCompositeKeysExtensionTest extends TestCase
{
    // Requirements: INT-87, PRT-12.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_composite_key_rows(): void
    {
        require_once dirname(__DIR__, 2) . '/php/tests/CoverageCompositeKeysCase.php';
        Assert::assertTrue((new ReflectionClass(Db::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Collection::class))->isInternal());
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                CoverageCompositeKeysCase::run($db, COMPOSITE_NATIVE_TENANT, COMPOSITE_NATIVE_OTHER_TENANT);
            } finally {
                $db->close();
            }
        }
    }
}
