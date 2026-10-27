<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\MarkdownTest;

// Requirements: DIA-183, DIA-184, DIA-185, DIA-188, DIA-189, DIA-31, PRT-64.
// Requirements: PRT-67.
#[\PHPUnit\Framework\Attributes\Large]
final class MarkdownTestExtensionTest extends MarkdownTest
{
    public function testBindMessageVectors(): void
    {
        // In extension mode, exercise the same vectors through the public Markdown request boundary instead of the
        // PHP library's private Markdown::param helper. testPublicBindMessageVectors runs that complete vector set.
        $this->testPublicBindMessageVectors();
    }
}
