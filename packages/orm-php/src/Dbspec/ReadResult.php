<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * Dbspec::readFile의 결과: diagnostic 없는 파일 text, 또는 text 없는 signature
 * diagnostic이며 둘을 함께 갖지 않는다.
 */
final readonly class ReadResult
{
    /** @param list<Diagnostic> $diagnostics */
    private function __construct(public ?string $text, public array $diagnostics)
    {
    }

    public static function valid(string $text): self
    {
        return new self($text, []);
    }

    /** @param non-empty-list<Diagnostic> $diagnostics */
    public static function invalid(array $diagnostics): self
    {
        if ($diagnostics === []) {
            throw new \LogicException('An invalid read result needs a diagnostic');
        }
        return new self(null, $diagnostics);
    }
}
