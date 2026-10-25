<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Markdown;
use Polyspec\Orm\MarkdownLinks;
use Polyspec\Orm\MarkdownSession;

#[Small]
final class MarkdownNativeTest extends TestCase
{
    public function testMarkdownExecutorClassesAndLinksAreNative(): void
    {
        foreach ([Markdown::class, MarkdownSession::class, MarkdownLinks::class] as $class) {
            $reflection = new \ReflectionClass($class);
            self::assertTrue($reflection->isInternal(), $class);
            self::assertSame('polyspec_orm', $reflection->getExtensionName(), $class);
            self::assertTrue($reflection->isFinal(), $class);
        }

        $session = new \ReflectionClass(MarkdownSession::class);
        self::assertTrue($session->getConstructor()->isPrivate());
        foreach (['dial', 'call', 'close'] as $method) {
            self::assertTrue($session->getMethod($method)->isInternal(), 'MarkdownSession::' . $method);
        }

        foreach (['beginMessage', 'unsupported', 'read', 'scalar', 'write', 'links'] as $method) {
            self::assertTrue((new \ReflectionMethod(Markdown::class, $method))->isInternal(), 'Markdown::' . $method);
        }

        self::assertSame(['op' => 'begin'], Markdown::beginMessage(false));
        self::assertSame(['op' => 'begin', 'read_only' => true], Markdown::beginMessage(true));
        $unsupported = Markdown::unsupported('getQuery');
        self::assertSame(Code::CAPABILITY_UNSUPPORTED, $unsupported->code_);
        self::assertSame(
            'CAPABILITY_UNSUPPORTED: getQuery is not supported by the markdown IR executor',
            $unsupported->getMessage(),
        );

        $links = new MarkdownLinks();
        self::assertSame([], $links->joins);
        self::assertSame([], $links->rels);
        $links->joins = ['author' => ['A1']];
        $links->rels = ['tasks' => [['T1'], ['T2']]];
        self::assertSame(['author' => ['A1']], $links->joins);
        self::assertSame(['tasks' => [['T1'], ['T2']]], $links->rels);
    }
}
