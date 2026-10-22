<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The full-text predicates (PRT-75): the fulltext_boolean normalization of DIA-6, and the match each dialect renders
// over the columns, with SQLite refusing the predicate (DIA-187).
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/FulltextSearchTest.php

use Polyspec\Orm\Code;
use Polyspec\Orm\Dialect;
use Polyspec\Orm\Engine;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Planner;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Transform;
use PHPUnit\Framework\TestCase;

final class FulltextSearchTest extends TestCase
{
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
        if (extension_loaded('polyspec_orm')) {
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
