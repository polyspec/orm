import {
  OrderProductItem, Product, ProductBrand, ProductBrandLang, ProductLang, ProductMatchCategory, ProductReview, User,
} from '../src/models/complex_query/models.js';

export function complexQueryRequest(keyword: string, categorySeqs: readonly number[]): Product {
  const category = new ProductMatchCategory().removeAllColumns().addColumnProductSeq().serviceRegionCategoryItemSeq(categorySeqs);
  const brandLang = new ProductBrandLang().removeAllColumns().addColumnProductBrandSeq().fulltextBooleanNameWithDescription(keyword);
  const lang = new ProductLang().removeAllColumns().addColumnProductSeq().fulltextBooleanNameWithShortDescriptionWithContent(keyword);
  return new Product()
    .relation(new ProductLang().matchSeqWithProductSeq().langId(1).parentNode())
    .relation(new ProductBrand().matchProductBrandSeqWithSeq().aliasBrand()
      .relation(new ProductBrandLang().matchSeqWithProductBrandSeq().langId(1).parentNode()))
    .relations(new ProductReview().matchSeqWithProductSeq().aliasReviews().isClose(false).orderBySeqDesc().groupLimit(3).keyNameSeq()
      .relation(new User().matchUserSeqWithSeq().aliasUser().removeAllColumns().addColumnName().addColumnProfileUrl()))
    .relation(new OrderProductItem().matchSeqWithProductSeq().aliasMyOrderItem().serviceMemberSeq(77).andIsClose(false).orderBySeqDesc().groupLimit(1))
    .seq(category)
    .serviceSeq(7).andIsClose(false).andIsDisplay(true)
    .and(q => q.isAllday(true).or(q => q.isAllday(false).andLeDisplayStartDt(new Date()).andGeDisplayEndDt(new Date())))
    .and(q => q.fulltextBooleanNameWithShortDescriptionWithContent(keyword)
      .or(q => q.productBrandSeq(brandLang))
      .or(q => q.seq(lang)))
    .orderByLikeCountDescAndSeqDesc();
}
