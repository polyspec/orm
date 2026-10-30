<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

// The extension's declarations of the classes it registers match src/polyspec_orm.stub.php and the PHP client. The
// extension registers the client's own names, so neither the stub nor the client can be loaded into the process that
// loads it: this test reads the extension in its own process and runs declarations.php without the extension for the
// stub and the client. The stub is the inventory of the interface check (contracts/symbols/php-extension.json).

use ReflectionExtension;
use RuntimeException;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

/**
 * requiredModules is the names of the modules that the extension requires as ZEND_MOD_REQUIRED (src/polyspec_orm.c).
 */
function requiredModules(): array
{
    preg_match_all(
        '/ZEND_MOD_REQUIRED\("([a-z_]+)"\)/',
        file_get_contents(dirname(__DIR__) . '/src/polyspec_orm.c'),
        $names
    );
    return $names[1];
}

/**
 * dynamicModules are the modules that php -n loads from extension_dir: ORM_PHP_DYNAMIC_MODULES, a comma list that the
 * Makefile derives from this PHP (PHP_EXTENSION_DYNAMIC_MODULES). Empty when this PHP has them built in; pdo on
 * Ubuntu, where pdo is a shared module.
 * @return list<string>
 */
function dynamicModules(): array
{
    $declared = getenv('ORM_PHP_DYNAMIC_MODULES');
    if ($declared === false) {
        throw new RuntimeException(
            'ORM_PHP_DYNAMIC_MODULES is not declared; the Makefile derives it as PHP_EXTENSION_DYNAMIC_MODULES',
        );
    }
    $modules = array_values(array_filter(explode(',', $declared), static fn(string $module): bool => $module !== ''));
    // The stub extends Pdo\Pgsql. The declarations child uses -n, so explicitly load the shared module when it is
    // not built into this PHP executable.
    if (!in_array('pdo_pgsql', modulesWithoutIni(), true) && !in_array('pdo_pgsql', $modules, true)) {
        $modules[] = 'pdo_pgsql';
    }
    return $modules;
}

/** Modules that PHP_BINARY provides without php.ini, as used by the declarations child. @return list<string> */
function modulesWithoutIni(): array
{
    static $modules;
    if (is_array($modules)) {
        return $modules;
    }
    [$code, $out, $err] = run([PHP_BINARY, '-n', '-r', 'echo implode(",", get_loaded_extensions());']);
    if ($code !== 0) {
        throw new RuntimeException("cannot inspect modules of PHP -n: stderr: $err; stdout: $out");
    }
    $modules = $out === '' ? [] : explode(',', $out);
    return $modules;
}

/**
 * moduleArguments are the arguments that make the PHP run without php.ini (-n) have the module the extension requires.
 * -n also does not load shared modules (for example pdo, which the Ubuntu PHP package loads from conf.d), so a module
 * not in that PHP is loaded from this PHP's extension_dir. If a required module is missing, PHP does not load the
 * extension. $loaded (module name) is whether php -n has that module.
 */
function moduleArguments(array $modules, string $extensionDir): array
{
    if ($modules === []) {
        return [];
    }
    return [
        '-d',
        "extension_dir=$extensionDir",
        ...array_merge(...array_map(static fn(string $module): array => ['-d', "extension=$module"], $modules))
    ];
}

/** run executes the command and returns [exit code, stdout, stderr]. */
function run(array $command, array $env = []): array
{
    $process = proc_open(
        $command,
        [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes,
        null,
        $env === [] ? null : $env + getenv()
    );
    if ($process === false) {
        throw new RuntimeException('cannot start ' . implode(' ', $command));
    }
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    return [proc_close($process), $out, $err];
}

/**
 * Runs declarations.php in mode $mode in a PHP without the extension and returns its JSON. On failure, writes stderr
 * and stdout together: the reason the extension did not load (startup warning) is written to stdout in the CLI.
 */
function declared(string $mode): array
{
    // -n does not read php.ini: if php.ini loads the extension, a class with the same name as the stub already exists.
    // The dynamic modules that the run declares are loaded by moduleArguments.
    $command = [
        PHP_BINARY,
        '-n',
        ...moduleArguments(dynamicModules(), (string) ini_get('extension_dir')),
        __DIR__ . '/declarations.php',
        $mode
    ];
    // The child runs in a PHP without the extension, so the mode it declares is library, whatever the run declares.
    [$code, $out, $err] = run($command, ['ORM_PHP_MODE' => 'library']);
    Assert::assertSame(
        0,
        $code,
        implode(' ', $command) . " exited with $code: stderr: " . trim($err) . '; stdout: ' . trim($out)
    );
    return json_decode($out, true, 512, JSON_THROW_ON_ERROR);
}

/** The declarations of the classes that the loaded extension registers. */
function registered(): array
{
    return declarations(array_keys((new ReflectionExtension('polyspec_orm'))->getClasses()), false);
}

/**
 * The array constants that src/polyspec_orm.c registers, since gen_stub cannot write them into the arginfo of the stub.
 */
const ARRAY_CONSTANTS = [
    'Polyspec\\Orm\\Dbspec\\ColumnType::SIMPLE',
    'Polyspec\\Orm\\Dbspec\\ColumnType::PARAMETERIZED',
    'Polyspec\\Orm\\Dbspec\\ForeignKey::ACTIONS',
    'Polyspec\\Orm\\Dbspec\\Setting::KINDS',
    'Polyspec\\Orm\\Dbspec\\Setting::CODEC_STAGES',
    'Polyspec\\Orm\\Dbspec\\Setting::STORE_ARGUMENTS',
    'Polyspec\\Orm\\Dbspec\\PlanApply::EFFECT_QUERIES',
    'Polyspec\\Orm\\Db::DRIVERS',
    'Polyspec\\Orm\\Chain::ENGINE_OP',
    'Polyspec\\Orm\\RuntimeModel::STYLED_STAGES',
    'Polyspec\\Orm\\RuntimeModel::HOST_STAGES',
    'Polyspec\\Orm\\Dialect::COLUMN_FUNCTION_TYPES',
    'Polyspec\\Orm\\Dialect::COLUMN_FUNCTION_ARITY',
    'Polyspec\\Orm\\Dialect::VALUE_FUNCTION_UNITS',
];

const NATIVE_PRIVATE_CONSTANTS = [
    'Polyspec\\Orm\\Chain::LEADING' => [
        'Ne' => 'ne', 'Eq' => '', 'Gt' => 'gt', 'Lt' => 'lt', 'Ge' => 'ge', 'Le' => 'le', 'Lk' => 'lk',
        'Lb' => 'lb', 'Between' => 'between',
    ],
    'Polyspec\\Orm\\Chain::COMPARE' => [
        'Eq' => '',
        'Ne' => 'ne',
        'Gt' => 'gt',
        'Lt' => 'lt',
        'Ge' => 'ge',
        'Le' => 'le',
    ],
    'Polyspec\\Orm\\Dialect::INTERVAL_BOUNDS' => [
        'second' => '315537897600',
        'minute' => '5258964960',
        'hour' => '87649416',
        'day' => '3652059',
        'month' => '119988',
    ],
    'Polyspec\\Orm\\Model::OPERATORS' => [
        '' => 'eq', 'ne' => 'not_eq', 'gt' => 'gt', 'lt' => 'lt', 'ge' => 'gte', 'le' => 'lte',
        'lk' => 'contains', 'lb' => 'contains_binary',
    ],
];

// Each case runs child PHP processes.
#[Large]
final class DeclarationsTest extends TestCase
{
    // The module case is when the module the extension requires exists only as a shared module in a PHP without php.ini
    // (pdo in the CI runner's PHP package). It builds the argument that loads that module from extension_dir, and
    // checks that it adds no argument when all are present.
    // INT-94: the extension declares pdo as its required module, so PHP loads it only with pdo present.
    public function testRequiredModules(): void
    {
        $required = requiredModules();
        Assert::assertTrue(
            in_array('pdo', $required, true),
            'src/polyspec_orm.c requires ' . implode(', ', $required) . ', without pdo'
        );
        $loaded = dynamicModules();
        Assert::assertSame(
            !in_array('pdo_pgsql', modulesWithoutIni(), true),
            in_array('pdo_pgsql', $loaded, true),
            'the -n declarations child explicitly loads pdo_pgsql when its PHP executable does not provide it'
        );
        $shared = moduleArguments(['pdo'], '/usr/lib/php/20250925');
        Assert::assertSame(
            ['-d', 'extension_dir=/usr/lib/php/20250925', '-d', 'extension=pdo'],
            $shared,
            'a PHP without a built-in pdo gets the arguments ' . json_encode(
                $shared
            ) . ', not the shared pdo of its extension_dir'
        );
        $builtIn = moduleArguments([], '/usr/lib/php/20250925');
        Assert::assertSame(
            [],
            $builtIn,
            'a PHP with every required module built in gets the arguments ' . json_encode($builtIn)
        );
        [$code, $out] = run([PHP_BINARY, '-n', '-r', 'echo "startup line"; exit(3);']);
        Assert::assertFalse(
            $code !== 3 || $out !== 'startup line',
            "the run of a failing PHP keeps exit $code and stdout " . json_encode($out)
        );
    }

    // DBS-172: the extension registers the PHP client's own class names, properties, constants and methods.
    public function testDeclarations(): void
    {
        $native = registered();
        $stub = declared('stub');
        // gen_stub cannot write array constants, so the stub declares none and src/polyspec_orm.c registers these;
        // testClient compares their values with the PHP client.
        $differences = [];
        foreach (ARRAY_CONSTANTS as $key) {
            if (!str_starts_with($native[$key] ?? '', 'public const = ') || isset($stub[$key])) {
                $differences[] = "$key: src/polyspec_orm.c registers it, and the stub does not declare it; extension "
                    . (
                    $native[$key] ?? '(not declared)'
                ) . ', stub ' . ($stub[$key] ?? '(not declared)');
            }
            $stub[$key] = $native[$key] ?? '(not declared)';
        }
        foreach (NATIVE_PRIVATE_CONSTANTS as $key => $value) {
            $expected = 'private const = ' . json_encode($value, JSON_THROW_ON_ERROR);
            if (($native[$key] ?? '(not declared)') !== $expected || isset($stub[$key])) {
                $differences[] = "$key: expected source private constant $expected, extension "
                    . ($native[$key] ?? '(not declared)') . ', stub ' . ($stub[$key] ?? '(not declared)');
            }
            $stub[$key] = $expected;
        }
        $where = 'Polyspec\\Orm\\Model::$where';
        $whereDefault = 'private array = ' . json_encode(['items' => [], 'pending' => ''], JSON_THROW_ON_ERROR);
        if (
            ($native[$where] ?? '(not declared)') !== $whereDefault
            || ($stub[$where] ?? '(not declared)') !== 'private array'
        ) {
            $differences[] = "$where: expected native-only source default $whereDefault, extension "
                . ($native[$where] ?? '(not declared)') . ', stub ' . ($stub[$where] ?? '(not declared)');
        }
        $stub[$where] = $whereDefault;
        foreach (array_unique([...array_keys($native), ...array_keys($stub)]) as $key) {
            $want = $stub[$key] ?? '(not declared)';
            $got = $native[$key] ?? '(not declared)';
            if ($want !== $got) {
                $differences[] = "$key\n  stub      $want\n  extension $got";
            }
        }
        Assert::assertSame(
            [],
            $differences,
            "the extension declares other symbols than src/polyspec_orm.stub.php:\n" . implode("\n", $differences)
        );
    }

    public function testStatsRetainsItsConnectionCounters(): void
    {
        $stats = new \Polyspec\Orm\Stats(4, 2, 1, 1);
        Assert::assertSame(4, $stats->maxOpenConnections);
        Assert::assertSame(2, $stats->openConnections);
        Assert::assertSame(1, $stats->inUse);
        Assert::assertSame(1, $stats->idle);
    }

    public function testInternalCatalogBuildExceptionIsExcludedFromClientDeclarations(): void
    {
        $client = declared('client');
        $catalog = new \ReflectionClass(\Polyspec\Orm\Catalog::class);
        $buildException = 'Polyspec\\Orm\\Dbspec\\CatalogDocumentBuildException';

        Assert::assertTrue($catalog->getMethod('connect')->isPublic(), 'the public PHP Catalog API remains public');
        Assert::assertArrayNotHasKey($buildException, $client);
    }

    public function testFunctionTypeDeclarationMatchesClient(): void
    {
        $key = 'Polyspec\\Orm\\Validator::functionType()';
        $signature = 'public static function(string $name, ?array $col): string';
        Assert::assertSame(
            $signature,
            declared('client')[$key] ?? '(not declared)',
            'the PHP functionType helper keeps its two-argument declaration'
        );
        Assert::assertSame(
            $signature,
            registered()[$key] ?? '(not declared)',
            'the native functionType declaration keeps its two-argument contract'
        );
    }

    // Requirements: INT-138.
    // The extension has the same public declarations (name, parent, constants, order and types of properties, methods)
    // for each class that is not PHP client's @internal, and the only other classes are those the stub marks @internal.
    // DBS-172: the extension registers the PHP client's own class names, properties, constants and methods.
    public function testClient(): void
    {
        $native = registered();
        $client = declared('client');
        $differences = [];
        $classes = [];
        foreach ($client as $key => $want) {
            $classes[explode('::', $key)[0]] = true;
            $got = $native[$key] ?? '(not declared)';
            if ($want !== $got) {
                $differences[] = "$key\n  client    $want\n  extension $got";
            }
        }
        // Property order: the constructor and object graph follow the PHP client's order.
        $order = static fn(array $declarations): array => array_values(
            array_filter(array_keys($declarations), static fn(string $k): bool => str_contains($k, '::$'))
        );
        $clientOrder = $order($client);
        $nativeOrder = array_values(
            array_filter(
                $order($native),
                static fn(string $k): bool => isset(
                    $classes[explode('::', $k)[0]]
                ) && str_starts_with($native[$k], 'public')
            )
        );
        if ($clientOrder !== $nativeOrder) {
            $differences[] = 'public properties in another order: client ' . implode(
                ', ',
                $clientOrder
            ) . '; extension ' . implode(', ', $nativeOrder);
        }
        $stub = file_get_contents(dirname(__DIR__) . '/src/polyspec_orm.stub.php');
        preg_match_all('/^namespace\s+([^;]+);/m', $stub, $namespaces, PREG_OFFSET_CAPTURE);
        $internalClasses = [];
        foreach ($namespaces[1] as $index => [$namespace]) {
            $start = $namespaces[0][$index][1] + strlen($namespaces[0][$index][0]);
            $end = $namespaces[0][$index + 1][1] ?? strlen($stub);
            $scope = substr($stub, $start, $end - $start);
            preg_match_all(
                '/\/\*\*(?:(?!\*\/)[\s\S])*@internal(?:(?!\*\/)[\s\S])*\*\/\s*'
                    . '(?:final |abstract )?(?:readonly )?(?:class|interface) (\w+)/',
                $scope,
                $internal
            );
            foreach ($internal[1] as $name) {
                $internalClasses[] = $namespace . '\\' . $name;
            }
        }
        foreach (array_keys($native) as $key) {
            $class = explode('::', $key)[0];
            if (!isset($classes[$class]) && !in_array($class, $internalClasses, true)) {
                $differences[] = "$class is neither a class of the PHP client nor @internal in the stub";
                $classes[$class] = true;
            }
        }
        Assert::assertSame(
            [],
            $differences,
            "the extension differs from the PHP client's dbspec classes:\n" . implode("\n", $differences)
        );
    }

    // The limit/columns document is parsed in a child process so PHPUnit's already-held memory does not change the
    // measurement. The child loads this run's extension and uses its default 128 MiB memory limit.
    public function testLimitColumnsPeak(): void
    {
        $extension = getenv('POLYSPEC_ORM_EXTENSION');
        if (!is_string($extension) || $extension === '') {
            throw new RuntimeException('POLYSPEC_ORM_EXTENSION must name the extension loaded by this test run');
        }
        $text = "dbspec 1 shop\n";
        for ($t = 0; $t < 121; $t++) {
            $text .= "\ntable t$t {\n";
            for ($i = 0; $i < 1000; $i++) {
                $text .= "  c$i i64\n";
            }
            $text .= "  primary key (c0)\n}\n";
        }
        $code = <<<'PHP'
$text = (string) stream_get_contents(STDIN);
$baseline = memory_get_usage();
memory_reset_peak_usage();
$result = \Polyspec\Orm\Dbspec\Dbspec::parse($text, []);
echo json_encode([
    'document' => $result->document !== null,
    'baseline' => $baseline,
    'peak' => memory_get_peak_usage(),
], JSON_THROW_ON_ERROR), PHP_EOL;
PHP;
        $process = proc_open(
            [PHP_BINARY, '-d', 'extension=' . $extension, '-d', 'memory_limit=128M', '-r', $code],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
        );
        Assert::assertIsResource($process, 'the native limit/columns process did not start');
        fwrite($pipes[0], $text);
        fclose($pipes[0]);
        $output = (string) stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        $error = (string) stream_get_contents($pipes[2]);
        fclose($pipes[2]);
        Assert::assertSame(0, proc_close($process), $error);
        $measurement = json_decode(trim($output), true, 512, JSON_THROW_ON_ERROR);
        $baseline = (int) $measurement['baseline'];
        $bound = 134217728 - $baseline - 16777216;
        $peak = (int) $measurement['peak'] - $baseline;
        Assert::assertFalse((bool) $measurement['document'], 'the limit document returned a document');
        Assert::assertLessThan(
            $bound,
            $peak,
            sprintf(
                'the limit/columns case peaks at %d bytes above the baseline of %d bytes; '
                . 'the derived bound is %d bytes '
                . '(128 MiB 134217728 minus the baseline minus the 16 MiB margin 16777216)',
                $peak,
                $baseline,
                $bound
            )
        );
    }

    // PIE builds the extension from composer.json's php-ext: the name is the extension's name that was loaded, and
    // config.m4 is in build-path.
    // INT-95: the package is of type php-ext, names polyspec_orm, and its build-path holds the config.m4 that builds
    // it.
    public function testPackage(): void
    {
        $package = json_decode(file_get_contents(dirname(__DIR__) . '/composer.json'), true, 512, JSON_THROW_ON_ERROR);
        $name = $package['php-ext']['extension-name'] ?? null;
        Assert::assertFalse(
            $package['type'] !== 'php-ext' || $name !== 'polyspec_orm',
            "packages/php-ext/composer.json declares the extension " . json_encode($name) . " of type " . json_encode(
                $package['type']
            ) . ", not polyspec_orm of type php-ext"
        );
        $config = dirname(__DIR__) . '/' . ($package['php-ext']['build-path'] ?? '') . '/config.m4';
        Assert::assertFalse(
            !is_file($config) || !str_contains(file_get_contents($config), "PHP_NEW_EXTENSION([$name]"),
            "the build-path of packages/php-ext/composer.json has no config.m4 that builds $name"
        );
    }
}
