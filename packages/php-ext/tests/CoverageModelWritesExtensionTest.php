<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Model;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

#[Medium]
final class CoverageModelWritesExtensionTest extends TestCase
{
    // Requirements: DSL-104, INT-35, PRT-41.
    public function testCreateParts(): void
    {
        Assert::assertTrue((new ReflectionMethod(Model::class, 'creates'))->isInternal(), 'Model::creates is native');
        require_once dirname(__DIR__, 2) . '/php/tests/CoverageModelWritesCase.php';
        \Polyspec\Orm\Tests\CoverageModelWritesCase::createParts(__FILE__, 990003);
    }

    // Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-110.
    public function testModelWriteCycle(): void
    {
        foreach (['create', 'creates', 'update', 'delete', 'getCount'] as $method) {
            Assert::assertTrue((new ReflectionMethod(Model::class, $method))->isInternal(), "Model::$method is native");
        }
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                $existing = (new CompositeAccount())($db)->tenantId(990002)->getCount();
                Assert::assertSame(0, $existing, "composite_account holds $existing rows before the case");
                coverageRestoring(function () use ($db): void {
                    $created = (new CompositeAccount())($db)->setTenantId(990002)->setAccountId(1)
                        ->setName('created')->create();
                    Assert::assertSame('created', $created->getName());
                    Assert::assertSame(3, (new CompositeAccount())($db)->creates([
                        (new CompositeAccount())->setTenantId(990002)->setAccountId(2)->setName('many-2'),
                        (new CompositeAccount())->setTenantId(990002)->setAccountId(3)->setName('many-3'),
                        (new CompositeAccount())->setTenantId(990002)->setAccountId(4)->setName('many-4'),
                    ], 2));
                    (new CompositeAccount())($db)->getByTenantIdAndAccountId(990002, 1)
                        ->setName('updated')->update();
                    Assert::assertSame(
                        'updated',
                        (new CompositeAccount())($db)->getByTenantIdAndAccountId(990002, 1)->getName(),
                    );
                    (new CompositeAccount())($db)->setTenantId(990002)->setAccountId(1)->setName('ignored')
                        ->duplication((new CompositeAccount())->setName('upserted'))->create();
                    Assert::assertSame(
                        'upserted',
                        (new CompositeAccount())($db)->getByTenantIdAndAccountId(990002, 1)->getName(),
                    );
                    Assert::assertSame(4, (new CompositeAccount())($db)->tenantId(990002)->getCount());
                    (new CompositeAccount())($db)->tenantId(990002)->gets()->delete();
                    Assert::assertNull((new CompositeAccount())($db)->getByTenantIdAndAccountId(990002, 1));
                    Assert::assertSame(0, (new CompositeAccount())($db)->tenantId(990002)->getCount());
                }, fn() => (new CompositeAccount())($db)->tenantId(990002)->gets()->delete());
            } finally {
                $db->close();
            }
        }
    }
}
