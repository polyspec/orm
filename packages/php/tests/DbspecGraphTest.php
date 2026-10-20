<?php

declare(strict_types=1);

// A document, document set, plan list or unsupported list whose array holds another type is a TypeError
// "<what> holds <value>, not <type>" at the first such element (Polyspec\Orm\Dbspec\Graph), one case per checked array;
// a document whose arrays hold their types is read as before.
require_once __DIR__ . '/case_clock.php';
require_once __DIR__ . '/dbspec_plan_cases.php';

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Document;
use Polyspec\Orm\Dbspec\Plan;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

// The document of the canonical case every-line-kind of tests/dbspec/cases.json.
const GRAPH_TEXT = "dbspec 1 shop\n\nuse core { users }\n\ntable orders {\n  id i64 identity\n  user_id i64\n  status varchar(32) default 'pending'\n  total decimal(13,2) default 0.00\n  coupon_code varchar(32) null\n  placed_at datetime(6) default now\n  primary key (id)\n  unique uq_orders_coupon (coupon_code)\n  index ix_orders_status (status, placed_at desc)\n  index ix_orders_user (user_id)\n  foreign key fk_orders_user (user_id) references users (id) on delete restrict on update restrict\n  check ck_orders_total (total >= 0.00)\n  settings {\n    updated placed_at\n    select explicit coupon_code\n  }\n}\n\ndiagram main {\n  orders at 120 340\n}\n";
const GRAPH_CORE = "dbspec 1 core\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n";

/** A parsed copy of the graph document, whose core document is external. */
function graph_document(): Document
{
    $document = Dbspec::parse(GRAPH_TEXT, ['core' => GRAPH_CORE])->document;
    Assert::assertNotNull($document, 'the graph document parses');
    return $document;
}

function graph_core(): Document
{
    $core = Dbspec::parse(GRAPH_CORE, [])->document;
    $core->external = true;
    return $core;
}

/** The plan of the case rename-table-and-column of tests/dbspec/plans.json. */
function graph_plan_text(): string
{
    $vectors = plan_vectors();
    return implode("\n", array_column($vectors['cases'], 'plan', 'id')['rename-table-and-column']) . "\n";
}

/** A copy of the graph plan with the given properties (Plan is readonly). */
function graph_plan_with(array $changes): Plan
{
    $p = graph_plan();
    $args = ['name' => $p->name, 'from' => $p->from, 'renameTables' => $p->renameTables, 'renameColumns' => $p->renameColumns, 'dropTables' => $p->dropTables, 'dropColumns' => $p->dropColumns, 'schema' => $p->schema, 'to' => $p->to];
    return new Plan(...array_merge($args, $changes));
}

function graph_plan(): Plan
{
    $plan = Dbspec::parsePlan(graph_plan_text())->plan;
    Assert::assertNotNull($plan, 'the graph plan parses');
    return $plan;
}

/** The message of the TypeError that $body throws. */
function graph_type_error(Closure $body): string
{
    try {
        $body();
    } catch (TypeError $e) {
        return $e->getMessage();
    }
    Assert::fail('no TypeError');
}

#[Small]
final class DbspecGraphTest extends TestCase
{
    /** @return iterable<string, array{Closure(Document): void, string}> a change that puts a wrong element in one array, and the message */
    public static function documentCases(): iterable
    {
        $n = 'Polyspec\\Orm\\Dbspec\\';
        yield 'Document::$trailingComments' => [static function (Document $d): void {
            $d->trailingComments = ['# end', 1];
        }, "{$n}Document::\$trailingComments holds int, not a string"];
        yield 'Document::$uses' => [static function (Document $d): void {
            $d->uses[] = 'core';
        }, "{$n}Document::\$uses holds string, not {$n}UseLine"];
        yield 'UseLine::$tables' => [static function (Document $d): void {
            $d->uses[0]->tables[] = null;
        }, "{$n}UseLine::\$tables holds null, not a string"];
        yield 'UseLine::$comments' => [static function (Document $d): void {
            $d->uses[0]->comments = [true];
        }, "{$n}UseLine::\$comments holds true, not a string"];
        yield 'Document::$tables' => [static function (Document $d): void {
            $d->tables[] = [];
        }, "{$n}Document::\$tables holds array, not {$n}Table"];
        yield 'Table::$comments' => [static function (Document $d): void {
            $d->tables[0]->comments = [1.5];
        }, "{$n}Table::\$comments holds float, not a string"];
        yield 'Table::$closingComments' => [static function (Document $d): void {
            $d->tables[0]->closingComments = [false];
        }, "{$n}Table::\$closingComments holds false, not a string"];
        yield 'Table::$columns' => [static function (Document $d): void {
            $d->tables[0]->columns[] = 'id';
        }, "{$n}Table::\$columns holds string, not {$n}Column"];
        yield 'ColumnType::$parameters' => [static function (Document $d): void {
            $d->tables[0]->columns[2]->type = new Polyspec\Orm\Dbspec\ColumnType('varchar', ['32']);
        }, "{$n}ColumnType::\$parameters holds string, not an int"];
        yield 'Column::$comments' => [static function (Document $d): void {
            $d->tables[0]->columns[0]->comments = [2];
        }, "{$n}Column::\$comments holds int, not a string"];
        yield 'PrimaryKey::$columns' => [static function (Document $d): void {
            $d->tables[0]->primaryKey->columns = [1];
        }, "{$n}PrimaryKey::\$columns holds int, not a string"];
        yield 'PrimaryKey::$comments' => [static function (Document $d): void {
            $d->tables[0]->primaryKey->comments = [1];
        }, "{$n}PrimaryKey::\$comments holds int, not a string"];
        yield 'Table::$uniqueKeys' => [static function (Document $d): void {
            $d->tables[0]->uniqueKeys[] = 1;
        }, "{$n}Table::\$uniqueKeys holds int, not {$n}UniqueKey"];
        yield 'UniqueKey::$columns' => [static function (Document $d): void {
            $d->tables[0]->uniqueKeys[0]->columns = [1];
        }, "{$n}UniqueKey::\$columns holds int, not a string"];
        yield 'UniqueKey::$comments' => [static function (Document $d): void {
            $d->tables[0]->uniqueKeys[0]->comments = [1];
        }, "{$n}UniqueKey::\$comments holds int, not a string"];
        yield 'Table::$indexes' => [static function (Document $d): void {
            $d->tables[0]->indexes[] = 1;
        }, "{$n}Table::\$indexes holds int, not {$n}Index"];
        yield 'Index::$columns' => [static function (Document $d): void {
            $d->tables[0]->indexes[0]->columns = ['user_id'];
        }, "{$n}Index::\$columns holds string, not {$n}IndexColumn"];
        yield 'Index::$comments' => [static function (Document $d): void {
            $d->tables[0]->indexes[0]->comments = [1];
        }, "{$n}Index::\$comments holds int, not a string"];
        yield 'Table::$foreignKeys' => [static function (Document $d): void {
            $d->tables[0]->foreignKeys[] = 1;
        }, "{$n}Table::\$foreignKeys holds int, not {$n}ForeignKey"];
        yield 'ForeignKey::$columns' => [static function (Document $d): void {
            $d->tables[0]->foreignKeys[0]->columns = [1];
        }, "{$n}ForeignKey::\$columns holds int, not a string"];
        yield 'ForeignKey::$referencedColumns' => [static function (Document $d): void {
            $d->tables[0]->foreignKeys[0]->referencedColumns = [1];
        }, "{$n}ForeignKey::\$referencedColumns holds int, not a string"];
        yield 'ForeignKey::$comments' => [static function (Document $d): void {
            $d->tables[0]->foreignKeys[0]->comments = [1];
        }, "{$n}ForeignKey::\$comments holds int, not a string"];
        yield 'Table::$checks' => [static function (Document $d): void {
            $d->tables[0]->checks[] = 1;
        }, "{$n}Table::\$checks holds int, not {$n}Check"];
        yield 'Check::$comments' => [static function (Document $d): void {
            $d->tables[0]->checks[0]->comments = [1];
        }, "{$n}Check::\$comments holds int, not a string"];
        yield 'Settings::$comments' => [static function (Document $d): void {
            $d->tables[0]->settings->comments = [1];
        }, "{$n}Settings::\$comments holds int, not a string"];
        yield 'Settings::$closingComments' => [static function (Document $d): void {
            $d->tables[0]->settings->closingComments = [1];
        }, "{$n}Settings::\$closingComments holds int, not a string"];
        yield 'Settings::$settings' => [static function (Document $d): void {
            $d->tables[0]->settings->settings[] = 'immutable';
        }, "{$n}Settings::\$settings holds string, not {$n}Setting"];
        yield 'Setting::$arguments' => [static function (Document $d): void {
            $d->tables[0]->settings->settings[1]->arguments = ['code', 1];
        }, "{$n}Setting::\$arguments holds int, not a string"];
        yield 'Setting::$comments' => [static function (Document $d): void {
            $d->tables[0]->settings->settings[0]->comments = [1];
        }, "{$n}Setting::\$comments holds int, not a string"];
        yield 'Setting::$requires' => [static function (Document $d): void {
            $d->tables[0]->settings->settings[0]->requires = [1];
        }, "{$n}Setting::\$requires holds int, not a string"];
        yield 'Setting::$exclude' => [static function (Document $d): void {
            $d->tables[0]->settings->settings[0]->exclude = [1];
        }, "{$n}Setting::\$exclude holds int, not a string"];
        yield 'Setting::$include' => [static function (Document $d): void {
            $d->tables[0]->settings->settings[0]->include = [1];
        }, "{$n}Setting::\$include holds int, not a string"];
        yield 'Document::$diagrams' => [static function (Document $d): void {
            $d->diagrams[] = 'main';
        }, "{$n}Document::\$diagrams holds string, not {$n}Diagram"];
        yield 'Diagram::$comments' => [static function (Document $d): void {
            $d->diagrams[0]->comments = [1];
        }, "{$n}Diagram::\$comments holds int, not a string"];
        yield 'Diagram::$closingComments' => [static function (Document $d): void {
            $d->diagrams[0]->closingComments = [1];
        }, "{$n}Diagram::\$closingComments holds int, not a string"];
        yield 'Diagram::$placements' => [static function (Document $d): void {
            $d->diagrams[0]->placements[] = 'orders';
        }, "{$n}Diagram::\$placements holds string, not {$n}Placement"];
        yield 'Placement::$comments' => [static function (Document $d): void {
            $d->diagrams[0]->placements[0]->comments = [1];
        }, "{$n}Placement::\$comments holds int, not a string"];
    }

    // Every entry point that reads a document refuses the changed document with the same TypeError.
    #[DataProvider('documentCases')]
    public function test_document(Closure $change, string $message): void
    {
        $id = $this->name();
        $entries = [
            'emit' => static fn(Document $d) => Dbspec::emit($d),
            'manifest' => static fn(Document $d) => Dbspec::manifest([$d, graph_core()]),
            'render' => static fn(Document $d) => Dbspec::render([$d, graph_core()], 'sqlite'),
            'externalDifferences' => static fn(Document $d) => Dbspec::externalDifferences($d, []),
            'compareSchemas' => static fn(Document $d) => Dbspec::compareSchemas($d, graph_core()),
            'installedDifferences' => static fn(Document $d) => Dbspec::installedDifferences(graph_core(), [], $d),
            'addTablesAndColumnsSteps' => static fn(Document $d) => Dbspec::addTablesAndColumnsSteps($d, [], graph_core(), 'sqlite'),
            'diff' => static fn(Document $d) => Dbspec::diff($d, graph_plan()),
            'planSteps' => static fn(Document $d) => Dbspec::planSteps($d, graph_plan(), 'sqlite'),
            'exportMermaid' => static fn(Document $d) => Dbspec::exportMermaid($d),
        ];
        foreach ($entries as $entry => $call) {
            $document = graph_document();
            $change($document);
            Assert::assertSame($message, graph_type_error(static fn() => $call($document)), "$id through $entry");
        }
    }

    /** @return iterable<string, array{Closure(): mixed, string}> a call with a wrong element in a list or a plan, and the message */
    public static function listCases(): iterable
    {
        $n = 'Polyspec\\Orm\\Dbspec\\';
        yield 'document set' => [static fn() => Dbspec::manifest([graph_document(), 'core']), "the document set holds string, not {$n}Document"];
        yield 'document set of render' => [static fn() => Dbspec::render([1], 'sqlite'), "the document set holds int, not {$n}Document"];
        yield 'document set of externalDifferences' => [static fn() => Dbspec::externalDifferences(graph_core(), [null]), "the document set holds null, not {$n}Document"];
        yield 'plans' => [static fn() => Dbspec::chain([graph_plan(), 'p']), "the plans holds string, not {$n}Plan"];
        yield 'plans of apply' => [static fn() => Dbspec::apply(new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]), 'sqlite', [1], static fn() => new DateTimeImmutable(), null), "the plans holds int, not {$n}Plan"];
        yield 'unsupported objects' => [static fn() => Dbspec::installedDifferences(graph_core(), ['x'], graph_core()), "the unsupported objects holds string, not {$n}Unsupported"];
        yield 'Plan::$renameTables' => [static fn() => Dbspec::emitPlan(graph_plan_with(['renameTables' => [...graph_plan()->renameTables, 'a']])), "{$n}Plan::\$renameTables holds string, not {$n}TableRename"];
        yield 'Plan::$renameColumns' => [static fn() => Dbspec::emitPlan(graph_plan_with(['renameColumns' => [...graph_plan()->renameColumns, 'a']])), "{$n}Plan::\$renameColumns holds string, not {$n}ColumnRename"];
        yield 'Plan::$dropTables' => [static fn() => Dbspec::emitPlan(graph_plan_with(['dropTables' => [1]])), "{$n}Plan::\$dropTables holds int, not a string"];
        yield 'Plan::$dropColumns' => [static fn() => Dbspec::emitPlan(graph_plan_with(['dropColumns' => ['b.f']])), "{$n}Plan::\$dropColumns holds string, not {$n}ColumnName"];
        yield 'Plan::$schema' => [static function () {
            $p = graph_plan();
            $p->schema->tables[] = 'users';
            return Dbspec::diff(null, $p);
        }, "{$n}Document::\$tables holds string, not {$n}Table"];
    }

    #[DataProvider('listCases')]
    public function test_list(Closure $call, string $message): void
    {
        Assert::assertSame($message, graph_type_error($call), $this->name());
    }

    // The first wrong element in reading order is the one reported: trailing comments come before the tables.
    public function test_first_element(): void
    {
        $document = graph_document();
        $document->tables[0]->columns[] = 'id';
        $document->trailingComments = [1];
        Assert::assertSame('Polyspec\\Orm\\Dbspec\\Document::$trailingComments holds int, not a string', graph_type_error(static fn() => Dbspec::emit($document)));
    }

    // A document whose arrays hold their types reads as before.
    public function test_valid(): void
    {
        $document = graph_document();
        Assert::assertSame(GRAPH_TEXT, Dbspec::emit($document));
        Assert::assertNotNull(Dbspec::manifest([$document, graph_core()])->manifest);
        Assert::assertSame(graph_plan_text(), Dbspec::emitPlan(graph_plan()));
    }
}
