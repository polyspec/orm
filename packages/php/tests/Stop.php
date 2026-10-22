<?php

declare(strict_types=1);

/** The error the callback throws to roll back the transaction. */
final class Stop extends RuntimeException
{
}
