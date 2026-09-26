import type { Battle } from '../src/models/models.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const getterUsesExactText: Equal<ReturnType<Battle['getPrice']>, string | null> = true;
const setterAcceptsOnlyExactText: Equal<Parameters<Battle['setPrice']>[0], string | null> = true;
void getterUsesExactText;
void setterAcceptsOnlyExactText;
