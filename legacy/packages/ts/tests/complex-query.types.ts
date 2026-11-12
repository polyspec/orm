import { Product, ProductBrandLang, ProductLang, ProductMatchCategory } from '../src/models/complex_query/models.js';

export function fulltextChains(product: Product, brand: ProductBrandLang, language: ProductLang, keyword: string): void {
  product.fulltextBooleanNameWithShortDescriptionWithContent(keyword);
  brand.fulltextBooleanNameWithDescription(keyword);
  language.fulltextBooleanNameWithShortDescriptionWithContent(keyword);
}

type Assert<T extends true> = T;
export type ProductFulltextRejectsInteger = Assert<'fulltextBooleanServiceSeq' extends keyof Product ? false : true>;

export function complexQuerySubqueries(keyword: string): void {
  const category = new ProductMatchCategory().removeAllColumns().addColumnProductSeq().serviceRegionCategoryItemSeq([11, 12]);
  const brand = new ProductBrandLang().removeAllColumns().addColumnProductBrandSeq().fulltextBooleanNameWithDescription(keyword);
  const language = new ProductLang().removeAllColumns().addColumnProductSeq().fulltextBooleanNameWithShortDescriptionWithContent(keyword);
  new Product().seq(category).and(q => q.fulltextBooleanNameWithShortDescriptionWithContent(keyword)
    .or(q => q.productBrandSeq(brand))
    .or(q => q.seq(language)));
}
