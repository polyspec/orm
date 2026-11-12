<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDO;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\StatementEvent;

/** A SQLite Db of a test with the statement events that it published since it was opened. */
final class StatementEventLog
{
    /** @var list<StatementEvent> */
    public array $events = [];

    public readonly Db $db;

    private readonly \Closure $unsubscribe;

    public function __construct(PDO $pdo)
    {
        $this->db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $this->unsubscribe = $this->db->subscribe(function (StatementEvent $event): void {
            $this->events[] = $event;
        });
    }

    /** Ends the recording and closes the Db. */
    public function close(): void
    {
        ($this->unsubscribe)();
        $this->db->close();
    }
}
