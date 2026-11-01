<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\StatementEvent;

/** The statement events that a recording subscriber receives, in order, and the events with a negative elapsed time. */
final class RecipeRecording
{
    /** @var list<StatementEvent> */
    public array $events = [];
    /** @var list<string> */
    public array $negative = [];

    public function receive(StatementEvent $e): void
    {
        if ($e->elapsed < 0) {
            $this->negative[] = $e->sql;
        }
        $this->events[] = $e;
    }
}
