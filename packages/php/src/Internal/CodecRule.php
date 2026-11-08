<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

/**
 * A rule of a codec stage that a value or a stream breaks (docs/spec/codec.md): its message is the rule, which names no
 * value (INT-163), and Codec prefixes it with the stage. A failure of the library a stage reads or writes with is no
 * CodecRule; Codec states its stage text instead and keeps the library failure as the previous exception.
 *
 * @internal
 */
final class CodecRule extends \InvalidArgumentException
{
}
