<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The PHP plan reader opens tests/dbspec/plan-cases.json and tests/dbspec/plans-physical.json from one file each
// (dbspec_plan_cases.php, plan_vectors_at()). The test counts the test sources that open each file in code, and names
// them: exactly one, the helper.

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class DbspecPlanReaderTest extends TestCase
{
    public function testOneFileOpensPlansJson(): void
    {
        // The reader takes the path of the recipe through plan_vectors_at, which opens it.
        $openers_of = ['file_get_contents(', 'plan_vectors_at('];
        foreach (['plan-cases' . '.json', 'plans-physical' . '.json'] as $target) {
            $openers = [];
            foreach (glob(__DIR__ . '/*.php') ?: [] as $path) {
                if (basename($path) === basename(__FILE__)) {
                    continue;
                }
                foreach (file($path, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
                    $code = ltrim($line);
                    if (str_starts_with($code, '//') || str_starts_with($code, '*') || str_starts_with($code, '/*')) {
                        continue;
                    }
                    $opens = str_contains($code, $openers_of[0]) || str_contains($code, $openers_of[1]);
                    if ($opens && str_contains($code, $target)) {
                        $openers[] = basename($path);
                        break;
                    }
                }
            }
            sort($openers);
            Assert::assertSame(
                ['dbspec_plan_cases.php'],
                $openers,
                "$target must be opened by one file only: " . implode(', ', $openers)
            );
        }
    }
}
