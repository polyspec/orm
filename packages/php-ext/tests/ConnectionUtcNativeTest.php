<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use DateTimeImmutable;
use DateTimeZone;
use Closure;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Schema;
use Polyspec\Orm\StyledValue;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Tests\Model\ServiceMember;
use Polyspec\Orm\Tests\Model\ServiceRegion;
use Polyspec\Orm\Tests\Model\User;
use Polyspec\Orm\Tests\ThreeDrivers;
use ReflectionMethod;

use function Polyspec\Orm\Tests\case_admin;
use function Polyspec\Orm\Tests\with_case_database;
use function Polyspec\Orm\Tests\installBench;

#[Medium]
final class ConnectionUtcNativeTest extends TestCase
{
    use ThreeDrivers;

    /** @return iterable<string, array{string, string}> */
    public static function connections(): iterable
    {
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            foreach (['', 'UTC', '+00:00'] as $zone) {
                $name = $zone === '' ? 'default' : ($zone === 'UTC' ? 'utc' : 'offset');
                yield "$driver/$name" => [$driver, $zone];
            }
        }
    }

    // Requirements: CFG-2, DIA-57, DSL-141.
    // This case verifies the C connection factory, not only the PHP library path.
    #[DataProvider('connections')]
    public function testNativeConnectionsUseUtc(string $driver, string $zone): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        with_case_database(
            $driver,
            static function (string $step): void {
            },
            function (string $base, object $database) use ($driver, $zone): void {
                $plain = preg_replace('/[?&]timezone=[^&]*/', '', $base);
                if (!is_string($plain)) {
                    self::fail('could not remove an existing timezone parameter from the case DSN');
                }
                $suffix = str_contains($plain, '?') ? '&' : '?';
                $dsn = $zone === '' ? $plain : $plain . $suffix . 'timezone=' . rawurlencode($zone);
                $db = Orm::connect($dsn, new Config());
                try {
                    self::assertNativeServerTimezone($driver, $db->pdo());
                    installBench($db);
                    self::assertUtcRoundTrip($db);
                } finally {
                    $db->close();
                }
            }
        );
    }

    private static function assertNativeServerTimezone(string $driver, \PDO $pdo): void
    {
        if ($driver === 'mysql') {
            $admin = getenv('ORM_TEST_MYSQL_DSN');
            self::assertIsString($admin);
            $server = case_admin($admin);
            self::assertSame(
                'SYSTEM',
                (string) $server->query('SELECT @@GLOBAL.time_zone')->fetchColumn(),
                'MySQL fixture global time_zone'
            );
            self::assertSame(
                'KST',
                (string) $server->query('SELECT @@system_time_zone')->fetchColumn(),
                'MySQL fixture system time zone'
            );
            self::assertSame(
                '+00:00',
                (string) $pdo->query('SELECT @@SESSION.time_zone')->fetchColumn(),
                'native MySQL connection time_zone'
            );
        } elseif ($driver === 'postgres') {
            $admin = getenv('ORM_TEST_POSTGRES_DSN');
            self::assertIsString($admin);
            $server = case_admin($admin);
            self::assertSame(
                'Asia/Seoul',
                (string) $server->query('SHOW TimeZone')->fetchColumn(),
                'PostgreSQL fixture time zone'
            );
            self::assertSame(
                'UTC',
                (string) $pdo->query('SHOW TimeZone')->fetchColumn(),
                'native PostgreSQL connection time zone'
            );
        }
    }

    private static function assertUtcRoundTrip(Db $db): void
    {
        $instant = new DateTimeImmutable('2026-01-02T00:00:00+09:00');
        $startUtc = $instant->setTimezone(new DateTimeZone('UTC'));
        $before = new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $created = self::createNativeAuthor($db, $startUtc->format('Y-m-d H:i:s'));
        $row = (new Author())($db)->getBySeq($created->getSeq());
        self::assertNotNull($row);
        $start = $row->getStartDt();
        self::assertInstanceOf(DateTimeImmutable::class, $start);
        self::assertTrue($start == $instant, 'the stored datetime represents the input instant');
        self::assertSame('2026-01-01 15:00 +00:00', $start->format('Y-m-d H:i P'), 'the stored wall clock is UTC');
        $createdAt = $row->getCreatedTs();
        self::assertInstanceOf(DateTimeImmutable::class, $createdAt);
        self::assertLessThan(60, abs($createdAt->getTimestamp() - $before->getTimestamp()), 'default now is UTC');
        self::assertSame(0, $createdAt->getOffset(), 'default now timezone offset');
        $author = static fn() => (new Author())($db);
        self::assertSame(
            1,
            $author()->startDt($startUtc->format('Y-m-d H:i:s'))->getCount(),
            'instant equality filter'
        );
        self::assertSame(1, $author()->startDt('2026-01-01 15:00:00')->getCount(), 'text equality filter');
        self::assertSame(1, $author()->startDt('2026-01-01T15:00:00.0')->getCount(), 'fractional equality filter');
        self::assertSame(
            1,
            $author()->startDt(['2026-01-01 15:00:00', '2026-01-03 00:00:00'])->getCount(),
            'IN filter'
        );
        self::assertSame(
            1,
            $author()->betweenStartDt(['2026-01-01 15:00:00', '2026-01-01 15:00:00.5'])->getCount(),
            'between filter'
        );
        if ($db->driver() === 'sqlite') {
            try {
                $author()->startDt('2026-01-02')->getCount();
                self::fail('date-only datetime text must be refused');
            } catch (OrmException $error) {
                self::assertSame('CODEC_ENCODE', $error->code_, 'date-only datetime text');
            }
        }
    }

    // Requirements: INT-99, DBS-68, COD-20. The case performs a native Model read after an INSERT of SQL NULL.
    #[DataProvider('drivers')]
    public function testNativeStyledSqlNullIsPreservedOnDatabaseRead(string $driver): void
    {
        self::withNativeDatabase($driver, static function (Db $db): void {
            $created = self::createNativeAuthor($db, '2026-01-01 15:00:00', true);
            $styled = (new Author())($db)->removeAllColumns()->addColumnJsonSetting()->getBySeq($created->getSeq());
            self::assertInstanceOf(StyledValue::class, $styled->getJsonSetting());
            self::assertSame('sql-null', $styled->getJsonSetting()->kind);
        });
    }

    // Requirements: INT-99.
    #[DataProvider('drivers')]
    public function testNativeI16ValuesAndDefaults(string $driver): void
    {
        self::assertTrue((new ReflectionClass(\Polyspec\Orm\Model::class))->isInternal());
        $dir = \Polyspec\Orm\Tests\OrmGenTestSupport::createWorkDirectory('orm-php-ext-runtime-i16-');
        $document = "dbspec 1 native_i16_$driver\n\ntable item {\n"
            . "  seq i64 identity\n  small i16\n  defaulted i16 default 3\n  primary key (seq)\n}\n";
        try {
            $class = \Polyspec\Orm\Tests\OrmGenTestSupport::generateItemModel(
                $dir,
                'Polyspec\\Orm\\Extension\\Tests\\RuntimeI16' . ucfirst($driver),
                $document
            );
            $parsed = Dbspec::parse($document, []);
            self::assertNotNull($parsed->document, 'the native i16 fixture parses');
            $manifest = Dbspec::manifest([$parsed->document])->manifest;
            self::assertNotNull($manifest, 'the native i16 fixture has a schema manifest');
            self::withNativeDatabase($driver, static function (Db $db) use ($class, $manifest): void {
                $db->utils()->schema()->install(new Schema($manifest->manifestText, $manifest->manifestHash));
                $low = (new $class())->connect($db)->setSmall(-32768)->create();
                $high = (new $class())->connect($db)->setSmall(32767)->create();
                $lowRead = (new $class())->connect($db)->getBySeq($low->getSeq());
                $highRead = (new $class())->connect($db)->getBySeq($high->getSeq());
                self::assertSame(-32768, $lowRead->getSmall());
                self::assertSame(32767, $highRead->getSmall());
                self::assertSame(3, $lowRead->getDefaulted(), 'an omitted i16 column reads its database default');
            });
        } finally {
            \Polyspec\Orm\Tests\OrmGenTestSupport::removeWorkDirectory($dir);
        }
    }

    // Requirements: INT-98. Each native model read must reject a database cell outside its declared i32 range.
    #[DataProvider('drivers')]
    public function testNativeOutOfRangeDatabaseCellFailsTypedRead(string $driver): void
    {
        self::withNativeDatabase($driver, static function (Db $db) use ($driver): void {
            $created = self::createNativeAuthor($db, '2026-01-01 15:00:00');
            self::assertNativeTypedCellFailure($driver, $db, $created->getSeq());
        });
    }

    private static function withNativeDatabase(string $driver, Closure $case): void
    {
        with_case_database(
            $driver,
            static function (string $step): void {
            },
            static function (string $dsn) use ($case): void {
                $db = Orm::connect($dsn, new Config());
                try {
                    installBench($db);
                    $case($db);
                } finally {
                    $db->close();
                }
            }
        );
    }

    private static function createNativeAuthor(Db $db, string $start, bool $styledSqlNull = false): Author
    {
        $service = (new Service())($db)->setName('typed-read-service')->create();
        $user = (new User())($db)->setName('typed-read-user')->create();
        $region = (new ServiceRegion())($db)->setServiceSeq($service->getSeq())->setName('typed-read-region')->create();
        $member = (new ServiceMember())($db)->setServiceSeq($service->getSeq())->setUserSeq($user->getSeq())->create();
        $author = (new Author())($db)
            ->setName('typed-read-author')->setUserSeq($user->getSeq())->setServiceSeq($service->getSeq())
            ->setServiceRegionSeq($region->getSeq())->setServiceMemberSeq($member->getSeq())
            ->setStartDt($start)->setEndDt('2026-01-03 00:00:00');
        if ($styledSqlNull) {
            $author->setJsonSetting(StyledValue::sqlNull());
        }
        return $author->create();
    }

    private static function assertNativeTypedCellFailure(string $driver, Db $db, int $seq): void
    {
        $pdo = $db->pdo();
        if ($driver === 'mysql') {
            $pdo->exec('ALTER TABLE author MODIFY target_club_reader_count BIGINT UNSIGNED');
            $sql = 'UPDATE author SET target_club_reader_count = 18446744073709551615 WHERE seq = ?';
        } elseif ($driver === 'postgres') {
            $pdo->exec('ALTER TABLE author ALTER COLUMN target_club_reader_count TYPE BIGINT');
            $sql = 'UPDATE author SET target_club_reader_count = 2147483648 WHERE seq = ?';
        } else {
            $sql = 'UPDATE author SET target_club_reader_count = 2147483648 WHERE seq = ?';
        }
        $pdo->prepare($sql)->execute([$seq]);
        try {
            (new Author())($db)->removeAllColumns()->addColumnTargetClubReaderCount()->getBySeq($seq);
            self::fail("$driver accepted an out-of-range i32 cell");
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_, "$driver i32 cell read error");
        }
    }
}
