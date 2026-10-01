<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** `use <document> { <table>, ... }`: tables of another document available as foreign key targets. */
final class UseLine
{
    /**
     * @param list<string> $tables
     * @param list<string> $comments
     */
    public function __construct(public string $document, public array $tables, public array $comments = [])
    {
    }
}
