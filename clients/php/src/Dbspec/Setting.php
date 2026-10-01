<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * One setting line. The kind is one of KINDS, in canonical order; the
 * arguments are the names the line lists: `audit` holds the history table,
 * operation, action and previous columns in that order.
 */
final class Setting
{
    public const KINDS = ['entity', 'updated', 'soft_delete', 'select_explicit', 'codec', 'aes_version', 'blind_index', 'navigation', 'immutable', 'audit'];
    public const CODEC_STAGES = ['ordered_json', 'aes', 'hex', 'gz', 'base64', 'serialize', 'yaml', 'ip'];

    /**
     * @param list<string> $arguments
     * @param list<string> $comments
     */
    public function __construct(public string $kind, public array $arguments, public array $comments = [])
    {
    }
}
