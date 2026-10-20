<?php

declare(strict_types=1);

// The extension's declarations of the classes it registers match src/polyspec_orm.stub.php and the PHP client. The extension
// registers the client's own names, so neither the stub nor the client can be loaded into the process that loads it: this test
// reads the extension in its own process and runs declarations.php without the extension for the stub and the client. The
// stub is the inventory of the interface check (contracts/symbols/php-extension.json).

require_once __DIR__ . '/declarations.php';

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

/** requiredModules is the names of the modules that the extension requires as ZEND_MOD_REQUIRED (src/polyspec_orm.c). */
function requiredModules(): array
{
    preg_match_all('/ZEND_MOD_REQUIRED\("([a-z_]+)"\)/', file_get_contents(dirname(__DIR__) . '/src/polyspec_orm.c'), $names);
    return $names[1];
}

/**
 * moduleArguments are the arguments that make the PHP run without php.ini (-n) have the module the extension requires. -n
 * also does not load shared modules (for example pdo, which the Ubuntu PHP package loads from conf.d), so a module not in that PHP is
 * loaded from this PHP's extension_dir. If a required module is missing, PHP does not load the extension. $loaded (module name) is whether php -n has
 * that module.
 */
function moduleArguments(array $modules, callable $loaded, string $extensionDir): array
{
    $missing = array_values(array_filter($modules, static fn(string $module): bool => !$loaded($module)));
    if ($missing === []) {
        return [];
    }
    return ['-d', "extension_dir=$extensionDir", ...array_merge(...array_map(static fn(string $module): array => ['-d', "extension=$module"], $missing))];
}

/** run executes the command and returns [exit code, stdout, stderr]. */
function run(array $command): array
{
    $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
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
 * Runs declarations.php in mode $mode in a PHP without the extension and returns its JSON. On failure, writes stderr and stdout together:
 * the reason the extension did not load (startup warning) is written to stdout in the CLI.
 */
function declared(string $mode): array
{
    // -n does not read php.ini: if php.ini loads the extension, a class with the same name as the stub already exists. The module the extension requires is
    // loaded by moduleArguments.
    $loaded = static fn(string $module): bool => run([PHP_BINARY, '-n', '-r', 'exit(extension_loaded($argv[1]) ? 0 : 1);', $module])[0] === 0;
    $command = [PHP_BINARY, '-n', ...moduleArguments(requiredModules(), $loaded, (string) ini_get('extension_dir')), __DIR__ . '/declarations.php', $mode];
    [$code, $out, $err] = run($command);
    Assert::assertSame(0, $code, implode(' ', $command) . " exited with $code: stderr: " . trim($err) . '; stdout: ' . trim($out));
    return json_decode($out, true, 512, JSON_THROW_ON_ERROR);
}

/** The declarations of the classes that the loaded extension registers. */
function registered(): array
{
    return declarations(array_keys((new ReflectionExtension('polyspec_orm'))->getClasses()), false);
}

/** The array constants that src/polyspec_orm.c registers, since gen_stub cannot write them into the arginfo of the stub. */
const ARRAY_CONSTANTS = [
    'Polyspec\\Orm\\Dbspec\\ColumnType::SIMPLE',
    'Polyspec\\Orm\\Dbspec\\ColumnType::PARAMETERIZED',
    'Polyspec\\Orm\\Dbspec\\ForeignKey::ACTIONS',
    'Polyspec\\Orm\\Dbspec\\Setting::KINDS',
    'Polyspec\\Orm\\Dbspec\\Setting::CODEC_STAGES',
    'Polyspec\\Orm\\Dbspec\\Setting::STORE_ARGUMENTS',
    'Polyspec\\Orm\\Dbspec\\PlanApply::EFFECT_QUERIES',
    'Polyspec\\Orm\\Db::DRIVERS',
];

// Each case runs child PHP processes.
#[Large]
final class DeclarationsTest extends TestCase
{
    // The module case is when the module the extension requires exists only as a shared module in a PHP without php.ini (pdo in the CI runner's PHP package). It
    // builds the argument that loads that module from extension_dir, and checks that it adds no argument when all are present.
    public function test_required_modules(): void
    {
        $required = requiredModules();
        Assert::assertTrue(in_array('pdo', $required, true), 'src/polyspec_orm.c requires ' . implode(', ', $required) . ', without pdo');
        $shared = moduleArguments(['spl', 'hash', 'pdo'], static fn(string $module): bool => $module !== 'pdo', '/usr/lib/php/20250925');
        Assert::assertSame(['-d', 'extension_dir=/usr/lib/php/20250925', '-d', 'extension=pdo'], $shared, 'a PHP without a built-in pdo gets the arguments ' . json_encode($shared) . ', not the shared pdo of its extension_dir');
        $builtIn = moduleArguments(['spl', 'hash', 'pdo'], static fn(string $module): bool => true, '/usr/lib/php/20250925');
        Assert::assertSame([], $builtIn, 'a PHP with every required module built in gets the arguments ' . json_encode($builtIn));
        [$code, $out] = run([PHP_BINARY, '-n', '-r', 'echo "startup line"; exit(3);']);
        Assert::assertFalse($code !== 3 || $out !== 'startup line', "the run of a failing PHP keeps exit $code and stdout " . json_encode($out));
    }

    public function test_declarations(): void
    {
        $native = registered();
        $stub = declared('stub');
        // gen_stub cannot write array constants, so the stub declares none and src/polyspec_orm.c registers these; test_client
        // compares their values with the PHP client.
        $differences = [];
        foreach (ARRAY_CONSTANTS as $key) {
            if (!str_starts_with($native[$key] ?? '', 'public const = ') || isset($stub[$key])) {
                $differences[] = "$key: src/polyspec_orm.c registers it, and the stub does not declare it; extension " . ($native[$key] ?? '(not declared)') . ', stub ' . ($stub[$key] ?? '(not declared)');
            }
            $stub[$key] = $native[$key] ?? '(not declared)';
        }
        foreach (array_unique([...array_keys($native), ...array_keys($stub)]) as $key) {
            $want = $stub[$key] ?? '(not declared)';
            $got = $native[$key] ?? '(not declared)';
            if ($want !== $got) {
                $differences[] = "$key\n  stub      $want\n  extension $got";
            }
        }
        Assert::assertSame([], $differences, "the extension declares other symbols than src/polyspec_orm.stub.php:\n" . implode("\n", $differences));
    }

    // The extension has the same public declarations (name, parent, constants, order and types of properties, methods) for each class that is not PHP client's @internal,
    // and the only other classes are those the stub marks @internal.
    public function test_client(): void
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
        $order = static fn(array $declarations): array => array_values(array_filter(array_keys($declarations), static fn(string $k): bool => str_contains($k, '::$')));
        $clientOrder = $order($client);
        $nativeOrder = array_values(array_filter($order($native), static fn(string $k): bool => isset($classes[explode('::', $k)[0]]) && str_starts_with($native[$k], 'public')));
        if ($clientOrder !== $nativeOrder) {
            $differences[] = 'public properties in another order: client ' . implode(', ', $clientOrder) . '; extension ' . implode(', ', $nativeOrder);
        }
        preg_match_all('/@internal\n \*\/\n(?:final |abstract )?(?:readonly )?class (\w+)/', file_get_contents(dirname(__DIR__) . '/src/polyspec_orm.stub.php'), $internal);
        foreach (array_keys($native) as $key) {
            $class = explode('::', $key)[0];
            if (!isset($classes[$class]) && !in_array(substr($class, strlen(EXTENSION_NAMESPACE)), $internal[1], true)) {
                $differences[] = "$class is neither a class of the PHP client nor @internal in the stub";
                $classes[$class] = true;
            }
        }
        Assert::assertSame([], $differences, "the extension differs from the PHP client's dbspec classes:\n" . implode("\n", $differences));
    }

    // PIE builds the extension from composer.json's php-ext: the name is the extension's name that was loaded, and config.m4 is in build-path.
    public function test_package(): void
    {
        $package = json_decode(file_get_contents(dirname(__DIR__) . '/composer.json'), true, 512, JSON_THROW_ON_ERROR);
        $name = $package['php-ext']['extension-name'] ?? null;
        Assert::assertFalse($package['type'] !== 'php-ext' || $name !== 'polyspec_orm', "packages/php-ext/composer.json declares the extension " . json_encode($name) . " of type " . json_encode($package['type']) . ", not polyspec_orm of type php-ext");
        $config = dirname(__DIR__) . '/' . ($package['php-ext']['build-path'] ?? '') . '/config.m4';
        Assert::assertFalse(!is_file($config) || !str_contains(file_get_contents($config), "PHP_NEW_EXTENSION([$name]"), "the build-path of packages/php-ext/composer.json has no config.m4 that builds $name");
    }
}
