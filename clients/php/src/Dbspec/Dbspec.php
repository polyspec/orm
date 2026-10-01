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
        return Emitter::emit($document, View::Canonical);
    }

    /**
     * The statements that create the tables of the document set in one
     * dialect, `mysql`, `postgres` or `sqlite` (docs/dialects.md "Rendered
     * statements"). The documents are valid parsed documents of one declared
     * set; an unknown dialect is an InvalidArgumentException.
     *
     * @param list<Document> $documents
     * @return list<string>
     */
    public static function render(array $documents, string $dialect): array
    {
        return Renderer::render($documents, $dialect);
    }

    /**
     * The manifest of the document set, whose documents are taken in document
     * name order. A document name that repeats in the set is a name.duplicate
     * diagnostic at the header name of the later document.
     *
     * @param list<Document> $documents
     */
    public static function manifest(array $documents): ManifestResult
    {
        usort($documents, static fn(Document $a, Document $b): int => strcmp($a->name, $b->name));
        $manifestText = '';
        $schemaText = '';
        foreach ($documents as $i => $document) {
            if ($i > 0 && $documents[$i - 1]->name === $document->name) {
                return ManifestResult::invalid([new Diagnostic('name.duplicate', 1, strlen('dbspec 1 ') + 1, "document {$document->name} appears twice in the document set")]);
            }
            $manifestText .= Emitter::emit($document, View::Manifest);
            $schemaText .= Emitter::emit($document, View::Schema);
        }
        return ManifestResult::valid(new Manifest($manifestText, $schemaText, 'sha256:' . hash('sha256', $manifestText), 'sha256:' . hash('sha256', $schemaText)));
    }
}
