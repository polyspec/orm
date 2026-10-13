<?php
declare(strict_types=1);
// model_writes feature coverage: 생성된 CompositeAccount model의 create,
// creates, update, duplication(upsert), count, delete를 tenant 990002의 행으로
// 실행하고 그 행을 모두 지운다. composite_account에는 identity column이 없어
// database state가 실행 전과 같게 남는다.

require __DIR__ . '/autoload.php';
require __DIR__ . '/coverage_cases.php';

use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Code;

const WRITE_TENANT = 990002;

runCoverageCases($argv, [
    'model_write_cycle' => function (): void {
        [, $dsn] = coverageDatabase();
        $db = coverageConnect($dsn);
        try {
            $existing = (new CompositeAccount)($db)->tenantId(WRITE_TENANT)->getCount();
            coverageWant($existing === 0, "composite_account holds $existing rows of tenant " . WRITE_TENANT . ' before the case');
            coverageRestoring(function () use ($db): void {
                $created = (new CompositeAccount)($db)->setTenantId(WRITE_TENANT)->setAccountId(1)->setName('created')->create();
                coverageWant($created->getName() === 'created' && $created->getAccountId() === 1, 'created row ' . json_encode($created->toArray()));
                $inserted = (new CompositeAccount)($db)->creates([
                    (new CompositeAccount)->setTenantId(WRITE_TENANT)->setAccountId(2)->setName('many-2'),
                    (new CompositeAccount)->setTenantId(WRITE_TENANT)->setAccountId(3)->setName('many-3'),
                    (new CompositeAccount)->setTenantId(WRITE_TENANT)->setAccountId(4)->setName('many-4'),
                ]);
                coverageWant($inserted === 3, "creates inserted $inserted rows, want 3");
                (new CompositeAccount)($db)->getByTenantIdAndAccountId(WRITE_TENANT, 1)->setName('updated')->update();
                $name = (new CompositeAccount)($db)->getByTenantIdAndAccountId(WRITE_TENANT, 1)->getName();
                coverageWant($name === 'updated', "updated name is $name");
                (new CompositeAccount)($db)->setTenantId(WRITE_TENANT)->setAccountId(1)->setName('ignored')
                    ->duplication((new CompositeAccount)->setName('upserted'))->create();
                $name = (new CompositeAccount)($db)->getByTenantIdAndAccountId(WRITE_TENANT, 1)->getName();
                coverageWant($name === 'upserted', "upserted name is $name");
                $count = (new CompositeAccount)($db)->tenantId(WRITE_TENANT)->getCount();
                coverageWant($count === 4, "tenant row count is $count, want 4");
                (new CompositeAccount)($db)->tenantId(WRITE_TENANT)->gets()->delete();
                $missing = coverageCode(fn() => (new CompositeAccount)($db)->getByTenantIdAndAccountId(WRITE_TENANT, 1));
                coverageWant($missing === Code::NO_ROWS, "get of a deleted row is $missing, want NO_ROWS");
                $left = (new CompositeAccount)($db)->tenantId(WRITE_TENANT)->getCount();
                coverageWant($left === 0, "$left rows left after delete");
            }, fn() => (new CompositeAccount)($db)->tenantId(WRITE_TENANT)->gets()->delete());
        } finally {
            $db->close();
        }
    },
]);
