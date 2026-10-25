<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;

/** INT-47 for the PHP library and the extension: a transaction of one fiber holds its connection from another fiber. */
final class FiberTransaction
{
    /** A fiber that, when started, opens a transaction of $db and suspends inside it until it is resumed. */
    public static function holding(Db $db): \Fiber
    {
        return new \Fiber(static function () use ($db): void {
            $db->transaction(static function (): void {
                \Fiber::suspend();
            }, retry: 0);
        });
    }

    /**
     * Starts $fiber, whose transaction of $db suspends, starts a transaction of $db outside it and resumes $fiber on
     * every path; the OrmException that the outside transaction raised, or null.
     */
    public static function outsideError(\Fiber $fiber, Db $db): ?OrmException
    {
        $fiber->start();
        try {
            $db->transaction(static fn() => null, retry: 0);
            return null;
        } catch (OrmException $caught) {
            return $caught;
        } finally {
            $fiber->resume();
        }
    }
}
