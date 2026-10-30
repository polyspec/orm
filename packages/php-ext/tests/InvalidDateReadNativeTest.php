<?php

declare(strict_types=1);

// The native read of a date column (T293): a stored value that no date form reads throws the CODEC_DECODE OrmException
// "invalid date value <text>" that Model::timeValue of the PHP library throws, on a row read and on a grouped value, and a
// text that the library reads in one of its fallback forms reads natively too. Each case stores its value in a SQLite file
// through PDO, since the model writes only valid dates.

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\Model\DayCell;

use function Polyspec\Orm\Tests\Model\connect;

#[Medium]
final class InvalidDateReadNativeTest extends TestCase
{
    // Requirements: COD-1.
    public function testRowReadOfANonTextDateThrowsTheDecodeError(): void
    {
        self::withDay(5, static function ($db): void {
            try {
                (new DayCell())->connect($db)->seq(1)->get()?->getDay();
                self::fail('a row read accepted the date value 5');
            } catch (OrmException $error) {
                self::assertSame(Code::CODEC_DECODE, $error->code_);
                self::assertSame('CODEC_DECODE: invalid date value 5', $error->getMessage());
            }
        });
    }

    // Requirements: COD-1.
    public function testGroupedNonTextDateThrowsTheDecodeError(): void
    {
        self::withDay(5, static function ($db): void {
            try {
                foreach ((new DayCell())->connect($db)->groupByDay()->getsCount() as $row) {
                    $row->value('day');
                }
                self::fail('a grouped read accepted the date value 5');
            } catch (OrmException $error) {
                self::assertSame(Code::CODEC_DECODE, $error->code_);
                self::assertSame('CODEC_DECODE: invalid date value 5', $error->getMessage());
            }
        });
    }

    // Requirements: COD-1.
    public function testTextDateOfAFallbackFormReads(): void
    {
        self::withDay('2026-1-1', static function ($db): void {
            $day = (new DayCell())->connect($db)->seq(1)->get()?->getDay();
            self::assertInstanceOf(\DateTimeImmutable::class, $day);
            self::assertSame('2026-01-01 00:00:00', $day->format('Y-m-d H:i:s'));
        });
    }

    // Requirements: COD-1.
    public function testTextDateThatNoFormReadsThrowsTheDecodeError(): void
    {
        self::withDay('not a date', static function ($db): void {
            try {
                (new DayCell())->connect($db)->seq(1)->get()?->getDay();
                self::fail('a row read accepted the date value "not a date"');
            } catch (OrmException $error) {
                self::assertSame(Code::CODEC_DECODE, $error->code_);
                self::assertSame('CODEC_DECODE: invalid date value not a date', $error->getMessage());
            }
        });
    }

    /** Runs $case on a SQLite file whose day_cell row 1 stores $day. */
    private static function withDay(int|string $day, callable $case): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-invalid-date-');
        self::assertIsString($path);
        try {
            $pdo = new \PDO('sqlite:' . $path);
            $pdo->exec('CREATE TABLE day_cell (seq INTEGER PRIMARY KEY, label VARCHAR(8) NOT NULL, day DATE NULL, at_time TIME NULL)');
            $insert = $pdo->prepare('INSERT INTO day_cell (seq, label, day) VALUES (1, ?, ?)');
            $insert->execute(['cell', $day]);
            $pdo = null;
            $db = connect('sqlite://' . $path, new Config());
            try {
                $case($db);
            } finally {
                $db->close();
            }
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }
}
