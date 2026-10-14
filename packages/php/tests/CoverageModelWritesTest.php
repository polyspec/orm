<?php
declare(strict_types=1);
// model_writes feature coverage: 생성된 CompositeAccount model의 create,
// creates, update, duplication(upsert), count, delete를 tenant 990002의 행으로
// 실행하고 그 행을 모두 지운다. composite_account에는 identity column이 없어
// database state가 실행 전과 같게 남는다.

require_once __DIR__ . '/coverage_cases.php';

use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Code;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

const WRITE_TENANT = 990002;

#[Medium]
final class CoverageModelWritesTest extends TestCase
{
    public function test_model_write_cycle(): void
    {
        [, $dsn] = coverageDatabase();
        $db = coverageConnect($dsn);
        try {
            $existing = (new CompositeAccount)($db)->tenantId(WRITE_TENANT)->getCount();
            Assert::assertTrue($existing === 0, "composite_account holds $existing rows of tenant " . WRITE_TENANT . ' before the case');
            coverageRestoring(function () use ($db): void {
                $created = (new CompositeAccount)($db)->setTenantId(WRITE_TENANT)->setAccountId(1)->setName('created')->create();
                Assert::assertTrue($created->getName() === 'created' && $created->getAccountId() === 1, 'created row ' . json_encode($created->toArray()));
                $inserted = (new CompositeAccount)($db)->creates([
                    (new CompositeAccount)->setTenantId(WRITE_TENANT)->setAccountId(2)->setName('many-2'),
                    (new CompositeAccount)->setTenantId(WRITE_TENANT)->setAccountId(3)->setName('many-3'),
                    (new CompositeAccount)->setTenantId(WRITE_TENANT)->setAccountId(4)->setName('many-4'),
                ]);
                Assert::assertTrue($inserted === 3, "creates inserted $inserted rows, want 3");
                (new CompositeAccount)($db)->getByTenantIdAndAccountId(WRITE_TENANT, 1)->setName('updated')->update();
                $name = (new CompositeAccount)($db)->getByTenantIdAndAccountId(WRITE_TENANT, 1)->getName();
                Assert::assertTrue($name === 'updated', "updated name is $name");
                (new CompositeAccount)($db)->setTenantId(WRITE_TENANT)->setAccountId(1)->setName('ignored')
                    ->duplication((new CompositeAccount)->setName('upserted'))->create();
                $name = (new CompositeAccount)($db)->getByTenantIdAndAccountId(WRITE_TENANT, 1)->getName();
                Assert::assertTrue($name === 'upserted', "upserted name is $name");
                $count = (new CompositeAccount)($db)->tenantId(WRITE_TENANT)->getCount();
                Assert::assertTrue($count === 4, "tenant row count is $count, want 4");
                (new CompositeAccount)($db)->tenantId(WRITE_TENANT)->gets()->delete();
                $missing = coverageCode(fn() => (new CompositeAccount)($db)->getByTenantIdAndAccountId(WRITE_TENANT, 1));
                Assert::assertTrue($missing === Code::NO_ROWS, "get of a deleted row is $missing, want NO_ROWS");
                $left = (new CompositeAccount)($db)->tenantId(WRITE_TENANT)->getCount();
                Assert::assertTrue($left === 0, "$left rows left after delete");
            }, fn() => (new CompositeAccount)($db)->tenantId(WRITE_TENANT)->gets()->delete());
        } finally {
            $db->close();
        }
    }
}
