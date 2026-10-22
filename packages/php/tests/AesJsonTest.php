<?php

declare(strict_types=1);

// Encrypted JSON value test on SQLite, MySQL and PostgreSQL: the
// `ordered_json aes` column of contracts/fixtures/secret_config.dbs takes an
// ordered-json value, reads it back with the same text, rotates to another key
// version, and takes an update. The models are generated from the document into
// a temporary directory, so the test runs in its own process.
// Each case runs in a case database of its own (case_database.php) created
// through ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the test fails when either
// is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/AesJsonTest.php
// [--filter <case>]
// The bench model is not read: this test uses only the model of its own document set.

use Polyspec\Orm\Tests\AesJson\SecretConfig;
use Polyspec\Orm\AesKeyring;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\StyledValue;
use Polyspec\OrderedJson\Value;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

use function Polyspec\OrderedJson\parse;
use function Polyspec\OrderedJson\stringify;

#[Medium]
final class AesJsonTest extends TestCase
{
    private static mixed $documents = null;

    /** The fixture of the file: what the script did before its cases, once per class. */
    private static function fixture(): void
    {
        $work = sys_get_temp_dir() . '/orm-php-aes-json-' . getmypid();
        @mkdir($work, 0o700, true);
        register_shutdown_function(static function () use ($work): void {
            exec('rm -rf ' . escapeshellarg($work));
        });

        self::$documents = [(string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/secret_config.dbs')];
        Generator::generate(
            RuntimeModel::build(RuntimeModel::parse(['secret_config.dbs' => self::$documents[0]])),
            "$work/gen",
            'Polyspec\\Orm\\Tests\\AesJson'
        );
        spl_autoload_register(static function (string $class) use ($work): void {
            if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\AesJson\\')) {
                require "$work/gen/" . substr($class, strlen('Polyspec\\Orm\\Tests\\AesJson\\')) . '.php';
            }
        });
        require "$work/gen/bootstrap.php";
    }

    private static function check(bool $ok, string $message): void
    {
        \PHPUnit\Framework\Assert::assertTrue($ok, $message);
    }

    private static function raw(string $dsn): PDO
    {
        [, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
        return new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    }

    /** @return array{string, int} the stored cell and key version of the single row */
    private static function stored(string $dsn): array
    {
        $row = self::raw($dsn)->query('SELECT config, aes_key_version FROM secret_config')->fetch(PDO::FETCH_NUM);
        $cell = is_resource($row[0]) ? (string) stream_get_contents($row[0]) : (string) $row[0];
        return [$cell, (int) $row[1]];
    }

    /** @param array<int, string> $keys */
    private static function open(string $dsn, array $keys, int $version): Db
    {
        return Orm::connectSchema(
            $dsn,
            \Polyspec\Orm\Tests\AesJson\schema(),
            new Config(aesKey: $keys[$version], aesVersion: $version, aesKeys: $keys)
        );
    }

    /** The ordered-json text of a read styled value; a value of another type fails the test. */
    private static function text(mixed $value): string
    {
        $payload = $value instanceof StyledValue ? $value->payload() : $value;
        if (!$payload instanceof Value) {
            throw new RuntimeException('json value is ' . get_debug_type($payload) . ', not an ordered-json value');
        }
        return stringify($payload);
    }

    private static function styled(mixed $value): StyledValue
    {
        return StyledValue::value($value);
    }

    /** The OrmException code of json_encode($value), or 'no error'. */
    private static function jsonEncodeCode(mixed $value): string
    {
        try {
            json_encode($value, JSON_THROW_ON_ERROR);
        } catch (\Polyspec\Orm\OrmException $e) {
            return $e->code_;
        }
        return 'no error';
    }

    private static function aesJsonColumn(string $dsn): void
    {
        $value = '{"z":{"b":1,"a":[]},"a":[true,null,"x"],"token":"s3cret-token","n":-12.50,"e":{}}';
        $updated = '{"token":"next-token","list":[1,"two",null]}';
        $one = [1 => 'config-key-one'];
        $both = [1 => 'config-key-one', 2 => 'config-key-two'];

        $first = self::open($dsn, $one, 1);
        $first->utils()->schema()->install(\Polyspec\Orm\Tests\AesJson\schema());
        $seq = (new SecretConfig())($first)->setConfig(self::styled(parse($value)))->create()->getSeq();
        $row = (new SecretConfig())($first)->addAllColumns()->getBySeq($seq);
        self::check(self::text($row->getConfig()) === $value, 'read back');
        $array = $row->toArray()['config'];
        self::check(
            $array['kind'] === 'value' && self::text($array['value']) === $value,
            'toArray keeps the ordered-json value'
        );
        $rowJson = '{"seq":' . $seq . ',"aes_key_version":1,"config":{"kind":"value","value":' . $value . '}}';
        self::check(
            $row->toJson() === $rowJson,
            'toJson keeps the member order and the number text: ' . $row->toJson()
        );
        self::check(
            self::jsonEncodeCode($row) === 'CODEC_ENCODE',
            'json_encode of a model with an ordered-json value fails'
        );
        $rows = (new SecretConfig())($first)->addAllColumns()->seq($seq)->gets();
        self::check($rows->toJson() === '[' . $rowJson . ']', 'collection toJson');
        self::check(
            self::jsonEncodeCode($rows) === 'CODEC_ENCODE',
            'json_encode of a collection with an ordered-json value fails'
        );
        self::check((
            new SecretConfig()
        )($first)->removeAllColumns()->addColumnSeq()->getBySeq($seq)->toJson() === '{"seq":' . $seq . '}'
            && json_encode(
                (new SecretConfig())($first)->removeAllColumns()->addColumnSeq()->getBySeq($seq)
            ) === '{"seq":' . $seq . '}', 'a row without an ordered-json value');
        $native = (new SecretConfig())($first)->setConfig(self::styled(['k' => [1, 2]]))->create()->getSeq();
        $read = (new SecretConfig())($first)->addAllColumns()->getBySeq($native);
        self::check(self::text($read->getConfig()) === '{"k":[1,2]}', 'native value write');
        (new SecretConfig())($first)->getBySeq($native)->delete();
        [$cell, $version] = self::stored($dsn);
        self::check(
            str_starts_with($cell, "ORM-AES2\0") && !str_contains($cell, 's3cret-token') && $version === 1,
            "stored version $version"
        );
        $first->close();

        $second = self::open($dsn, $both, 2);
        self::check(
            self::text((new SecretConfig())($second)->addAllColumns()->getBySeq($seq)->getConfig()) === $value,
            'mixed-version read'
        );
        self::check($second->utils()->aes()->rotate(new SecretConfig(), new AesKeyring($both, 2)) === 1, 'rotate');
        self::check(self::stored($dsn)[1] === 2, 'rotated version');
        $second->close();

        $rotated = self::open($dsn, [2 => 'config-key-two'], 2);
        self::check(
            self::text((new SecretConfig())($rotated)->addAllColumns()->getBySeq($seq)->getConfig()) === $value,
            'rotated read'
        );
        $rotated->close();

        $again = self::open($dsn, $both, 1);
        (new SecretConfig())($again)->getBySeq($seq)->setConfig(self::styled(parse($updated)))->update();
        self::check(self::stored($dsn)[1] === 1, 'updated version');
        self::check(
            self::text((new SecretConfig())($again)->addAllColumns()->getBySeq($seq)->getConfig()) === $updated,
            'updated read'
        );
        $again->close();
    }

    public static function setUpBeforeClass(): void
    {
        self::fixture();
    }

    /** @return iterable<string, array{string}> the drivers of the case, each a data set */
    public static function drivers(): iterable
    {
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            yield $driver => [$driver];
        }
    }

    #[DataProvider('drivers')]
    public function testAesJsonColumn(string $driver): void
    {
        // The test of DSL-8, COD-7 (docs/spec).
        // The case makes an AES JSON column table in a case database of its own and writes and reads a few rows.
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::aesJsonColumn($dsn));
    }
}
