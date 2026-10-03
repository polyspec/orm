<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * Checks the parsed documents of one set (docs/dbspec.md "Manifest and
 * hashes"): a repeated document name, a used document missing from the set
 * and an external document that no owned document reaches through `use` are
 * diagnostics at the header name.
 *
 * @internal
 */
final class DocumentSet
{
    /**
     * The documents in document name order and the diagnostics of the set.
     *
     * @param list<Document> $documents
     * @return array{list<Document>, list<Diagnostic>}
     */
    public static function check(array $documents): array
    {
        usort($documents, static fn(Document $a, Document $b): int => strcmp($a->name, $b->name));
        $names = [];
        foreach ($documents as $document) {
            $names[$document->name] = true;
        }
        $header = strlen('dbspec 1 ') + 1;
        $diagnostics = [];
        foreach ($documents as $i => $document) {
            if ($i > 0 && $documents[$i - 1]->name === $document->name) {
                $diagnostics[] = new Diagnostic('name.duplicate', 1, $header, "document {$document->name} appears twice in the document set");
            }
            $used = array_map(static fn(UseLine $u): string => $u->document, $document->uses);
            usort($used, strcmp(...));
            foreach ($used as $name) {
                if (!isset($names[$name])) {
                    $diagnostics[] = new Diagnostic('use', 1, $header, "document {$document->name} uses $name, which is not in the document set");
                }
            }
        }
        // 외부 문서는 소유한 문서에서 use를 따라 닿는 문서다.
        $byName = [];
        foreach ($documents as $document) {
            $byName[$document->name] ??= $document;
        }
        $reached = [];
        $walk = static function (Document $d) use (&$walk, &$reached, $byName): void {
            foreach ($d->uses as $use) {
                $next = $byName[$use->document] ?? null;
                if ($next !== null && !isset($reached[$next->name])) {
                    $reached[$next->name] = true;
                    $walk($next);
                }
            }
        };
        foreach ($documents as $document) {
            if (!$document->external) {
                $walk($document);
            }
        }
        foreach ($documents as $document) {
            if ($document->external && !isset($reached[$document->name])) {
                $diagnostics[] = new Diagnostic('use', 1, $header, "external document {$document->name} is not used by a document of the set");
            }
        }
        return [$documents, $diagnostics];
    }
}
