// Requirements: COD-11, COD-12, COD-15, COD-38, DIA-26, DSL-104, DSL-107, INT-35, PRT-41, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
// The suite unit model_writes_chain-postgres (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/model_writes_chain/model_writes_chain.json', 'postgres');
