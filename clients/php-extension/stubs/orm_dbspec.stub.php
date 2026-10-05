<?php
declare(strict_types=1);

/*
 * PHP 확장 orm_dbspec이 등록하는 class의 선언이다. 실행 시 load하지 않는다: 확장이 있으면 같은 이름의
 * class를 확장이 등록한다. 선언은 interface 검사(contracts/interfaces.json의 php-extension)의 inventory이고,
 * clients/php-extension/tests/declarations_test.php가 load한 확장의 Reflection과 이 file의 Reflection이
 * 같은지 확인한다. 동작은 docs/dbspec.md의 dbspec 인터페이스이며 Rust client(orm-schema)의 동작이다.
 */

namespace Orm\Dbspec\Native;

/** One SCHEMA_INVALID finding: the rule, the 1-based line and column of the offending token, and a message. */
final readonly class Diagnostic
{
    public string $rule;
    public int $line;
    public int $column;
    public string $message;

    private function __construct()
    {
    }
}

/** One parsed and validated dbspec document. It is immutable; emitting it gives its canonical text. */
final class Document
{
    /** The extension creates documents; constructing one throws an Exception. */
    public function __construct()
    {
    }
}

/** The outcome of Dbspec::readFile and Dbspec::readBytes: the file text and no diagnostics, or the diagnostics and no text. */
final readonly class ReadResult
{
    public ?string $text;
    /** @var list<Diagnostic> */
    public array $diagnostics;

    private function __construct()
    {
    }
}

/** The outcome of Dbspec::parse: a document and no diagnostics, or every diagnostic in source order and no document. */
final readonly class ParseResult
{
    public ?Document $document;
    /** @var list<Diagnostic> */
    public array $diagnostics;

    private function __construct()
    {
    }
}

/** The manifest and schema texts of a document set and their hashes (docs/dbspec.md, "Manifest and hashes"). */
final readonly class Manifest
{
    public string $manifestText;
    public string $schemaText;
    public string $manifestHash;
    public string $schemaHash;
    public string $externalText;

    private function __construct()
    {
    }
}

/** The outcome of Dbspec::manifest: a manifest and no diagnostics, or the diagnostics and no manifest. */
final readonly class ManifestResult
{
    public ?Manifest $manifest;
    /** @var list<Diagnostic> */
    public array $diagnostics;

    private function __construct()
    {
    }
}

/** The outcome of Dbspec::render: the statements and no diagnostics, or the diagnostics and no statements. */
final readonly class RenderResult
{
    /** @var ?list<string> */
    public ?array $statements;
    /** @var list<Diagnostic> */
    public array $diagnostics;

    private function __construct()
    {
    }
}

/** The dbspec interface: reading document files, parsing, canonical emission, the manifest and rendering. */
final class Dbspec
{
    /** The first bytes of every dbspec document file; the header `dbspec 1 <document>` starts with them. */
    public const SIGNATURE = 'dbspec ';

    /** Only the static methods are used; constructing a Dbspec throws an Exception. */
    public function __construct()
    {
    }

    /**
     * Reads a dbspec document file and checks its bytes with readBytes, the path naming the file. A file that
     * cannot be read, a directory included, is a RuntimeException.
     */
    public static function readFile(string $path): ReadResult
    {
    }

    /** Checks the bytes of a document file that the caller read; $name is the name its messages use. */
    public static function readBytes(string $name, string $bytes): ReadResult
    {
    }

    /**
     * Parses and validates the text; $documents maps each other document name of the declared set to its text.
     *
     * @param array<string, string> $documents
     */
    public static function parse(string $text, array $documents): ParseResult
    {
    }

    /** Writes the canonical text of the document: `emit(parse(s)) === s` for canonical input. */
    public static function emit(Document $document): string
    {
    }

    /**
     * The manifest of the document set, whose documents are taken in document name order, or its diagnostics.
     *
     * @param list<Document> $documents
     */
    public static function manifest(array $documents): ManifestResult
    {
    }

    /**
     * The statements that create the tables of the document set in `mysql`, `postgres` or `sqlite`, or the
     * diagnostics of the set. An unknown dialect is an InvalidArgumentException.
     *
     * @param list<Document> $documents
     */
    public static function render(array $documents, string $dialect): RenderResult
    {
    }
}
