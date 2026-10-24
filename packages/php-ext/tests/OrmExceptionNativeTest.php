<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\AesKeyring;
use Polyspec\Orm\AesRotationStatus;
use Polyspec\Orm\Config;
use Polyspec\Orm\Schema;
use Polyspec\Orm\Orm;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use RuntimeException;

final class OrmExceptionNativeTest extends TestCase
{
    public function testOrmConnectionFactoryIsProvidedByTheExtension(): void
    {
        $class = new ReflectionClass(Orm::class);
        Assert::assertTrue($class->isInternal());
        Assert::assertSame('polyspec_orm', $class->getExtensionName());
    }

    public function testOrmConnectionFactoryRejectsAnInvalidDsnBeforeOpeningTransport(): void
    {
        try {
            Orm::connect('not a DSN', new Config());
            Assert::fail('a non-URI DSN must be rejected before transport setup');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CONFIG, $error->code_);
        }
    }

    public function testOrmConnectionFactoryRejectsAConfigThatIsNotConfigBeforeOpeningSqlite(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-connect-config-type-');
        Assert::assertIsString($path);
        unlink($path);
        try {
            try {
                Orm::connect('sqlite:///' . $path, new \stdClass());
                Assert::fail('connect accepted an object that is not a Config');
            } catch (\TypeError $error) {
                Assert::assertStringContainsString('Config', $error->getMessage());
            }
            Assert::assertFileDoesNotExist($path);
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function testNativeOrmParsesMysqlDsn(): void
    {
        Assert::assertSame(
            ['mysql', 'mysql:host=db.example;port=3307;dbname=app;charset=utf8mb4', 'user', 'p@ss', [], null],
            Orm::parseDsn('mysql://user:p%40ss@db.example:3307/app?timezone=UTC')
        );
    }

    public function testNativeOrmParsesPostgresDsn(): void
    {
        Assert::assertSame(
            ['postgres', 'pgsql:host=pool.example;port=5432;dbname=app;sslmode=require', 'user', 'secret', [], null],
            Orm::parseDsn('postgres://user:secret@db.example/app?host=pool.example&sslmode=require')
        );
    }

    public function testNativeOrmParsesSqlitePragmas(): void
    {
        Assert::assertSame(
            ['sqlite', 'sqlite:/tmp/app db.sqlite', null, null, [['journal_mode', 'WAL']], null],
            Orm::parseDsn('sqlite:///tmp/app%20db.sqlite?_pragma=journal_mode(WAL)')
        );
        Assert::assertSame(
            ['sqlite', 'sqlite:/tmp/app.sqlite', null, null, [['busy_timeout', '200'], ['journal_mode', 'WAL']], null],
            Orm::parseDsn('sqlite:///tmp/app.sqlite?&_pragma=busy_timeout(200)&&_pragma=journal_mode(WAL)&')
        );
    }

    // Requirements: CFG-2, CFG-19.
    public function testNativeOrmRejectsMalformedAndUnsupportedDsnParameters(): void
    {
        foreach (
            [
            'mysqlx://localhost/app',
            'relative/path',
            'sqlite://relative.sqlite',
            'mysql://localhost/',
            'postgres://localhost/app?timezone=Nowhere',
            'sqlite:///tmp/app.sqlite?_txlock=immediate',
            'sqlite:///tmp/app.sqlite?_pragma=busy_timeout',
            'sqlite:///tmp/app%2.sqlite',
            'sqlite:///tmp/app%FF.sqlite',
            'mysql://localhost/app?ssl-mode=VERIFY_IDENTITY&ssl-ca=ca.pem',
            'mysql://localhost/app?charset=utf8',
            'postgres://localhost/app?application_name=orm',
            'mysql://localhost/app?ssl-mode%5B%5D=VERIFY_IDENTITY',
            ] as $dsn
        ) {
            try {
                Orm::parseDsn($dsn);
                Assert::fail("invalid DSN was accepted: $dsn");
            } catch (OrmException $error) {
                Assert::assertSame(Code::CONFIG, $error->code_, "wrong error for $dsn");
            }
        }
    }

    // Requirements: CFG-17.
    public function testNativeMysqlTlsRejectsAddressLiteralsForIdentityVerification(): void
    {
        foreach (['127.0.0.1', '[::1]'] as $host) {
            try {
                Orm::parseDsn("mysql://$host/app?ssl-mode=VERIFY_IDENTITY&ssl-ca=%2Ftmp%2Fca.pem");
                Assert::fail("TLS identity verification must reject address literal $host");
            } catch (OrmException $error) {
                Assert::assertSame(Code::CONFIG, $error->code_);
                Assert::assertStringContainsString('needs a host name, not the address', $error->getMessage());
            }
        }
        Assert::assertSame('/tmp/ca.pem', Orm::parseDsn(
            'mysql://db.example/app?ssl-mode=VERIFY_IDENTITY&ssl-ca=%2Ftmp%2Fca.pem'
        )[5]);
    }

    public function testNativeDsnErrorsPreserveTheirSupportedParameterDetails(): void
    {
        try {
            Orm::parseDsn('mysql://db.example/app?extra=value');
            Assert::fail('unknown query parameters must be rejected');
        } catch (OrmException $error) {
            Assert::assertSame(
                'CONFIG: mysql DSN has the unknown parameter extra; it accepts timezone, socket, ssl-mode, ssl-ca',
                $error->getMessage()
            );
        }
        try {
            Orm::parseDsn('mysql://db.example/app?ssl-mode=disabled&ssl-ca=%2Ftmp%2Fca.pem');
            Assert::fail('unsupported TLS modes must be rejected');
        } catch (OrmException $error) {
            Assert::assertSame(
                'CONFIG: mysql DSN ssl-mode "disabled" is not supported; '
                . 'the TLS mode is ssl-mode=VERIFY_IDENTITY with ssl-ca',
                $error->getMessage()
            );
        }
        try {
            Orm::parseDsn('mysql://db.example/app?extra=%ZZ');
            Assert::fail('an unknown parameter must be rejected before decoding its value');
        } catch (OrmException $error) {
            Assert::assertSame(
                'CONFIG: mysql DSN has the unknown parameter extra; it accepts timezone, socket, ssl-mode, ssl-ca',
                $error->getMessage()
            );
        }
        try {
            Orm::parseMarkdownDsn('markdown://127.0.0.1:49152/corpus?extra=%ZZ');
            Assert::fail('an unknown markdown parameter must be rejected before decoding its value');
        } catch (OrmException $error) {
            Assert::assertSame(
                'CONFIG: markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>; it does not accept extra',
                $error->getMessage()
            );
        }
    }

    public function testNativeOrmParsesMarkdownDsnAndCreatesFunctionValues(): void
    {
        Assert::assertSame(
            ['127.0.0.1:49152', 'corpus', 'a token'],
            Orm::parseMarkdownDsn('markdown://127.0.0.1:49152/corpus?token=a+token')
        );
        $cases = [
            ['now', [], Orm::now()],
            ['today', [], Orm::today()],
            ['seconds_ago', [3], Orm::secondsAgo(3)],
            ['minutes_ago', [3], Orm::minutesAgo(3)],
            ['hours_ago', [3], Orm::hoursAgo(3)],
            ['days_ago', [3], Orm::daysAgo(3)],
            ['months_ago', [3], Orm::monthsAgo(3)],
            ['seconds_later', [3], Orm::secondsLater(3)],
            ['minutes_later', [3], Orm::minutesLater(3)],
            ['hours_later', [3], Orm::hoursLater(3)],
            ['days_later', [3], Orm::daysLater(3)],
            ['months_later', [3], Orm::monthsLater(3)],
            ['day_of_week', [], Orm::dayOfWeek()],
            ['year', [], Orm::year()],
            ['month', [], Orm::month()],
            ['date', [], Orm::date()],
        ];
        foreach ($cases as [$name, $args, $function]) {
            Assert::assertSame($name, $function->name);
            Assert::assertSame($args, $function->args);
            Assert::assertFalse($function->column);
        }
        $conflict = Orm::transactionConflict('retry');
        Assert::assertSame(Code::DEADLOCK, $conflict->code_);
        Assert::assertSame('DEADLOCK: retry', $conflict->getMessage());
    }

    public function testNativeMysqlTlsOptionsRequireAReadableCaFile(): void
    {
        Assert::assertSame([], Orm::mysqlTlsOptions(null));
        $path = tempnam(sys_get_temp_dir(), 'orm-native-ca-');
        Assert::assertNotFalse($path);
        try {
            $options = Orm::mysqlTlsOptions($path);
            Assert::assertSame($path, $options[\Pdo\Mysql::ATTR_SSL_CA]);
            Assert::assertTrue($options[\Pdo\Mysql::ATTR_SSL_VERIFY_SERVER_CERT]);
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function testNativeMarkdownConnectionRejectsTimeoutBeforeOpeningTransport(): void
    {
        try {
            Orm::connect('markdown://127.0.0.1:1/corpus?token=secret', new Config(statementTimeoutMs: 1));
            Assert::fail('markdown must reject statement timeouts before opening its socket');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CAPABILITY_UNSUPPORTED, $error->code_);
        }
    }

    // Requirements: CFG-4, CFG-5, CFG-6.
    public function testNativeConnectionRejectsUnsupportedPoolAndNegativeTimeoutOptions(): void
    {
        foreach (
            [
            [new Config(poolSize: 1), 'poolSize, poolIdleSize and poolLifetimeMs configure a connection pool'],
            [new Config(poolIdleSize: 1), 'poolSize, poolIdleSize and poolLifetimeMs configure a connection pool'],
            [new Config(poolLifetimeMs: 1000), 'poolSize, poolIdleSize and poolLifetimeMs configure a connection pool'],
            [new Config(statementTimeoutMs: -1), 'statement timeout must not be negative'],
            ] as [$config, $message]
        ) {
            try {
                Orm::connect('sqlite:///tmp/native-config-check.sqlite', $config);
                Assert::fail('unsupported connection options must fail before opening a database');
            } catch (OrmException $error) {
                Assert::assertSame(Code::CONFIG, $error->code_);
                Assert::assertStringContainsString($message, $error->getMessage());
            }
        }
    }

    public function testNativeMarkdownConnectionUsesTheLoopbackTransport(): void
    {
        try {
            Orm::connect('markdown://127.0.0.1:1/corpus?token=secret', new Config());
            Assert::fail('a refused flowmark endpoint must fail');
        } catch (OrmException $error) {
            Assert::assertSame(Code::DRIVER, $error->code_);
            Assert::assertStringContainsString('connecting to the flowmark server 127.0.0.1:1', $error->getMessage());
        }
    }

    public function testConnectSchemaVerifiesBeforeConnecting(): void
    {
        $schema = new Schema('', 'not a hash');
        try {
            Orm::connectSchema('not a DSN', $schema, new Config());
            Assert::fail('a schema with an invalid hash must fail before connecting');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CONFIG, $error->code_);
        }
    }

    public function testConnectSchemaChecksSchemaTypeBeforeConfigTypeAndDsn(): void
    {
        try {
            Orm::connectSchema('not a DSN', new \stdClass(), new \stdClass());
            Assert::fail('connectSchema accepted objects that are not Schema and Config');
        } catch (\TypeError $error) {
            Assert::assertStringContainsString('Schema', $error->getMessage());
        }
    }

    public function testNativeSqliteConnectionReturnsAWorkingNativeDb(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-native-connect-');
        Assert::assertNotFalse($path);
        try {
            $db = Orm::connect('sqlite://' . $path, new Config());
            Assert::assertSame('sqlite', $db->driver());
            $pdo = $db->pdo();
            $pdo->exec('CREATE TABLE native_connect_probe (value TEXT NOT NULL)');
            $pdo->exec("INSERT INTO native_connect_probe VALUES ('connected')");
            Assert::assertSame('connected', $pdo->query('SELECT value FROM native_connect_probe')->fetchColumn());
            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function testNativeSqliteConnectionFailurePreservesThePdoCause(): void
    {
        $path = sys_get_temp_dir() . '/orm-native-connect-missing-' . bin2hex(random_bytes(6)) . '/db.sqlite';
        try {
            Orm::connect('sqlite://' . $path, new Config());
            Assert::fail('a database under a nonexistent directory must fail to connect');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CONFIG, $error->code_);
            Assert::assertInstanceOf(\PDOException::class, $error->getPrevious());
        }
    }

    public function testNativeMarkdownConnectionSendsTheConnectHandshake(): void
    {
        $serverCode = self::markdownServerCode('{}');
        [$process, $pipes] = self::startMarkdownServer($serverCode);
        try {
            $port = trim((string) fgets($pipes[1]));
            Assert::assertMatchesRegularExpression('/^[1-9][0-9]*$/', $port);
            $db = Orm::connect("markdown://127.0.0.1:$port/corpus?token=test-token", new Config());
            Assert::assertSame('markdown', $db->driver());
            $encoded = trim((string) fgets($pipes[1]), "\r\n");
            $request = json_decode((string) base64_decode($encoded, true), true, 512, JSON_THROW_ON_ERROR);
            Assert::assertSame(['op' => 'connect', 'corpus' => 'corpus', 'token' => 'test-token'], $request);
            $db->close();
        } finally {
            self::stopMarkdownServer($process, $pipes);
        }
    }

    // Requirements: PRT-64.
    public function testNativeMarkdownConnectionRefusesConnectError(): void
    {
        $response = json_encode(
            ['error' => ['code' => 'CONFIG', 'message' => "connect: the token is not the corpus's token"]],
            JSON_THROW_ON_ERROR
        );
        $serverCode = self::markdownServerCode($response);
        [$process, $pipes] = self::startMarkdownServer($serverCode);
        try {
            $port = trim((string) fgets($pipes[1]));
            Assert::assertMatchesRegularExpression('/^[1-9][0-9]*$/', $port);
            Assert::assertTrue((new \ReflectionMethod(Orm::class, 'connect'))->isInternal());
            try {
                Orm::connect("markdown://127.0.0.1:$port/corpus?token=wrong-token", new Config());
                Assert::fail('a rejected native Markdown handshake must fail connect');
            } catch (OrmException $error) {
                Assert::assertSame(Code::CONFIG, $error->code_);
                Assert::assertSame(
                    "CONFIG: connect: the token is not the corpus's token",
                    $error->getMessage()
                );
                Assert::assertNull($error->getPrevious());
            }
            $encoded = trim((string) fgets($pipes[1]), "\r\n");
            $request = json_decode(
                (string) base64_decode($encoded, true),
                true,
                512,
                JSON_THROW_ON_ERROR
            );
            Assert::assertSame(
                ['op' => 'connect', 'corpus' => 'corpus', 'token' => 'wrong-token'],
                $request
            );
        } finally {
            self::stopMarkdownServer($process, $pipes);
        }
    }

    public function testAesKeyringIsProvidedByTheExtension(): void
    {
        $class = new ReflectionClass(AesKeyring::class);
        Assert::assertTrue($class->isInternal());
        Assert::assertSame('polyspec_orm', $class->getExtensionName());
    }

    public function testAesKeyringValidatesVersionsAndRotatesEveryNonNullColumn(): void
    {
        $ring = new AesKeyring([2 => 'new secret', 1 => 'old secret'], 2);
        Assert::assertSame(2, $ring->currentVersion);
        Assert::assertSame([1, 2], $ring->versions());
        Assert::assertSame('old secret', $ring->key(1));
        Assert::assertSame(17, AesKeyring::storedVersion('017'));

        $cipher = \Polyspec\Orm\Codec::hostEncode('plain', ['aes'], 'old secret')->bytes;
        $rotated = $ring->rotateRow(
            ['version' => '1', 'first' => $cipher, 'second' => null],
            'version',
            [['name' => 'first', 'styles' => ['aes']], ['name' => 'second', 'styles' => ['aes']]],
            2
        );
        Assert::assertSame(2, $rotated['version']);
        Assert::assertSame('plain', \Polyspec\Orm\Codec::hostDecode($rotated['first']->bytes, ['aes'], 'new secret'));
        Assert::assertNull($rotated['second']);
    }

    public function testAesKeyringRejectsInvalidConfigurationAndStoredVersions(): void
    {
        try {
            new AesKeyring([1 => ''], 1);
            Assert::fail('an empty key must be rejected');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CONFIG, $error->code_);
        }

        try {
            AesKeyring::storedVersion('2147483648');
            Assert::fail('a version outside the positive 32-bit range must be rejected');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CODEC_DECODE, $error->code_);
        }
    }

    public function testAesKeyringDoesNotReturnPartialRotationOnDecodeFailure(): void
    {
        $ring = new AesKeyring([1 => 'old secret', 2 => 'new secret'], 2);
        $first = \Polyspec\Orm\Codec::hostEncode('plain', ['aes'], 'old secret')->bytes;
        $row = ['version' => 1, 'first' => $first, 'second' => 'not an AES envelope'];
        try {
            $ring->rotateRow(
                $row,
                'version',
                [['name' => 'first', 'styles' => ['aes']], ['name' => 'second', 'styles' => ['aes']]],
                2
            );
            Assert::fail('an invalid second ciphertext must fail the complete row rotation');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CODEC_DECODE, $error->code_);
        }
        Assert::assertSame(1, $row['version']);
        Assert::assertSame($first, $row['first']);
    }

    public function testAesRotationStatusRetainsItsDeclaredValues(): void
    {
        $status = new AesRotationStatus(3, 8, 2, [1 => 4, 2 => 2, 3 => 2]);
        Assert::assertSame([3, 8, 2, [1 => 4, 2 => 2, 3 => 2]], [
            $status->current,
            $status->total,
            $status->pending,
            $status->versions,
        ]);
    }

    public function testTheExceptionClassIsRegisteredByTheExtension(): void
    {
        $class = new ReflectionClass(OrmException::class);
        Assert::assertTrue($class->isInternal());
        Assert::assertSame('polyspec_orm', $class->getExtensionName());
    }

    public function testConstructionRetainsCodePreviousRollbackAndCleanup(): void
    {
        $previous = new RuntimeException('primary cause');
        $rollback = new RuntimeException('rollback cause');
        $cleanup = new RuntimeException('cleanup cause');
        $error = new OrmException(Code::DRIVER, 'operation failed', $previous, $rollback, [$cleanup]);

        Assert::assertSame('DRIVER: operation failed', $error->getMessage());
        Assert::assertSame(Code::DRIVER, $error->code_);
        Assert::assertSame($previous, $error->getPrevious());
        Assert::assertSame($rollback, $error->rollback);
        Assert::assertSame([$cleanup], $error->cleanup);
    }

    public function testRollbackAndCleanupFactoriesKeepTheirCauseObjects(): void
    {
        $cause = new RuntimeException('operation failed');
        $rollback = new RuntimeException('rollback failed');
        $rolled = OrmException::rollback($cause, $rollback);
        Assert::assertSame(Code::ROLLBACK, $rolled->code_);
        Assert::assertSame($cause, $rolled->getPrevious());
        Assert::assertSame($rollback, $rolled->rollback);
        Assert::assertSame([], $rolled->cleanup);

        $cleanup = new RuntimeException('restore failed');
        $combined = OrmException::withCleanup($rolled, $cleanup);
        Assert::assertSame(Code::ROLLBACK, $combined->code_);
        Assert::assertSame($rolled, $combined->getPrevious());
        Assert::assertSame([$cleanup], $combined->cleanup);
    }

    public function testDriverFactoryKeepsItsCodeAndOriginalThrowable(): void
    {
        $driverError = new \PDOException('driver operation failed');
        $driverError->errorInfo = ['HY000', 1205, 'lock wait timeout'];
        $error = OrmException::fromDriver($driverError, 'mysql', new class extends \PDO {
            public function __construct()
            {
            }
        });

        Assert::assertSame(Code::CANCELED, $error->code_);
        Assert::assertSame('CANCELED: driver operation failed', $error->getMessage());
        Assert::assertSame($driverError, $error->getPrevious());
        Assert::assertNull($error->rollback);
        Assert::assertSame([], $error->cleanup);
    }

    private static function markdownServerCode(string $response): string
    {
        return str_replace('__RESPONSE__', var_export($response, true), <<<'PHP'
$server = stream_socket_server('tcp://127.0.0.1:0', $errno, $error);
if ($server === false) { fwrite(STDERR, $error); exit(2); }
$address = stream_socket_get_name($server, false);
echo substr($address, strrpos($address, ':') + 1), "\n";
flush();
$client = stream_socket_accept($server, 10);
if ($client === false) { exit(3); }
$request = fgets($client);
if ($request === false) { exit(4); }
fwrite($client, __RESPONSE__ . "\n");
fclose($client);
echo base64_encode($request), "\n";
fclose($server);
PHP);
    }

    /** @return array{resource, array<int, resource>} */
    private static function startMarkdownServer(string $serverCode): array
    {
        $pipes = [];
        $process = proc_open(
            [PHP_BINARY, '-r', $serverCode],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes
        );
        Assert::assertIsResource($process);
        return [$process, $pipes];
    }

    /** @param array<int, resource> $pipes */
    private static function stopMarkdownServer($process, array $pipes): void
    {
        foreach ($pipes as $pipe) {
            if (is_resource($pipe)) {
                fclose($pipe);
            }
        }
        $status = proc_get_status($process);
        if ($status['running']) {
            proc_terminate($process);
        }
        proc_close($process);
    }
}
