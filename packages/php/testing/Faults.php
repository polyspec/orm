<?php
declare(strict_types=1);

namespace Polyspec\Orm\Testing;

use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;

/**
 * PHP client의 test entry point다. package autoloader는 이 file을 map하지 않으므로,
 * process는 package의 `testing/Faults.php`를 path로 require한 뒤에만 이 class를
 * 가진다.
 */
final class Faults
{
    /**
     * connection에 test fault를 설정한다: callback이 실패한 다음 transaction의
     * rollback은 실행된 뒤 rollback 오류로 FAULT 오류를 보고하므로, transaction은
     * callback 오류와 fault를 가진 ROLLBACK 오류를 throw한다. fault는 그런
     * rollback이 소비할 때까지 남는다.
     */
    public static function failNextRollback(Db $db): void
    {
        (\Closure::bind(static function (Db $db): void {
            $db->state->rollbackFault = true;
        }, null, Db::class))($db);
    }

    /**
     * connection에 statement fault를 설정한다: 다음 statement(transaction 제어 statement 제외)는
     * 보내지 않고 $code와 $message의 OrmException으로 끝난다. 그 statement가 fault를 소비한다.
     * 이미 설정된 statement fault는 대체된다. code나 message가 비면 \InvalidArgumentException이고
     * 아무것도 설정하지 않는다.
     */
    public static function failNextStatement(Db $db, string $code, string $message): void
    {
        if ($code === '') {
            throw new \InvalidArgumentException('failNextStatement needs a nonempty code');
        }
        if ($message === '') {
            throw new \InvalidArgumentException('failNextStatement needs a nonempty message');
        }
        (\Closure::bind(static function (Db $db) use ($code, $message): void {
            $db->state->statementFault = new OrmException($code, $message);
        }, null, Db::class))($db);
    }

    /**
     * connection의 executor clock을 $clock 시각으로 고정한다. $clock은 UTC의 `YYYY-MM-DD HH:MM:SS.ffffff` text다
     * (docs/protocol.md "Test clock"). 형식이 다르면 \InvalidArgumentException이고 아무것도 설정하지 않는다.
     */
    public static function fixClock(Db $db, string $clock): void
    {
        $t = preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/D', $clock) === 1
            ? \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s.u', $clock, new \DateTimeZone('UTC'))
            : false;
        if ($t === false || $t->format('Y-m-d H:i:s.u') !== $clock) {
            throw new \InvalidArgumentException('fixClock needs a YYYY-MM-DD HH:MM:SS.ffffff clock');
        }
        (\Closure::bind(static function (Db $db) use ($t): void {
            $db->state->fixedClock = $t;
        }, null, Db::class))($db);
    }
}
