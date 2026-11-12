<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

/** A bound subscription: its stop function, and the recording of a recording subscriber (null for one that fails). */
final class RecipeSubscription
{
    public function __construct(public readonly \Closure $stop, public readonly ?RecipeRecording $recording)
    {
    }
}
