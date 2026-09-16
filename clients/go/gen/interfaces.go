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
	GetOrNil() (*AuthorRow, error)
	Gets() (*orm.Collection[AuthorRow], error)
	Stream(visit func(*AuthorRow) bool) (orm.StreamResult, error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[AuthorRow], error)
	AESStatus(keyring orm.AESKeyring) (orm.AESRotationStatus, error)
	RotateAES(keyring orm.AESKeyring) (int, error)
	Insert() (*AuthorRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ex orm.Exec) *AuthorQuery
	Scope(v int64) *AuthorQuery
	Paginate(page, per int) (*orm.Page[AuthorRow], error)
	GetsAfter(cursor string, per int) (*orm.KeysetPage[AuthorRow], error)
	GetsBefore(cursor string, per int) (*orm.KeysetPage[AuthorRow], error)
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
	GetsByAesKeyVersion(v int32) (*orm.Collection[AuthorRow], error)
	GetsByAesHexEmail(v string) (*orm.Collection[AuthorRow], error)
	GetsByEmailBlindIndex(v string) (*orm.Collection[AuthorRow], error)
	GetsByAesHexPhone(v string) (*orm.Collection[AuthorRow], error)
	GetsByPhoneBlindIndex(v string) (*orm.Collection[AuthorRow], error)
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
	GetCountByAesKeyVersion(v int32) (int64, error)
	GetCountByAesHexEmail(v string) (int64, error)
	GetCountByEmailBlindIndex(v string) (int64, error)
	GetCountByAesHexPhone(v string) (int64, error)
	GetCountByPhoneBlindIndex(v string) (int64, error)
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
	AesKeyVersionEq(v int32) *AuthorQuery
	AesHexEmailEq(v string) *AuthorQuery
	EmailBlindIndexEq(v string) *AuthorQuery
	AesHexPhoneEq(v string) *AuthorQuery
	PhoneBlindIndexEq(v string) *AuthorQuery
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
	AesKeyVersion(v int32) *AuthorQuery
	AesHexEmail(v string) *AuthorQuery
	EmailBlindIndex(v string) *AuthorQuery
	AesHexPhone(v string) *AuthorQuery
	PhoneBlindIndex(v string) *AuthorQuery
	Price(v float64) *AuthorQuery
	Ip(v string) *AuthorQuery
}

var _ AuthorInterface = (*AuthorQuery)(nil)

type AuthorRowInterface interface {
	Using(ex orm.Exec) *AuthorRow
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
	GetOrNil() (*UserRow, error)
	Gets() (*orm.Collection[UserRow], error)
	Stream(visit func(*UserRow) bool) (orm.StreamResult, error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[UserRow], error)
	Insert() (*UserRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ex orm.Exec) *UserQuery
	Paginate(page, per int) (*orm.Page[UserRow], error)
	GetsAfter(cursor string, per int) (*orm.KeysetPage[UserRow], error)
	GetsBefore(cursor string, per int) (*orm.KeysetPage[UserRow], error)
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
	Using(ex orm.Exec) *UserRow
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
	GetOrNil() (*ServiceRow, error)
	Gets() (*orm.Collection[ServiceRow], error)
	Stream(visit func(*ServiceRow) bool) (orm.StreamResult, error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[ServiceRow], error)
	Insert() (*ServiceRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ex orm.Exec) *ServiceQuery
	Paginate(page, per int) (*orm.Page[ServiceRow], error)
	GetsAfter(cursor string, per int) (*orm.KeysetPage[ServiceRow], error)
	GetsBefore(cursor string, per int) (*orm.KeysetPage[ServiceRow], error)
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
	Using(ex orm.Exec) *ServiceRow
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
	GetOrNil() (*ServiceRegionRow, error)
	Gets() (*orm.Collection[ServiceRegionRow], error)
	Stream(visit func(*ServiceRegionRow) bool) (orm.StreamResult, error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[ServiceRegionRow], error)
	Insert() (*ServiceRegionRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ex orm.Exec) *ServiceRegionQuery
	Paginate(page, per int) (*orm.Page[ServiceRegionRow], error)
	GetsAfter(cursor string, per int) (*orm.KeysetPage[ServiceRegionRow], error)
	GetsBefore(cursor string, per int) (*orm.KeysetPage[ServiceRegionRow], error)
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
	Using(ex orm.Exec) *ServiceRegionRow
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
	GetOrNil() (*ServiceMemberRow, error)
	Gets() (*orm.Collection[ServiceMemberRow], error)
	Stream(visit func(*ServiceMemberRow) bool) (orm.StreamResult, error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[ServiceMemberRow], error)
	Insert() (*ServiceMemberRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ex orm.Exec) *ServiceMemberQuery
	Paginate(page, per int) (*orm.Page[ServiceMemberRow], error)
	GetsAfter(cursor string, per int) (*orm.KeysetPage[ServiceMemberRow], error)
	GetsBefore(cursor string, per int) (*orm.KeysetPage[ServiceMemberRow], error)
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
	Using(ex orm.Exec) *ServiceMemberRow
	Update() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ ServiceMemberRowInterface = (*ServiceMemberRow)(nil)

type CompositeAccountInterface interface {
	Get() (*CompositeAccountRow, error)
	GetOrNil() (*CompositeAccountRow, error)
	Gets() (*orm.Collection[CompositeAccountRow], error)
	Stream(visit func(*CompositeAccountRow) bool) (orm.StreamResult, error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[CompositeAccountRow], error)
	Insert() (*CompositeAccountRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ex orm.Exec) *CompositeAccountQuery
	Paginate(page, per int) (*orm.Page[CompositeAccountRow], error)
	GetsAfter(cursor string, per int) (*orm.KeysetPage[CompositeAccountRow], error)
	GetsBefore(cursor string, per int) (*orm.KeysetPage[CompositeAccountRow], error)
	GetsByTenantId(v int64) (*orm.Collection[CompositeAccountRow], error)
	GetsByAccountId(v int64) (*orm.Collection[CompositeAccountRow], error)
	GetsByName(v string) (*orm.Collection[CompositeAccountRow], error)
	GetCountByTenantId(v int64) (int64, error)
	GetCountByAccountId(v int64) (int64, error)
	GetCountByName(v string) (int64, error)
	TenantIdEq(v int64) *CompositeAccountQuery
	AccountIdEq(v int64) *CompositeAccountQuery
	NameEq(v string) *CompositeAccountQuery
	TenantId(v int64) *CompositeAccountQuery
	AccountId(v int64) *CompositeAccountQuery
	Name(v string) *CompositeAccountQuery
}

var _ CompositeAccountInterface = (*CompositeAccountQuery)(nil)

type CompositeAccountRowInterface interface {
	Using(ex orm.Exec) *CompositeAccountRow
	Update() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ CompositeAccountRowInterface = (*CompositeAccountRow)(nil)

type CompositeMembershipInterface interface {
	Get() (*CompositeMembershipRow, error)
	GetOrNil() (*CompositeMembershipRow, error)
	Gets() (*orm.Collection[CompositeMembershipRow], error)
	Stream(visit func(*CompositeMembershipRow) bool) (orm.StreamResult, error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[CompositeMembershipRow], error)
	Insert() (*CompositeMembershipRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ex orm.Exec) *CompositeMembershipQuery
	Paginate(page, per int) (*orm.Page[CompositeMembershipRow], error)
	GetsAfter(cursor string, per int) (*orm.KeysetPage[CompositeMembershipRow], error)
	GetsBefore(cursor string, per int) (*orm.KeysetPage[CompositeMembershipRow], error)
	GetsByTenantId(v int64) (*orm.Collection[CompositeMembershipRow], error)
	GetsByAccountId(v int64) (*orm.Collection[CompositeMembershipRow], error)
	GetsByRole(v string) (*orm.Collection[CompositeMembershipRow], error)
	GetCountByTenantId(v int64) (int64, error)
	GetCountByAccountId(v int64) (int64, error)
	GetCountByRole(v string) (int64, error)
	TenantIdEq(v int64) *CompositeMembershipQuery
	AccountIdEq(v int64) *CompositeMembershipQuery
	RoleEq(v string) *CompositeMembershipQuery
	TenantId(v int64) *CompositeMembershipQuery
	AccountId(v int64) *CompositeMembershipQuery
	Role(v string) *CompositeMembershipQuery
}

var _ CompositeMembershipInterface = (*CompositeMembershipQuery)(nil)

type CompositeMembershipRowInterface interface {
	Using(ex orm.Exec) *CompositeMembershipRow
	Update() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ CompositeMembershipRowInterface = (*CompositeMembershipRow)(nil)

type SoftRecordInterface interface {
	Get() (*SoftRecordRow, error)
	GetOrNil() (*SoftRecordRow, error)
	Gets() (*orm.Collection[SoftRecordRow], error)
	Stream(visit func(*SoftRecordRow) bool) (orm.StreamResult, error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[SoftRecordRow], error)
	Insert() (*SoftRecordRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ex orm.Exec) *SoftRecordQuery
	Paginate(page, per int) (*orm.Page[SoftRecordRow], error)
	GetsAfter(cursor string, per int) (*orm.KeysetPage[SoftRecordRow], error)
	GetsBefore(cursor string, per int) (*orm.KeysetPage[SoftRecordRow], error)
	GetsBySeq(v int64) (*orm.Collection[SoftRecordRow], error)
	GetsByName(v string) (*orm.Collection[SoftRecordRow], error)
	GetsByDeletedAt(v time.Time) (*orm.Collection[SoftRecordRow], error)
	GetCountBySeq(v int64) (int64, error)
	GetCountByName(v string) (int64, error)
	GetCountByDeletedAt(v time.Time) (int64, error)
	SeqEq(v int64) *SoftRecordQuery
	NameEq(v string) *SoftRecordQuery
	DeletedAtEq(v time.Time) *SoftRecordQuery
	Seq(v int64) *SoftRecordQuery
	Name(v string) *SoftRecordQuery
	DeletedAt(v time.Time) *SoftRecordQuery
}

var _ SoftRecordInterface = (*SoftRecordQuery)(nil)

type SoftRecordRowInterface interface {
	Using(ex orm.Exec) *SoftRecordRow
	Update() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ SoftRecordRowInterface = (*SoftRecordRow)(nil)

type AccountInterface interface {
	Get() (*AccountRow, error)
	GetOrNil() (*AccountRow, error)
	Gets() (*orm.Collection[AccountRow], error)
	Stream(visit func(*AccountRow) bool) (orm.StreamResult, error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[AccountRow], error)
	Insert() (*AccountRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ex orm.Exec) *AccountQuery
	Paginate(page, per int) (*orm.Page[AccountRow], error)
	GetsAfter(cursor string, per int) (*orm.KeysetPage[AccountRow], error)
	GetsBefore(cursor string, per int) (*orm.KeysetPage[AccountRow], error)
	GetsBySeq(v int64) (*orm.Collection[AccountRow], error)
	GetsByName(v string) (*orm.Collection[AccountRow], error)
	GetCountBySeq(v int64) (int64, error)
	GetCountByName(v string) (int64, error)
	SeqEq(v int64) *AccountQuery
	NameEq(v string) *AccountQuery
	Seq(v int64) *AccountQuery
	Name(v string) *AccountQuery
}

var _ AccountInterface = (*AccountQuery)(nil)

type AccountRowInterface interface {
	Using(ex orm.Exec) *AccountRow
	Update() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ AccountRowInterface = (*AccountRow)(nil)

type ProjectInterface interface {
	Get() (*ProjectRow, error)
	GetOrNil() (*ProjectRow, error)
	Gets() (*orm.Collection[ProjectRow], error)
	Stream(visit func(*ProjectRow) bool) (orm.StreamResult, error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[ProjectRow], error)
	Insert() (*ProjectRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ex orm.Exec) *ProjectQuery
	Paginate(page, per int) (*orm.Page[ProjectRow], error)
	GetsAfter(cursor string, per int) (*orm.KeysetPage[ProjectRow], error)
	GetsBefore(cursor string, per int) (*orm.KeysetPage[ProjectRow], error)
	GetsBySeq(v int64) (*orm.Collection[ProjectRow], error)
	GetsByName(v string) (*orm.Collection[ProjectRow], error)
	GetCountBySeq(v int64) (int64, error)
	GetCountByName(v string) (int64, error)
	SeqEq(v int64) *ProjectQuery
	NameEq(v string) *ProjectQuery
	Seq(v int64) *ProjectQuery
	Name(v string) *ProjectQuery
}

var _ ProjectInterface = (*ProjectQuery)(nil)

type ProjectRowInterface interface {
	Using(ex orm.Exec) *ProjectRow
	Update() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ ProjectRowInterface = (*ProjectRow)(nil)

type AccountProjectInterface interface {
	Get() (*AccountProjectRow, error)
	GetOrNil() (*AccountProjectRow, error)
	Gets() (*orm.Collection[AccountProjectRow], error)
	Stream(visit func(*AccountProjectRow) bool) (orm.StreamResult, error)
	GetCount() (int64, error)
	GetsCount() (*orm.Collection[AccountProjectRow], error)
	Insert() (*AccountProjectRow, error)
	Update() (int64, error)
	Delete() (int64, error)
	SQL() (*orm.Statement, error)
	Using(ex orm.Exec) *AccountProjectQuery
	Paginate(page, per int) (*orm.Page[AccountProjectRow], error)
	GetsAfter(cursor string, per int) (*orm.KeysetPage[AccountProjectRow], error)
	GetsBefore(cursor string, per int) (*orm.KeysetPage[AccountProjectRow], error)
	GetsByAccountSeq(v int64) (*orm.Collection[AccountProjectRow], error)
	GetsByProjectSeq(v int64) (*orm.Collection[AccountProjectRow], error)
	GetCountByAccountSeq(v int64) (int64, error)
	GetCountByProjectSeq(v int64) (int64, error)
	AccountSeqEq(v int64) *AccountProjectQuery
	ProjectSeqEq(v int64) *AccountProjectQuery
	AccountSeq(v int64) *AccountProjectQuery
	ProjectSeq(v int64) *AccountProjectQuery
}

var _ AccountProjectInterface = (*AccountProjectQuery)(nil)

type AccountProjectRowInterface interface {
	Using(ex orm.Exec) *AccountProjectRow
	Update() error
	Delete() error
	DeleteCascade() error
	Has(name string) bool
	RelLoaded(rel string) bool
	ToArray() (map[string]any, error)
}

var _ AccountProjectRowInterface = (*AccountProjectRow)(nil)
