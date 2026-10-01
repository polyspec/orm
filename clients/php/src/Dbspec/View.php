<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * What an emission writes: the canonical text, the manifest text without
 * comments and diagrams, or the schema text that also keeps only the schema
 * settings (docs/dbspec.md, "Manifest and hashes").
 *
 * @internal
 */
enum View
{
    case Canonical;
    case Manifest;
    case Schema;
}
