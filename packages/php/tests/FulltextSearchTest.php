<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The full-text predicates (PRT-75): the fulltext_boolean normalization of DIA-6, and the match each dialect renders
// over the columns, with SQLite refusing the predicate (DIA-187).
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/FulltextSearchTest.php

use Polyspec\Orm\Code;
use Polyspec\Orm\Chain;
use Polyspec\Orm\Config;
use Polyspec\Orm\Dialect;
use Polyspec\Orm\Engine;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Planner;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Transform;
use PHPUnit\Framework\TestCase;

final class FulltextSearchTest extends TestCase
{
    public function testModelBuilderParsesTheDocumentedFulltextNames(): void
    {
        if (getenv('ORM_PHP_MODE') === 'extension') {
            self::assertTrue((new \ReflectionClass(Model::class))->isInternal());
            self::assertTrue((new \ReflectionClass(Chain::class))->isInternal());
        }
        $metadata = [
            'entity' => 'product_lang',
            'manifest_hash' => 'sha256:test',
            'columns' => [
                'name' => ['type' => 'text', 'codec' => []],
                'short_description' => ['type' => 'varchar', 'codec' => []],
                'content' => ['type' => 'text', 'codec' => []],
            ],
        ];
        $schema = [$metadata];

        self::assertSame([
            [
                'conn' => '', 'op' => 'fulltext_boolean', 'column' => '',
                'columns' => ['name', 'short_description', 'content'], 'compare' => '',
            ],
        ], Chain::parseMeta($metadata, $schema, 'FulltextBooleanNameWithShortDescriptionWithContent'));
        self::assertSame([
            [
                'conn' => '', 'op' => 'fulltext', 'column' => '', 'columns' => ['name', 'content'], 'compare' => '',
            ],
        ], Chain::parseMeta($metadata, $schema, 'FulltextNameWithContent'));

        $user = (new \Polyspec\Orm\Tests\Model\User())->fulltextBooleanName('alpha beta');
        $where = (new \ReflectionProperty(Model::class, 'where'))->getValue($user);
        self::assertSame('fulltext_boolean', $where['items'][0]['pred']['op']);
        self::assertSame(['name'], $where['items'][0]['pred']['cols']);
        self::assertSame('alpha beta', $where['items'][0]['pred']['value']);

        $path = tempnam(sys_get_temp_dir(), 'orm-fulltext-');
        self::assertIsString($path);
        $db = null;
        try {
            $db = \Polyspec\Orm\Tests\Model\connect("sqlite://$path", new Config());
            $query = (new \Polyspec\Orm\Tests\Model\User())->connect($db)->fulltextBooleanName('alpha beta');
            try {
                $query->getQuery();
                self::fail('SQLite must refuse the documented full-text model chain');
            } catch (OrmException $e) {
                self::assertSame(Code::OPERATOR_NOT_ALLOWED, $e->code_);
            }
        } finally {
            if ($db !== null) {
                $db->close();
            }
            foreach (['', '-journal', '-wal', '-shm'] as $suffix) {
                if (file_exists($path . $suffix)) {
                    self::assertTrue(unlink($path . $suffix), "remove SQLite test file $path$suffix");
                }
            }
        }
    }

    public function testPaginateRunsRootThenCountThenItsSixRelations(): void
    {
        if (getenv('ORM_PHP_MODE') === 'extension') {
            self::assertTrue((new \ReflectionClass(\Polyspec\Orm\Db::class))->isInternal());
        }
        $path = tempnam(sys_get_temp_dir(), 'orm-cpx2-');
        self::assertIsString($path);
        $db = null;
        try {
            $db = \Polyspec\Orm\Tests\Model\connect("sqlite://$path", new Config());
            \Polyspec\Orm\Tests\installBench($db);
            $service = (new \Polyspec\Orm\Tests\Model\Service())->connect($db)
                ->setName('service')
                ->create();
            (new \Polyspec\Orm\Tests\Model\ServiceRegion())->connect($db)
                ->setServiceSeq($service->getSeq())
                ->setName('region')
                ->create();

            $selects = [];
            $db->subscribe(static function (object $event) use (&$selects): void {
                if ($event->kind === 'select') {
                    $selects[] = $event->sql;
                }
            });

            $query = (new \Polyspec\Orm\Tests\Model\Service())->connect($db);
            foreach (['One', 'Two', 'Three', 'Four', 'Five', 'Six'] as $name) {
                $query = $query->relations(
                    (new \Polyspec\Orm\Tests\Model\ServiceRegion())
                        ->matchSeqWithServiceSeq()
                        ->{'aliasRegion' . $name}()
                );
            }
            $build = new \ReflectionMethod(Model::class, 'build');
            $request = $build->invoke($query, 'paginate', $db);
            $root = dirname(__DIR__, 3);
            $runtime = RuntimeModel::build(RuntimeModel::files(
                [
                    "$root/contracts/fixtures/bench/bench.dbs",
                    "$root/contracts/fixtures/bench/bench_reader.dbs",
                ],
                ["$root/contracts/fixtures/bench/bench_shared.dbs"]
            ));
            $compiled = (new Engine($runtime, 'sqlite', 8))->compile($request->shape());
            self::assertSame(
                ['main', 'count', 'relation', 'relation', 'relation', 'relation', 'relation', 'relation'],
                array_column($compiled['steps'], 'role')
            );
            $page = $query->getsPage(1, 10);

            self::assertSame(1, $page->totalCount);
            self::assertCount(1, $page->items);
            self::assertCount(8, $selects);
            self::assertStringContainsString(' FROM "service" ', $selects[0]);
            self::assertStringContainsString('COUNT(*)', $selects[1]);
            foreach (array_slice($selects, 2) as $sql) {
                self::assertStringContainsString('service_region', $sql);
            }
        } finally {
            if ($db !== null) {
                $db->close();
            }
            foreach (['', '-journal', '-wal', '-shm'] as $suffix) {
                if (file_exists($path . $suffix)) {
                    self::assertTrue(unlink($path . $suffix), "remove SQLite test file $path$suffix");
                }
            }
        }
    }

    public function testFulltextSearch(): void
    {
        $cases = [
            'alpha beta' => '+alpha +beta*',
            "  +a  (b) \"c\"  " => '+a +b +c*',
            'one ~ two' => '+one +two*',
            '' => '',
            "  \t " => '',
            '+ - < > ( ) ~ * " @' => '',
        ];
        foreach ($cases as $input => $want) {
            $this->assertSame($want, Transform::fulltextBoolean($input), "fulltextBoolean($input)");
        }

        $this->assertSame('+alpha +beta*', Transform::param('fulltext_boolean', 'alpha beta'));
        try {
            Transform::param('fulltext_boolean', '  ');
            $this->fail('an empty search text must be refused');
        } catch (OrmException $e) {
            $this->assertSame(Code::IR_INVALID, $e->code_);
        }

        $cols = ['p.name', 'p.description'];
        $value = static fn(string $t): string => "\$[$t]";
        $mysql = new Dialect('mysql');
        $postgres = new Dialect('postgres');
        $sqlite = new Dialect('sqlite');

        $this->assertSame(
            'MATCH (p.name, p.description) AGAINST ($[fulltext_boolean] IN BOOLEAN MODE)',
            $mysql->fulltext($cols, $value, true)
        );
        $this->assertSame(
            'MATCH (p.name, p.description) AGAINST ($[] IN NATURAL LANGUAGE MODE)',
            $mysql->fulltext($cols, $value, false)
        );
        $doc = "to_tsvector('simple', coalesce(p.name, '') || ' ' || coalesce(p.description, ''))";
        $this->assertSame("$doc @@ plainto_tsquery('simple', \$[])", $postgres->fulltext($cols, $value, false));
        $this->assertSame("$doc @@ websearch_to_tsquery('simple', \$[])", $postgres->fulltext($cols, $value, true));
        $this->assertNull($sqlite->fulltext($cols, $value, true));

        $this->assertCompiles();
    }

    /**
     * The planner of the engine compiles the predicate in each dialect. With the extension loaded, the planner is the
     * extension's (the extension registers Planner), and its predicate, bind slot and error come from the C planner and
     * validator.
     */
    private function assertCompiles(): void
    {
        if (getenv('ORM_PHP_MODE') === 'extension') {
            $this->assertTrue(
                (new \ReflectionClass(Planner::class))->isInternal(),
                'the planner is the extension planner'
            );
        }
        $root = dirname(__DIR__, 3);
        $model = RuntimeModel::build(RuntimeModel::files(["$root/contracts/fixtures/bench/bench.dbs"]));
        $request = [
            'manifest_hash' => $model->manifestHash,
            'entity' => 'user',
            'ir_version' => 1,
            'kind' => 'count',
            'n_params' => 1,
            'where' => ['items' => [['pred' => ['cols' => ['name'], 'op' => 'fulltext_boolean', 'p' => 0]]]],
        ];
        $mysql = (new Engine($model, 'mysql', 8))->compile($request)['steps'][0];
        $this->assertSame(
            'SELECT COUNT(*) FROM `user` AS `a` WHERE MATCH (`a`.`name`) AGAINST (? IN BOOLEAN MODE)',
            $mysql['sql']
        );
        $this->assertSame('fulltext_boolean', $mysql['bind_slots'][0]['transform']);
        $postgres = (new Engine($model, 'postgres', 8))->compile($request)['steps'][0];
        $this->assertSame(
            "SELECT COUNT(*) FROM \"user\" AS \"a\" WHERE to_tsvector('simple', coalesce(\"a\".\"name\", '')) @@ "
            . "websearch_to_tsquery('simple', \$1)",
            $postgres['sql']
        );
        try {
            (new Engine($model, 'sqlite', 8))->compile($request);
            $this->fail('SQLite must refuse the predicate');
        } catch (OrmException $e) {
            $this->assertSame(Code::OPERATOR_NOT_ALLOWED, $e->code_);
        }
    }
}
