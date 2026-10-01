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
     * statements"), or the diagnostics of the set (docs/dbspec.md "Manifest
     * and hashes"). An unknown dialect is an InvalidArgumentException.
     *
     * @param list<Document> $documents
     */
    public static function render(array $documents, string $dialect): RenderResult
    {
        if (!in_array($dialect, Renderer::DIALECTS, true)) {
            throw new \InvalidArgumentException("Unknown dialect `$dialect`; the dialects are mysql, postgres and sqlite");
        }
        [, $diagnostics] = DocumentSet::check($documents);
        return $diagnostics === [] ? RenderResult::valid(Renderer::render($documents, $dialect)) : RenderResult::invalid($diagnostics);
    }

    /**
     * The manifest of the document set, whose documents are taken in document
     * name order, or the diagnostics of the set (docs/dbspec.md "Manifest and
     * hashes").
     *
     * @param list<Document> $documents
     */
    public static function manifest(array $documents): ManifestResult
    {
        [$ordered, $diagnostics] = DocumentSet::check($documents);
        if ($diagnostics !== []) {
            return ManifestResult::invalid($diagnostics);
        }
        $manifestText = '';
        $schemaText = '';
        foreach ($ordered as $document) {
            $manifestText .= Emitter::emit($document, View::Manifest);
            $schemaText .= Emitter::emit($document, View::Schema);
        }
        return ManifestResult::valid(new Manifest($manifestText, $schemaText, 'sha256:' . hash('sha256', $manifestText), 'sha256:' . hash('sha256', $schemaText)));
    }
}
