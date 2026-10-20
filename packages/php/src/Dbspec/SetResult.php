<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The outcome of Dbspec::readSet: the files of `documents` and of `external` in written order and no
 * errors, or the errors by step, then by path, and no files.
 */
final readonly class SetResult
{
    /**
     * @param ?list<SetFile> $documents
     * @param ?list<SetFile> $external
     * @param list<SetError> $errors
     */
    private function __construct(public ?array $documents, public ?array $external, public array $errors)
    {
    }

    /**
     * @param list<SetFile> $documents
     * @param list<SetFile> $external
     */
    public static function valid(array $documents, array $external): SetResult
    {
        return new self($documents, $external, []);
    }

    /** @param non-empty-list<SetError> $errors */
    public static function invalid(array $errors): SetResult
    {
        if ($errors === []) {
            throw new \LogicException('An invalid set result needs an error');
        }
        return new self(null, null, $errors);
    }
}
