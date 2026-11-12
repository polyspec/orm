<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PDO;
use PDOStatement;
use PHPUnit\Framework\Assert;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use ReflectionClass;

/** A local SQLite PDO that records the SQL and parameters run through the native Model. */
final class NativeQueryProbePdo extends PDO
{
    /** @var list<array{sql: string, params: list<mixed>}> */
    public array $executions = [];

    public function __construct()
    {
        parent::__construct('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        parent::setAttribute(PDO::ATTR_STATEMENT_CLASS, [NativeQueryProbeStatement::class, [$this]]);
    }

    public static function assertNativeOrmClasses(): void
    {
        Assert::assertTrue((new ReflectionClass(Db::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
    }

    /** @param list<array{tenantId: int, accountId: int, name: string, role: string}> $rows */
    public static function withCompositeRows(array $rows): self
    {
        $pdo = new self();
        $pdo->exec(
            'CREATE TABLE "composite_account" ("tenant_id" INTEGER NOT NULL, "account_id" INTEGER NOT NULL, '
            . '"name" TEXT NOT NULL, PRIMARY KEY ("tenant_id", "account_id"))'
        );
        $pdo->exec(
            'CREATE TABLE "composite_membership" ("tenant_id" INTEGER NOT NULL, "account_id" INTEGER NOT NULL, '
            . '"role" TEXT NOT NULL, PRIMARY KEY ("tenant_id", "account_id"))'
        );
        $account = $pdo->prepare('INSERT INTO "composite_account" VALUES (?, ?, ?)');
        $membership = $pdo->prepare('INSERT INTO "composite_membership" VALUES (?, ?, ?)');
        Assert::assertInstanceOf(PDOStatement::class, $account);
        Assert::assertInstanceOf(PDOStatement::class, $membership);
        foreach ($rows as $row) {
            Assert::assertTrue($account->execute([$row['tenantId'], $row['accountId'], $row['name']]));
            Assert::assertTrue($membership->execute([$row['tenantId'], $row['accountId'], $row['role']]));
        }
        $pdo->executions = [];
        return $pdo;
    }

    public function connectOrm(): Db
    {
        $db = new Db($this, 'sqlite', new Config(), new \DateTimeZone('UTC'));
        $db->registerSet(\Polyspec\Orm\Tests\Model\schema());
        return $db;
    }
}
