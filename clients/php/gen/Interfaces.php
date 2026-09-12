<?php
// Code generated from contracts/interfaces.json; DO NOT EDIT.
declare(strict_types=1);
namespace App\Orm;
\Orm\Wire::register(json_decode('[{"id":"IRRequest","native":{"go":"engine/ir/ir.go::Request","rust":"clients/rust/orm/src/ir.rs::Request","typescript":"clients/typescript/src/index.ts::Request"},"fields":{"ir_version":"integer","schema_hash":"text","kind":"text","set":"list\\u003cIRAssign\\u003e","on_duplicate":"list\\u003cIRAssign\\u003e","optimistic":"IROptimist","agg":"text","raw":"IRRaw","debug":"bool","n_params":"integer"},"optional":["set","on_duplicate","optimistic","agg","raw","debug"],"extends":"IRQuery"},{"id":"IRQuery","native":{"go":"engine/ir/ir.go::Query","rust":"clients/rust/orm/src/ir.rs::Query","typescript":"clients/typescript/src/index.ts::RequestQuery"},"fields":{"entity":"text","scope_p":"integer","columns":"IRColumns","on":"IRGroup","where":"IRGroup","having":"IRGroup","joins":"list\\u003cIRJoin\\u003e","relations":"list\\u003cIRRelation\\u003e","order":"list\\u003cIROrder\\u003e","group_by":"list\\u003ctext\\u003e","group_by_expr":"list\\u003cIRGroupExpr\\u003e","limit":"IRLimit","distinct":"bool","force_index":"text","lock":"text","key_by":"text","flatten":"bool","limit_per_parent":"integer","if_parent":"IRIfParent","keyset":"IRKeyset","drop_child_key":"bool","no_cascade_delete":"bool"},"optional":["scope_p","columns","on","where","having","joins","relations","order","group_by","group_by_expr","limit","distinct","force_index","lock","key_by","flatten","limit_per_parent","if_parent","keyset","drop_child_key","no_cascade_delete"]},{"id":"IRKeyset","native":{"go":"engine/ir/ir.go::Keyset","rust":"clients/rust/orm/src/ir.rs::Keyset","typescript":"clients/typescript/src/index.ts::Keyset"},"fields":{"direction":"text","values":"list\\u003cinteger\\u003e"},"optional":[]},{"id":"IRColumns","native":{"go":"engine/ir/ir.go::Columns","rust":"clients/rust/orm/src/ir.rs::Columns","typescript":"clients/typescript/src/index.ts::Projection"},"fields":{"mode":"text","add":"list\\u003ctext\\u003e","remove":"list\\u003ctext\\u003e","as":"map\\u003ctext\\u003e","expr":"map\\u003ctext\\u003e"},"optional":["mode","add","remove","as","expr"]},{"id":"IRJoin","native":{"go":"engine/ir/ir.go::Join","rust":"clients/rust/orm/src/ir.rs::Join","typescript":"clients/typescript/src/index.ts::Join"},"fields":{"rel":"text","kind":"text","query":"IRQuery"},"optional":[]},{"id":"IRRelation","native":{"go":"engine/ir/ir.go::Relation","rust":"clients/rust/orm/src/ir.rs::Relation","typescript":"clients/typescript/src/index.ts::Relation"},"fields":{"rel":"text","query":"IRQuery"},"optional":[]},{"id":"IRGroup","native":{"go":"engine/ir/ir.go::Group","rust":"clients/rust/orm/src/ir.rs::Group","typescript":"clients/typescript/src/index.ts::Group"},"fields":{"conn":"text","items":"list\\u003cIRItem\\u003e"},"optional":["conn"]},{"id":"IRItem","native":{"go":"engine/ir/ir.go::Item","rust":"clients/rust/orm/src/ir.rs::Item","typescript":"clients/typescript/src/index.ts::Item"},"fields":{"pred":"IRPred","group":"IRGroup","nav":"IRNav"},"optional":["pred","group","nav"],"union":true},{"id":"IRPred","native":{"go":"engine/ir/ir.go::Pred","rust":"clients/rust/orm/src/ir.rs::Pred","typescript":"clients/typescript/src/index.ts::Predicate"},"fields":{"conn":"text","column":"text","op":"text","p":"integer","ps":"list\\u003cinteger\\u003e","ref":"IRColRef","expr":"text","match":"list\\u003ctext\\u003e"},"optional":["conn","column","op","p","ps","ref","expr","match"]},{"id":"IRColRef","native":{"go":"engine/ir/ir.go::ColRef","rust":"clients/rust/orm/src/ir.rs::ColRef","typescript":"clients/typescript/src/index.ts::ColumnReferenceIR"},"fields":{"path":"text","column":"text"},"optional":[]},{"id":"IRNav","native":{"go":"engine/ir/ir.go::Nav","rust":"clients/rust/orm/src/ir.rs::Nav","typescript":"clients/typescript/src/index.ts::Navigation"},"fields":{"conn":"text","rel":"text","group":"IRGroup","mode":"text","count_op":"text","p":"integer"},"optional":["conn","mode","count_op","p"]},{"id":"IROrder","native":{"go":"engine/ir/ir.go::Order","rust":"clients/rust/orm/src/ir.rs::Order","typescript":"clients/typescript/src/index.ts::Order"},"fields":{"column":"text","expr":"text","desc":"bool"},"optional":["column","expr","desc"]},{"id":"IRGroupExpr","native":{"go":"engine/ir/ir.go::GroupExpr","rust":"clients/rust/orm/src/ir.rs::GroupExpr","typescript":"clients/typescript/src/index.ts::GroupExpression"},"fields":{"expr":"text","as":"text"},"optional":[]},{"id":"IRLimit","native":{"go":"engine/ir/ir.go::Limit","rust":"clients/rust/orm/src/ir.rs::Limit","typescript":"clients/typescript/src/index.ts::Limit"},"fields":{"offset":"integer","count":"integer"},"optional":[]},{"id":"IRIfParent","native":{"go":"engine/ir/ir.go::IfParent","rust":"clients/rust/orm/src/ir.rs::IfParent","typescript":"clients/typescript/src/index.ts::IfParent"},"fields":{"column":"text","p":"integer"},"optional":[]},{"id":"IRAssign","native":{"go":"engine/ir/ir.go::Assign","rust":"clients/rust/orm/src/ir.rs::Assign","typescript":"clients/typescript/src/index.ts::Assignment"},"fields":{"column":"text","p":"integer","null":"bool","expr":"text","ps":"list\\u003cinteger\\u003e","plus_p":"integer","minus_p":"integer"},"optional":["p","null","expr","ps","plus_p","minus_p"]},{"id":"IRRaw","native":{"go":"engine/ir/ir.go::Raw","rust":"clients/rust/orm/src/ir.rs::Raw","typescript":"clients/typescript/src/index.ts::Raw"},"fields":{"sql":"text","ps":"list\\u003cinteger\\u003e"},"optional":["ps"]},{"id":"IROptimist","native":{"go":"engine/ir/ir.go::Optimist","rust":"clients/rust/orm/src/ir.rs::Optimist","typescript":"clients/typescript/src/index.ts::Optimistic"},"fields":{"column":"text","p":"integer"},"optional":[]},{"id":"Plan","native":{"go":"engine/plan/plan.go::Plan","rust":"clients/rust/orm/src/plan.rs::Plan","typescript":"clients/typescript/src/index.ts::Plan"},"fields":{"schema_hash":"text","kind":"text","steps":"list\\u003cPlanStep\\u003e"},"optional":[]},{"id":"PlanStep","native":{"go":"engine/plan/plan.go::Step","rust":"clients/rust/orm/src/plan.rs::Step","typescript":"clients/typescript/src/index.ts::PlanStep"},"fields":{"id":"integer","role":"text","sql":"text","bind_slots":"list\\u003cPlanBindSlot\\u003e","assemble":"PlanAssemble","parent":"PlanParent"},"optional":["assemble","parent"]},{"id":"PlanKeyRef","native":{"go":"engine/plan/plan.go::KeyRef","rust":"clients/rust/orm/src/plan.rs::KeyRef","typescript":"clients/typescript/src/index.ts::KeyReference"},"fields":{"column":"text","index":"integer"},"optional":[]},{"id":"PlanParent","native":{"go":"engine/plan/plan.go::ParentRef","rust":"clients/rust/orm/src/plan.rs::ParentRef","typescript":"clients/typescript/src/index.ts::ParentReference"},"fields":{"step":"integer","keys":"list\\u003cPlanKeyRef\\u003e","if_parent":"PlanIfParent"},"optional":["if_parent"]},{"id":"PlanIfParent","native":{"go":"engine/plan/plan.go::IfParent","rust":"clients/rust/orm/src/plan.rs::IfParent","typescript":"clients/typescript/src/index.ts::PlanIfParent"},"fields":{"column":"text","index":"integer","param":"integer"},"optional":[]},{"id":"PlanBindSlot","native":{"go":"engine/plan/plan.go::BindSlot","rust":"clients/rust/orm/src/plan.rs::BindSlot","typescript":"clients/typescript/src/index.ts::BindSlot"},"fields":{"from":"text","param":"integer","transform":"text","name":"text","step":"integer","column":"text","host_styles":"list\\u003ctext\\u003e","col_type":"text"},"optional":["transform","name","step","column","host_styles","col_type"]},{"id":"PlanAssemble","native":{"go":"engine/plan/plan.go::Assemble","rust":"clients/rust/orm/src/plan.rs::Assemble","typescript":"clients/typescript/src/index.ts::Assemble"},"fields":{"entity":"text","alias":"text","columns":"list\\u003cPlanOutCol\\u003e","children":"list\\u003cPlanChild\\u003e","key":"list\\u003cPlanKeyRef\\u003e"},"optional":["children"]},{"id":"PlanOutCol","native":{"go":"engine/plan/plan.go::OutCol","rust":"clients/rust/orm/src/plan.rs::OutCol","typescript":"clients/typescript/src/index.ts::OutputColumn"},"fields":{"index":"integer","name":"text","column":"text","type":"text","styles":"list\\u003ctext\\u003e","hidden":"bool"},"optional":["column","styles","hidden"]},{"id":"PlanChild","native":{"go":"engine/plan/plan.go::Child","rust":"clients/rust/orm/src/plan.rs::Child","typescript":"clients/typescript/src/index.ts::Child"},"fields":{"rel":"text","kind":"text","step":"integer","parent_keys":"list\\u003cPlanKeyRef\\u003e","child_keys":"list\\u003cPlanKeyRef\\u003e","key":"list\\u003cPlanKeyRef\\u003e","flatten":"bool","cascade":"bool","assemble":"PlanAssemble"},"optional":["step","parent_keys","child_keys","key","flatten","cascade","assemble"]}]', true, 512, JSON_THROW_ON_ERROR));

interface BattleInterface {
public function get(): ?\App\Orm\BattleRow;
public function gets(): \Orm\Collection;
public function stream(callable $visit): \Orm\StreamResult;
public function getCount(): int;
public function getsCount(): \Orm\Collection;
public function aesStatus(\Orm\AesKeyring $keyring): \Orm\AesRotationStatus;
public function rotateAES(\Orm\AesKeyring $keyring): int;
public function insert(): ?\App\Orm\BattleRow;
public function save(): ?\App\Orm\BattleRow;
public function update(): int;
public function delete(): int;
public function sql(): array;
public static function query(): static;
public function using(\Orm\Db|\PDO $db): static;
public function scope(int $v): static;
public function paginate(int $page, int $per): \Orm\Page;
public function getsAfter(string $cursor, int $per): \Orm\KeysetPage;
public function getsBefore(string $cursor, int $per): \Orm\KeysetPage;
public function getsBySeq(int $value): \Orm\Collection;
public function getsByName(string $value): \Orm\Collection;
public function getsByDescription(string $value): \Orm\Collection;
public function getsByCreatedTs(string $value): \Orm\Collection;
public function getsByUpdatedTs(string $value): \Orm\Collection;
public function getsByIsClose(bool $value): \Orm\Collection;
public function getsByIsDisplay(bool $value): \Orm\Collection;
public function getsByDisplayStartDt(string $value): \Orm\Collection;
public function getsByDisplayEndDt(string $value): \Orm\Collection;
public function getsByIsAllday(bool $value): \Orm\Collection;
public function getsByTargetTeamPlayerCount(int $value): \Orm\Collection;
public function getsBySuccessCount(int $value): \Orm\Collection;
public function getsByPlayerCount(int $value): \Orm\Collection;
public function getsByReadCount(int $value): \Orm\Collection;
public function getsByCoverUrl(string $value): \Orm\Collection;
public function getsByUserSeq(int $value): \Orm\Collection;
public function getsByServiceSeq(int $value): \Orm\Collection;
public function getsByServiceModuleSeq(int $value): \Orm\Collection;
public function getsByServiceMemberSeq(int $value): \Orm\Collection;
public function getsByStartDt(string $value): \Orm\Collection;
public function getsByEndDt(string $value): \Orm\Collection;
public function getsByUuid(string $value): \Orm\Collection;
public function getsByIsSinglePlay(bool $value): \Orm\Collection;
public function getsByLikeCount(int $value): \Orm\Collection;
public function getsByAesKeyVersion(int $value): \Orm\Collection;
public function getsByAesHexEmail(string $value): \Orm\Collection;
public function getsByEmailBlindIndex(string $value): \Orm\Collection;
public function getsByAesHexPhone(string $value): \Orm\Collection;
public function getsByPhoneBlindIndex(string $value): \Orm\Collection;
public function getsByPrice(float $value): \Orm\Collection;
public function getsByIp(string $value): \Orm\Collection;
public function getCountBySeq(int $value): int;
public function getCountByName(string $value): int;
public function getCountByDescription(string $value): int;
public function getCountByCreatedTs(string $value): int;
public function getCountByUpdatedTs(string $value): int;
public function getCountByIsClose(bool $value): int;
public function getCountByIsDisplay(bool $value): int;
public function getCountByDisplayStartDt(string $value): int;
public function getCountByDisplayEndDt(string $value): int;
public function getCountByIsAllday(bool $value): int;
public function getCountByTargetTeamPlayerCount(int $value): int;
public function getCountBySuccessCount(int $value): int;
public function getCountByPlayerCount(int $value): int;
public function getCountByReadCount(int $value): int;
public function getCountByCoverUrl(string $value): int;
public function getCountByUserSeq(int $value): int;
public function getCountByServiceSeq(int $value): int;
public function getCountByServiceModuleSeq(int $value): int;
public function getCountByServiceMemberSeq(int $value): int;
public function getCountByStartDt(string $value): int;
public function getCountByEndDt(string $value): int;
public function getCountByUuid(string $value): int;
public function getCountByIsSinglePlay(bool $value): int;
public function getCountByLikeCount(int $value): int;
public function getCountByAesKeyVersion(int $value): int;
public function getCountByAesHexEmail(string $value): int;
public function getCountByEmailBlindIndex(string $value): int;
public function getCountByAesHexPhone(string $value): int;
public function getCountByPhoneBlindIndex(string $value): int;
public function getCountByPrice(float $value): int;
public function getCountByIp(string $value): int;
public function seqEq(int $v): static;
public function nameEq(string $v): static;
public function descriptionEq(string $v): static;
public function createdTsEq(string $v): static;
public function updatedTsEq(string $v): static;
public function isCloseEq(bool $v): static;
public function isDisplayEq(bool $v): static;
public function displayStartDtEq(string $v): static;
public function displayEndDtEq(string $v): static;
public function isAlldayEq(bool $v): static;
public function targetTeamPlayerCountEq(int $v): static;
public function successCountEq(int $v): static;
public function playerCountEq(int $v): static;
public function readCountEq(int $v): static;
public function coverUrlEq(string $v): static;
public function userSeqEq(int $v): static;
public function serviceSeqEq(int $v): static;
public function serviceModuleSeqEq(int $v): static;
public function serviceMemberSeqEq(int $v): static;
public function startDtEq(string $v): static;
public function endDtEq(string $v): static;
public function uuidEq(string $v): static;
public function isSinglePlayEq(bool $v): static;
public function likeCountEq(int $v): static;
public function aesKeyVersionEq(int $v): static;
public function aesHexEmailEq(string $v): static;
public function emailBlindIndexEq(string $v): static;
public function aesHexPhoneEq(string $v): static;
public function phoneBlindIndexEq(string $v): static;
public function priceEq(float $v): static;
public function ipEq(string $v): static;
public function seq(int $v): static;
public function name(string $v): static;
public function description(string $v): static;
public function createdTs(string $v): static;
public function updatedTs(string $v): static;
public function isClose(bool $v): static;
public function isDisplay(bool $v): static;
public function displayStartDt(string $v): static;
public function displayEndDt(string $v): static;
public function isAllday(bool $v): static;
public function targetTeamPlayerCount(int $v): static;
public function successCount(int $v): static;
public function playerCount(int $v): static;
public function readCount(int $v): static;
public function coverUrl(string $v): static;
public function userSeq(int $v): static;
public function serviceSeq(int $v): static;
public function serviceModuleSeq(int $v): static;
public function serviceMemberSeq(int $v): static;
public function startDt(string $v): static;
public function endDt(string $v): static;
public function uuid(string $v): static;
public function isSinglePlay(bool $v): static;
public function likeCount(int $v): static;
public function aesKeyVersion(int $v): static;
public function aesHexEmail(string $v): static;
public function emailBlindIndex(string $v): static;
public function aesHexPhone(string $v): static;
public function phoneBlindIndex(string $v): static;
public function price(float $v): static;
public function ip(string $v): static;
}

interface BattleRowInterface {
public function using(\Orm\Db|\PDO $db): static;
public function update(): void;
public function updateOptimistic(): void;
public function delete(bool $cascade=false): void;
public function deleteCascade(): void;
public function has(string $col): bool;
public function relLoaded(string $name): bool;
public function toArray(): array;
}

interface UserInterface {
public function get(): ?\App\Orm\UserRow;
public function gets(): \Orm\Collection;
public function stream(callable $visit): \Orm\StreamResult;
public function getCount(): int;
public function getsCount(): \Orm\Collection;
public function insert(): ?\App\Orm\UserRow;
public function save(): ?\App\Orm\UserRow;
public function update(): int;
public function delete(): int;
public function sql(): array;
public static function query(): static;
public function using(\Orm\Db|\PDO $db): static;
public function paginate(int $page, int $per): \Orm\Page;
public function getsAfter(string $cursor, int $per): \Orm\KeysetPage;
public function getsBefore(string $cursor, int $per): \Orm\KeysetPage;
public function getsBySeq(int $value): \Orm\Collection;
public function getsByName(string $value): \Orm\Collection;
public function getCountBySeq(int $value): int;
public function getCountByName(string $value): int;
public function seqEq(int $v): static;
public function nameEq(string $v): static;
public function seq(int $v): static;
public function name(string $v): static;
}

interface UserRowInterface {
public function using(\Orm\Db|\PDO $db): static;
public function update(): void;
public function delete(bool $cascade=false): void;
public function deleteCascade(): void;
public function has(string $col): bool;
public function relLoaded(string $name): bool;
public function toArray(): array;
}

interface ServiceInterface {
public function get(): ?\App\Orm\ServiceRow;
public function gets(): \Orm\Collection;
public function stream(callable $visit): \Orm\StreamResult;
public function getCount(): int;
public function getsCount(): \Orm\Collection;
public function insert(): ?\App\Orm\ServiceRow;
public function save(): ?\App\Orm\ServiceRow;
public function update(): int;
public function delete(): int;
public function sql(): array;
public static function query(): static;
public function using(\Orm\Db|\PDO $db): static;
public function paginate(int $page, int $per): \Orm\Page;
public function getsAfter(string $cursor, int $per): \Orm\KeysetPage;
public function getsBefore(string $cursor, int $per): \Orm\KeysetPage;
public function getsBySeq(int $value): \Orm\Collection;
public function getsByName(string $value): \Orm\Collection;
public function getCountBySeq(int $value): int;
public function getCountByName(string $value): int;
public function seqEq(int $v): static;
public function nameEq(string $v): static;
public function seq(int $v): static;
public function name(string $v): static;
}

interface ServiceRowInterface {
public function using(\Orm\Db|\PDO $db): static;
public function update(): void;
public function delete(bool $cascade=false): void;
public function deleteCascade(): void;
public function has(string $col): bool;
public function relLoaded(string $name): bool;
public function toArray(): array;
}

interface ServiceModuleInterface {
public function get(): ?\App\Orm\ServiceModuleRow;
public function gets(): \Orm\Collection;
public function stream(callable $visit): \Orm\StreamResult;
public function getCount(): int;
public function getsCount(): \Orm\Collection;
public function insert(): ?\App\Orm\ServiceModuleRow;
public function save(): ?\App\Orm\ServiceModuleRow;
public function update(): int;
public function delete(): int;
public function sql(): array;
public static function query(): static;
public function using(\Orm\Db|\PDO $db): static;
public function paginate(int $page, int $per): \Orm\Page;
public function getsAfter(string $cursor, int $per): \Orm\KeysetPage;
public function getsBefore(string $cursor, int $per): \Orm\KeysetPage;
public function getsBySeq(int $value): \Orm\Collection;
public function getsByServiceSeq(int $value): \Orm\Collection;
public function getsByName(string $value): \Orm\Collection;
public function getCountBySeq(int $value): int;
public function getCountByServiceSeq(int $value): int;
public function getCountByName(string $value): int;
public function seqEq(int $v): static;
public function serviceSeqEq(int $v): static;
public function nameEq(string $v): static;
public function seq(int $v): static;
public function serviceSeq(int $v): static;
public function name(string $v): static;
}

interface ServiceModuleRowInterface {
public function using(\Orm\Db|\PDO $db): static;
public function update(): void;
public function delete(bool $cascade=false): void;
public function deleteCascade(): void;
public function has(string $col): bool;
public function relLoaded(string $name): bool;
public function toArray(): array;
}

interface ServiceMemberInterface {
public function get(): ?\App\Orm\ServiceMemberRow;
public function gets(): \Orm\Collection;
public function stream(callable $visit): \Orm\StreamResult;
public function getCount(): int;
public function getsCount(): \Orm\Collection;
public function insert(): ?\App\Orm\ServiceMemberRow;
public function save(): ?\App\Orm\ServiceMemberRow;
public function update(): int;
public function delete(): int;
public function sql(): array;
public static function query(): static;
public function using(\Orm\Db|\PDO $db): static;
public function paginate(int $page, int $per): \Orm\Page;
public function getsAfter(string $cursor, int $per): \Orm\KeysetPage;
public function getsBefore(string $cursor, int $per): \Orm\KeysetPage;
public function getsBySeq(int $value): \Orm\Collection;
public function getsByServiceSeq(int $value): \Orm\Collection;
public function getsByUserSeq(int $value): \Orm\Collection;
public function getCountBySeq(int $value): int;
public function getCountByServiceSeq(int $value): int;
public function getCountByUserSeq(int $value): int;
public function seqEq(int $v): static;
public function serviceSeqEq(int $v): static;
public function userSeqEq(int $v): static;
public function seq(int $v): static;
public function serviceSeq(int $v): static;
public function userSeq(int $v): static;
}

interface ServiceMemberRowInterface {
public function using(\Orm\Db|\PDO $db): static;
public function update(): void;
public function delete(bool $cascade=false): void;
public function deleteCascade(): void;
public function has(string $col): bool;
public function relLoaded(string $name): bool;
public function toArray(): array;
}

interface CompositeAccountInterface {
public function get(): ?\App\Orm\CompositeAccountRow;
public function gets(): \Orm\Collection;
public function stream(callable $visit): \Orm\StreamResult;
public function getCount(): int;
public function getsCount(): \Orm\Collection;
public function insert(): ?\App\Orm\CompositeAccountRow;
public function save(): ?\App\Orm\CompositeAccountRow;
public function update(): int;
public function delete(): int;
public function sql(): array;
public static function query(): static;
public function using(\Orm\Db|\PDO $db): static;
public function paginate(int $page, int $per): \Orm\Page;
public function getsAfter(string $cursor, int $per): \Orm\KeysetPage;
public function getsBefore(string $cursor, int $per): \Orm\KeysetPage;
public function getsByTenantId(int $value): \Orm\Collection;
public function getsByAccountId(int $value): \Orm\Collection;
public function getsByName(string $value): \Orm\Collection;
public function getCountByTenantId(int $value): int;
public function getCountByAccountId(int $value): int;
public function getCountByName(string $value): int;
public function tenantIdEq(int $v): static;
public function accountIdEq(int $v): static;
public function nameEq(string $v): static;
public function tenantId(int $v): static;
public function accountId(int $v): static;
public function name(string $v): static;
}

interface CompositeAccountRowInterface {
public function using(\Orm\Db|\PDO $db): static;
public function update(): void;
public function delete(bool $cascade=false): void;
public function deleteCascade(): void;
public function has(string $col): bool;
public function relLoaded(string $name): bool;
public function toArray(): array;
}

interface CompositeMembershipInterface {
public function get(): ?\App\Orm\CompositeMembershipRow;
public function gets(): \Orm\Collection;
public function stream(callable $visit): \Orm\StreamResult;
public function getCount(): int;
public function getsCount(): \Orm\Collection;
public function insert(): ?\App\Orm\CompositeMembershipRow;
public function save(): ?\App\Orm\CompositeMembershipRow;
public function update(): int;
public function delete(): int;
public function sql(): array;
public static function query(): static;
public function using(\Orm\Db|\PDO $db): static;
public function paginate(int $page, int $per): \Orm\Page;
public function getsAfter(string $cursor, int $per): \Orm\KeysetPage;
public function getsBefore(string $cursor, int $per): \Orm\KeysetPage;
public function getsByTenantId(int $value): \Orm\Collection;
public function getsByAccountId(int $value): \Orm\Collection;
public function getsByRole(string $value): \Orm\Collection;
public function getCountByTenantId(int $value): int;
public function getCountByAccountId(int $value): int;
public function getCountByRole(string $value): int;
public function tenantIdEq(int $v): static;
public function accountIdEq(int $v): static;
public function roleEq(string $v): static;
public function tenantId(int $v): static;
public function accountId(int $v): static;
public function role(string $v): static;
}

interface CompositeMembershipRowInterface {
public function using(\Orm\Db|\PDO $db): static;
public function update(): void;
public function delete(bool $cascade=false): void;
public function deleteCascade(): void;
public function has(string $col): bool;
public function relLoaded(string $name): bool;
public function toArray(): array;
}

interface SoftRecordInterface {
public function get(): ?\App\Orm\SoftRecordRow;
public function gets(): \Orm\Collection;
public function stream(callable $visit): \Orm\StreamResult;
public function getCount(): int;
public function getsCount(): \Orm\Collection;
public function insert(): ?\App\Orm\SoftRecordRow;
public function save(): ?\App\Orm\SoftRecordRow;
public function update(): int;
public function delete(): int;
public function sql(): array;
public static function query(): static;
public function using(\Orm\Db|\PDO $db): static;
public function paginate(int $page, int $per): \Orm\Page;
public function getsAfter(string $cursor, int $per): \Orm\KeysetPage;
public function getsBefore(string $cursor, int $per): \Orm\KeysetPage;
public function getsBySeq(int $value): \Orm\Collection;
public function getsByName(string $value): \Orm\Collection;
public function getsByDeletedAt(string $value): \Orm\Collection;
public function getCountBySeq(int $value): int;
public function getCountByName(string $value): int;
public function getCountByDeletedAt(string $value): int;
public function seqEq(int $v): static;
public function nameEq(string $v): static;
public function deletedAtEq(string $v): static;
public function seq(int $v): static;
public function name(string $v): static;
public function deletedAt(string $v): static;
}

interface SoftRecordRowInterface {
public function using(\Orm\Db|\PDO $db): static;
public function update(): void;
public function delete(bool $cascade=false): void;
public function deleteCascade(): void;
public function has(string $col): bool;
public function relLoaded(string $name): bool;
public function toArray(): array;
}
