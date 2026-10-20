<?php

// Generic types of the PHP client: Db::transaction returns the type of its callback's result, and the rows that a
// model reads (gets, getsPage, and a Collection's get, first, all and iteration) carry the model's own class, so that
// PHPStan at level 9 reports no method.nonObject and no mixed on the calls a module makes on them.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/ClientGenericsTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

// Every call reads a value through a typed getter of a row that the client returned.
const CALLS = <<<'PHP'
<?php
declare(strict_types=1);

use Polyspec\Orm\Db;
use Polyspec\Orm\Tests\Model\Author;

function transactionResult(Db $db): string
{
    $author = $db->transaction(static fn(): ?Author => (new Author())->seq(1)->get());
    return $author?->getName() ?? '';
}

function transactionScalar(Db $db): int
{
    return $db->transaction(static fn(): int => 1) + 1;
}

/** @return list<string> */
function rows(Db $db): array
{
    $names = [];
    foreach ((new Author())($db)->gets() as $author) {
        $names[] = $author->getName();
    }
    $rows = (new Author())($db)->gets();
    $names[] = $rows->first()?->getName() ?? '';
    $names[] = $rows->get(1)?->getName() ?? '';
    foreach ($rows->all() as $author) {
        $names[] = $author->getName();
    }
    foreach ($rows->entries() as [, $author]) {
        $names[] = $author->getName();
    }
    foreach ((new Author())($db)->getsPage(1, 10)->items as $author) {
        $names[] = $author->getName();
    }
    return $names;
}

/** @return list<string> */
function rowsInTransaction(Db $db): array
{
    $rows = $db->transaction(static fn() => (new Author())->gets());
    $names = [];
    foreach ($rows as $author) {
        $names[] = $author->getName();
    }
    return $names;
}
PHP;

#[Small]
final class ClientGenericsTest extends TestCase
{
    private static string $work;

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 3);
        self::$work = $work = sys_get_temp_dir() . '/orm-php-client-generics-' . getmypid();
        @mkdir($work, 0o700, true);

        file_put_contents("$work/calls.php", CALLS);
    }

    public static function tearDownAfterClass(): void
    {
        exec('rm -rf ' . escapeshellarg(self::$work));
    }

    public function test_phpstan_types_the_transaction_result_and_the_rows_of_a_model(): void
    {
        $root = dirname(__DIR__, 3);
        $work = self::$work;
        // PHPStan loads the autoloader of the repository root (vendor-php), so its autoload file is autoload.php, the
        // autoloader of that root.
        // PHPStan keeps its cache in the case's own folder, which tearDownAfterClass removes.
        file_put_contents("$work/phpstan.neon", "parameters:\n    tmpDir: $work/phpstan-cache\n");
        $command = [PHP_BINARY, "$root/vendor-php/bin/phpstan", 'analyse', '--no-progress', '--no-ansi', '--error-format=raw',
            '--configuration', "$work/phpstan.neon", '--level=9', '--memory-limit=512M', '--autoload-file', __DIR__ . '/autoload.php', "$work/calls.php"];
        $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $root);
        $out = (string) stream_get_contents($pipes[1]);
        $err = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($process);
        $findings = array_values(array_filter(explode("\n", $out), static fn(string $line): bool => str_contains($line, '[identifier=')));
        self::assertFalse($code !== 0 || $findings !== [], "phpstan exited $code with " . count($findings) . " findings:\n" . implode("\n", $findings) . ($findings === [] ? "\n$out$err" : ''));
    }
}
