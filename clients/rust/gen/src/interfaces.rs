// Code generated from contracts/interfaces.json; DO NOT EDIT.
#![allow(unused_imports, unused_mut, async_fn_in_trait)]
use super::*;
use orm::{Collection, Page, Result};
use orm::db::{self, Exec};

pub trait AuthorInterface: Sized {
async fn get(&mut self) -> Result<Option<AuthorRow>>;
async fn gets(&mut self) -> Result<Collection<AuthorRow>>;
async fn stream(&mut self, visit: impl FnMut(AuthorRow) -> bool) -> Result<db::StreamResult>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<AuthorRow>>;
async fn aes_status(&self, keyring: &orm::aes_rotation::AesKeyring) -> Result<orm::aes_rotation::AesRotationStatus>;
async fn rotate_aes(&self, keyring: &orm::aes_rotation::AesKeyring) -> Result<u64>;
async fn insert(&mut self) -> Result<Option<AuthorRow>>;
async fn save(&mut self) -> Result<Option<AuthorRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn using(self, ex: &impl Exec) -> Self;
fn scope(self, v: i64) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<AuthorRow>>;
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<AuthorRow>>;
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>>;
async fn gets_by_description(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>>;
async fn gets_by_created_ts(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<AuthorRow>>;
async fn gets_by_updated_ts(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<AuthorRow>>;
async fn gets_by_is_close(&mut self, v: bool) -> Result<Collection<AuthorRow>>;
async fn gets_by_is_display(&mut self, v: bool) -> Result<Collection<AuthorRow>>;
async fn gets_by_display_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<AuthorRow>>;
async fn gets_by_display_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<AuthorRow>>;
async fn gets_by_is_allday(&mut self, v: bool) -> Result<Collection<AuthorRow>>;
async fn gets_by_target_club_reader_count(&mut self, v: i64) -> Result<Collection<AuthorRow>>;
async fn gets_by_success_count(&mut self, v: i64) -> Result<Collection<AuthorRow>>;
async fn gets_by_reader_count(&mut self, v: i64) -> Result<Collection<AuthorRow>>;
async fn gets_by_read_count(&mut self, v: i64) -> Result<Collection<AuthorRow>>;
async fn gets_by_photo_url(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>>;
async fn gets_by_user_seq(&mut self, v: i64) -> Result<Collection<AuthorRow>>;
async fn gets_by_service_seq(&mut self, v: i64) -> Result<Collection<AuthorRow>>;
async fn gets_by_service_region_seq(&mut self, v: i64) -> Result<Collection<AuthorRow>>;
async fn gets_by_service_member_seq(&mut self, v: i64) -> Result<Collection<AuthorRow>>;
async fn gets_by_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<AuthorRow>>;
async fn gets_by_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<AuthorRow>>;
async fn gets_by_uuid(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>>;
async fn gets_by_is_single_work(&mut self, v: bool) -> Result<Collection<AuthorRow>>;
async fn gets_by_like_count(&mut self, v: i64) -> Result<Collection<AuthorRow>>;
async fn gets_by_aes_key_version(&mut self, v: i32) -> Result<Collection<AuthorRow>>;
async fn gets_by_aes_hex_email(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>>;
async fn gets_by_aes_hex_phone(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>>;
async fn gets_by_price(&mut self, v: f64) -> Result<Collection<AuthorRow>>;
async fn gets_by_ip(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>>;
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64>;
async fn get_count_by_description(&mut self, v: impl Into<String>) -> Result<i64>;
async fn get_count_by_created_ts(&mut self, v: chrono::NaiveDateTime) -> Result<i64>;
async fn get_count_by_updated_ts(&mut self, v: chrono::NaiveDateTime) -> Result<i64>;
async fn get_count_by_is_close(&mut self, v: bool) -> Result<i64>;
async fn get_count_by_is_display(&mut self, v: bool) -> Result<i64>;
async fn get_count_by_display_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64>;
async fn get_count_by_display_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64>;
async fn get_count_by_is_allday(&mut self, v: bool) -> Result<i64>;
async fn get_count_by_target_club_reader_count(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_success_count(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_reader_count(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_read_count(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_photo_url(&mut self, v: impl Into<String>) -> Result<i64>;
async fn get_count_by_user_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_service_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_service_region_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_service_member_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64>;
async fn get_count_by_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64>;
async fn get_count_by_uuid(&mut self, v: impl Into<String>) -> Result<i64>;
async fn get_count_by_is_single_work(&mut self, v: bool) -> Result<i64>;
async fn get_count_by_like_count(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_aes_key_version(&mut self, v: i32) -> Result<i64>;
async fn get_count_by_aes_hex_email(&mut self, v: impl Into<String>) -> Result<i64>;
async fn get_count_by_aes_hex_phone(&mut self, v: impl Into<String>) -> Result<i64>;
async fn get_count_by_price(&mut self, v: f64) -> Result<i64>;
async fn get_count_by_ip(&mut self, v: impl Into<String>) -> Result<i64>;
fn seq_eq(self, v: i64) -> Self;
fn name_eq(self, v: impl Into<String>) -> Self;
fn description_eq(self, v: impl Into<String>) -> Self;
fn created_ts_eq(self, v: chrono::NaiveDateTime) -> Self;
fn updated_ts_eq(self, v: chrono::NaiveDateTime) -> Self;
fn is_close_eq(self, v: bool) -> Self;
fn is_display_eq(self, v: bool) -> Self;
fn display_start_dt_eq(self, v: chrono::NaiveDateTime) -> Self;
fn display_end_dt_eq(self, v: chrono::NaiveDateTime) -> Self;
fn is_allday_eq(self, v: bool) -> Self;
fn target_club_reader_count_eq(self, v: i64) -> Self;
fn success_count_eq(self, v: i64) -> Self;
fn reader_count_eq(self, v: i64) -> Self;
fn read_count_eq(self, v: i64) -> Self;
fn photo_url_eq(self, v: impl Into<String>) -> Self;
fn user_seq_eq(self, v: i64) -> Self;
fn service_seq_eq(self, v: i64) -> Self;
fn service_region_seq_eq(self, v: i64) -> Self;
fn service_member_seq_eq(self, v: i64) -> Self;
fn start_dt_eq(self, v: chrono::NaiveDateTime) -> Self;
fn end_dt_eq(self, v: chrono::NaiveDateTime) -> Self;
fn uuid_eq(self, v: impl Into<String>) -> Self;
fn is_single_work_eq(self, v: bool) -> Self;
fn like_count_eq(self, v: i64) -> Self;
fn aes_key_version_eq(self, v: i32) -> Self;
fn aes_hex_email_eq(self, v: impl Into<String>) -> Self;
fn aes_hex_phone_eq(self, v: impl Into<String>) -> Self;
fn price_eq(self, v: f64) -> Self;
fn ip_eq(self, v: impl Into<String>) -> Self;
fn seq(self, v: i64) -> Self;
fn name(self, v: impl Into<String>) -> Self;
fn description(self, v: impl Into<String>) -> Self;
fn created_ts(self, v: chrono::NaiveDateTime) -> Self;
fn updated_ts(self, v: chrono::NaiveDateTime) -> Self;
fn is_close(self, v: bool) -> Self;
fn is_display(self, v: bool) -> Self;
fn display_start_dt(self, v: chrono::NaiveDateTime) -> Self;
fn display_end_dt(self, v: chrono::NaiveDateTime) -> Self;
fn is_allday(self, v: bool) -> Self;
fn target_club_reader_count(self, v: i64) -> Self;
fn success_count(self, v: i64) -> Self;
fn reader_count(self, v: i64) -> Self;
fn read_count(self, v: i64) -> Self;
fn photo_url(self, v: impl Into<String>) -> Self;
fn user_seq(self, v: i64) -> Self;
fn service_seq(self, v: i64) -> Self;
fn service_region_seq(self, v: i64) -> Self;
fn service_member_seq(self, v: i64) -> Self;
fn start_dt(self, v: chrono::NaiveDateTime) -> Self;
fn end_dt(self, v: chrono::NaiveDateTime) -> Self;
fn uuid(self, v: impl Into<String>) -> Self;
fn is_single_work(self, v: bool) -> Self;
fn like_count(self, v: i64) -> Self;
fn aes_key_version(self, v: i32) -> Self;
fn aes_hex_email(self, v: impl Into<String>) -> Self;
fn aes_hex_phone(self, v: impl Into<String>) -> Self;
fn price(self, v: f64) -> Self;
fn ip(self, v: impl Into<String>) -> Self;
}
impl AuthorInterface for Author {
async fn get(&mut self) -> Result<Option<AuthorRow>> { Author::get(self).await }
async fn gets(&mut self) -> Result<Collection<AuthorRow>> { Author::gets(self).await }
async fn stream(&mut self, visit: impl FnMut(AuthorRow) -> bool) -> Result<db::StreamResult> { Author::stream(self,visit).await }
async fn get_count(&mut self) -> Result<i64> { Author::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<AuthorRow>> { Author::gets_count(self).await }
async fn aes_status(&self, keyring: &orm::aes_rotation::AesKeyring) -> Result<orm::aes_rotation::AesRotationStatus> { Author::aes_status(self,keyring).await }
async fn rotate_aes(&self, keyring: &orm::aes_rotation::AesKeyring) -> Result<u64> { Author::rotate_aes(self,keyring).await }
async fn insert(&mut self) -> Result<Option<AuthorRow>> { Author::insert(self).await }
async fn save(&mut self) -> Result<Option<AuthorRow>> { Author::save(self).await }
async fn update(&mut self) -> Result<u64> { Author::update(self).await }
async fn delete(&mut self) -> Result<u64> { Author::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { Author::sql(self).await }
fn using(mut self, ex: &impl Exec) -> Self { Author::using(self,ex) }
fn scope(mut self, v: i64) -> Self { Author::scope(self,v) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<AuthorRow>> { Author::paginate(self,page,per).await }
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<AuthorRow>> { Author::gets_by_seq(self,v).await }
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>> { Author::gets_by_name(self,v).await }
async fn gets_by_description(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>> { Author::gets_by_description(self,v).await }
async fn gets_by_created_ts(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<AuthorRow>> { Author::gets_by_created_ts(self,v).await }
async fn gets_by_updated_ts(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<AuthorRow>> { Author::gets_by_updated_ts(self,v).await }
async fn gets_by_is_close(&mut self, v: bool) -> Result<Collection<AuthorRow>> { Author::gets_by_is_close(self,v).await }
async fn gets_by_is_display(&mut self, v: bool) -> Result<Collection<AuthorRow>> { Author::gets_by_is_display(self,v).await }
async fn gets_by_display_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<AuthorRow>> { Author::gets_by_display_start_dt(self,v).await }
async fn gets_by_display_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<AuthorRow>> { Author::gets_by_display_end_dt(self,v).await }
async fn gets_by_is_allday(&mut self, v: bool) -> Result<Collection<AuthorRow>> { Author::gets_by_is_allday(self,v).await }
async fn gets_by_target_club_reader_count(&mut self, v: i64) -> Result<Collection<AuthorRow>> { Author::gets_by_target_club_reader_count(self,v).await }
async fn gets_by_success_count(&mut self, v: i64) -> Result<Collection<AuthorRow>> { Author::gets_by_success_count(self,v).await }
async fn gets_by_reader_count(&mut self, v: i64) -> Result<Collection<AuthorRow>> { Author::gets_by_reader_count(self,v).await }
async fn gets_by_read_count(&mut self, v: i64) -> Result<Collection<AuthorRow>> { Author::gets_by_read_count(self,v).await }
async fn gets_by_photo_url(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>> { Author::gets_by_photo_url(self,v).await }
async fn gets_by_user_seq(&mut self, v: i64) -> Result<Collection<AuthorRow>> { Author::gets_by_user_seq(self,v).await }
async fn gets_by_service_seq(&mut self, v: i64) -> Result<Collection<AuthorRow>> { Author::gets_by_service_seq(self,v).await }
async fn gets_by_service_region_seq(&mut self, v: i64) -> Result<Collection<AuthorRow>> { Author::gets_by_service_region_seq(self,v).await }
async fn gets_by_service_member_seq(&mut self, v: i64) -> Result<Collection<AuthorRow>> { Author::gets_by_service_member_seq(self,v).await }
async fn gets_by_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<AuthorRow>> { Author::gets_by_start_dt(self,v).await }
async fn gets_by_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<AuthorRow>> { Author::gets_by_end_dt(self,v).await }
async fn gets_by_uuid(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>> { Author::gets_by_uuid(self,v).await }
async fn gets_by_is_single_work(&mut self, v: bool) -> Result<Collection<AuthorRow>> { Author::gets_by_is_single_work(self,v).await }
async fn gets_by_like_count(&mut self, v: i64) -> Result<Collection<AuthorRow>> { Author::gets_by_like_count(self,v).await }
async fn gets_by_aes_key_version(&mut self, v: i32) -> Result<Collection<AuthorRow>> { Author::gets_by_aes_key_version(self,v).await }
async fn gets_by_aes_hex_email(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>> { Author::gets_by_aes_hex_email(self,v).await }
async fn gets_by_aes_hex_phone(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>> { Author::gets_by_aes_hex_phone(self,v).await }
async fn gets_by_price(&mut self, v: f64) -> Result<Collection<AuthorRow>> { Author::gets_by_price(self,v).await }
async fn gets_by_ip(&mut self, v: impl Into<String>) -> Result<Collection<AuthorRow>> { Author::gets_by_ip(self,v).await }
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64> { Author::get_count_by_seq(self,v).await }
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64> { Author::get_count_by_name(self,v).await }
async fn get_count_by_description(&mut self, v: impl Into<String>) -> Result<i64> { Author::get_count_by_description(self,v).await }
async fn get_count_by_created_ts(&mut self, v: chrono::NaiveDateTime) -> Result<i64> { Author::get_count_by_created_ts(self,v).await }
async fn get_count_by_updated_ts(&mut self, v: chrono::NaiveDateTime) -> Result<i64> { Author::get_count_by_updated_ts(self,v).await }
async fn get_count_by_is_close(&mut self, v: bool) -> Result<i64> { Author::get_count_by_is_close(self,v).await }
async fn get_count_by_is_display(&mut self, v: bool) -> Result<i64> { Author::get_count_by_is_display(self,v).await }
async fn get_count_by_display_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64> { Author::get_count_by_display_start_dt(self,v).await }
async fn get_count_by_display_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64> { Author::get_count_by_display_end_dt(self,v).await }
async fn get_count_by_is_allday(&mut self, v: bool) -> Result<i64> { Author::get_count_by_is_allday(self,v).await }
async fn get_count_by_target_club_reader_count(&mut self, v: i64) -> Result<i64> { Author::get_count_by_target_club_reader_count(self,v).await }
async fn get_count_by_success_count(&mut self, v: i64) -> Result<i64> { Author::get_count_by_success_count(self,v).await }
async fn get_count_by_reader_count(&mut self, v: i64) -> Result<i64> { Author::get_count_by_reader_count(self,v).await }
async fn get_count_by_read_count(&mut self, v: i64) -> Result<i64> { Author::get_count_by_read_count(self,v).await }
async fn get_count_by_photo_url(&mut self, v: impl Into<String>) -> Result<i64> { Author::get_count_by_photo_url(self,v).await }
async fn get_count_by_user_seq(&mut self, v: i64) -> Result<i64> { Author::get_count_by_user_seq(self,v).await }
async fn get_count_by_service_seq(&mut self, v: i64) -> Result<i64> { Author::get_count_by_service_seq(self,v).await }
async fn get_count_by_service_region_seq(&mut self, v: i64) -> Result<i64> { Author::get_count_by_service_region_seq(self,v).await }
async fn get_count_by_service_member_seq(&mut self, v: i64) -> Result<i64> { Author::get_count_by_service_member_seq(self,v).await }
async fn get_count_by_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64> { Author::get_count_by_start_dt(self,v).await }
async fn get_count_by_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64> { Author::get_count_by_end_dt(self,v).await }
async fn get_count_by_uuid(&mut self, v: impl Into<String>) -> Result<i64> { Author::get_count_by_uuid(self,v).await }
async fn get_count_by_is_single_work(&mut self, v: bool) -> Result<i64> { Author::get_count_by_is_single_work(self,v).await }
async fn get_count_by_like_count(&mut self, v: i64) -> Result<i64> { Author::get_count_by_like_count(self,v).await }
async fn get_count_by_aes_key_version(&mut self, v: i32) -> Result<i64> { Author::get_count_by_aes_key_version(self,v).await }
async fn get_count_by_aes_hex_email(&mut self, v: impl Into<String>) -> Result<i64> { Author::get_count_by_aes_hex_email(self,v).await }
async fn get_count_by_aes_hex_phone(&mut self, v: impl Into<String>) -> Result<i64> { Author::get_count_by_aes_hex_phone(self,v).await }
async fn get_count_by_price(&mut self, v: f64) -> Result<i64> { Author::get_count_by_price(self,v).await }
async fn get_count_by_ip(&mut self, v: impl Into<String>) -> Result<i64> { Author::get_count_by_ip(self,v).await }
fn seq_eq(mut self, v: i64) -> Self { Author::seq_eq(self,v) }
fn name_eq(mut self, v: impl Into<String>) -> Self { Author::name_eq(self,v) }
fn description_eq(mut self, v: impl Into<String>) -> Self { Author::description_eq(self,v) }
fn created_ts_eq(mut self, v: chrono::NaiveDateTime) -> Self { Author::created_ts_eq(self,v) }
fn updated_ts_eq(mut self, v: chrono::NaiveDateTime) -> Self { Author::updated_ts_eq(self,v) }
fn is_close_eq(mut self, v: bool) -> Self { Author::is_close_eq(self,v) }
fn is_display_eq(mut self, v: bool) -> Self { Author::is_display_eq(self,v) }
fn display_start_dt_eq(mut self, v: chrono::NaiveDateTime) -> Self { Author::display_start_dt_eq(self,v) }
fn display_end_dt_eq(mut self, v: chrono::NaiveDateTime) -> Self { Author::display_end_dt_eq(self,v) }
fn is_allday_eq(mut self, v: bool) -> Self { Author::is_allday_eq(self,v) }
fn target_club_reader_count_eq(mut self, v: i64) -> Self { Author::target_club_reader_count_eq(self,v) }
fn success_count_eq(mut self, v: i64) -> Self { Author::success_count_eq(self,v) }
fn reader_count_eq(mut self, v: i64) -> Self { Author::reader_count_eq(self,v) }
fn read_count_eq(mut self, v: i64) -> Self { Author::read_count_eq(self,v) }
fn photo_url_eq(mut self, v: impl Into<String>) -> Self { Author::photo_url_eq(self,v) }
fn user_seq_eq(mut self, v: i64) -> Self { Author::user_seq_eq(self,v) }
fn service_seq_eq(mut self, v: i64) -> Self { Author::service_seq_eq(self,v) }
fn service_region_seq_eq(mut self, v: i64) -> Self { Author::service_region_seq_eq(self,v) }
fn service_member_seq_eq(mut self, v: i64) -> Self { Author::service_member_seq_eq(self,v) }
fn start_dt_eq(mut self, v: chrono::NaiveDateTime) -> Self { Author::start_dt_eq(self,v) }
fn end_dt_eq(mut self, v: chrono::NaiveDateTime) -> Self { Author::end_dt_eq(self,v) }
fn uuid_eq(mut self, v: impl Into<String>) -> Self { Author::uuid_eq(self,v) }
fn is_single_work_eq(mut self, v: bool) -> Self { Author::is_single_work_eq(self,v) }
fn like_count_eq(mut self, v: i64) -> Self { Author::like_count_eq(self,v) }
fn aes_key_version_eq(mut self, v: i32) -> Self { Author::aes_key_version_eq(self,v) }
fn aes_hex_email_eq(mut self, v: impl Into<String>) -> Self { Author::aes_hex_email_eq(self,v) }
fn aes_hex_phone_eq(mut self, v: impl Into<String>) -> Self { Author::aes_hex_phone_eq(self,v) }
fn price_eq(mut self, v: f64) -> Self { Author::price_eq(self,v) }
fn ip_eq(mut self, v: impl Into<String>) -> Self { Author::ip_eq(self,v) }
fn seq(self, v: i64) -> Self { Author::seq(self,v) }
fn name(self, v: impl Into<String>) -> Self { Author::name(self,v) }
fn description(self, v: impl Into<String>) -> Self { Author::description(self,v) }
fn created_ts(self, v: chrono::NaiveDateTime) -> Self { Author::created_ts(self,v) }
fn updated_ts(self, v: chrono::NaiveDateTime) -> Self { Author::updated_ts(self,v) }
fn is_close(self, v: bool) -> Self { Author::is_close(self,v) }
fn is_display(self, v: bool) -> Self { Author::is_display(self,v) }
fn display_start_dt(self, v: chrono::NaiveDateTime) -> Self { Author::display_start_dt(self,v) }
fn display_end_dt(self, v: chrono::NaiveDateTime) -> Self { Author::display_end_dt(self,v) }
fn is_allday(self, v: bool) -> Self { Author::is_allday(self,v) }
fn target_club_reader_count(self, v: i64) -> Self { Author::target_club_reader_count(self,v) }
fn success_count(self, v: i64) -> Self { Author::success_count(self,v) }
fn reader_count(self, v: i64) -> Self { Author::reader_count(self,v) }
fn read_count(self, v: i64) -> Self { Author::read_count(self,v) }
fn photo_url(self, v: impl Into<String>) -> Self { Author::photo_url(self,v) }
fn user_seq(self, v: i64) -> Self { Author::user_seq(self,v) }
fn service_seq(self, v: i64) -> Self { Author::service_seq(self,v) }
fn service_region_seq(self, v: i64) -> Self { Author::service_region_seq(self,v) }
fn service_member_seq(self, v: i64) -> Self { Author::service_member_seq(self,v) }
fn start_dt(self, v: chrono::NaiveDateTime) -> Self { Author::start_dt(self,v) }
fn end_dt(self, v: chrono::NaiveDateTime) -> Self { Author::end_dt(self,v) }
fn uuid(self, v: impl Into<String>) -> Self { Author::uuid(self,v) }
fn is_single_work(self, v: bool) -> Self { Author::is_single_work(self,v) }
fn like_count(self, v: i64) -> Self { Author::like_count(self,v) }
fn aes_key_version(self, v: i32) -> Self { Author::aes_key_version(self,v) }
fn aes_hex_email(self, v: impl Into<String>) -> Self { Author::aes_hex_email(self,v) }
fn aes_hex_phone(self, v: impl Into<String>) -> Self { Author::aes_hex_phone(self,v) }
fn price(self, v: f64) -> Self { Author::price(self,v) }
fn ip(self, v: impl Into<String>) -> Self { Author::ip(self,v) }
}

pub trait AuthorRowInterface: Sized {
fn using(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn update_optimistic(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> Result<serde_json::Value>;
}
impl AuthorRowInterface for AuthorRow {
fn using(&mut self, ex: &impl Exec) -> &mut Self { AuthorRow::using(self,ex) }
async fn update(&mut self) -> Result<()> { AuthorRow::update(self).await }
async fn update_optimistic(&mut self) -> Result<()> { AuthorRow::update_optimistic(self).await }
async fn delete(&self) -> Result<()> { AuthorRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { AuthorRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { AuthorRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { AuthorRow::rel_loaded(self,name) }
fn to_map(&self) -> Result<serde_json::Value> { AuthorRow::to_map(self) }
}

pub trait UserInterface: Sized {
async fn get(&mut self) -> Result<Option<UserRow>>;
async fn gets(&mut self) -> Result<Collection<UserRow>>;
async fn stream(&mut self, visit: impl FnMut(UserRow) -> bool) -> Result<db::StreamResult>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<UserRow>>;
async fn insert(&mut self) -> Result<Option<UserRow>>;
async fn save(&mut self) -> Result<Option<UserRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn using(self, ex: &impl Exec) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<UserRow>>;
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<UserRow>>;
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<UserRow>>;
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64>;
fn seq_eq(self, v: i64) -> Self;
fn name_eq(self, v: impl Into<String>) -> Self;
fn seq(self, v: i64) -> Self;
fn name(self, v: impl Into<String>) -> Self;
}
impl UserInterface for User {
async fn get(&mut self) -> Result<Option<UserRow>> { User::get(self).await }
async fn gets(&mut self) -> Result<Collection<UserRow>> { User::gets(self).await }
async fn stream(&mut self, visit: impl FnMut(UserRow) -> bool) -> Result<db::StreamResult> { User::stream(self,visit).await }
async fn get_count(&mut self) -> Result<i64> { User::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<UserRow>> { User::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<UserRow>> { User::insert(self).await }
async fn save(&mut self) -> Result<Option<UserRow>> { User::save(self).await }
async fn update(&mut self) -> Result<u64> { User::update(self).await }
async fn delete(&mut self) -> Result<u64> { User::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { User::sql(self).await }
fn using(mut self, ex: &impl Exec) -> Self { User::using(self,ex) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<UserRow>> { User::paginate(self,page,per).await }
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<UserRow>> { User::gets_by_seq(self,v).await }
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<UserRow>> { User::gets_by_name(self,v).await }
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64> { User::get_count_by_seq(self,v).await }
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64> { User::get_count_by_name(self,v).await }
fn seq_eq(mut self, v: i64) -> Self { User::seq_eq(self,v) }
fn name_eq(mut self, v: impl Into<String>) -> Self { User::name_eq(self,v) }
fn seq(self, v: i64) -> Self { User::seq(self,v) }
fn name(self, v: impl Into<String>) -> Self { User::name(self,v) }
}

pub trait UserRowInterface: Sized {
fn using(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> Result<serde_json::Value>;
}
impl UserRowInterface for UserRow {
fn using(&mut self, ex: &impl Exec) -> &mut Self { UserRow::using(self,ex) }
async fn update(&mut self) -> Result<()> { UserRow::update(self).await }
async fn delete(&self) -> Result<()> { UserRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { UserRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { UserRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { UserRow::rel_loaded(self,name) }
fn to_map(&self) -> Result<serde_json::Value> { UserRow::to_map(self) }
}

pub trait ServiceInterface: Sized {
async fn get(&mut self) -> Result<Option<ServiceRow>>;
async fn gets(&mut self) -> Result<Collection<ServiceRow>>;
async fn stream(&mut self, visit: impl FnMut(ServiceRow) -> bool) -> Result<db::StreamResult>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<ServiceRow>>;
async fn insert(&mut self) -> Result<Option<ServiceRow>>;
async fn save(&mut self) -> Result<Option<ServiceRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn using(self, ex: &impl Exec) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<ServiceRow>>;
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<ServiceRow>>;
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<ServiceRow>>;
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64>;
fn seq_eq(self, v: i64) -> Self;
fn name_eq(self, v: impl Into<String>) -> Self;
fn seq(self, v: i64) -> Self;
fn name(self, v: impl Into<String>) -> Self;
}
impl ServiceInterface for Service {
async fn get(&mut self) -> Result<Option<ServiceRow>> { Service::get(self).await }
async fn gets(&mut self) -> Result<Collection<ServiceRow>> { Service::gets(self).await }
async fn stream(&mut self, visit: impl FnMut(ServiceRow) -> bool) -> Result<db::StreamResult> { Service::stream(self,visit).await }
async fn get_count(&mut self) -> Result<i64> { Service::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<ServiceRow>> { Service::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<ServiceRow>> { Service::insert(self).await }
async fn save(&mut self) -> Result<Option<ServiceRow>> { Service::save(self).await }
async fn update(&mut self) -> Result<u64> { Service::update(self).await }
async fn delete(&mut self) -> Result<u64> { Service::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { Service::sql(self).await }
fn using(mut self, ex: &impl Exec) -> Self { Service::using(self,ex) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<ServiceRow>> { Service::paginate(self,page,per).await }
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<ServiceRow>> { Service::gets_by_seq(self,v).await }
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<ServiceRow>> { Service::gets_by_name(self,v).await }
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64> { Service::get_count_by_seq(self,v).await }
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64> { Service::get_count_by_name(self,v).await }
fn seq_eq(mut self, v: i64) -> Self { Service::seq_eq(self,v) }
fn name_eq(mut self, v: impl Into<String>) -> Self { Service::name_eq(self,v) }
fn seq(self, v: i64) -> Self { Service::seq(self,v) }
fn name(self, v: impl Into<String>) -> Self { Service::name(self,v) }
}

pub trait ServiceRowInterface: Sized {
fn using(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> Result<serde_json::Value>;
}
impl ServiceRowInterface for ServiceRow {
fn using(&mut self, ex: &impl Exec) -> &mut Self { ServiceRow::using(self,ex) }
async fn update(&mut self) -> Result<()> { ServiceRow::update(self).await }
async fn delete(&self) -> Result<()> { ServiceRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { ServiceRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { ServiceRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { ServiceRow::rel_loaded(self,name) }
fn to_map(&self) -> Result<serde_json::Value> { ServiceRow::to_map(self) }
}

pub trait ServiceRegionInterface: Sized {
async fn get(&mut self) -> Result<Option<ServiceRegionRow>>;
async fn gets(&mut self) -> Result<Collection<ServiceRegionRow>>;
async fn stream(&mut self, visit: impl FnMut(ServiceRegionRow) -> bool) -> Result<db::StreamResult>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<ServiceRegionRow>>;
async fn insert(&mut self) -> Result<Option<ServiceRegionRow>>;
async fn save(&mut self) -> Result<Option<ServiceRegionRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn using(self, ex: &impl Exec) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<ServiceRegionRow>>;
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<ServiceRegionRow>>;
async fn gets_by_service_seq(&mut self, v: i64) -> Result<Collection<ServiceRegionRow>>;
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<ServiceRegionRow>>;
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_service_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64>;
fn seq_eq(self, v: i64) -> Self;
fn service_seq_eq(self, v: i64) -> Self;
fn name_eq(self, v: impl Into<String>) -> Self;
fn seq(self, v: i64) -> Self;
fn service_seq(self, v: i64) -> Self;
fn name(self, v: impl Into<String>) -> Self;
}
impl ServiceRegionInterface for ServiceRegion {
async fn get(&mut self) -> Result<Option<ServiceRegionRow>> { ServiceRegion::get(self).await }
async fn gets(&mut self) -> Result<Collection<ServiceRegionRow>> { ServiceRegion::gets(self).await }
async fn stream(&mut self, visit: impl FnMut(ServiceRegionRow) -> bool) -> Result<db::StreamResult> { ServiceRegion::stream(self,visit).await }
async fn get_count(&mut self) -> Result<i64> { ServiceRegion::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<ServiceRegionRow>> { ServiceRegion::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<ServiceRegionRow>> { ServiceRegion::insert(self).await }
async fn save(&mut self) -> Result<Option<ServiceRegionRow>> { ServiceRegion::save(self).await }
async fn update(&mut self) -> Result<u64> { ServiceRegion::update(self).await }
async fn delete(&mut self) -> Result<u64> { ServiceRegion::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { ServiceRegion::sql(self).await }
fn using(mut self, ex: &impl Exec) -> Self { ServiceRegion::using(self,ex) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<ServiceRegionRow>> { ServiceRegion::paginate(self,page,per).await }
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<ServiceRegionRow>> { ServiceRegion::gets_by_seq(self,v).await }
async fn gets_by_service_seq(&mut self, v: i64) -> Result<Collection<ServiceRegionRow>> { ServiceRegion::gets_by_service_seq(self,v).await }
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<ServiceRegionRow>> { ServiceRegion::gets_by_name(self,v).await }
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64> { ServiceRegion::get_count_by_seq(self,v).await }
async fn get_count_by_service_seq(&mut self, v: i64) -> Result<i64> { ServiceRegion::get_count_by_service_seq(self,v).await }
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64> { ServiceRegion::get_count_by_name(self,v).await }
fn seq_eq(mut self, v: i64) -> Self { ServiceRegion::seq_eq(self,v) }
fn service_seq_eq(mut self, v: i64) -> Self { ServiceRegion::service_seq_eq(self,v) }
fn name_eq(mut self, v: impl Into<String>) -> Self { ServiceRegion::name_eq(self,v) }
fn seq(self, v: i64) -> Self { ServiceRegion::seq(self,v) }
fn service_seq(self, v: i64) -> Self { ServiceRegion::service_seq(self,v) }
fn name(self, v: impl Into<String>) -> Self { ServiceRegion::name(self,v) }
}

pub trait ServiceRegionRowInterface: Sized {
fn using(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> Result<serde_json::Value>;
}
impl ServiceRegionRowInterface for ServiceRegionRow {
fn using(&mut self, ex: &impl Exec) -> &mut Self { ServiceRegionRow::using(self,ex) }
async fn update(&mut self) -> Result<()> { ServiceRegionRow::update(self).await }
async fn delete(&self) -> Result<()> { ServiceRegionRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { ServiceRegionRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { ServiceRegionRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { ServiceRegionRow::rel_loaded(self,name) }
fn to_map(&self) -> Result<serde_json::Value> { ServiceRegionRow::to_map(self) }
}

pub trait ServiceMemberInterface: Sized {
async fn get(&mut self) -> Result<Option<ServiceMemberRow>>;
async fn gets(&mut self) -> Result<Collection<ServiceMemberRow>>;
async fn stream(&mut self, visit: impl FnMut(ServiceMemberRow) -> bool) -> Result<db::StreamResult>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<ServiceMemberRow>>;
async fn insert(&mut self) -> Result<Option<ServiceMemberRow>>;
async fn save(&mut self) -> Result<Option<ServiceMemberRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn using(self, ex: &impl Exec) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<ServiceMemberRow>>;
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<ServiceMemberRow>>;
async fn gets_by_service_seq(&mut self, v: i64) -> Result<Collection<ServiceMemberRow>>;
async fn gets_by_user_seq(&mut self, v: i64) -> Result<Collection<ServiceMemberRow>>;
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_service_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_user_seq(&mut self, v: i64) -> Result<i64>;
fn seq_eq(self, v: i64) -> Self;
fn service_seq_eq(self, v: i64) -> Self;
fn user_seq_eq(self, v: i64) -> Self;
fn seq(self, v: i64) -> Self;
fn service_seq(self, v: i64) -> Self;
fn user_seq(self, v: i64) -> Self;
}
impl ServiceMemberInterface for ServiceMember {
async fn get(&mut self) -> Result<Option<ServiceMemberRow>> { ServiceMember::get(self).await }
async fn gets(&mut self) -> Result<Collection<ServiceMemberRow>> { ServiceMember::gets(self).await }
async fn stream(&mut self, visit: impl FnMut(ServiceMemberRow) -> bool) -> Result<db::StreamResult> { ServiceMember::stream(self,visit).await }
async fn get_count(&mut self) -> Result<i64> { ServiceMember::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<ServiceMemberRow>> { ServiceMember::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<ServiceMemberRow>> { ServiceMember::insert(self).await }
async fn save(&mut self) -> Result<Option<ServiceMemberRow>> { ServiceMember::save(self).await }
async fn update(&mut self) -> Result<u64> { ServiceMember::update(self).await }
async fn delete(&mut self) -> Result<u64> { ServiceMember::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { ServiceMember::sql(self).await }
fn using(mut self, ex: &impl Exec) -> Self { ServiceMember::using(self,ex) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<ServiceMemberRow>> { ServiceMember::paginate(self,page,per).await }
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<ServiceMemberRow>> { ServiceMember::gets_by_seq(self,v).await }
async fn gets_by_service_seq(&mut self, v: i64) -> Result<Collection<ServiceMemberRow>> { ServiceMember::gets_by_service_seq(self,v).await }
async fn gets_by_user_seq(&mut self, v: i64) -> Result<Collection<ServiceMemberRow>> { ServiceMember::gets_by_user_seq(self,v).await }
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64> { ServiceMember::get_count_by_seq(self,v).await }
async fn get_count_by_service_seq(&mut self, v: i64) -> Result<i64> { ServiceMember::get_count_by_service_seq(self,v).await }
async fn get_count_by_user_seq(&mut self, v: i64) -> Result<i64> { ServiceMember::get_count_by_user_seq(self,v).await }
fn seq_eq(mut self, v: i64) -> Self { ServiceMember::seq_eq(self,v) }
fn service_seq_eq(mut self, v: i64) -> Self { ServiceMember::service_seq_eq(self,v) }
fn user_seq_eq(mut self, v: i64) -> Self { ServiceMember::user_seq_eq(self,v) }
fn seq(self, v: i64) -> Self { ServiceMember::seq(self,v) }
fn service_seq(self, v: i64) -> Self { ServiceMember::service_seq(self,v) }
fn user_seq(self, v: i64) -> Self { ServiceMember::user_seq(self,v) }
}

pub trait ServiceMemberRowInterface: Sized {
fn using(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> Result<serde_json::Value>;
}
impl ServiceMemberRowInterface for ServiceMemberRow {
fn using(&mut self, ex: &impl Exec) -> &mut Self { ServiceMemberRow::using(self,ex) }
async fn update(&mut self) -> Result<()> { ServiceMemberRow::update(self).await }
async fn delete(&self) -> Result<()> { ServiceMemberRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { ServiceMemberRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { ServiceMemberRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { ServiceMemberRow::rel_loaded(self,name) }
fn to_map(&self) -> Result<serde_json::Value> { ServiceMemberRow::to_map(self) }
}
