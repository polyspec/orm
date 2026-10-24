<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Tests\Model\ServiceMember;
use Polyspec\Orm\Tests\Model\ServiceRegion;
use Polyspec\Orm\Tests\Model\User;
use ReflectionMethod;

use function Polyspec\Orm\Tests\case_admin;
use function Polyspec\Orm\Tests\with_case_database;
use function Polyspec\Orm\Tests\installBench;

final class ConnectionUtcNativeTest extends TestCase
{
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

    // Requirements: CFG-2. This case verifies the C connection factory, not only the PHP library path.
    #[Medium]
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

    private static function assertUtcRoundTrip(\Polyspec\Orm\Db $db): void
    {
        $service = (new Service())($db)->setName('utc-service')->create();
        $user = (new User())($db)->setName('utc-user')->create();
        $region = (new ServiceRegion())($db)->setServiceSeq($service->getSeq())->setName('utc-region')->create();
        $member = (new ServiceMember())($db)->setServiceSeq($service->getSeq())->setUserSeq($user->getSeq())->create();
        $instant = new DateTimeImmutable('2026-01-02T00:00:00+09:00');
        $startUtc = $instant->setTimezone(new DateTimeZone('UTC'));
        $before = new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $created = (new Author())($db)
            ->setName('utc-row')->setUserSeq($user->getSeq())->setServiceSeq($service->getSeq())
            ->setServiceRegionSeq($region->getSeq())->setServiceMemberSeq($member->getSeq())
            ->setStartDt($startUtc->format('Y-m-d H:i:s'))->setEndDt('2026-01-03 00:00:00')->create();
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
}
