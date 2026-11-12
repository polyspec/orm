// The drop of a case database on MySQL (docs/spec/dialects.md DIA-212, DIA-200): the case of dropDiscardsItsSession of
// case-database.mjs.
import { dropDiscardsItsSession } from './case-database.mjs';

dropDiscardsItsSession('mysql');
