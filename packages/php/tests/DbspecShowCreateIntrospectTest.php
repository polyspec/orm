<?php

declare(strict_types=1);

// Polyspec\Orm\Dbspec\Dbspec::introspect on MySQL, reading a canned catalog
// (T62-4-8). The double CannedCatalogPdo answers each catalog query of mysql_read with the rows of
// tests/dbspec/show-create.json ("catalog" and each case), so the reader of shown_check goes to SHOW CREATE TABLE
// for the body of the one CHECK. Each case expects the same checks and unsupported objects as the Go introspection
// of the same answers (packages/go/engine/dbspec show_create_introspect_test.go reads the same file), or the error of a
// CHECK the statement lacks.

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Unsupported;

#[Small]
final class DbspecShowCreateIntrospectTest extends TestCase
{
    private static function data(): array
    {
        return json_decode(
            (string) file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/show-create.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
    }

    public static function showCreateCases(): iterable
    {
        foreach (self::data()['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    // Requirements: DIA-84.
    #[DataProvider('showCreateCases')]
    public function testIntrospect(array $case): void
    {
        $catalog = self::data()['catalog'];
        $table = $catalog['table'];
        $create = implode("\n", $case['create']) . "\n";
        $pdo = new CannedCatalogPdo($catalog, $create, $case['name']);
        if (isset($case['error'])) {
            $this->expectException(RuntimeException::class);
            $this->expectExceptionMessageMatches('/^' . preg_quote($case['error'], '/') . '$/');
            Dbspec::introspect($pdo, 'mysql', $table);
            return;
        }
        $result = Dbspec::introspect($pdo, 'mysql', $table);
        $checks = [];
        foreach (explode("\n", Dbspec::emit($result->document)) as $line) {
            $line = trim($line);
            if (str_starts_with($line, 'check ')) {
                $checks[] = $line;
            }
        }
        // The reason text differs between the clients, as the reasons of tests/dbspec/introspect.json are not compared;
        // the rule before the first ": " is compared.
        $reasons = array_map(
            static fn (Unsupported $u): string => "$u->kind $u->name: " . explode(': ', $u->reason, 2)[0],
            $result->unsupported,
        );
        $this->assertSame($case['checks'], $checks, 'checks');
        $this->assertSame($case['unsupported'], $reasons, 'unsupported');
    }
}
