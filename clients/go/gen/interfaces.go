// Code generated from contracts/interfaces.json; DO NOT EDIT.
package gen

import (
	"context"
	"github.com/polyspec/orm/clients/go/orm"
	"time"
)

var _ context.Context
var _ time.Time

type BattleInterface interface {
	Get() (*BattleRow, error)
	Gets() (*orm.Collection[BattleRow], error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[BattleRow], error)
	Insert() (*BattleRow, error)
	Save() (*BattleRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ctx context.Context, ex orm.Exec) *BattleQuery
	Paginate(page, per int) (*orm.Page[BattleRow], error)
	GetsBySeq(v int64) (*orm.Collection[BattleRow], error)
	GetsByName(v string) (*orm.Collection[BattleRow], error)
	GetsByDescription(v string) (*orm.Collection[BattleRow], error)
	GetsByCreatedTs(v time.Time) (*orm.Collection[BattleRow], error)
	GetsByUpdatedTs(v time.Time) (*orm.Collection[BattleRow], error)
	GetsByIsClose(v bool) (*orm.Collection[BattleRow], error)
	GetsByIsDisplay(v bool) (*orm.Collection[BattleRow], error)
	GetsByDisplayStartDt(v time.Time) (*orm.Collection[BattleRow], error)
	GetsByDisplayEndDt(v time.Time) (*orm.Collection[BattleRow], error)
	GetsByIsAllday(v bool) (*orm.Collection[BattleRow], error)
	GetsByTargetTeamPlayerCount(v int64) (*orm.Collection[BattleRow], error)
	GetsBySuccessCount(v int64) (*orm.Collection[BattleRow], error)
	GetsByPlayerCount(v int64) (*orm.Collection[BattleRow], error)
	GetsByReadCount(v int64) (*orm.Collection[BattleRow], error)
	GetsByCoverUrl(v string) (*orm.Collection[BattleRow], error)
	GetsByUserSeq(v int64) (*orm.Collection[BattleRow], error)
	GetsByServiceSeq(v int64) (*orm.Collection[BattleRow], error)
	GetsByServiceModuleSeq(v int64) (*orm.Collection[BattleRow], error)
	GetsByServiceMemberSeq(v int64) (*orm.Collection[BattleRow], error)
	GetsByStartDt(v time.Time) (*orm.Collection[BattleRow], error)
	GetsByEndDt(v time.Time) (*orm.Collection[BattleRow], error)
	GetsByUuid(v string) (*orm.Collection[BattleRow], error)
	GetsByIsSinglePlay(v bool) (*orm.Collection[BattleRow], error)
	GetsByLikeCount(v int64) (*orm.Collection[BattleRow], error)
	GetsByAesKeyVersion(v int32) (*orm.Collection[BattleRow], error)
	GetsByAesHexEmail(v string) (*orm.Collection[BattleRow], error)
	GetsByAesHexPhone(v string) (*orm.Collection[BattleRow], error)
	GetsByPrice(v float64) (*orm.Collection[BattleRow], error)
	GetsByIp(v string) (*orm.Collection[BattleRow], error)
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
	GetCountByTargetTeamPlayerCount(v int64) (int64, error)
	GetCountBySuccessCount(v int64) (int64, error)
	GetCountByPlayerCount(v int64) (int64, error)
	GetCountByReadCount(v int64) (int64, error)
	GetCountByCoverUrl(v string) (int64, error)
	GetCountByUserSeq(v int64) (int64, error)
	GetCountByServiceSeq(v int64) (int64, error)
	GetCountByServiceModuleSeq(v int64) (int64, error)
	GetCountByServiceMemberSeq(v int64) (int64, error)
	GetCountByStartDt(v time.Time) (int64, error)
	GetCountByEndDt(v time.Time) (int64, error)
	GetCountByUuid(v string) (int64, error)
	GetCountByIsSinglePlay(v bool) (int64, error)
	GetCountByLikeCount(v int64) (int64, error)
	GetCountByAesKeyVersion(v int32) (int64, error)
	GetCountByAesHexEmail(v string) (int64, error)
	GetCountByAesHexPhone(v string) (int64, error)
	GetCountByPrice(v float64) (int64, error)
	GetCountByIp(v string) (int64, error)
	SeqEq(v int64) *BattleQuery
	NameEq(v string) *BattleQuery
	DescriptionEq(v string) *BattleQuery
	CreatedTsEq(v time.Time) *BattleQuery
	UpdatedTsEq(v time.Time) *BattleQuery
	IsCloseEq(v bool) *BattleQuery
	IsDisplayEq(v bool) *BattleQuery
	DisplayStartDtEq(v time.Time) *BattleQuery
	DisplayEndDtEq(v time.Time) *BattleQuery
	IsAlldayEq(v bool) *BattleQuery
	TargetTeamPlayerCountEq(v int64) *BattleQuery
	SuccessCountEq(v int64) *BattleQuery
	PlayerCountEq(v int64) *BattleQuery
	ReadCountEq(v int64) *BattleQuery
	CoverUrlEq(v string) *BattleQuery
	UserSeqEq(v int64) *BattleQuery
	ServiceSeqEq(v int64) *BattleQuery
	ServiceModuleSeqEq(v int64) *BattleQuery
	ServiceMemberSeqEq(v int64) *BattleQuery
	StartDtEq(v time.Time) *BattleQuery
	EndDtEq(v time.Time) *BattleQuery
	UuidEq(v string) *BattleQuery
	IsSinglePlayEq(v bool) *BattleQuery
	LikeCountEq(v int64) *BattleQuery
	AesKeyVersionEq(v int32) *BattleQuery
	AesHexEmailEq(v string) *BattleQuery
	AesHexPhoneEq(v string) *BattleQuery
	PriceEq(v float64) *BattleQuery
	IpEq(v string) *BattleQuery
	Seq(v int64) *BattleQuery
	Name(v string) *BattleQuery
	Description(v string) *BattleQuery
	CreatedTs(v time.Time) *BattleQuery
	UpdatedTs(v time.Time) *BattleQuery
	IsClose(v bool) *BattleQuery
	IsDisplay(v bool) *BattleQuery
	DisplayStartDt(v time.Time) *BattleQuery
	DisplayEndDt(v time.Time) *BattleQuery
	IsAllday(v bool) *BattleQuery
	TargetTeamPlayerCount(v int64) *BattleQuery
	SuccessCount(v int64) *BattleQuery
	PlayerCount(v int64) *BattleQuery
	ReadCount(v int64) *BattleQuery
	CoverUrl(v string) *BattleQuery
	UserSeq(v int64) *BattleQuery
	ServiceSeq(v int64) *BattleQuery
	ServiceModuleSeq(v int64) *BattleQuery
	ServiceMemberSeq(v int64) *BattleQuery
	StartDt(v time.Time) *BattleQuery
	EndDt(v time.Time) *BattleQuery
	Uuid(v string) *BattleQuery
	IsSinglePlay(v bool) *BattleQuery
	LikeCount(v int64) *BattleQuery
	AesKeyVersion(v int32) *BattleQuery
	AesHexEmail(v string) *BattleQuery
	AesHexPhone(v string) *BattleQuery
	Price(v float64) *BattleQuery
	Ip(v string) *BattleQuery
}

var _ BattleInterface = (*BattleQuery)(nil)

type BattleRowInterface interface {
	Using(ctx context.Context, ex orm.Exec) *BattleRow
	Update() error
	UpdateOptimistic() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ BattleRowInterface = (*BattleRow)(nil)

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

type ServiceModuleInterface interface {
	Get() (*ServiceModuleRow, error)
	Gets() (*orm.Collection[ServiceModuleRow], error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[ServiceModuleRow], error)
	Insert() (*ServiceModuleRow, error)
	Save() (*ServiceModuleRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ctx context.Context, ex orm.Exec) *ServiceModuleQuery
	Paginate(page, per int) (*orm.Page[ServiceModuleRow], error)
	GetsBySeq(v int64) (*orm.Collection[ServiceModuleRow], error)
	GetsByServiceSeq(v int64) (*orm.Collection[ServiceModuleRow], error)
	GetsByName(v string) (*orm.Collection[ServiceModuleRow], error)
	GetCountBySeq(v int64) (int64, error)
	GetCountByServiceSeq(v int64) (int64, error)
	GetCountByName(v string) (int64, error)
	SeqEq(v int64) *ServiceModuleQuery
	ServiceSeqEq(v int64) *ServiceModuleQuery
	NameEq(v string) *ServiceModuleQuery
	Seq(v int64) *ServiceModuleQuery
	ServiceSeq(v int64) *ServiceModuleQuery
	Name(v string) *ServiceModuleQuery
}

var _ ServiceModuleInterface = (*ServiceModuleQuery)(nil)

type ServiceModuleRowInterface interface {
	Using(ctx context.Context, ex orm.Exec) *ServiceModuleRow
	Update() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ ServiceModuleRowInterface = (*ServiceModuleRow)(nil)

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
