<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Internal\MarkdownPdoAdapter;
use Polyspec\Orm\Internal\MarkdownStatementAdapter;
use Polyspec\Orm\MarkdownSession;

#[Small]
final class MarkdownNativeTest extends TestCase
{
    /**
     * A markdown connection is a SQLite connection whose PDO handle sends each statement as a statement message of its
     * flowmark session (DIA-185): the session and the handle and its statements are native classes of the extension.
     */
    public function testMarkdownSessionAndPdoAdapterAreNative(): void
    {
        foreach ([MarkdownSession::class, MarkdownPdoAdapter::class, MarkdownStatementAdapter::class] as $class) {
            $reflection = new \ReflectionClass($class);
            self::assertTrue($reflection->isInternal(), $class);
            self::assertSame('polyspec_orm', $reflection->getExtensionName(), $class);
            self::assertTrue($reflection->isFinal(), $class);
        }
        self::assertSame(\PDO::class, get_parent_class(MarkdownPdoAdapter::class));
        self::assertSame(\PDOStatement::class, get_parent_class(MarkdownStatementAdapter::class));

        $session = new \ReflectionClass(MarkdownSession::class);
        self::assertTrue($session->getConstructor()->isPrivate());
        foreach (['dial', 'call', 'statement', 'fetch', 'closeRows', 'broken', 'shutdown', 'close'] as $method) {
            self::assertTrue($session->getMethod($method)->isInternal(), 'MarkdownSession::' . $method);
        }
        foreach (['run', 'fetchRows', 'closeRows', 'close', 'shutdown', 'abandon', 'prepare', 'exec'] as $method) {
            self::assertTrue(
                (new \ReflectionMethod(MarkdownPdoAdapter::class, $method))->isInternal(),
                'MarkdownPdoAdapter::' . $method,
            );
        }
        self::assertFalse(class_exists('Polyspec\\Orm\\Markdown', false), 'the markdown IR executor is removed');
        self::assertFalse(class_exists('Polyspec\\Orm\\MarkdownLinks', false), 'the markdown IR links are removed');
    }
}
