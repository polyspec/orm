<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** Parses, validates and canonically emits dbspec documents (docs/dbspec.md). */
final class Dbspec
{
    /**
     * Parses a document. `$documents` is the declared document set, document
     * name => text, in which `use` lines find the documents they name. The
     * result holds the document and no diagnostics, or every diagnostic in
     * source order and no document.
     *
     * @param array<string, string> $documents
     */
    public static function parse(string $text, array $documents): ParseResult
    {
        foreach ($documents as $name => $source) {
            if (!is_string($name) || !is_string($source)) {
                throw new \InvalidArgumentException('The declared document set maps document names to texts');
            }
        }
        [$document, $diagnostics] = (new Parser($documents))->run($text);
        return $document === null ? ParseResult::invalid($diagnostics) : ParseResult::valid($document);
    }

    /** Writes a document in its canonical text: `emit(parse(s)) === s` for canonical input. */
    public static function emit(Document $document): string
    {
        return Emitter::emit($document);
    }
}
