<?php
declare(strict_types=1);
/*
 * contracts/fixtures/ir_answers.json의 case마다 그 chain(tests/markdown/cases.json의 case)을 실행한다: flowmark server
 * 대신 markdown_fake_server.php가 connect에 {"ok":true}, chain의 request 하나에 case의 answer를 쓰고, chain의 결과가
 * expect와 같은지 본다(docs/protocol.md §5 Read). flowmark는 필요 없다.
 *
 * Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/IrAnswersTest.php
 */
require_once __DIR__ . '/MarkdownTest.php';
require_once __DIR__ . '/MarkdownConformanceTest.php';

use Polyspec\Orm\Config;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class IrAnswersTest extends TestCase
{
    /** @return iterable<string, array{array{id: string, chain: string, answer: mixed, expect: mixed}}> */
    public static function cases(): iterable
    {
        $doc = json_decode((string) file_get_contents(__DIR__ . '/../../../contracts/fixtures/ir_answers.json'), true, 512, JSON_THROW_ON_ERROR);
        foreach ($doc['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    /** @param array{id: string, chain: string, answer: mixed, expect: mixed} $case */
    #[DataProvider('cases')]
    public function test_ir_answer(array $case): void
    {
        $chain = MarkdownConformanceTest::conformance_cases()[$case['chain']] ?? null;
        self::assertNotNull($chain, "chain {$case['chain']} is no markdown conformance case");
        $server = markdown_fake_server(['{"ok":true}', json_encode($case['answer'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION)]);
        $served = new Served();
        $served->db = \Polyspec\Orm\Tests\MarkdownModel\connect($server[2], new Config());
        $error = null;
        try {
            $got = $chain($served);
        } catch (OrmException $e) {
            $error = $e;
            $got = ['error' => $e->code_];
        } finally {
            $served->db->close();
            markdown_received($server);
        }
        $actual = MarkdownConformanceTest::normalize($got);
        $expect = MarkdownConformanceTest::normalize($case['expect']);
        $detail = $error === null ? '' : " (error {$error->code_}: {$error->getMessage()})";
        self::assertSame($expect, $actual, "{$case['id']}: got " . MarkdownConformanceTest::json_text($actual) . ', want ' . MarkdownConformanceTest::json_text($expect) . $detail);
    }
}
