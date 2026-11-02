// Requirements: COD-31, DBS-113, INT-101, INT-102, INT-103, INT-104, INT-106, INT-108, INT-109, INT-110, INT-111, INT-112, INT-113, INT-114, INT-115, INT-117, INT-123, INT-136, INT-4, INT-8, INT-97, SCH-3, SCH-5, SCH-6, SCH-6a
// Requirements: DBS-113, INT-34, INT-102, INT-106, INT-108, INT-110, INT-112, SCH-5.
// The suite unit catalog_connection-sqlite (docs/spec/feature-coverage.md FCV-3).
import { runRecipe } from './recipe.mjs';

await runRecipe('contracts/fixtures/catalog_connection/catalog_connection.json', 'sqlite');
