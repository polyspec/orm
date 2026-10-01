<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** The outcome of Dbspec::manifest: a manifest and no diagnostics, or the diagnostics and no manifest. */
final readonly class ManifestResult
{
    /** @param list<Diagnostic> $diagnostics */
    private function __construct(public ?Manifest $manifest, public array $diagnostics)
    {
    }

    public static function valid(Manifest $manifest): self
    {
        return new self($manifest, []);
    }

    /** @param non-empty-list<Diagnostic> $diagnostics */
    public static function invalid(array $diagnostics): self
    {
        if ($diagnostics === []) {
            throw new \LogicException('An invalid manifest result needs a diagnostic');
        }
        return new self(null, $diagnostics);
    }
}
