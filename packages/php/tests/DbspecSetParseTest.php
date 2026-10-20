<?php

declare(strict_types=1);

// The set parse Dbspec::parseSet (docs/spec/dbspec.md "Parsing a set") through the shared vectors
// tests/dbspec/set-parse.json; each parsed text equals one Dbspec::parse of it with the other named texts.
require_once __DIR__ . '/dbspec_set_parse_cases.php';

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;

#[Small]
final class DbspecSetParseTest extends TestCase
{
    public static function setParseCases(): iterable
    {
        return dbspec_set_parse_sets(dirname(__DIR__, 3));
    }

    #[DataProvider('setParseCases')]
    public function test_set_parse(array $case): void
    {
        dbspec_set_parse_check($case, static fn(array $owned, array $external): array => Dbspec::parseSet($owned, $external), function (array $result, array $case): void {
            $texts = [...$case['owned'], ...$case['external']];
            $named = [];
            $repeated = [];
            foreach ($result as $i => $d) {
                if ($d->name === '') {
                    continue;
                }
                if (isset($named[$d->name])) {
                    $repeated[$i] = true;
                } else {
                    $named[$d->name] = $i;
                }
            }
            foreach ($result as $i => $d) {
                if (isset($repeated[$i])) {
                    continue;
                }
                $others = [];
                foreach ($named as $name => $j) {
                    if ($name !== $d->name) {
                        $others[$name] = $texts[$j];
                    }
                }
                $one = Dbspec::parse($texts[$i], $others);
                if ($one->document !== null) {
                    $one->document->external = $d->external;
                }
                $this->assertSame(json_encode([$one->document, $one->positions, $one->diagnostics]), json_encode([$d->document, $d->positions, $d->diagnostics]), "text $i differs from one parse of it");
            }
        });
    }
}
