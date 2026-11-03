<?php

// The refusal of the errors vector of tests/conformance/vectors.json before any request (DSL-10, DSL-19, DSL-47,
// DSL-67, DSL-96, DSL-98, DSL-123, PRT-14): each chain runs on a SQLite file that has no table, with a statement
// subscriber, so a chain that reached the database would fail on the missing table with another code and with an event.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\StatementEvent;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\User;

use function Polyspec\Orm\Tests\Model\connect;

#[Medium]
class RefusalBeforeRequestTest extends TestCase
{
    // Requirements: DSL-10, DSL-19, DSL-47, DSL-67, DSL-96, DSL-98, DSL-123, PRT-14.
    public function testEachChainOfTheErrorsVectorIsRefusedBeforeAnyRequest(): void
    {
        $file = json_decode(
            (string)file_get_contents(dirname(__DIR__, 3) . '/tests/conformance/vectors.sqlite.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        $vector = array_values(array_filter($file['vectors'], static fn(array $v): bool => $v['name'] === 'errors'))[0];
        $this->assertSame([], $vector['expect']['statements']);
        $path = tempnam(sys_get_temp_dir(), 'orm-refusal-');
        $this->assertIsString($path);
        try {
            $db = connect('sqlite://' . $path, new Config(aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key'));
            $statements = [];
            $db->subscribe(static function (StatementEvent $e) use (&$statements): void {
                $statements[] = $e->sql;
            });
            $author = static fn(): Author => (new Author())($db);
            // A chain that the spec does not refuse reaches the database, so an empty statement list means no request.
            try {
                $author()->seq(42)->gets();
                $this->fail('a chain that is not refused found a table in the empty database');
            } catch (OrmException) {
                $this->assertNotSame([], $statements);
            }
            $chains = [
                'missing connector' => fn() => $author()->name('a')->isClose(true)->gets(),
                'dangling connector' => fn() => $author()->name('a')->and()->gets(),
                'empty list' => fn() => $author()->seq([])->gets(),
                'no connection' => fn() => (new Author())->name('a')->gets(),
                'lock outside a transaction' => fn() => $author()->forUpdate()->gets(),
                'join child with connection' => fn() => $author()->joinUserSeqWithSeq((new User())($db))->gets(),
                'page with limit' => fn() => $author()->limit(0, 1)->getsPage(1, 10),
                'relation with limit' => fn() => $author()
                    ->relation((new User())->matchUserSeqWithSeq()->limit(0, 1))->getsBySeq(42),
                'unjoined model placement' => fn() => $author()->name('a')->or(new User())->gets(),
            ];
            $this->assertSame($vector['chain'], implode(', ', array_keys($chains)));
            foreach (array_values($chains) as $i => $chain) {
                $name = array_keys($chains)[$i];
                $statements = [];
                try {
                    $chain();
                    $this->fail("$name was not refused");
                } catch (OrmException $e) {
                    $this->assertSame($vector['expect']['result'][$i], $e->code_, "$name: {$e->getMessage()}");
                }
                $this->assertSame([], $statements, "$name sent a statement before its refusal");
            }
        } finally {
            unset($db);
            unlink($path);
        }
    }
}
