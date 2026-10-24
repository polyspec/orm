<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDOException;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\TestCase;

// Requirements: INT-72, DIA-180, DIA-181, PLN-17.
final class TransactionFailureTest extends TestCase
{
    use TransactionFailureCases;

    public function testStatementFailureKeepsItsDriverCause(): void
    {
        $pdo = new ModelTestFailingPdo('sqlite::memory:');
        $pdo->exec('CREATE TABLE statement_failure (value INTEGER)');
        $pdo->exec("CREATE TRIGGER reject_statement_failure BEFORE INSERT ON statement_failure BEGIN "
            . "SELECT RAISE(ABORT, 'statement failure'); END");
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));

        try {
            try {
                $db->execute([
                    'sql' => 'INSERT INTO statement_failure (value) VALUES (1)',
                    'tables' => ['statement_failure'],
                    'bind_slots' => [],
                ], []);
                self::fail('the trigger must reject the statement');
            } catch (OrmException $error) {
                self::assertSame(Code::DRIVER, $error->code_);
                self::assertInstanceOf(PDOException::class, $error->getPrevious());
                self::assertStringContainsString('statement failure', $error->getMessage());
            }
        } finally {
            $db->close();
        }
    }
}
