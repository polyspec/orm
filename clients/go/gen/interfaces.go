// Code generated from contracts/interfaces.json; DO NOT EDIT.
package gen

import (
	"context"
	"github.com/polyspec/orm/clients/go/orm"
	"time"
)

var _ context.Context
var _ time.Time

type AuthorInterface interface {
	Get() (*AuthorRow, error)
	Gets() (*orm.Collection[AuthorRow], error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[AuthorRow], error)
	Insert() (*AuthorRow, error)
	Save() (*AuthorRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ctx context.Context, ex orm.Exec) *AuthorQuery
	Paginate(page, per int) (*orm.Page[AuthorRow], error)
	GetsBySeq(v int64) (*orm.Collection[AuthorRow], error)
	GetsByName(v string) (*orm.Collection[AuthorRow], error)
	GetsByDescription(v string) (*orm.Collection[AuthorRow], error)
	GetsByCreatedTs(v time.Time) (*orm.Collection[AuthorRow], error)
	GetsByUpdatedTs(v time.Time) (*orm.Collection[AuthorRow], error)
	GetsByIsClose(v bool) (*orm.Collection[AuthorRow], error)
	GetsByIsDisplay(v bool) (*orm.Collection[AuthorRow], error)
	GetsByDisplayStartDt(v time.Time) (*orm.Collection[AuthorRow], error)
	GetsByDisplayEndDt(v time.Time) (*orm.Collection[AuthorRow], error)
	GetsByIsAllday(v bool) (*orm.Collection[AuthorRow], error)
	GetsByTargetClubReaderCount(v int64) (*orm.Collection[AuthorRow], error)
	GetsBySuccessCount(v int64) (*orm.Collection[AuthorRow], error)
	GetsByReaderCount(v int64) (*orm.Collection[AuthorRow], error)
	GetsByReadCount(v int64) (*orm.Collection[AuthorRow], error)
	GetsByPhotoUrl(v string) (*orm.Collection[AuthorRow], error)
	GetsByUserSeq(v int64) (*orm.Collection[AuthorRow], error)
	GetsByServiceSeq(v int64) (*orm.Collection[AuthorRow], error)
	GetsByServiceRegionSeq(v int64) (*orm.Collection[AuthorRow], error)
	GetsByServiceMemberSeq(v int64) (*orm.Collection[AuthorRow], error)
	GetsByStartDt(v time.Time) (*orm.Collection[AuthorRow], error)
	GetsByEndDt(v time.Time) (*orm.Collection[AuthorRow], error)
	GetsByUuid(v string) (*orm.Collection[AuthorRow], error)
	GetsByIsSingleWork(v bool) (*orm.Collection[AuthorRow], error)
	GetsByLikeCount(v int64) (*orm.Collection[AuthorRow], error)
	GetsByAesHexEmail(v string) (*orm.Collection[AuthorRow], error)
	GetsByAesHexPhone(v string) (*orm.Collection[AuthorRow], error)
	GetsByPrice(v float64) (*orm.Collection[AuthorRow], error)
	GetsByIp(v string) (*orm.Collection[AuthorRow], error)
	GetCountBySeq(v int64) (int64, error)
	GetCountByName(v string) (int64, error)
	GetCountByDescription(v string) (int64, error)
	GetCountByCreatedTs(v time.Time) (int64, error)
	GetCountByUpdatedTs(v time.Time) (int64, error)
	GetCountByIsClose(v bool) (int64, error)
	GetCountByIsDisplay(v bool) (int64, error)
	GetCountByDisplayStartDt(v time.Time) (int64, error)
	GetCountByDisplayEndDt(v time.Time) (int64, error)
	GetCountByIsAllday(v bool) (int64, error)
	GetCountByTargetClubReaderCount(v int64) (int64, error)
	GetCountBySuccessCount(v int64) (int64, error)
	GetCountByReaderCount(v int64) (int64, error)
	GetCountByReadCount(v int64) (int64, error)
	GetCountByPhotoUrl(v string) (int64, error)
	GetCountByUserSeq(v int64) (int64, error)
	GetCountByServiceSeq(v int64) (int64, error)
	GetCountByServiceRegionSeq(v int64) (int64, error)
	GetCountByServiceMemberSeq(v int64) (int64, error)
	GetCountByStartDt(v time.Time) (int64, error)
	GetCountByEndDt(v time.Time) (int64, error)
	GetCountByUuid(v string) (int64, error)
	GetCountByIsSingleWork(v bool) (int64, error)
	GetCountByLikeCount(v int64) (int64, error)
	GetCountByAesHexEmail(v string) (int64, error)
	GetCountByAesHexPhone(v string) (int64, error)
	GetCountByPrice(v float64) (int64, error)
	GetCountByIp(v string) (int64, error)
	SeqEq(v int64) *AuthorQuery
	NameEq(v string) *AuthorQuery
	DescriptionEq(v string) *AuthorQuery
	CreatedTsEq(v time.Time) *AuthorQuery
	UpdatedTsEq(v time.Time) *AuthorQuery
	IsCloseEq(v bool) *AuthorQuery
	IsDisplayEq(v bool) *AuthorQuery
	DisplayStartDtEq(v time.Time) *AuthorQuery
	DisplayEndDtEq(v time.Time) *AuthorQuery
	IsAlldayEq(v bool) *AuthorQuery
	TargetClubReaderCountEq(v int64) *AuthorQuery
	SuccessCountEq(v int64) *AuthorQuery
	ReaderCountEq(v int64) *AuthorQuery
	ReadCountEq(v int64) *AuthorQuery
	PhotoUrlEq(v string) *AuthorQuery
	UserSeqEq(v int64) *AuthorQuery
	ServiceSeqEq(v int64) *AuthorQuery
	ServiceRegionSeqEq(v int64) *AuthorQuery
	ServiceMemberSeqEq(v int64) *AuthorQuery
	StartDtEq(v time.Time) *AuthorQuery
	EndDtEq(v time.Time) *AuthorQuery
	UuidEq(v string) *AuthorQuery
	IsSingleWorkEq(v bool) *AuthorQuery
	LikeCountEq(v int64) *AuthorQuery
	AesHexEmailEq(v string) *AuthorQuery
	AesHexPhoneEq(v string) *AuthorQuery
	PriceEq(v float64) *AuthorQuery
	IpEq(v string) *AuthorQuery
	Seq(v int64) *AuthorQuery
	Name(v string) *AuthorQuery
	Description(v string) *AuthorQuery
	CreatedTs(v time.Time) *AuthorQuery
	UpdatedTs(v time.Time) *AuthorQuery
	IsClose(v bool) *AuthorQuery
	IsDisplay(v bool) *AuthorQuery
	DisplayStartDt(v time.Time) *AuthorQuery
	DisplayEndDt(v time.Time) *AuthorQuery
	IsAllday(v bool) *AuthorQuery
	TargetClubReaderCount(v int64) *AuthorQuery
	SuccessCount(v int64) *AuthorQuery
	ReaderCount(v int64) *AuthorQuery
	ReadCount(v int64) *AuthorQuery
	PhotoUrl(v string) *AuthorQuery
	UserSeq(v int64) *AuthorQuery
	ServiceSeq(v int64) *AuthorQuery
	ServiceRegionSeq(v int64) *AuthorQuery
	ServiceMemberSeq(v int64) *AuthorQuery
	StartDt(v time.Time) *AuthorQuery
	EndDt(v time.Time) *AuthorQuery
	Uuid(v string) *AuthorQuery
	IsSingleWork(v bool) *AuthorQuery
	LikeCount(v int64) *AuthorQuery
	AesHexEmail(v string) *AuthorQuery
	AesHexPhone(v string) *AuthorQuery
	Price(v float64) *AuthorQuery
	Ip(v string) *AuthorQuery
}

var _ AuthorInterface = (*AuthorQuery)(nil)

type AuthorRowInterface interface {
	Using(ctx context.Context, ex orm.Exec) *AuthorRow
	Update() error
	UpdateOptimistic() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ AuthorRowInterface = (*AuthorRow)(nil)

type UserInterface interface {
	Get() (*UserRow, error)
	Gets() (*orm.Collection[UserRow], error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[UserRow], error)
	Insert() (*UserRow, error)
	Save() (*UserRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ctx context.Context, ex orm.Exec) *UserQuery
	Paginate(page, per int) (*orm.Page[UserRow], error)
	GetsBySeq(v int64) (*orm.Collection[UserRow], error)
	GetsByName(v string) (*orm.Collection[UserRow], error)
	GetCountBySeq(v int64) (int64, error)
	GetCountByName(v string) (int64, error)
	SeqEq(v int64) *UserQuery
	NameEq(v string) *UserQuery
	Seq(v int64) *UserQuery
	Name(v string) *UserQuery
}

var _ UserInterface = (*UserQuery)(nil)

type UserRowInterface interface {
	Using(ctx context.Context, ex orm.Exec) *UserRow
	Update() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ UserRowInterface = (*UserRow)(nil)

type ServiceInterface interface {
	Get() (*ServiceRow, error)
	Gets() (*orm.Collection[ServiceRow], error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[ServiceRow], error)
	Insert() (*ServiceRow, error)
	Save() (*ServiceRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ctx context.Context, ex orm.Exec) *ServiceQuery
	Paginate(page, per int) (*orm.Page[ServiceRow], error)
	GetsBySeq(v int64) (*orm.Collection[ServiceRow], error)
	GetsByName(v string) (*orm.Collection[ServiceRow], error)
	GetCountBySeq(v int64) (int64, error)
	GetCountByName(v string) (int64, error)
	SeqEq(v int64) *ServiceQuery
	NameEq(v string) *ServiceQuery
	Seq(v int64) *ServiceQuery
	Name(v string) *ServiceQuery
}

var _ ServiceInterface = (*ServiceQuery)(nil)

type ServiceRowInterface interface {
	Using(ctx context.Context, ex orm.Exec) *ServiceRow
	Update() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ ServiceRowInterface = (*ServiceRow)(nil)

type ServiceRegionInterface interface {
	Get() (*ServiceRegionRow, error)
	Gets() (*orm.Collection[ServiceRegionRow], error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[ServiceRegionRow], error)
	Insert() (*ServiceRegionRow, error)
	Save() (*ServiceRegionRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ctx context.Context, ex orm.Exec) *ServiceRegionQuery
	Paginate(page, per int) (*orm.Page[ServiceRegionRow], error)
	GetsBySeq(v int64) (*orm.Collection[ServiceRegionRow], error)
	GetsByServiceSeq(v int64) (*orm.Collection[ServiceRegionRow], error)
	GetsByName(v string) (*orm.Collection[ServiceRegionRow], error)
	GetCountBySeq(v int64) (int64, error)
	GetCountByServiceSeq(v int64) (int64, error)
	GetCountByName(v string) (int64, error)
	SeqEq(v int64) *ServiceRegionQuery
	ServiceSeqEq(v int64) *ServiceRegionQuery
	NameEq(v string) *ServiceRegionQuery
	Seq(v int64) *ServiceRegionQuery
	ServiceSeq(v int64) *ServiceRegionQuery
	Name(v string) *ServiceRegionQuery
}

var _ ServiceRegionInterface = (*ServiceRegionQuery)(nil)

type ServiceRegionRowInterface interface {
	Using(ctx context.Context, ex orm.Exec) *ServiceRegionRow
	Update() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ ServiceRegionRowInterface = (*ServiceRegionRow)(nil)

type ServiceMemberInterface interface {
	Get() (*ServiceMemberRow, error)
	Gets() (*orm.Collection[ServiceMemberRow], error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[ServiceMemberRow], error)
	Insert() (*ServiceMemberRow, error)
	Save() (*ServiceMemberRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ctx context.Context, ex orm.Exec) *ServiceMemberQuery
	Paginate(page, per int) (*orm.Page[ServiceMemberRow], error)
	GetsBySeq(v int64) (*orm.Collection[ServiceMemberRow], error)
	GetsByServiceSeq(v int64) (*orm.Collection[ServiceMemberRow], error)
	GetsByUserSeq(v int64) (*orm.Collection[ServiceMemberRow], error)
	GetCountBySeq(v int64) (int64, error)
	GetCountByServiceSeq(v int64) (int64, error)
	GetCountByUserSeq(v int64) (int64, error)
	SeqEq(v int64) *ServiceMemberQuery
	ServiceSeqEq(v int64) *ServiceMemberQuery
	UserSeqEq(v int64) *ServiceMemberQuery
	Seq(v int64) *ServiceMemberQuery
	ServiceSeq(v int64) *ServiceMemberQuery
	UserSeq(v int64) *ServiceMemberQuery
}

var _ ServiceMemberInterface = (*ServiceMemberQuery)(nil)

type ServiceMemberRowInterface interface {
	Using(ctx context.Context, ex orm.Exec) *ServiceMemberRow
	Update() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ ServiceMemberRowInterface = (*ServiceMemberRow)(nil)
