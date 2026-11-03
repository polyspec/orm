// Requirements: COD-8, PLN-44, INT-60, INT-75, INT-131.
// Recipe conversion of the AES rotation: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit aes_rotation-postgres.
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/aes_rotation/aes_rotation.json', 'postgres');
