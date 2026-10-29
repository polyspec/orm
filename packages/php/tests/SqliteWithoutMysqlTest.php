<?php

// The sqlite path loads no MySQL dialect class (N17): a child process uses php -n and the launcher's explicit module
// list to run the sqlite path and an autoloader that refuses orm's MySQL dialect classes. The parent asserts that the
// child has only the SQLite PDO driver and no MySQL driver modules. The launcher refuses a PHP whose MySQL drivers are
// compiled in because php -n cannot unload them.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use RuntimeException;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class SqliteWithoutMysqlTest extends TestCase
{
    // The child program uses the canonical test autoloader, then runs the SQLite case with the work directory it is
    // given.
    private const CHILD = <<<'PHP'
        $autoload = $argv[1];
        $work = $argv[2];
        require $autoload;
        if (($argv[3] ?? '') === 'schema-bootstrap-only') {
            $schema = Polyspec\Orm\Tests\Model\schema();
            echo json_encode([
                'schema_function' => function_exists('Polyspec\\Orm\\Tests\\Model\\schema'),
                'schema_type' => $schema instanceof Polyspec\Orm\Schema,
                'schema_hash' => $schema->manifestHash,
            ], JSON_THROW_ON_ERROR);
            exit(0);
        }
        $modules = get_loaded_extensions();
        $drivers = PDO::getAvailableDrivers();
        // orm's MySQL dialect classes: a load of one of them fails the child, before its code runs. It is registered
        // after the Composer loader, which prepends itself, so this guard sees every class load first.
        $mysqlDialect = ['Polyspec\\Orm\\Dbspec\\MysqlCatalog'];
        spl_autoload_register(static function (string $class) use ($mysqlDialect): void {
            if (in_array($class, $mysqlDialect, true)) {
                fwrite(STDERR, "the sqlite path loaded the MySQL dialect class $class");
                exit(5);
            }
        }, true, true);
        $db = Polyspec\Orm\Orm::connect(
            "sqlite://$work/case.sqlite",
            new Polyspec\Orm\Config(aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key')
        );
        $driver = $db->pdo()->getAttribute(PDO::ATTR_DRIVER_NAME);
        $dialect = $db->driver();
        \Polyspec\Orm\Tests\installBench($db);
        $created = (new Polyspec\Orm\Tests\Model\Service)($db)->setName('without-mysql')->create();
        $read = (new Polyspec\Orm\Tests\Model\Service)($db)->getBySeq($created->getSeq());
        $db->close();
        foreach ($mysqlDialect as $class) {
            if (class_exists($class, false)) {
                fwrite(STDERR, "the sqlite path declared the MySQL dialect class $class");
                exit(6);
            }
        }
        echo json_encode([
            'name' => $read->getName(),
            'dialect' => $dialect,
            'pdo_driver' => $driver,
            'modules' => $modules,
            'drivers' => $drivers,
        ], JSON_THROW_ON_ERROR);
        PHP;

    public function testChildLoadsGeneratedModelSchemaBeforeConnecting(): void
    {
        $root = dirname(__DIR__, 3);
        $process = proc_open(
            [
                PHP_BINARY,
                '-n',
                '-r',
                self::CHILD,
                '--',
                "$root/packages/php/tests/autoload.php",
                sys_get_temp_dir() . '/unused-php-without-mysql-probe',
                'schema-bootstrap-only',
            ],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
        );
        self::assertIsResource($process, 'the schema bootstrap child did not start');
        $output = stream_get_contents($pipes[1]);
        $errors = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $status = proc_close($process);

        self::assertSame(0, $status, "schema bootstrap child exited $status: $errors; stdout: $output");
        $result = json_decode($output, true, 512, JSON_THROW_ON_ERROR);
        self::assertSame(true, $result['schema_function'] ?? null);
        self::assertSame(true, $result['schema_type'] ?? null);
        self::assertMatchesRegularExpression('/^sha256:[0-9a-f]{64}$/', $result['schema_hash'] ?? '');
    }

    public function testSqlitePathLoadsNoMysqlDialectClass(): void
    {
        $root = dirname(__DIR__, 3);
        $manifest = json_decode(
            (string) file_get_contents("$root/packages/php/composer.json"),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        $drivers = ['ext-pdo_mysql', 'ext-pdo_pgsql', 'ext-pdo_sqlite'];
        $required = array_values(array_intersect($drivers, array_keys($manifest['require'] ?? [])));
        $suggested = array_values(array_intersect($drivers, array_keys($manifest['suggest'] ?? [])));
        self::assertTrue(
            $required === [] && $suggested === $drivers,
            'composer.json requires ' . json_encode($required) . ' and suggests ' . json_encode(
                $suggested
            ) . ' of the PDO drivers; it must require none and suggest all three'
        );

        $work = sys_get_temp_dir() . '/orm-php-without-mysql-' . getmypid();
        if (!mkdir($work, 0o700, true)) {
            throw new RuntimeException("cannot create $work");
        }
        try {
            $extensions = getenv('ORM_PHP_WITHOUT_MYSQL_EXTENSIONS');
            self::assertIsString($extensions, 'the php-without-mysql launcher must declare its -n extensions');
            $declaredExtensions = array_values(array_filter(
                explode(',', $extensions),
                static fn(string $name): bool => $name !== ''
            ));
            self::assertSame(
                [],
                array_values(array_intersect(['mysqlnd', 'pdo_mysql', 'mysqli'], $declaredExtensions)),
                'the child module declaration must not load MySQL drivers'
            );
            $extensionOptions = [];
            foreach ($declaredExtensions as $name) {
                self::assertMatchesRegularExpression('/^[a-z0-9_]+$/', $name, 'invalid -n extension name');
                $extensionOptions[] = '-d';
                $extensionOptions[] = "extension=$name";
            }
            $process = proc_open(
                [
                    PHP_BINARY,
                    '-n',
                    ...$extensionOptions,
                    '-r',
                    self::CHILD,
                    '--',
                    "$root/packages/php/tests/autoload.php",
                    $work,
                ],
                [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                $pipes,
            );
            self::assertIsResource($process, 'php -n did not start');
            $output = stream_get_contents($pipes[1]);
            $errors = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            $status = proc_close($process);
            self::assertSame(0, $status, "the child exited with $status: stderr: $errors; stdout: $output");
            $result = json_decode($output, true, 512, JSON_THROW_ON_ERROR);
            self::assertSame('without-mysql', $result['name'] ?? null, 'the child read the SQLite row');
            self::assertSame('sqlite', $result['dialect'] ?? null, 'the SQLite DSN selects the SQLite dialect');
            self::assertSame('sqlite', $result['pdo_driver'] ?? null, 'the SQLite connection uses PDO SQLite');
            self::assertContains('pdo_sqlite', $result['modules'] ?? [], 'the child loaded pdo_sqlite');
            self::assertContains('sqlite', $result['drivers'] ?? [], 'the child exposes the SQLite PDO driver');
            self::assertSame(
                [],
                array_values(array_intersect(['mysqlnd', 'pdo_mysql', 'mysqli'], $result['modules'] ?? [])),
                'the child loaded no MySQL PDO modules'
            );
        } finally {
            foreach (glob("$work/*") ?: [] as $file) {
                unlink($file);
            }
            rmdir($work);
        }
    }
}
