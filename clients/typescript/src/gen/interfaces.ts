// Code generated from contracts/interfaces.json; DO NOT EDIT.
import type { Collection, Page } from '../model.js';
import type { Db } from '../database.js';
import type { Point } from '../codec.js';
import type { AesKeyring, AesRotationStatus, StreamResult } from '../index.js';
import type { BattleRow, UserRow, ServiceRow, ServiceModuleRow, ServiceMemberRow } from './entities.js';

export interface BattleInterface {
get(): Promise<BattleRow | null>;
gets(): Promise<Collection<BattleRow>>;
stream(visitor: (row: BattleRow) => boolean | Promise<boolean>): Promise<StreamResult>;
getCount(): Promise<number>;
getsCount(): Promise<Collection<BattleRow>>;
aesStatus(keyring: AesKeyring): Promise<AesRotationStatus>;
rotateAES(keyring: AesKeyring): Promise<number>;
insert(): Promise<BattleRow | null>;
save(): Promise<BattleRow | null>;
update(): Promise<number>;
delete(): Promise<number>;
sql(): Promise<{ sql: string; binds: unknown[]; }>;
using(database: Db): this;
scope(value: number): this;
paginate(page: number, per: number): Promise<Page<BattleRow>>;
getsBySeq(value: number): Promise<Collection<BattleRow>>;
getsByName(value: string): Promise<Collection<BattleRow>>;
getsByDescription(value: string): Promise<Collection<BattleRow>>;
getsByCreatedTs(value: string | Date): Promise<Collection<BattleRow>>;
getsByUpdatedTs(value: string | Date): Promise<Collection<BattleRow>>;
getsByIsClose(value: boolean): Promise<Collection<BattleRow>>;
getsByIsDisplay(value: boolean): Promise<Collection<BattleRow>>;
getsByDisplayStartDt(value: string | Date): Promise<Collection<BattleRow>>;
getsByDisplayEndDt(value: string | Date): Promise<Collection<BattleRow>>;
getsByIsAllday(value: boolean): Promise<Collection<BattleRow>>;
getsByTargetTeamPlayerCount(value: number): Promise<Collection<BattleRow>>;
getsBySuccessCount(value: number): Promise<Collection<BattleRow>>;
getsByPlayerCount(value: number): Promise<Collection<BattleRow>>;
getsByReadCount(value: number): Promise<Collection<BattleRow>>;
getsByCoverUrl(value: string): Promise<Collection<BattleRow>>;
getsByUserSeq(value: number): Promise<Collection<BattleRow>>;
getsByServiceSeq(value: number): Promise<Collection<BattleRow>>;
getsByServiceModuleSeq(value: number): Promise<Collection<BattleRow>>;
getsByServiceMemberSeq(value: number): Promise<Collection<BattleRow>>;
getsByStartDt(value: string | Date): Promise<Collection<BattleRow>>;
getsByEndDt(value: string | Date): Promise<Collection<BattleRow>>;
getsByUuid(value: string): Promise<Collection<BattleRow>>;
getsByIsSinglePlay(value: boolean): Promise<Collection<BattleRow>>;
getsByLikeCount(value: number): Promise<Collection<BattleRow>>;
getsByAesKeyVersion(value: number): Promise<Collection<BattleRow>>;
getsByAesHexEmail(value: string): Promise<Collection<BattleRow>>;
getsByAesHexPhone(value: string): Promise<Collection<BattleRow>>;
getsByPrice(value: number): Promise<Collection<BattleRow>>;
getsByIp(value: string): Promise<Collection<BattleRow>>;
getCountBySeq(value: number): Promise<number>;
getCountByName(value: string): Promise<number>;
getCountByDescription(value: string): Promise<number>;
getCountByCreatedTs(value: string | Date): Promise<number>;
getCountByUpdatedTs(value: string | Date): Promise<number>;
getCountByIsClose(value: boolean): Promise<number>;
getCountByIsDisplay(value: boolean): Promise<number>;
getCountByDisplayStartDt(value: string | Date): Promise<number>;
getCountByDisplayEndDt(value: string | Date): Promise<number>;
getCountByIsAllday(value: boolean): Promise<number>;
getCountByTargetTeamPlayerCount(value: number): Promise<number>;
getCountBySuccessCount(value: number): Promise<number>;
getCountByPlayerCount(value: number): Promise<number>;
getCountByReadCount(value: number): Promise<number>;
getCountByCoverUrl(value: string): Promise<number>;
getCountByUserSeq(value: number): Promise<number>;
getCountByServiceSeq(value: number): Promise<number>;
getCountByServiceModuleSeq(value: number): Promise<number>;
getCountByServiceMemberSeq(value: number): Promise<number>;
getCountByStartDt(value: string | Date): Promise<number>;
getCountByEndDt(value: string | Date): Promise<number>;
getCountByUuid(value: string): Promise<number>;
getCountByIsSinglePlay(value: boolean): Promise<number>;
getCountByLikeCount(value: number): Promise<number>;
getCountByAesKeyVersion(value: number): Promise<number>;
getCountByAesHexEmail(value: string): Promise<number>;
getCountByAesHexPhone(value: string): Promise<number>;
getCountByPrice(value: number): Promise<number>;
getCountByIp(value: string): Promise<number>;
seqEq(value: number): this;
nameEq(value: string): this;
descriptionEq(value: string): this;
createdTsEq(value: string | Date): this;
updatedTsEq(value: string | Date): this;
isCloseEq(value: boolean): this;
isDisplayEq(value: boolean): this;
displayStartDtEq(value: string | Date): this;
displayEndDtEq(value: string | Date): this;
isAlldayEq(value: boolean): this;
targetTeamPlayerCountEq(value: number): this;
successCountEq(value: number): this;
playerCountEq(value: number): this;
readCountEq(value: number): this;
coverUrlEq(value: string): this;
userSeqEq(value: number): this;
serviceSeqEq(value: number): this;
serviceModuleSeqEq(value: number): this;
serviceMemberSeqEq(value: number): this;
startDtEq(value: string | Date): this;
endDtEq(value: string | Date): this;
uuidEq(value: string): this;
isSinglePlayEq(value: boolean): this;
likeCountEq(value: number): this;
aesKeyVersionEq(value: number): this;
aesHexEmailEq(value: string): this;
aesHexPhoneEq(value: string): this;
priceEq(value: number): this;
ipEq(value: string): this;
seq(value: number): this;
name(value: string): this;
description(value: string): this;
createdTs(value: string | Date): this;
updatedTs(value: string | Date): this;
isClose(value: boolean): this;
isDisplay(value: boolean): this;
displayStartDt(value: string | Date): this;
displayEndDt(value: string | Date): this;
isAllday(value: boolean): this;
targetTeamPlayerCount(value: number): this;
successCount(value: number): this;
playerCount(value: number): this;
readCount(value: number): this;
coverUrl(value: string): this;
userSeq(value: number): this;
serviceSeq(value: number): this;
serviceModuleSeq(value: number): this;
serviceMemberSeq(value: number): this;
startDt(value: string | Date): this;
endDt(value: string | Date): this;
uuid(value: string): this;
isSinglePlay(value: boolean): this;
likeCount(value: number): this;
aesKeyVersion(value: number): this;
aesHexEmail(value: string): this;
aesHexPhone(value: string): this;
price(value: number): this;
ip(value: string): this;
}

export interface BattleRowInterface {
using(database: Db): this;
update(): Promise<void>;
updateOptimistic(): Promise<void>;
delete(): Promise<void>;
deleteCascade(): Promise<void>;
has(column: string): boolean;
relLoaded(relation: string): boolean;
toObject(): Record<string, unknown>;
}

export interface UserInterface {
get(): Promise<UserRow | null>;
gets(): Promise<Collection<UserRow>>;
stream(visitor: (row: UserRow) => boolean | Promise<boolean>): Promise<StreamResult>;
getCount(): Promise<number>;
getsCount(): Promise<Collection<UserRow>>;
insert(): Promise<UserRow | null>;
save(): Promise<UserRow | null>;
update(): Promise<number>;
delete(): Promise<number>;
sql(): Promise<{ sql: string; binds: unknown[]; }>;
using(database: Db): this;
paginate(page: number, per: number): Promise<Page<UserRow>>;
getsBySeq(value: number): Promise<Collection<UserRow>>;
getsByName(value: string): Promise<Collection<UserRow>>;
getCountBySeq(value: number): Promise<number>;
getCountByName(value: string): Promise<number>;
seqEq(value: number): this;
nameEq(value: string): this;
seq(value: number): this;
name(value: string): this;
}

export interface UserRowInterface {
using(database: Db): this;
update(): Promise<void>;
delete(): Promise<void>;
deleteCascade(): Promise<void>;
has(column: string): boolean;
relLoaded(relation: string): boolean;
toObject(): Record<string, unknown>;
}

export interface ServiceInterface {
get(): Promise<ServiceRow | null>;
gets(): Promise<Collection<ServiceRow>>;
stream(visitor: (row: ServiceRow) => boolean | Promise<boolean>): Promise<StreamResult>;
getCount(): Promise<number>;
getsCount(): Promise<Collection<ServiceRow>>;
insert(): Promise<ServiceRow | null>;
save(): Promise<ServiceRow | null>;
update(): Promise<number>;
delete(): Promise<number>;
sql(): Promise<{ sql: string; binds: unknown[]; }>;
using(database: Db): this;
paginate(page: number, per: number): Promise<Page<ServiceRow>>;
getsBySeq(value: number): Promise<Collection<ServiceRow>>;
getsByName(value: string): Promise<Collection<ServiceRow>>;
getCountBySeq(value: number): Promise<number>;
getCountByName(value: string): Promise<number>;
seqEq(value: number): this;
nameEq(value: string): this;
seq(value: number): this;
name(value: string): this;
}

export interface ServiceRowInterface {
using(database: Db): this;
update(): Promise<void>;
delete(): Promise<void>;
deleteCascade(): Promise<void>;
has(column: string): boolean;
relLoaded(relation: string): boolean;
toObject(): Record<string, unknown>;
}

export interface ServiceModuleInterface {
get(): Promise<ServiceModuleRow | null>;
gets(): Promise<Collection<ServiceModuleRow>>;
stream(visitor: (row: ServiceModuleRow) => boolean | Promise<boolean>): Promise<StreamResult>;
getCount(): Promise<number>;
getsCount(): Promise<Collection<ServiceModuleRow>>;
insert(): Promise<ServiceModuleRow | null>;
save(): Promise<ServiceModuleRow | null>;
update(): Promise<number>;
delete(): Promise<number>;
sql(): Promise<{ sql: string; binds: unknown[]; }>;
using(database: Db): this;
paginate(page: number, per: number): Promise<Page<ServiceModuleRow>>;
getsBySeq(value: number): Promise<Collection<ServiceModuleRow>>;
getsByServiceSeq(value: number): Promise<Collection<ServiceModuleRow>>;
getsByName(value: string): Promise<Collection<ServiceModuleRow>>;
getCountBySeq(value: number): Promise<number>;
getCountByServiceSeq(value: number): Promise<number>;
getCountByName(value: string): Promise<number>;
seqEq(value: number): this;
serviceSeqEq(value: number): this;
nameEq(value: string): this;
seq(value: number): this;
serviceSeq(value: number): this;
name(value: string): this;
}

export interface ServiceModuleRowInterface {
using(database: Db): this;
update(): Promise<void>;
delete(): Promise<void>;
deleteCascade(): Promise<void>;
has(column: string): boolean;
relLoaded(relation: string): boolean;
toObject(): Record<string, unknown>;
}

export interface ServiceMemberInterface {
get(): Promise<ServiceMemberRow | null>;
gets(): Promise<Collection<ServiceMemberRow>>;
stream(visitor: (row: ServiceMemberRow) => boolean | Promise<boolean>): Promise<StreamResult>;
getCount(): Promise<number>;
getsCount(): Promise<Collection<ServiceMemberRow>>;
insert(): Promise<ServiceMemberRow | null>;
save(): Promise<ServiceMemberRow | null>;
update(): Promise<number>;
delete(): Promise<number>;
sql(): Promise<{ sql: string; binds: unknown[]; }>;
using(database: Db): this;
paginate(page: number, per: number): Promise<Page<ServiceMemberRow>>;
getsBySeq(value: number): Promise<Collection<ServiceMemberRow>>;
getsByServiceSeq(value: number): Promise<Collection<ServiceMemberRow>>;
getsByUserSeq(value: number): Promise<Collection<ServiceMemberRow>>;
getCountBySeq(value: number): Promise<number>;
getCountByServiceSeq(value: number): Promise<number>;
getCountByUserSeq(value: number): Promise<number>;
seqEq(value: number): this;
serviceSeqEq(value: number): this;
userSeqEq(value: number): this;
seq(value: number): this;
serviceSeq(value: number): this;
userSeq(value: number): this;
}

export interface ServiceMemberRowInterface {
using(database: Db): this;
update(): Promise<void>;
delete(): Promise<void>;
deleteCascade(): Promise<void>;
has(column: string): boolean;
relLoaded(relation: string): boolean;
toObject(): Record<string, unknown>;
}
