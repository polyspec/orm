// Code generated from contracts/interfaces.json; DO NOT EDIT.
import type { Collection, Page } from '../model.js';
import type { Db } from '../database.js';
import type { Point } from '../codec.js';
import type { AesKeyring, AesRotationStatus } from '../index.js';
import type { AuthorRow, UserRow, ServiceRow, ServiceRegionRow, ServiceMemberRow } from './entities.js';

export interface AuthorInterface {
get(): Promise<AuthorRow | null>;
gets(): Promise<Collection<AuthorRow>>;
getCount(): Promise<number>;
getsCount(): Promise<Collection<AuthorRow>>;
aesStatus(keyring: AesKeyring): Promise<AesRotationStatus>;
rotateAES(keyring: AesKeyring): Promise<number>;
insert(): Promise<AuthorRow | null>;
save(): Promise<AuthorRow | null>;
update(): Promise<number>;
delete(): Promise<number>;
sql(): Promise<{ sql: string; binds: unknown[]; }>;
using(database: Db): this;
scope(value: number): this;
paginate(page: number, per: number): Promise<Page<AuthorRow>>;
getsBySeq(value: number): Promise<Collection<AuthorRow>>;
getsByName(value: string): Promise<Collection<AuthorRow>>;
getsByDescription(value: string): Promise<Collection<AuthorRow>>;
getsByCreatedTs(value: string | Date): Promise<Collection<AuthorRow>>;
getsByUpdatedTs(value: string | Date): Promise<Collection<AuthorRow>>;
getsByIsClose(value: boolean): Promise<Collection<AuthorRow>>;
getsByIsDisplay(value: boolean): Promise<Collection<AuthorRow>>;
getsByDisplayStartDt(value: string | Date): Promise<Collection<AuthorRow>>;
getsByDisplayEndDt(value: string | Date): Promise<Collection<AuthorRow>>;
getsByIsAllday(value: boolean): Promise<Collection<AuthorRow>>;
getsByTargetClubReaderCount(value: number): Promise<Collection<AuthorRow>>;
getsBySuccessCount(value: number): Promise<Collection<AuthorRow>>;
getsByReaderCount(value: number): Promise<Collection<AuthorRow>>;
getsByReadCount(value: number): Promise<Collection<AuthorRow>>;
getsByPhotoUrl(value: string): Promise<Collection<AuthorRow>>;
getsByUserSeq(value: number): Promise<Collection<AuthorRow>>;
getsByServiceSeq(value: number): Promise<Collection<AuthorRow>>;
getsByServiceRegionSeq(value: number): Promise<Collection<AuthorRow>>;
getsByServiceMemberSeq(value: number): Promise<Collection<AuthorRow>>;
getsByStartDt(value: string | Date): Promise<Collection<AuthorRow>>;
getsByEndDt(value: string | Date): Promise<Collection<AuthorRow>>;
getsByUuid(value: string): Promise<Collection<AuthorRow>>;
getsByIsSingleWork(value: boolean): Promise<Collection<AuthorRow>>;
getsByLikeCount(value: number): Promise<Collection<AuthorRow>>;
getsByAesKeyVersion(value: number): Promise<Collection<AuthorRow>>;
getsByAesHexEmail(value: string): Promise<Collection<AuthorRow>>;
getsByAesHexPhone(value: string): Promise<Collection<AuthorRow>>;
getsByPrice(value: number): Promise<Collection<AuthorRow>>;
getsByIp(value: string): Promise<Collection<AuthorRow>>;
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
getCountByTargetClubReaderCount(value: number): Promise<number>;
getCountBySuccessCount(value: number): Promise<number>;
getCountByReaderCount(value: number): Promise<number>;
getCountByReadCount(value: number): Promise<number>;
getCountByPhotoUrl(value: string): Promise<number>;
getCountByUserSeq(value: number): Promise<number>;
getCountByServiceSeq(value: number): Promise<number>;
getCountByServiceRegionSeq(value: number): Promise<number>;
getCountByServiceMemberSeq(value: number): Promise<number>;
getCountByStartDt(value: string | Date): Promise<number>;
getCountByEndDt(value: string | Date): Promise<number>;
getCountByUuid(value: string): Promise<number>;
getCountByIsSingleWork(value: boolean): Promise<number>;
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
targetClubReaderCountEq(value: number): this;
successCountEq(value: number): this;
readerCountEq(value: number): this;
readCountEq(value: number): this;
photoUrlEq(value: string): this;
userSeqEq(value: number): this;
serviceSeqEq(value: number): this;
serviceRegionSeqEq(value: number): this;
serviceMemberSeqEq(value: number): this;
startDtEq(value: string | Date): this;
endDtEq(value: string | Date): this;
uuidEq(value: string): this;
isSingleWorkEq(value: boolean): this;
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
targetClubReaderCount(value: number): this;
successCount(value: number): this;
readerCount(value: number): this;
readCount(value: number): this;
photoUrl(value: string): this;
userSeq(value: number): this;
serviceSeq(value: number): this;
serviceRegionSeq(value: number): this;
serviceMemberSeq(value: number): this;
startDt(value: string | Date): this;
endDt(value: string | Date): this;
uuid(value: string): this;
isSingleWork(value: boolean): this;
likeCount(value: number): this;
aesKeyVersion(value: number): this;
aesHexEmail(value: string): this;
aesHexPhone(value: string): this;
price(value: number): this;
ip(value: string): this;
}

export interface AuthorRowInterface {
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

export interface ServiceRegionInterface {
get(): Promise<ServiceRegionRow | null>;
gets(): Promise<Collection<ServiceRegionRow>>;
getCount(): Promise<number>;
getsCount(): Promise<Collection<ServiceRegionRow>>;
insert(): Promise<ServiceRegionRow | null>;
save(): Promise<ServiceRegionRow | null>;
update(): Promise<number>;
delete(): Promise<number>;
sql(): Promise<{ sql: string; binds: unknown[]; }>;
using(database: Db): this;
paginate(page: number, per: number): Promise<Page<ServiceRegionRow>>;
getsBySeq(value: number): Promise<Collection<ServiceRegionRow>>;
getsByServiceSeq(value: number): Promise<Collection<ServiceRegionRow>>;
getsByName(value: string): Promise<Collection<ServiceRegionRow>>;
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

export interface ServiceRegionRowInterface {
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
