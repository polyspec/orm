<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** The `settings { ... }` block of a table. */
final class Settings
{
    /** @var list<Setting> */
    public array $settings = [];
    /** @var list<string> Comment lines before the closing brace. */
    public array $closingComments = [];

    /** @param list<string> $comments */
    public function __construct(public array $comments = [])
    {
    }
}
