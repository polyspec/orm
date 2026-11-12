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
use ReflectionClass;

use function Polyspec\Orm\Tests\with_case_database;
use function Polyspec\Orm\Tests\installBench;

#[Medium]
final class ConnectionUtcNativeTest extends TestCase
{
    use ThreeDrivers;

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
        $dir = \Polyspec\Orm\Tests\OrmGenTestSupport::createWorkDirectory(
            'orm-php-ext-runtime-i16-' . $driver . '-'
        );
        $document = "dbspec 1 native_i16_$driver\n\ntable item {\n"
            . "  seq i64 identity\n  small i16\n  defaulted i16 default 3\n  primary key (seq)\n}\n";
        try {
            $class = \Polyspec\Orm\Tests\OrmGenTestSupport::generateItemModel(
                $dir,
                'Polyspec\\Orm\\Extension\\Tests\\RuntimeI16' . ucfirst($driver),
                $document
            );
            require_once "$dir/model/bootstrap.php";
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
}
