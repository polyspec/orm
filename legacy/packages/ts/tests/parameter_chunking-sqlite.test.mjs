// Recipe conversion of the parameter chunking: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit parameter_chunking-sqlite.
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/parameter_chunking/parameter_chunking.json', 'sqlite');
