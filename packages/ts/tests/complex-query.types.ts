import { Product, ProductBrandLang, ProductLang } from '../src/models/complex_query/models.js';

export function fulltextChains(product: Product, brand: ProductBrandLang, language: ProductLang, keyword: string): void {
  product.fulltextBooleanNameWithShortDescriptionWithContent(keyword);
  brand.fulltextBooleanNameWithDescription(keyword);
  language.fulltextBooleanNameWithShortDescriptionWithContent(keyword);
  // @ts-expect-error the full-text chain rejects a non-text column
  product.fulltextBooleanServiceSeq(keyword);
}
