<?php
declare(strict_types=1);

// 확장 orm_dbspec이 등록한 class의 선언과 stubs/orm_dbspec.stub.php의 선언이 같은지 확인한다. 두 선언은
// 같은 이름의 class라 한 process에 함께 load할 수 없으므로 declarations.php를 확장과 함께, 그리고
// 확장 없이 실행한다. stub은 interface 검사(contracts/symbols/php-extension.json)의 inventory다. ORM_DBSPEC_EXTENSION은
// build한 확장 library이고, 없으면 test가 실패한다.

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

/** ORM_DBSPEC_EXTENSION이 적은, build한 확장 library다. */
function extensionLibrary(): string
{
    $extension = getenv('ORM_DBSPEC_EXTENSION');
    if ($extension === false || $extension === '' || !is_file($extension)) {
        throw new RuntimeException('ORM_DBSPEC_EXTENSION names no built library of the extension; run make dbspec-php-extension-check, which builds it');
    }
    return $extension;
}

/** requiredModules는 확장이 ZEND_MOD_REQUIRED로 요구하는 module의 이름이다(src/orm_dbspec.c). */
function requiredModules(): array
{
    preg_match_all('/ZEND_MOD_REQUIRED\("([a-z_]+)"\)/', file_get_contents(dirname(__DIR__) . '/src/orm_dbspec.c'), $names);
    return $names[1];
}

/**
 * moduleArguments는 php.ini 없이(-n) 실행하는 PHP가 확장이 요구하는 module을 갖게 하는 인자다. -n은 php.ini가 load하는
 * shared module(예: Ubuntu의 PHP package가 conf.d로 load하는 pdo)도 load하지 않으므로, 그 PHP에 들어 있지 않은 module은
 * 이 PHP의 extension_dir에서 load한다. 요구한 module이 없으면 PHP는 확장을 load하지 않는다. $loaded(module 이름)는 php -n이
 * 그 module을 갖는지다.
 */
function moduleArguments(array $modules, callable $loaded, string $extensionDir): array
{
    $missing = array_values(array_filter($modules, static fn(string $module): bool => !$loaded($module)));
    if ($missing === []) {
        return [];
    }
    return ['-d', "extension_dir=$extensionDir", ...array_merge(...array_map(static fn(string $module): array => ['-d', "extension=$module"], $missing))];
}

/** run은 명령을 실행해 [종료 코드, stdout, stderr]를 돌려준다. */
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
 * declarations.php를 $arguments(php 인자)로 실행해 그 JSON을 돌려준다. 실패하면 stderr와 stdout을 함께 적는다: PHP가
 * 확장을 load하지 못한 이유(startup 경고)는 CLI에서 stdout에 쓴다.
 */
function declarations(array $arguments, string $mode): array
{
    // -n은 php.ini를 읽지 않는다: php.ini가 확장을 load하면 stub과 같은 이름의 class가 이미 있다. 확장이 요구하는 module은
    // moduleArguments가 load한다.
    $loaded = static fn(string $module): bool => run([PHP_BINARY, '-n', '-r', 'exit(extension_loaded($argv[1]) ? 0 : 1);', $module])[0] === 0;
    $command = [PHP_BINARY, '-n', ...moduleArguments(requiredModules(), $loaded, (string) ini_get('extension_dir')), ...$arguments, __DIR__ . '/declarations.php', $mode];
    [$code, $out, $err] = run($command);
    Assert::assertSame(0, $code, implode(' ', $command) . " exited with $code: stderr: " . trim($err) . '; stdout: ' . trim($out));
    return json_decode($out, true, 512, JSON_THROW_ON_ERROR);
}

// Each case runs child PHP processes.
#[Large]
final class DeclarationsTest extends TestCase
{
    // module case는 php.ini 없는 PHP에 확장이 요구하는 module이 shared module로만 있을 때(CI runner의 PHP package에서 pdo) 그
    // module을 extension_dir에서 load하는 인자를 만들고, 모두 들어 있으면 인자를 더하지 않는지 본다.
    public function test_required_modules(): void
    {
        $required = requiredModules();
        Assert::assertTrue(in_array('pdo', $required, true), 'src/orm_dbspec.c requires ' . implode(', ', $required) . ', without pdo');
        $shared = moduleArguments(['spl', 'hash', 'pdo'], static fn(string $module): bool => $module !== 'pdo', '/usr/lib/php/20250925');
        Assert::assertSame(['-d', 'extension_dir=/usr/lib/php/20250925', '-d', 'extension=pdo'], $shared, 'a PHP without a built-in pdo gets the arguments ' . json_encode($shared) . ', not the shared pdo of its extension_dir');
        $builtIn = moduleArguments(['spl', 'hash', 'pdo'], static fn(string $module): bool => true, '/usr/lib/php/20250925');
        Assert::assertSame([], $builtIn, 'a PHP with every required module built in gets the arguments ' . json_encode($builtIn));
        [$code, $out] = run([PHP_BINARY, '-n', '-r', 'echo "startup line"; exit(3);']);
        Assert::assertFalse($code !== 3 || $out !== 'startup line', "the run of a failing PHP keeps exit $code and stdout " . json_encode($out));
    }

    public function test_declarations(): void
    {
        $extension = extensionLibrary();
        $native = declarations(['-d', "extension=$extension"], 'extension');
        $stub = declarations([], 'stub');
        $differences = [];
        foreach (array_unique([...array_keys($native), ...array_keys($stub)]) as $key) {
            $want = $stub[$key] ?? '(not declared)';
            $got = $native[$key] ?? '(not declared)';
            if ($want !== $got) {
                $differences[] = "$key\n  stub      $want\n  extension $got";
            }
        }
        Assert::assertSame([], $differences, "the extension declares other symbols than stubs/orm_dbspec.stub.php:\n" . implode("\n", $differences));
    }

    // 확장은 PHP client의 @internal이 아닌 class마다 같은 public 선언(이름, 부모, 상수, property의 순서와 type, 메서드)을 가지고,
    // 그 밖의 class는 stub이 @internal로 적은 것뿐이다.
    public function test_client(): void
    {
        $extension = extensionLibrary();
        $native = declarations(['-d', "extension=$extension"], 'extension');
        $client = declarations([], 'client');
        $differences = [];
        $classes = [];
        foreach ($client as $key => $want) {
            $classes[explode('::', $key)[0]] = true;
            $got = $native[$key] ?? '(not declared)';
            if ($want !== $got) {
                $differences[] = "$key\n  client    $want\n  extension $got";
            }
        }
        // property 순서: 생성자와 객체 graph가 PHP client의 순서를 따른다.
        $order = static fn(array $declarations): array => array_values(array_filter(array_keys($declarations), static fn(string $k): bool => str_contains($k, '::$')));
        $clientOrder = $order($client);
        $nativeOrder = array_values(array_filter($order($native), static fn(string $k): bool => isset($classes[explode('::', $k)[0]]) && str_starts_with($native[$k], 'public')));
        if ($clientOrder !== $nativeOrder) {
            $differences[] = 'public properties in another order: client ' . implode(', ', $clientOrder) . '; extension ' . implode(', ', $nativeOrder);
        }
        preg_match_all('/@internal\n \*\/\n(?:final |abstract )?(?:readonly )?class (\w+)/', file_get_contents(dirname(__DIR__) . '/stubs/orm_dbspec.stub.php'), $internal);
        foreach (array_keys($native) as $key) {
            $class = explode('::', $key)[0];
            if (!isset($classes[$class]) && !in_array(substr($class, strlen('Polyspec\\Orm\\Dbspec\\Native\\')), $internal[1], true)) {
                $differences[] = "$class is neither a class of the PHP client nor @internal in the stub";
                $classes[$class] = true;
            }
        }
        Assert::assertSame([], $differences, "the extension differs from the PHP client's dbspec classes:\n" . implode("\n", $differences));
    }

    // PIE는 composer.json의 php-ext로 확장을 build한다: 그 이름은 load한 확장의 이름이고 build-path에 config.m4가 있다.
    public function test_package(): void
    {
        $package = json_decode(file_get_contents(dirname(__DIR__) . '/composer.json'), true, 512, JSON_THROW_ON_ERROR);
        $name = $package['php-ext']['extension-name'] ?? null;
        Assert::assertFalse($package['type'] !== 'php-ext' || $name !== 'orm_dbspec', "packages/php-ext/composer.json declares the extension " . json_encode($name) . " of type " . json_encode($package['type']) . ", not orm_dbspec of type php-ext");
        $config = dirname(__DIR__) . '/' . ($package['php-ext']['build-path'] ?? '') . '/config.m4';
        Assert::assertFalse(!is_file($config) || !str_contains(file_get_contents($config), "PHP_NEW_EXTENSION([$name]"), "the build-path of packages/php-ext/composer.json has no config.m4 that builds $name");
    }

    // 확장의 test 가운데 PHP client test와 같은 case를 따르는 것은 그 test와 본문이 같다: 그 file의 header(설명, require와
    // use) 뒤 첫 `const` 선언부터 끝까지가 PHP client test의 같은 부분과 같다.
    public function test_mirrors(): void
    {
        $root = dirname(__DIR__, 3);
        $mirrors = ['DbspecPlanTest.php', 'DbspecMermaidTest.php', 'DbspecIntrospectTest.php', 'DbspecApplyCleanupTest.php', 'DbspecApplyTest.php'];
        foreach ($mirrors as $file) {
            $body = static function (string $path): string {
                $text = file_get_contents($path);
                $at = strpos($text, "\nconst ");
                Assert::assertNotSame(false, $at, "$path has no const declaration, where the shared body starts");
                return substr($text, $at);
            };
            Assert::assertSame($body("$root/packages/php/tests/$file"), $body("$root/packages/php-ext/tests/$file"), "packages/php-ext/tests/$file differs from packages/php/tests/$file after its header; change both tests together");
        }
    }
}
