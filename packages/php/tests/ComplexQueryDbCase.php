<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PHPUnit\Framework\Assert;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Engine;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\StatementEvent;
use Polyspec\Orm\Tests\ComplexModel\OrderProductItem;
use Polyspec\Orm\Tests\ComplexModel\Product;
use Polyspec\Orm\Tests\ComplexModel\ProductBrand;
use Polyspec\Orm\Tests\ComplexModel\ProductBrandLang;
use Polyspec\Orm\Tests\ComplexModel\ProductLang;
use Polyspec\Orm\Tests\ComplexModel\ProductMatchCategory;
use Polyspec\Orm\Tests\ComplexModel\ProductReview;
use Polyspec\Orm\Tests\ComplexModel\User;

final class ComplexQueryDbCase
{
    private static function assertNativeClasses(): void
    {
        foreach (
            [
            \Polyspec\Orm\Db::class,
            \Polyspec\Orm\Model::class,
            \Polyspec\Orm\Planner::class,
            \Polyspec\Orm\Chain::class,
            ] as $class
        ) {
            Assert::assertTrue((new \ReflectionClass($class))->isInternal(), "$class is a native extension class");
        }
    }

    public static function assertPagePlanSteps(bool $native): void
    {
        if ($native) {
            self::assertNativeClasses();
        }
        with_case_database('sqlite', static function (string $step): void {
        }, static function (string $dsn): void {
            $db = \Polyspec\Orm\Tests\ComplexModel\connect($dsn, new Config());
            try {
                $db->utils()->schema()->install(\Polyspec\Orm\Tests\ComplexModel\schema());
                $query = static fn(): Product => (new Product())->connect($db)
                    ->relations((new ProductReview())->matchSeqWithProductSeq()->aliasReviews())
                    ->serviceSeq(7)->orderBySeqDesc();
                $steps = $query()->getPagePlanSteps(2, 20);
                Assert::assertSame([
                    ['role' => 'main', 'tables' => ['product']],
                    ['role' => 'count', 'tables' => ['product']],
                    ['role' => 'relation', 'tables' => ['product_review']],
                ], array_map(static fn(array $s): array => ['role' => $s['role'], 'tables' => $s['tables']], $steps));
                // The steps are the statements that getsPage sends.
                $events = [];
                $unsubscribe = $db->subscribe(static function (StatementEvent $event) use (&$events): void {
                    $events[] = $event->sql;
                });
                $query()->getsPage(2, 20);
                $unsubscribe();
                Assert::assertSame([$steps[0]['sql'], $steps[1]['sql']], $events);
                foreach ([
                    static fn() => $query()->getPagePlanSteps(0, 20),
                    static fn() => $query()->getPagePlanSteps(1, 0),
                    static fn() => $query()->limit(0, 1)->getPagePlanSteps(1, 20),
                    static fn() => (new Product())->getPagePlanSteps(1, 20),
                ] as $refused) {
                    self::assertCode(Code::CONFIG, $refused);
                }
                self::assertCode(
                    Code::OPERATOR_NOT_ALLOWED,
                    static fn() => (new Product())->connect($db)
                        ->fulltextBooleanNameWithShortDescriptionWithContent('alpha')->getPagePlanSteps(1, 20)
                );
            } finally {
                $db->close();
            }
        });
    }

    private static function assertCode(string $code, \Closure $refused): void
    {
        try {
            $refused();
            Assert::fail("want $code");
        } catch (OrmException $error) {
            Assert::assertSame($code, $error->code_);
        }
    }
}
