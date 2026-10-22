<?php

declare(strict_types=1);

// The PHP plans reader opens tests/dbspec/plans.json from one file (dbspec_plan_cases.php, plan_vectors()). The test
// counts the test sources that open the file in code, and names them: exactly one, the helper.

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class DbspecPlanReaderTest extends TestCase
{
    public function testOneFileOpensPlansJson(): void
    {
        $opener = 'file_get_contents(';
        $target = 'plans' . '.json';
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
                if (str_contains($code, $opener) && str_contains($code, $target)) {
                    $openers[] = basename($path);
                    break;
                }
            }
        }
        sort($openers);
        Assert::assertSame(
            ['dbspec_plan_cases.php'],
            $openers,
            'plans.json must be opened by one file only: ' . implode(', ', $openers)
        );
    }
}
