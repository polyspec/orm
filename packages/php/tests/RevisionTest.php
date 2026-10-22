<?php

// An update or delete with an expected revision (docs/spec/dsl.md "Writes", expectRevision) on a SQLite file of
// each case: a match updates and bumps the revision or deletes, a mismatch fails with REVISION_CHANGED and
// changes nothing.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/RevisionTest.php
// [--filter <case>]
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Tests\RevisionCase\Note;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class RevisionTest extends TestCase
{
    private const DOCUMENT = "dbspec 1 revision\n\ntable note {\n  seq i64 identity\n  label varchar(32)\n  revision "
        . "i64\n  primary key (seq)\n}\n";

    private static string $work = '';
    private ?Db $db = null;

    public static function setUpBeforeClass(): void
    {
        self::$work = sys_get_temp_dir() . '/orm-php-revision-' . getmypid();
        is_dir(self::$work) || mkdir(self::$work, 0o700, true);
        Generator::generate(
            RuntimeModel::build(RuntimeModel::parse(['revision.dbs' => self::DOCUMENT])),
            self::$work . '/models',
            'Polyspec\\Orm\\Tests\\RevisionCase'
        );
        $work = self::$work;
        requireGeneratedClasses("$work/models");
        require_once self::$work . '/models/bootstrap.php';
    }

    public static function tearDownAfterClass(): void
    {
        exec('rm -rf ' . escapeshellarg(self::$work));
    }

    protected function tearDown(): void
    {
        $this->db?->close();
    }

    /** A new SQLite file with one note at revision 3; returns its key. */
    private function seed(string $name): int
    {
        $this->db = Orm::connect('sqlite://' . self::$work . "/$name.sqlite", new Config());
        $this->db->utils()->schema()->install(\Polyspec\Orm\Tests\RevisionCase\schema());
        return (new Note())($this->db)->setLabel('first')->setRevision(3)->create()->getSeq();
    }

    private static function code(callable $fn): string
    {
        try {
            $fn();
        } catch (OrmException $e) {
            return $e->code_;
        }
        return 'no error';
    }

    public function testUpdateMatchBumpsTheRevision(): void
    {
        // The test of DSL-108, DSL-114 (docs/spec).
        $seq = $this->seed('update-match');
        (new Note())($this->db)->setSeq($seq)->setLabel('second')->expectRevision('revision', 3)->update();
        $row = (new Note())($this->db)->getBySeq($seq);
        self::assertSame(['second', 4], [$row->getLabel(), $row->getRevision()]);
    }

    public function testUpdateMismatchChangesNothing(): void
    {
        // The test of DSL-108, DSL-114 (docs/spec).
        $seq = $this->seed('update-mismatch');
        self::assertSame(
            Code::REVISION_CHANGED,
            self::code(
                fn() => (new Note())($this->db)->setSeq($seq)
                    ->setLabel('stale')
                    ->expectRevision('revision', 2)
                    ->update()
            )
        );
        $row = (new Note())($this->db)->getBySeq($seq);
        self::assertSame(['first', 3], [$row->getLabel(), $row->getRevision()]);
    }

    public function testDeleteMatchDeletes(): void
    {
        // The test of DSL-108, DSL-114 (docs/spec).
        $seq = $this->seed('delete-match');
        (new Note())($this->db)->setSeq($seq)->expectRevision('revision', 3)->delete();
        self::assertNull((new Note())($this->db)->seq($seq)->get());
    }

    public function testDeleteMismatchChangesNothing(): void
    {
        // The test of DSL-108, DSL-114 (docs/spec).
        $seq = $this->seed('delete-mismatch');
        self::assertSame(
            Code::REVISION_CHANGED,
            self::code(fn() => (new Note())($this->db)->setSeq($seq)->expectRevision('revision', 4)->delete())
        );
        self::assertSame(3, (new Note())($this->db)->getBySeq($seq)->getRevision());
    }
}
