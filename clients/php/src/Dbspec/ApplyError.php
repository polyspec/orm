<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * A failure of apply or recover (docs/plans.md "Apply"). The code is locked,
 * interrupted, drift, chain, failed or verify; `plan` is empty when no plan
 * is named, `step` is the statement index of failed and interrupted, and
 * the previous throwable is the database or verification error.
 */
final class ApplyError extends \RuntimeException
{
    public function __construct(
        public readonly string $code_,
        public readonly string $plan,
        public readonly int $step,
        public readonly string $detail,
        ?\Throwable $previous = null,
    ) {
        $message = $code_;
        if ($plan !== '') {
            $message .= " $plan";
        }
        if ($code_ === 'failed' || $code_ === 'interrupted') {
            $message .= " at step $step";
        }
        if ($detail !== '') {
            $message .= ": $detail";
        }
        if ($previous !== null) {
            $message .= ': ' . $previous->getMessage();
        }
        parent::__construct($message, 0, $previous);
    }
}
