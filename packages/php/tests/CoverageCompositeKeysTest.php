<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// composite_keys feature coverage: composite_account with a two-column primary key and
// composite_membership that refers to that key (ON DELETE CASCADE) are written, read, and removed for tenants 990004
// and
// 990006. The memberships relation links the two parts of the foreign key
// (tenant_id, account_id) in key order. Account 2 must also exist in another tenant,
// so that a relation linked only by the account_id part is exposed.


use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

const COMPOSITE_TENANT = 990004;
const COMPOSITE_OTHER_TENANT = 990006;

#[Medium]
final class CoverageCompositeKeysTest extends TestCase
{
    // Requirements: DSL-82, INT-87, PRT-12, PRT-40.
    public function testCompositeKeyRows(): void
    {
        require_once __DIR__ . '/CoverageCompositeKeysCase.php';
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                CoverageCompositeKeysCase::run($db, COMPOSITE_TENANT, COMPOSITE_OTHER_TENANT);
            } finally {
                $db->close();
            }
        }
    }
}
