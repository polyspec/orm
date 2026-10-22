<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// MysqlCatalog::createChecks, the reader of a SHOW CREATE TABLE statement (T62-4-8), reads every case of
// tests/dbspec/show-create.json to the body that the case expects in CHECK_CLAUSE form, or to no body for a
// name the statement does not have.

use ReflectionMethod;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\MysqlCatalog;

#[Small]
final class DbspecShowCreateTest extends TestCase
{
    public static function showCreateCases(): iterable
    {
        $data = json_decode(
            (string) file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/show-create.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        foreach ($data['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    #[DataProvider('showCreateCases')]
    public function testShowCreate(array $case): void
    {
        $checks = (
            new ReflectionMethod(MysqlCatalog::class, 'createChecks')
        )->invoke(null, implode("\n", $case['create']) . "\n");
        $got = $checks[$case['name']] ?? null;
        if ($case['expected'] === 'not found') {
            $this->assertNull($got, "createChecks reads {$case['name']}, want not found");
            return;
        }
        $this->assertSame($case['expected'], $got, "createChecks reads {$case['name']}");
    }
}
