<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * A failure of apply or recover (docs/spec/plans.md "Apply"). The code is locked,
 * session, interrupted, drift, chain, failed, irreversible, nulls or verify; `plan` is
 * empty when no plan is named, `step` is the statement index of failed, interrupted,
 * irreversible, nulls and a session error before a step, and the previous throwable is
 * the database or verification error.
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
        if (
            in_array($code_, ['failed', 'interrupted', 'irreversible', 'nulls'], true)
            || ($code_ === 'session' && $plan !== '')
        ) {
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
