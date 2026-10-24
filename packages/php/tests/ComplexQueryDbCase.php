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
    public static function run(bool $native): void
    {
        if ($native) {
            self::assertNativeClasses();
        }

        $fixture = self::fixture();
        foreach (['mysql', 'postgres', 'sqlite'] as $driver) {
            with_case_database($driver, static function (string $step): void {
            }, static function (string $dsn) use ($driver, $fixture): void {
                $db = \Polyspec\Orm\Tests\ComplexModel\connect($dsn, new Config());
                try {
                    Assert::assertSame($driver, $db->driver(), 'the DSN selects the requested dialect');
                    $db->utils()->schema()->install(\Polyspec\Orm\Tests\ComplexModel\schema());
                    if ($driver === 'sqlite') {
                        self::assertSqliteRefusal($db, $fixture);
                        return;
                    }

                    self::seed($db->pdo(), $driver, $fixture);
                    if ($driver === 'mysql') {
                        foreach ($fixture['mysql_setup'] as $statement) {
                            $db->pdo()->exec($statement);
                        }
                    }
                    self::assertPage($db, $driver, $fixture);
                } finally {
                    $db->close();
                }
            });
        }
    }

    public static function runFeature(bool $native): void
    {
        if ($native) {
            self::assertNativeClasses();
        }
        $driver = getenv('ORM_FEATURE_DATABASE');
        $dsn = getenv('ORM_FEATURE_DSN');
        if (!is_string($driver) || !in_array($driver, ['mysql', 'postgres', 'sqlite'], true)) {
            throw new \RuntimeException(
                'ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required; run the feature coverage command'
            );
        }
        if (!is_string($dsn) || $dsn === '') {
            throw new \RuntimeException('ORM_FEATURE_DSN is required; run the feature coverage command');
        }
        $fixture = self::fixture();
        $db = \Polyspec\Orm\Tests\ComplexModel\connect($dsn, new Config());
        try {
            Assert::assertSame($driver, $db->driver(), 'ORM_FEATURE_DSN selects the requested database');
            if ($driver === 'sqlite') {
                self::assertSqliteRefusal($db, $fixture);
            } else {
                self::assertPage($db, $driver, $fixture);
            }
        } finally {
            $db->close();
        }
    }

    public static function assertFulltextChains(bool $native): void
    {
        if ($native) {
            self::assertNativeClasses();
        }
        $cases = [
            [
                (new Product())->fulltextBooleanNameWithShortDescriptionWithContent('alpha beta'),
                ['name', 'short_description', 'content'],
            ],
            [
                (new ProductBrandLang())->fulltextBooleanNameWithDescription('alpha beta'),
                ['name', 'description'],
            ],
        ];
        $where = new \ReflectionProperty(\Polyspec\Orm\Model::class, 'where');
        foreach ($cases as [$model, $columns]) {
            $state = $where->getValue($model);
            Assert::assertSame('fulltext_boolean', $state['items'][0]['pred']['op']);
            Assert::assertSame($columns, $state['items'][0]['pred']['cols']);
            Assert::assertSame('alpha beta', $state['items'][0]['pred']['value']);
        }
    }

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

    private static function fixture(): array
    {
        $path = dirname(__DIR__, 3) . '/contracts/fixtures/complex_query/complex_query.json';
        $text = file_get_contents($path);
        if ($text === false) {
            throw new \RuntimeException("cannot read $path");
        }
        return json_decode($text, true, 512, JSON_THROW_ON_ERROR);
    }

    private static function query(?\Polyspec\Orm\Db $db, array $input): Product
    {
        $category = (new ProductMatchCategory())->removeAllColumns()->addColumnProductSeq()
            ->serviceRegionCategoryItemSeq($input['category_seqs']);
        $brandLang = (new ProductBrandLang())->removeAllColumns()->addColumnProductBrandSeq()
            ->fulltextBooleanNameWithDescription($input['keyword']);
        $lang = (new ProductLang())->removeAllColumns()->addColumnProductSeq()
            ->fulltextBooleanNameWithShortDescriptionWithContent($input['keyword']);

        $query = (new Product())
            ->relation((new ProductLang())->matchSeqWithProductSeq()->langId($input['lang_id'])->parentNode())
            ->relation((new ProductBrand())->matchProductBrandSeqWithSeq()->aliasBrand()
                ->relation(
                    (new ProductBrandLang())->matchSeqWithProductBrandSeq()
                        ->langId($input['lang_id'])->parentNode()
                ))
            ->relations((new ProductReview())->matchSeqWithProductSeq()->aliasReviews()
                ->isClose(false)->orderBySeqDesc()->groupLimit(3)->keyNameSeq()
                ->relation((new User())->matchUserSeqWithSeq()->aliasUser()
                    ->removeAllColumns()->addColumnName()->addColumnProfileUrl()))
            ->relation((new OrderProductItem())->matchSeqWithProductSeq()->aliasMyOrderItem()
                ->serviceMemberSeq($input['member_seq'])->andIsClose(false)->orderBySeqDesc()->groupLimit(1))
            ->serviceSeq($input['service_seq'])->andIsClose(false)->andIsDisplay(true)
            ->and(static fn(Product $query): Product => $query
                ->isAllday(true)->or(static fn(Product $nested): Product => $nested
                    ->isAllday(false)->andLeDisplayStartDt(\Polyspec\Orm\Orm::now())
                    ->andGeDisplayEndDt(\Polyspec\Orm\Orm::now())))
            ->andSeq($category)
            ->and(static fn(Product $query): Product => $query
                ->fulltextBooleanNameWithShortDescriptionWithContent($input['keyword'])
                ->or(static fn(Product $nested): Product => $nested->productBrandSeq($brandLang))
                ->or(static fn(Product $nested): Product => $nested->seq($lang)))
            ->orderByLikeCountDescAndSeqDesc();
        return $db === null ? $query : $query->connect($db);
    }

    public static function assertPublicRequestCompiles(bool $native): void
    {
        if ($native) {
            self::assertNativeClasses();
        }
        $fixture = self::fixture();
        $root = dirname(__DIR__, 3);
        $model = RuntimeModel::build(RuntimeModel::files(["$root/{$fixture['schema']}"]));
        $pdo = new PDO('sqlite::memory:');
        $db = new \Polyspec\Orm\Db($pdo, 'sqlite', new Config(), new \DateTimeZone('UTC'));
        try {
            $query = self::query($db, $fixture['input']);
            $build = new \ReflectionMethod(\Polyspec\Orm\Model::class, 'build');
            $request = $build->invoke($query, 'paginate', $db);
            foreach (['mysql', 'postgres'] as $driver) {
                self::assertPlanSteps($model, $driver, $request->shape(), $fixture, "$driver compiled public request");
            }
            try {
                (new Engine($model, 'sqlite', 8))->compile($request->shape());
                Assert::fail('SQLite must reject the full-text public request');
            } catch (OrmException $error) {
                Assert::assertSame(Code::OPERATOR_NOT_ALLOWED, $error->code_);
            }
        } finally {
            $db->close();
        }
    }

    private static function assertPlan(\Polyspec\Orm\Db $db, string $driver, array $input, array $fixture): void
    {
        $query = self::query($db, $input);
        $build = new \ReflectionMethod(\Polyspec\Orm\Model::class, 'build');
        $request = $build->invoke($query, 'paginate', $db);
        $root = dirname(__DIR__, 3);
        $model = RuntimeModel::build(RuntimeModel::files(["$root/{$fixture['schema']}"]));
        self::assertPlanSteps($model, $driver, $request->shape(), $fixture, "$driver compiled plan steps");
    }

    private static function assertPlanSteps(
        RuntimeModel $model,
        string $driver,
        array $shape,
        array $fixture,
        string $message
    ): void {
        $plan = (new Engine($model, $driver, 8))->compile($shape);
        $steps = array_map(static fn(array $step): array => [
            'role' => $step['role'],
            'tables' => $step['tables'],
        ], $plan['steps']);
        Assert::assertSame($fixture['expected_plan_steps'][$driver], $steps, $message);
    }

    private static function seed(PDO $pdo, string $driver, array $fixture): void
    {
        $quote = $driver === 'mysql' ? '`' : '"';
        foreach ($fixture['seed_order'] as $table) {
            $columns = $fixture['seed_columns'][$table];
            $names = array_map(static fn(string $column): string => $quote . $column . $quote, $columns);
            $slots = array_map(
                static fn(int $index): string => $driver === 'postgres' ? '$' . ($index + 1) : '?',
                array_keys($columns)
            );
            $sql = 'INSERT INTO ' . $quote . $table . $quote . ' (' . implode(', ', $names) . ') VALUES ('
                . implode(', ', $slots) . ')';
            $statement = $pdo->prepare($sql);
            foreach ($fixture['seed'][$table] as $row) {
                foreach ($columns as $index => $column) {
                    $value = $row[$column];
                    $type = match (true) {
                        $value === null => PDO::PARAM_NULL,
                        is_bool($value) => PDO::PARAM_BOOL,
                        is_int($value) => PDO::PARAM_INT,
                        default => PDO::PARAM_STR,
                    };
                    $statement->bindValue($index + 1, $value, $type);
                }
                $statement->execute();
            }
        }
    }

    private static function assertSqliteRefusal(\Polyspec\Orm\Db $db, array $fixture): void
    {
        $events = [];
        $unsubscribe = $db->subscribe(static function (StatementEvent $event) use (&$events): void {
            $events[] = $event;
        });
        try {
            self::query($db, $fixture['input'])->getsPage(
                $fixture['input']['page'],
                $fixture['input']['per_page']
            );
            Assert::fail('SQLite must refuse full-text search before sending a statement');
        } catch (OrmException $error) {
            Assert::assertSame(Code::OPERATOR_NOT_ALLOWED, $error->code_);
        } finally {
            $unsubscribe();
        }
        Assert::assertSame([], $events, 'SQLite full-text refusal sends no statement');
        Assert::assertSame([], $fixture['expected_events']['sqlite']);
    }

    private static function assertPage(\Polyspec\Orm\Db $db, string $driver, array $fixture): void
    {
        self::assertPlan($db, $driver, $fixture['input'], $fixture);
        $events = [];
        $unsubscribe = $db->subscribe(static function (StatementEvent $event) use (&$events): void {
            $events[] = ['kind' => $event->kind, 'tables' => $event->tables];
        });
        try {
            $page = self::query($db, $fixture['input'])->getsPage(
                $fixture['input']['page'],
                $fixture['input']['per_page']
            );
        } finally {
            $unsubscribe();
        }
        $expected = $fixture['expected'];
        Assert::assertSame($expected['total_count'], $page->totalCount);
        Assert::assertSame($expected['total_pages'], $page->totalPages);

        $sequences = [];
        $productLangs = [];
        $brands = [];
        $brandLangs = [];
        $reviews = [];
        $reviewUsers = [];
        $orderItems = [];
        foreach ($page->items as $product) {
            $sequence = $product->getSeq();
            $key = (string) $sequence;
            $sequences[] = $sequence;
            if (isset($expected['product_lang_seqs'][$key])) {
                $language = $product->getProductLangModel();
                Assert::assertNotNull($language, "product $sequence has its localized row");
                $productLangs[$key] = $language->getSeq();
                Assert::assertSame('widget-' . $sequence . '-en', $product->getName());
            }
            if (isset($expected['brand_seqs'][$key])) {
                $brand = $product->getBrand();
                Assert::assertNotNull($brand, "product $sequence has its brand");
                $brandSequence = $brand->getSeq();
                $brands[$key] = $brandSequence;
                if (isset($expected['brand_lang_seqs'][(string) $brandSequence])) {
                    $brandLanguage = $brand->getProductBrandLangModel();
                    Assert::assertNotNull($brandLanguage, "brand $brandSequence has its localized row");
                    $brandLangs[(string) $brandSequence] = $brandLanguage->getSeq();
                    Assert::assertSame("brand-$brandSequence-en", $brand->getName());
                }
            }
            if (isset($expected['review_seqs'][$key])) {
                $productReviews = [];
                foreach ($product->getReviews() as $review) {
                    $reviewSequence = $review->getSeq();
                    $productReviews[] = $reviewSequence;
                    if (isset($expected['review_user_seqs'][(string) $reviewSequence])) {
                        $user = $review->getUser();
                        Assert::assertNotNull($user, "review $reviewSequence has its user");
                        $reviewUsers[(string) $reviewSequence] = $user->getSeq();
                    }
                }
                $reviews[$key] = $productReviews;
            }
            if (isset($expected['order_product_item_seqs'][$key])) {
                $item = $product->getMyOrderItem();
                Assert::assertNotNull($item, "product $sequence has its member order item");
                $orderItems[$key] = $item->getSeq();
            }
        }
        Assert::assertSame($expected['row_seqs'], $sequences);
        Assert::assertSame($expected['product_lang_seqs'], $productLangs);
        Assert::assertSame($expected['brand_seqs'], $brands);
        Assert::assertSame($expected['brand_lang_seqs'], $brandLangs);
        Assert::assertSame($expected['review_seqs'], $reviews);
        ksort($reviewUsers);
        Assert::assertSame($expected['review_user_seqs'], $reviewUsers);
        Assert::assertSame($expected['order_product_item_seqs'], $orderItems);
        Assert::assertSame($fixture['expected_events'][$driver], $events);
    }
}
