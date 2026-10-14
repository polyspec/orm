<?php
// Query methods of the generated PHP models: orm-gen declares the condition method of every column, the tuple
// method of every key prefix, the column methods and the orders, and forceIndex of every index, so that PHPStan at
// level 9 finds each method on the model, and each method builds the query that the chain of its name builds.
// Usage: php packages/orm-php/tests/model_methods_test.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\OrmGen;

$root = dirname(__DIR__, 3);
$work = sys_get_temp_dir() . '/orm-php-model-methods-' . getmypid();
@mkdir("$work/model", 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

const SCHEMA = "dbspec 1 methods\n\ntable item {\n  seq i64\n  account_seq i64\n  project_seq i64\n  name varchar(32)\n"
    . "  amount decimal(10,2)\n  primary key (seq)\n  unique uq_item_name (name)\n  index ix_item_account (account_seq, project_seq)\n}\n";

// Every call names a method that the schema enumerates.
const CALLS = <<<'PHP'
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

file_put_contents("$work/methods.dbs", SCHEMA);
file_put_contents("$work/dbspec-set.json", json_encode(['schema' => 1, 'documents' => ['methods.dbs'], 'external' => []]));
ob_start();
$generated = OrmGen::run(['gen', '--set', "$work/dbspec-set.json", '--out', "$work/model", '--namespace', 'Polyspec\\Orm\\Tests\\Methods'], STDERR);
ob_end_clean();
if ($generated !== 0) {
    fwrite(STDERR, "FAIL model_methods: orm-gen exited $generated\n");
    exit(1);
}
file_put_contents("$work/calls.php", CALLS);
file_put_contents("$work/autoload.php", "<?php\nrequire " . var_export("$root/packages/orm-php/tests/autoload.php", true) . ";\n"
    . "spl_autoload_register(static function (string \$class): void {\n"
    . "    \$prefix = 'Polyspec\\\\Orm\\\\Tests\\\\Methods\\\\';\n"
    . "    if (str_starts_with(\$class, \$prefix)) {\n        require " . var_export("$work/model/", true) . " . substr(\$class, strlen(\$prefix)) . '.php';\n    }\n});\n");

$failures = 0;

$passed = testcase_run('model_methods/phpstan finds every query method of a generated model', TESTCASE_COMPUTE, static function () use ($root, $work): void {
    $command = [PHP_BINARY, "$root/vendor-php/bin/phpstan", 'analyse', '--no-progress', '--no-ansi', '--error-format=raw',
        '--level=9', '--memory-limit=512M', '--autoload-file', "$work/autoload.php", "$work/calls.php"];
    $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $root);
    $out = (string) stream_get_contents($pipes[1]);
    $err = (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($process);
    $findings = array_values(array_filter(explode("\n", $out), static fn(string $line): bool => str_contains($line, '[identifier=')));
    if ($code !== 0 || $findings !== []) {
        throw new RuntimeException("phpstan exited $code with " . count($findings) . " findings:\n" . implode("\n", $findings) . ($findings === [] ? "\n$out$err" : ''));
    }
});
$failures += $passed ? 0 : 1;

$passed = testcase_run('model_methods/a declared method builds the query of its chain', TESTCASE_COMPUTE, static function () use ($work): void {
    require_once "$work/autoload.php";
    $class = 'Polyspec\\Orm\\Tests\\Methods\\Item';
    $reflection = new ReflectionClass($class);
    foreach (['seq', 'tupleAccountSeqWithProjectSeq', 'orderByNameDesc', 'sumAmount', 'forceIndexIxItemAccount'] as $method) {
        if (!$reflection->hasMethod($method) || $reflection->getMethod($method)->getDeclaringClass()->getName() !== $class) {
            throw new RuntimeException("$class does not declare $method");
        }
    }
    foreach (['tupleSeq', 'tupleName', 'sumName', 'plusName'] as $method) {
        if ($reflection->hasMethod($method)) {
            throw new RuntimeException("$class declares $method, which the schema does not enumerate");
        }
    }
    // Each declared method leaves the model in the state that the chain of its name leaves it in.
    $calls = ['seq' => [1], 'accountSeq' => [[1, 2]], 'tupleAccountSeqWithProjectSeq' => [[[1, 2]]], 'addColumnName' => [],
        'removeColumnAmount' => [], 'groupByAccountSeq' => [], 'keyNameSeq' => [], 'orderBySeqAsc' => [], 'orderByNameDesc' => [],
        'plusAmount' => ['1.00'], 'minusAccountSeq' => [1], 'sumAmount' => [], 'avgSeq' => [], 'forceIndexIxItemAccount' => []];
    foreach ($calls as $method => $args) {
        $declared = (new $class())->$method(...$args);
        $chained = (new $class())->__call($method, $args);
        if (var_export((array) $declared, true) !== var_export((array) $chained, true)) {
            throw new RuntimeException("$method builds another query than the chain of its name");
        }
    }
});
$failures += $passed ? 0 : 1;

if ($failures > 0) {
    exit(1);
}
