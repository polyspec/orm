import type { CompilerApi } from './typescript.mjs';

type RuntimeCompilerApi = typeof import('./typescript/node_modules/typescript/lib/typescript.js');
type SameType<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
type Assert<T extends true> = T;
const compilerApiTypesMatch: Assert<SameType<CompilerApi, RuntimeCompilerApi>> = true;
void compilerApiTypesMatch;
