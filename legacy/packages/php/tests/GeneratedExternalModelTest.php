<?php

// The generated schema value carries the external text at run time: the generated connect registers a set that uses an
// external document, and the model of a used external table reads a row of that table.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/GeneratedExternalModelTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\Attributes\RunTestsInSeparateProcesses;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;

#[Medium]
#[RunTestsInSeparateProcesses]
class GeneratedExternalModelTest extends TestCase
{
    // Requirements: DBS-110, DBS-173.
    public function testGeneratedExternalModelReadsItsTable(): void
    {
        $work = sys_get_temp_dir() . '/orm-php-generated-external-' . getmypid();
        mkdir($work, 0o700, true);
        try {
            $fixture = static fn(string $name): string => (string) file_get_contents(
                ormLegacyRoot() . "/contracts/fixtures/external/$name.dbs"
            );
            generateModels(
                ['member.dbs' => $fixture('member')],
                "$work/source",
                "$work/member",
                'Polyspec\\Orm\\Tests\\GeneratedExternal\\Member',
                ['core.dbs' => $fixture('core')]
            );
            requireGeneratedClasses("$work/member");
            require "$work/member/bootstrap.php";
            $raw = new PDO("sqlite:$work/external.sqlite");
            $raw->exec('CREATE TABLE ext_account (seq INTEGER PRIMARY KEY, name TEXT NOT NULL)');
            $raw->exec("INSERT INTO ext_account (seq, name) VALUES (1, 'kim')");
            $raw = null;
            $db = \Polyspec\Orm\Tests\GeneratedExternal\Member\connect("sqlite://$work/external.sqlite", new Config());
            try {
                $row = (new \Polyspec\Orm\Tests\GeneratedExternal\Member\ExtAccount())($db)->getBySeq(1);
                self::assertSame('kim', $row->getName());
            } finally {
                $db->close();
            }
        } finally {
            exec('rm -rf ' . escapeshellarg($work));
        }
    }
}
