// Package complexquery runs the CPX-2 product query against its shared case fixture.
package complexquery

import (
	"github.com/polyspec/orm/packages/go/complexmodel"
	"github.com/polyspec/orm/packages/go/orm"
)

// Input holds the parameters of the common complex-query case.
type Input struct {
	CategorySeqs []int64
	Keyword      string
	LangID       int32
	MemberSeq    int64
	Page         int
	PerPage      int
	ServiceSeq   int64
}

// Search builds and executes the public product search API from docs/spec/complex-query.md.
func Search(db *orm.DB, input Input) (*orm.Page[*complexmodel.ProductModel], error) {
	return searchModel(db, input).GetsPage(input.Page, input.PerPage)
}

func searchModel(db *orm.DB, input Input) *complexmodel.ProductModel {
	category := complexmodel.ProductMatchCategory().RemoveAllColumns().AddColumnProductSeq().ServiceRegionCategoryItemSeq(input.CategorySeqs)
	brandLang := complexmodel.ProductBrandLang().RemoveAllColumns().AddColumnProductBrandSeq().FulltextBooleanNameWithDescription(input.Keyword)
	lang := complexmodel.ProductLang().RemoveAllColumns().AddColumnProductSeq().FulltextBooleanNameWithShortDescriptionWithContent(input.Keyword)

	return complexmodel.Product().Connect(db).
		Relation(complexmodel.ProductLang().MatchSeqWithProductSeq().LangId(input.LangID).ParentNode()).
		Relation(complexmodel.ProductBrand().MatchProductBrandSeqWithSeq().AliasBrand().
			Relation(complexmodel.ProductBrandLang().MatchSeqWithProductBrandSeq().LangId(input.LangID).ParentNode())).
		Relations(complexmodel.ProductReview().MatchSeqWithProductSeq().AliasReviews().
			IsClose(false).OrderBySeqDesc().GroupLimit(3).KeyNameSeq().
			Relation(complexmodel.User().MatchUserSeqWithSeq().AliasUser().
				RemoveAllColumns().AddColumnName().AddColumnProfileUrl())).
		Relation(complexmodel.OrderProductItem().MatchSeqWithProductSeq().AliasMyOrderItem().
			ServiceMemberSeq(input.MemberSeq).AndIsClose(false).OrderBySeqDesc().GroupLimit(1)).
		Seq(category).
		And().ServiceSeq(input.ServiceSeq).AndIsClose(false).AndIsDisplay(true).
		And(func(q *complexmodel.ProductModel) {
			q.IsAllday(true).Or(func(q *complexmodel.ProductModel) {
				q.IsAllday(false).AndLeDisplayStartDt(orm.Now()).AndGeDisplayEndDt(orm.Now())
			})
		}).
		And(func(q *complexmodel.ProductModel) {
			q.FulltextBooleanNameWithShortDescriptionWithContent(input.Keyword)
			q.Or(func(q *complexmodel.ProductModel) { q.ProductBrandSeq(brandLang) })
			q.Or(func(q *complexmodel.ProductModel) { q.Seq(lang) })
		}).
		OrderByLikeCountDescAndSeqDesc()
}
