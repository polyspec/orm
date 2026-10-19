// The token classes of syntax analysis in the order of their table in docs/spec/dbspec.md "Syntax analysis": the legend of
// the language server's semantic tokens (docs/spec/editor.md "Results").
import type { DbspecTokenClass } from '@polyspec/orm/dbspec';

export const TOKEN_CLASSES = ['keyword', 'type', 'name', 'setting', 'number', 'string', 'operator', 'punctuation', 'comment', 'word'] as const satisfies readonly DbspecTokenClass[];

// Every class of the parser is in the list: a class added to DbspecTokenClass and not here fails the build.
type Missing = Exclude<DbspecTokenClass, (typeof TOKEN_CLASSES)[number]>;
const complete: [Missing] extends [never] ? true : Missing = true;
void complete;
