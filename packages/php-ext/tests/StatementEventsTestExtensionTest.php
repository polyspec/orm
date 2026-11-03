<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Db;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

// The PHP extension form of a statement event subscription, which the recipe statement_events cannot hold.
// Requirements: INT-77a.
#[\PHPUnit\Framework\Attributes\Medium]
final class StatementEventsTestExtensionTest extends TestCase
{
    public function testStatementEventEntryPointsAreNative(): void
    {
        foreach (['publish', 'observed', 'run', 'fetch'] as $method) {
            Assert::assertTrue(
                (new ReflectionMethod(Db::class, $method))->isInternal(),
                "Db::$method must run through the native extension"
            );
        }
    }

    /**
     * Unsubscribing frees the function of the unsubscribe closure: a process that subscribes and unsubscribes
     * over and over keeps its memory flat. The extension's allocation is persistent, so the measure is the
     * resident set of this process (ps), not memory_get_usage.
     */
    public function testUnsubscribeFreesClosure(): void
    {
        $path = sys_get_temp_dir() . '/unsubscribe-leak-' . getmypid() . '.sqlite';
        if (file_exists($path)) {
            unlink($path);
        }
        try {
            $db = \Polyspec\Orm\Orm::connect('sqlite://' . $path, new \Polyspec\Orm\Config());
            $rss = static fn(): int => (int) trim((string) shell_exec('ps -o rss= -p ' . getmypid()));
            $cycle = static function (\Polyspec\Orm\Db $db): void {
                $stop = $db->subscribe(static function (): void {
                });
                $stop();
            };
            for ($i = 0; $i < 20000; $i++) {
                $cycle($db);
            }
            $before = $rss();
            for ($i = 0; $i < 200000; $i++) {
                $cycle($db);
            }
            $grew = $rss() - $before;
            self::assertLessThan(
                10240,
                $grew,
                "resident set grew by {$grew} KB over 200000 subscribe/unsubscribe cycles",
            );
        } finally {
            if (file_exists($path)) {
                unlink($path);
            }
        }
    }
}
