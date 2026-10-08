import type { Author } from '../src/models/models.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const getterUsesExactText: Equal<ReturnType<Author['getPrice']>, string | null> = true;
const setterAcceptsOnlyExactText: Equal<Parameters<Author['setPrice']>[0], string | null> = true;
void getterUsesExactText;
void setterAcceptsOnlyExactText;
