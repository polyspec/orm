<?php

// Query methods of the generated PHP models: orm-gen declares the condition method of every column, the tuple
// method of every key prefix, the column methods and the orders, and forceIndex of every index, so that PHPStan at
// level 9 finds each method on the model, and each method builds the query that the chain of its name builds.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelMethodsTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\OrmGen;

const SCHEMA = "dbspec 1 methods\n\ntable item {\n  seq i64\n  account_seq i64\n  project_seq i64\n  name varchar(32)\n"
    . "  amount decimal(10,2)\n  primary key (seq)\n  unique uq_item_name (name)\n  index ix_item_account "
    . "(account_seq, project_seq)\n}\n";

// Every call names a method that the schema enumerates.
const MODEL_METHODS_CALLS = <<<'PHP'
<?php
declare(strict_types=1);

use Polyspec\Orm\Tests\Methods\Item;

function calls(Item $item): Item
{
    return $item->seq(1)->accountSeq([1, 2])->name('a')->amount('1.00')
        ->tupleAccountSeqWithProjectSeq([[1, 2]])
        ->addColumnName()->removeColumnAmount()->groupByAccountSeq()->keyNameSeq()
        ->orderBySeqAsc()->orderByNameDesc()->plusAmount('1.00')->minusAccountSeq(1)->sumAmount()->avgSeq()
        ->forceIndexIxItemAccount();
}
PHP;

#[Small]
final class ModelMethodsTest extends TestCase
{
    private static string $work;

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 3);
        self::$work = $work = sys_get_temp_dir() . '/orm-php-model-methods-' . getmypid();
        is_dir("$work/model") || mkdir("$work/model", 0o700, true);

        file_put_contents("$work/methods.dbs", SCHEMA);
        file_put_contents(
            "$work/dbspec-set.json",
            json_encode(['schema' => 1, 'documents' => ['methods.dbs'], 'external' => []])
        );
        ob_start();
        $generated = OrmGen::run(
            [
                'gen',
                '--set',
                "$work/dbspec-set.json",
                '--out',
                "$work/model",
                '--namespace',
                'Polyspec\\Orm\\Tests\\Methods'
            ],
            STDERR
        );
        ob_end_clean();
        self::assertSame(0, $generated, 'orm-gen exit code');
        file_put_contents("$work/calls.php", MODEL_METHODS_CALLS);
        // The autoloader of the generated models. PHPStan loads the autoloader of the repository root (vendor-php) and
        // then autoload.php, which adds the models to autoload.php of the tests, that root's autoloader; this process
        // runs on the package's autoloader (bootstrap.php) and loads the models' autoloader only.
        file_put_contents("$work/models.php", "<?php\nspl_autoload_register(static function (string \$class): void {\n"
            . "    \$prefix = 'Polyspec\\\\Orm\\\\Tests\\\\Methods\\\\';\n"
            . "    if (str_starts_with(\$class, \$prefix)) {\n        require " . var_export(
                "$work/model/",
                true
            ) . " . substr(\$class, strlen(\$prefix)) . '.php';\n    }\n});\n");
        file_put_contents("$work/autoload.php", "<?php\nrequire " . var_export(
            "$root/packages/php/tests/autoload.php",
            true
        ) . ";\n"
            . "require " . var_export("$work/models.php", true) . ";\n");
    }

    public static function tearDownAfterClass(): void
    {
        exec('rm -rf ' . escapeshellarg(self::$work));
    }

    public function testPhpstanFindsEveryQueryMethodOfAGeneratedModel(): void
    {
        $root = dirname(__DIR__, 3);
        $work = self::$work;
        // PHPStan keeps its cache in the system temporary directory unless a configuration names one; the
        // cache stays in the case's own folder, which tearDownAfterClass removes.
        file_put_contents("$work/phpstan.neon", "parameters:\n    tmpDir: $work/phpstan-cache\n");
        $command = [
            PHP_BINARY,
            "$root/vendor-php/bin/phpstan",
            'analyse',
            '--no-progress',
            '--no-ansi',
            '--error-format=raw',
            '--configuration',
            "$work/phpstan.neon",
            '--level=9',
            '--memory-limit=512M',
            '--autoload-file',
            "$work/autoload.php",
            "$work/calls.php"];
        $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $root);
        $out = (string) stream_get_contents($pipes[1]);
        $err = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($process);
        $findings = array_values(
            array_filter(explode("\n", $out), static fn(string $line): bool => str_contains($line, '[identifier='))
        );
        self::assertFalse(
            $code !== 0 || $findings !== [],
            "phpstan exited $code with " . count($findings) . " findings:\n" . implode("\n", $findings) . (
                $findings === [] ? "\n$out$err" : ''
            )
        );
    }

    public function testADeclaredMethodBuildsTheQueryOfItsChain(): void
    {
        $work = self::$work;
        require_once "$work/models.php";
        $class = 'Polyspec\\Orm\\Tests\\Methods\\Item';
        $reflection = new ReflectionClass($class);
        foreach (
            [
            'seq',
            'tupleAccountSeqWithProjectSeq',
            'orderByNameDesc',
            'sumAmount',
            'forceIndexIxItemAccount'
            ] as $method
        ) {
            self::assertFalse(
                !$reflection->hasMethod($method) || $reflection
                    ->getMethod($method)
                    ->getDeclaringClass()
                    ->getName() !== $class,
                "$class does not declare $method"
            );
        }
        foreach (['tupleSeq', 'tupleName', 'sumName', 'plusName'] as $method) {
            self::assertFalse(
                $reflection->hasMethod($method),
                "$class declares $method, which the schema does not enumerate"
            );
        }
        // Each declared method leaves the model in the state that the chain of its name leaves it in.
        $calls = ['seq' => [1], 'accountSeq' => [[1, 2]], 'tupleAccountSeqWithProjectSeq' => [
            [[1, 2]]
        ], 'addColumnName' => [],
            'removeColumnAmount' => [],
            'groupByAccountSeq' => [],
            'keyNameSeq' => [],
            'orderBySeqAsc' => [],
            'orderByNameDesc' => [],
            'plusAmount' => [
                '1.00'
            ], 'minusAccountSeq' => [1], 'sumAmount' => [], 'avgSeq' => [], 'forceIndexIxItemAccount' => []];
        foreach ($calls as $method => $args) {
            $declared = (new $class())->$method(...$args);
            $chained = (new $class())->__call($method, $args);
            self::assertFalse(
                var_export((array) $declared, true) !== var_export((array) $chained, true),
                "$method builds another query than the chain of its name"
            );
        }
    }

    // Requirements: DBS-121.
    /** A date, time or datetime setter takes the text form, never a native value (T189). */
    public function testATimeSetterTakesTheTextForm(): void
    {
        $cases = [
            [\Polyspec\Orm\Tests\Model\TimeCell::class, 'setAt', 'string'],
            [\Polyspec\Orm\Tests\Model\Author::class, 'setCreatedTs', 'string'],
            [\Polyspec\Orm\Tests\Model\Author::class, 'setDisplayStartDt', '?string'],
        ];
        foreach ($cases as [$class, $method, $type]) {
            $param = (new \ReflectionMethod($class, $method))->getParameters()[0];
            self::assertSame($type, (string) $param->getType(), "$class::$method takes a native value");
        }
    }
}
