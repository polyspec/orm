<?php

// The lazy registration of generated PHP models: a new process that reads the generated bootstrap and one model loads
// the file of that model only, and a generated class is compared with its entity when a statement first uses it.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist \
//   packages/php/tests/OrmGenLazyModelTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;

// Requirements: DBS-179.
// Each case reads the generated files in a new process, whose autoloader records the generated classes that it loads.
#[Small]
class OrmGenLazyModelTest extends TestCase
{
    use OrmGenProcessCase;

    private const NAMESPACE = 'Polyspec\\Orm\\Tests\\LazyModel';
    /** Runs the step of the third argument on the set in the directory of the second argument and prints the result. */
    private const READER = <<<'READER'
    <?php
    declare(strict_types=1);
    require $argv[1];
    $namespace = $argv[3];
    $loaded = [];
    spl_autoload_register(static function (string $class) use ($argv, $namespace, &$loaded): void {
        if (str_starts_with($class, "$namespace\\")) {
            $loaded[] = substr($class, strlen($namespace) + 1);
            require $argv[2] . '/' . substr($class, strlen($namespace) + 1) . '.php';
        }
    });
    require $argv[2] . '/bootstrap.php';
    $hash = constant("$namespace\\MANIFEST_HASH");
    $read = static function (string $class) use ($namespace, $argv): int {
        $db = Polyspec\Orm\Orm::connect('sqlite://' . $argv[5], new Polyspec\Orm\Config());
        $db->utils()->schema()->install(("$namespace\\schema")());
        $class = "$namespace\\$class";
        return count((new $class())->connect($db)->gets());
    };
    try {
        $result = match ($argv[4]) {
            'bootstrap' => ['models' => Polyspec\Orm\Registry::models($hash)],
            'runtime' => ['entities' => array_keys(Polyspec\Orm\Registry::model($hash)->entities)],
            'column' => ['column' => Polyspec\Orm\Chain::schemaColumnName($hash, 'Title')],
            'read item' => ['rows' => $read('Item')],
            'read other' => ['rows' => $read('Other')],
            'conflict' => [Polyspec\Orm\Registry::classes($hash, ['item' => "$namespace\\Other"])],
            'unknown set' => [Polyspec\Orm\Registry::classes('sha256:unknown', ['item' => "$namespace\\Item"])],
        };
    } catch (Polyspec\Orm\OrmException $e) {
        $result = ['code' => $e->code_, 'message' => $e->getMessage()];
    }
    echo json_encode($result + ['loaded' => $loaded]);
    READER;

    protected static function workPrefix(): string
    {
        return 'orm-php-lazy-model-';
    }

    /** Generates the models of a set of two tables into a new directory and returns the directory of the models. */
    private static function generate(string $name): string
    {
        return self::generateDocument(
            $name,
            'lazy.dbs',
            "dbspec 1 lazy\n\n"
            . "table item {\n  seq i64\n  name varchar(32)\n  primary key (seq)\n}\n\n"
            . "table other {\n  seq i64\n  title varchar(32)\n  primary key (seq)\n}\n",
            self::NAMESPACE
        );
    }

    /** Runs a step on the generated models of $model in a new process and returns what the reader printed. */
    private static function read(string $model, string $step): array
    {
        return self::readInProcess($model, self::READER, [self::NAMESPACE, $step, dirname($model) . '/db.sqlite']);
    }

    public function testTheBootstrapHandsOverTheClassesWithoutLoadingThem(): void
    {
        $result = self::read(self::generate('bootstrap'), 'bootstrap');
        self::assertSame(
            ['item' => self::NAMESPACE . '\\Item', 'other' => self::NAMESPACE . '\\Other'],
            $result['models'] ?? null,
            json_encode($result)
        );
        self::assertSame([], $result['loaded']);
    }

    public function testTheRuntimeModelLoadsNoClass(): void
    {
        $result = self::read(self::generate('runtime'), 'runtime');
        self::assertSame(['item', 'other'], $result['entities'] ?? null, json_encode($result));
        self::assertSame([], $result['loaded']);
    }

    public function testAColumnOfAnyModelOfTheSetLoadsNoClass(): void
    {
        $result = self::read(self::generate('column'), 'column');
        self::assertSame('title', $result['column'] ?? null, json_encode($result));
        self::assertSame([], $result['loaded']);
    }

    public function testAReadLoadsTheClassOfItsModelOnly(): void
    {
        $result = self::read(self::generate('read'), 'read item');
        self::assertSame(0, $result['rows'] ?? null, json_encode($result));
        self::assertSame(['Item'], $result['loaded']);
    }

    public function testAnEditedClassFailsWhenAStatementUsesItAndOnlyThen(): void
    {
        $model = self::generate('edited');
        $class = "$model/Other.php";
        $source = (string) file_get_contents($class);
        $changed = str_replace("'length' => 32", "'length' => 33", $source);
        self::assertNotSame($source, $changed);
        file_put_contents($class, $changed);
        self::assertSame(0, self::read($model, 'read item')['rows'] ?? null);
        $result = self::read($model, 'read other');
        self::assertSame(Code::CONFIG, $result['code'] ?? null, json_encode($result));
        self::assertStringContainsString('columns.title.length', $result['message']);
        self::assertStringContainsString(self::NAMESPACE . '\\Other', $result['message']);
    }

    public function testAnEntityGeneratedAsTwoClassesFails(): void
    {
        $result = self::read(self::generate('conflict'), 'conflict');
        self::assertSame(Code::CONFIG, $result['code'] ?? null, json_encode($result));
        self::assertStringContainsString('generated as both', $result['message']);
    }

    public function testClassesOfASetThatIsNotLoadedFail(): void
    {
        $result = self::read(self::generate('unknown'), 'unknown set');
        self::assertSame(Code::CONFIG, $result['code'] ?? null, json_encode($result));
        self::assertStringContainsString('before the models of manifest', $result['message']);
    }
}
