// Requirements: COD-7, COD-8, PLN-44, INT-60, INT-75, INT-131.
// Recipe conversion of the AES rotation: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit aes_rotation-markdown.
// INT-152: on flowmark a text stored in an INTEGER or REAL column is a text grid cell; the recipe expects it at step 16 of read_path_codes, rotation_path_codes and stored_version_text. Requirement: INT-152.
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/aes_rotation/aes_rotation.json', 'markdown');
