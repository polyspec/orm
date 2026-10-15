<?php
// The sqlite path loads no MySQL dialect class (N17): a child process with php -n runs the sqlite path and an autoloader that
// refuses orm's MySQL dialect classes. The child also asserts that a sqlite:// DSN selects the sqlite dialect and the sqlite
// PDO driver. The MySQL drivers may be compiled into the PHP that runs the case; the case proves only the class-load claim.
declare(strict_types=1);

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class SqliteWithoutMysqlTest extends TestCase
{
    // The child program: it refuses a MySQL driver, then runs the SQLite case with the autoloader and work directory it is given.
    private const CHILD = <<<'PHP'
        $autoload = $argv[1];
        $work = $argv[2];
        require $autoload;
        // orm's MySQL dialect classes: a load of one of them fails the child, before its code runs. It is registered after
        // the Composer loader, which prepends itself, so this guard sees every class load first.
        $mysqlDialect = ['Polyspec\\Orm\\Dbspec\\MysqlCatalog'];
        spl_autoload_register(static function (string $class) use ($mysqlDialect): void {
            if (in_array($class, $mysqlDialect, true)) {
                fwrite(STDERR, "the sqlite path loaded the MySQL dialect class $class");
                exit(5);
            }
        }, true, true);
        $db = Polyspec\Orm\Orm::connect("sqlite://$work/case.sqlite", new Polyspec\Orm\Config(aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key'));
        $driver = $db->pdo()->getAttribute(PDO::ATTR_DRIVER_NAME);
        if ($db->driver() !== 'sqlite' || $driver !== 'sqlite') {
            fwrite(STDERR, "the sqlite DSN selected the dialect {$db->driver()} and the PDO driver $driver");
            exit(4);
        }
        $db->utils()->schema()->install(Polyspec\Orm\Tests\Model\schema());
        $created = (new Polyspec\Orm\Tests\Model\Service)($db)->setName('without-mysql')->create();
        $read = (new Polyspec\Orm\Tests\Model\Service)($db)->getBySeq($created->getSeq());
        $db->close();
        foreach ($mysqlDialect as $class) {
            if (class_exists($class, false)) {
                fwrite(STDERR, "the sqlite path declared the MySQL dialect class $class");
                exit(6);
            }
        }
        echo $read->getName();
        PHP;

    public function test_sqlite_path_loads_no_mysql_dialect_class(): void
    {
        $root = dirname(__DIR__, 3);
        $manifest = json_decode((string) file_get_contents("$root/packages/php/composer.json"), true, 512, JSON_THROW_ON_ERROR);
        $drivers = ['ext-pdo_mysql', 'ext-pdo_pgsql', 'ext-pdo_sqlite'];
        $required = array_values(array_intersect($drivers, array_keys($manifest['require'] ?? [])));
        $suggested = array_values(array_intersect($drivers, array_keys($manifest['suggest'] ?? [])));
        self::assertTrue($required === [] && $suggested === $drivers, 'composer.json requires ' . json_encode($required) . ' and suggests ' . json_encode($suggested) . ' of the PDO drivers; it must require none and suggest all three');

        $work = sys_get_temp_dir() . '/orm-php-without-mysql-' . getmypid();
        if (!mkdir($work, 0o700, true)) {
            throw new RuntimeException("cannot create $work");
        }
        try {
            $process = proc_open(
                [PHP_BINARY, '-n', '-r', self::CHILD, '--', "$root/vendor-php/autoload.php", $work],
                [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                $pipes,
            );
            self::assertIsResource($process, 'php -n did not start');
            $output = stream_get_contents($pipes[1]);
            $errors = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            $status = proc_close($process);
            self::assertSame(0, $status, "the child exited with $status: $errors");
            self::assertSame('without-mysql', $output, "the child read the name $output");
        } finally {
            foreach (glob("$work/*") ?: [] as $file) {
                unlink($file);
            }
            rmdir($work);
        }
    }
}
