// Code generated from contracts/interfaces.json; DO NOT EDIT.
#![allow(unused_imports, unused_mut, async_fn_in_trait)]
use super::*;
use orm::{Collection, KeysetPage, Page, Result};
use orm::db::{self, Exec};

pub trait BattleInterface: Sized {
async fn get(&mut self) -> Result<BattleRow>;
async fn get_or_none(&mut self) -> Result<Option<BattleRow>>;
async fn gets(&mut self) -> Result<Collection<BattleRow>>;
async fn stream(&mut self, visit: impl FnMut(BattleRow) -> bool) -> Result<db::StreamResult>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<BattleRow>>;
async fn aes_status(&self, keyring: &orm::aes_rotation::AesKeyring) -> Result<orm::aes_rotation::AesRotationStatus>;
async fn rotate_aes(&self, keyring: &orm::aes_rotation::AesKeyring) -> Result<u64>;
async fn insert(&mut self) -> Result<Option<BattleRow>>;
async fn save(&mut self) -> Result<Option<BattleRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn using(self, ex: &impl Exec) -> Self;
fn scope(self, v: i64) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<BattleRow>>;
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<BattleRow>>;
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<BattleRow>>;
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<BattleRow>>;
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>>;
async fn gets_by_description(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>>;
async fn gets_by_created_ts(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<BattleRow>>;
async fn gets_by_updated_ts(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<BattleRow>>;
async fn gets_by_is_close(&mut self, v: bool) -> Result<Collection<BattleRow>>;
async fn gets_by_is_display(&mut self, v: bool) -> Result<Collection<BattleRow>>;
async fn gets_by_display_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<BattleRow>>;
async fn gets_by_display_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<BattleRow>>;
async fn gets_by_is_allday(&mut self, v: bool) -> Result<Collection<BattleRow>>;
async fn gets_by_target_team_player_count(&mut self, v: i64) -> Result<Collection<BattleRow>>;
async fn gets_by_success_count(&mut self, v: i64) -> Result<Collection<BattleRow>>;
async fn gets_by_player_count(&mut self, v: i64) -> Result<Collection<BattleRow>>;
async fn gets_by_read_count(&mut self, v: i64) -> Result<Collection<BattleRow>>;
async fn gets_by_cover_url(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>>;
async fn gets_by_user_seq(&mut self, v: i64) -> Result<Collection<BattleRow>>;
async fn gets_by_service_seq(&mut self, v: i64) -> Result<Collection<BattleRow>>;
async fn gets_by_service_module_seq(&mut self, v: i64) -> Result<Collection<BattleRow>>;
async fn gets_by_service_member_seq(&mut self, v: i64) -> Result<Collection<BattleRow>>;
async fn gets_by_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<BattleRow>>;
async fn gets_by_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<BattleRow>>;
async fn gets_by_uuid(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>>;
async fn gets_by_is_single_play(&mut self, v: bool) -> Result<Collection<BattleRow>>;
async fn gets_by_like_count(&mut self, v: i64) -> Result<Collection<BattleRow>>;
async fn gets_by_aes_key_version(&mut self, v: i32) -> Result<Collection<BattleRow>>;
async fn gets_by_aes_hex_email(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>>;
async fn gets_by_email_blind_index(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>>;
async fn gets_by_aes_hex_phone(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>>;
async fn gets_by_phone_blind_index(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>>;
async fn gets_by_price(&mut self, v: f64) -> Result<Collection<BattleRow>>;
async fn gets_by_ip(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>>;
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
async fn get_count_by_target_team_player_count(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_success_count(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_player_count(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_read_count(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_cover_url(&mut self, v: impl Into<String>) -> Result<i64>;
async fn get_count_by_user_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_service_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_service_module_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_service_member_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64>;
async fn get_count_by_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64>;
async fn get_count_by_uuid(&mut self, v: impl Into<String>) -> Result<i64>;
async fn get_count_by_is_single_play(&mut self, v: bool) -> Result<i64>;
async fn get_count_by_like_count(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_aes_key_version(&mut self, v: i32) -> Result<i64>;
async fn get_count_by_aes_hex_email(&mut self, v: impl Into<String>) -> Result<i64>;
async fn get_count_by_email_blind_index(&mut self, v: impl Into<String>) -> Result<i64>;
async fn get_count_by_aes_hex_phone(&mut self, v: impl Into<String>) -> Result<i64>;
async fn get_count_by_phone_blind_index(&mut self, v: impl Into<String>) -> Result<i64>;
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
fn target_team_player_count_eq(self, v: i64) -> Self;
fn success_count_eq(self, v: i64) -> Self;
fn player_count_eq(self, v: i64) -> Self;
fn read_count_eq(self, v: i64) -> Self;
fn cover_url_eq(self, v: impl Into<String>) -> Self;
fn user_seq_eq(self, v: i64) -> Self;
fn service_seq_eq(self, v: i64) -> Self;
fn service_module_seq_eq(self, v: i64) -> Self;
fn service_member_seq_eq(self, v: i64) -> Self;
fn start_dt_eq(self, v: chrono::NaiveDateTime) -> Self;
fn end_dt_eq(self, v: chrono::NaiveDateTime) -> Self;
fn uuid_eq(self, v: impl Into<String>) -> Self;
fn is_single_play_eq(self, v: bool) -> Self;
fn like_count_eq(self, v: i64) -> Self;
fn aes_key_version_eq(self, v: i32) -> Self;
fn aes_hex_email_eq(self, v: impl Into<String>) -> Self;
fn email_blind_index_eq(self, v: impl Into<String>) -> Self;
fn aes_hex_phone_eq(self, v: impl Into<String>) -> Self;
fn phone_blind_index_eq(self, v: impl Into<String>) -> Self;
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
fn target_team_player_count(self, v: i64) -> Self;
fn success_count(self, v: i64) -> Self;
fn player_count(self, v: i64) -> Self;
fn read_count(self, v: i64) -> Self;
fn cover_url(self, v: impl Into<String>) -> Self;
fn user_seq(self, v: i64) -> Self;
fn service_seq(self, v: i64) -> Self;
fn service_module_seq(self, v: i64) -> Self;
fn service_member_seq(self, v: i64) -> Self;
fn start_dt(self, v: chrono::NaiveDateTime) -> Self;
fn end_dt(self, v: chrono::NaiveDateTime) -> Self;
fn uuid(self, v: impl Into<String>) -> Self;
fn is_single_play(self, v: bool) -> Self;
fn like_count(self, v: i64) -> Self;
fn aes_key_version(self, v: i32) -> Self;
fn aes_hex_email(self, v: impl Into<String>) -> Self;
fn email_blind_index(self, v: impl Into<String>) -> Self;
fn aes_hex_phone(self, v: impl Into<String>) -> Self;
fn phone_blind_index(self, v: impl Into<String>) -> Self;
fn price(self, v: f64) -> Self;
fn ip(self, v: impl Into<String>) -> Self;
}
impl BattleInterface for Battle {
async fn get(&mut self) -> Result<BattleRow> { Battle::get(self).await }
async fn get_or_none(&mut self) -> Result<Option<BattleRow>> { Battle::get_or_none(self).await }
async fn gets(&mut self) -> Result<Collection<BattleRow>> { Battle::gets(self).await }
async fn stream(&mut self, visit: impl FnMut(BattleRow) -> bool) -> Result<db::StreamResult> { Battle::stream(self,visit).await }
async fn get_count(&mut self) -> Result<i64> { Battle::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<BattleRow>> { Battle::gets_count(self).await }
async fn aes_status(&self, keyring: &orm::aes_rotation::AesKeyring) -> Result<orm::aes_rotation::AesRotationStatus> { Battle::aes_status(self,keyring).await }
async fn rotate_aes(&self, keyring: &orm::aes_rotation::AesKeyring) -> Result<u64> { Battle::rotate_aes(self,keyring).await }
async fn insert(&mut self) -> Result<Option<BattleRow>> { Battle::insert(self).await }
async fn save(&mut self) -> Result<Option<BattleRow>> { Battle::save(self).await }
async fn update(&mut self) -> Result<u64> { Battle::update(self).await }
async fn delete(&mut self) -> Result<u64> { Battle::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { Battle::sql(self).await }
fn using(mut self, ex: &impl Exec) -> Self { Battle::using(self,ex) }
fn scope(mut self, v: i64) -> Self { Battle::scope(self,v) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<BattleRow>> { Battle::paginate(self,page,per).await }
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<BattleRow>> { Battle::gets_after(self,cursor,per).await }
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<BattleRow>> { Battle::gets_before(self,cursor,per).await }
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<BattleRow>> { Battle::gets_by_seq(self,v).await }
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>> { Battle::gets_by_name(self,v).await }
async fn gets_by_description(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>> { Battle::gets_by_description(self,v).await }
async fn gets_by_created_ts(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<BattleRow>> { Battle::gets_by_created_ts(self,v).await }
async fn gets_by_updated_ts(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<BattleRow>> { Battle::gets_by_updated_ts(self,v).await }
async fn gets_by_is_close(&mut self, v: bool) -> Result<Collection<BattleRow>> { Battle::gets_by_is_close(self,v).await }
async fn gets_by_is_display(&mut self, v: bool) -> Result<Collection<BattleRow>> { Battle::gets_by_is_display(self,v).await }
async fn gets_by_display_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<BattleRow>> { Battle::gets_by_display_start_dt(self,v).await }
async fn gets_by_display_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<BattleRow>> { Battle::gets_by_display_end_dt(self,v).await }
async fn gets_by_is_allday(&mut self, v: bool) -> Result<Collection<BattleRow>> { Battle::gets_by_is_allday(self,v).await }
async fn gets_by_target_team_player_count(&mut self, v: i64) -> Result<Collection<BattleRow>> { Battle::gets_by_target_team_player_count(self,v).await }
async fn gets_by_success_count(&mut self, v: i64) -> Result<Collection<BattleRow>> { Battle::gets_by_success_count(self,v).await }
async fn gets_by_player_count(&mut self, v: i64) -> Result<Collection<BattleRow>> { Battle::gets_by_player_count(self,v).await }
async fn gets_by_read_count(&mut self, v: i64) -> Result<Collection<BattleRow>> { Battle::gets_by_read_count(self,v).await }
async fn gets_by_cover_url(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>> { Battle::gets_by_cover_url(self,v).await }
async fn gets_by_user_seq(&mut self, v: i64) -> Result<Collection<BattleRow>> { Battle::gets_by_user_seq(self,v).await }
async fn gets_by_service_seq(&mut self, v: i64) -> Result<Collection<BattleRow>> { Battle::gets_by_service_seq(self,v).await }
async fn gets_by_service_module_seq(&mut self, v: i64) -> Result<Collection<BattleRow>> { Battle::gets_by_service_module_seq(self,v).await }
async fn gets_by_service_member_seq(&mut self, v: i64) -> Result<Collection<BattleRow>> { Battle::gets_by_service_member_seq(self,v).await }
async fn gets_by_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<BattleRow>> { Battle::gets_by_start_dt(self,v).await }
async fn gets_by_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<BattleRow>> { Battle::gets_by_end_dt(self,v).await }
async fn gets_by_uuid(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>> { Battle::gets_by_uuid(self,v).await }
async fn gets_by_is_single_play(&mut self, v: bool) -> Result<Collection<BattleRow>> { Battle::gets_by_is_single_play(self,v).await }
async fn gets_by_like_count(&mut self, v: i64) -> Result<Collection<BattleRow>> { Battle::gets_by_like_count(self,v).await }
async fn gets_by_aes_key_version(&mut self, v: i32) -> Result<Collection<BattleRow>> { Battle::gets_by_aes_key_version(self,v).await }
async fn gets_by_aes_hex_email(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>> { Battle::gets_by_aes_hex_email(self,v).await }
async fn gets_by_email_blind_index(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>> { Battle::gets_by_email_blind_index(self,v).await }
async fn gets_by_aes_hex_phone(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>> { Battle::gets_by_aes_hex_phone(self,v).await }
async fn gets_by_phone_blind_index(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>> { Battle::gets_by_phone_blind_index(self,v).await }
async fn gets_by_price(&mut self, v: f64) -> Result<Collection<BattleRow>> { Battle::gets_by_price(self,v).await }
async fn gets_by_ip(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>> { Battle::gets_by_ip(self,v).await }
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64> { Battle::get_count_by_seq(self,v).await }
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64> { Battle::get_count_by_name(self,v).await }
async fn get_count_by_description(&mut self, v: impl Into<String>) -> Result<i64> { Battle::get_count_by_description(self,v).await }
async fn get_count_by_created_ts(&mut self, v: chrono::NaiveDateTime) -> Result<i64> { Battle::get_count_by_created_ts(self,v).await }
async fn get_count_by_updated_ts(&mut self, v: chrono::NaiveDateTime) -> Result<i64> { Battle::get_count_by_updated_ts(self,v).await }
async fn get_count_by_is_close(&mut self, v: bool) -> Result<i64> { Battle::get_count_by_is_close(self,v).await }
async fn get_count_by_is_display(&mut self, v: bool) -> Result<i64> { Battle::get_count_by_is_display(self,v).await }
async fn get_count_by_display_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64> { Battle::get_count_by_display_start_dt(self,v).await }
async fn get_count_by_display_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64> { Battle::get_count_by_display_end_dt(self,v).await }
async fn get_count_by_is_allday(&mut self, v: bool) -> Result<i64> { Battle::get_count_by_is_allday(self,v).await }
async fn get_count_by_target_team_player_count(&mut self, v: i64) -> Result<i64> { Battle::get_count_by_target_team_player_count(self,v).await }
async fn get_count_by_success_count(&mut self, v: i64) -> Result<i64> { Battle::get_count_by_success_count(self,v).await }
async fn get_count_by_player_count(&mut self, v: i64) -> Result<i64> { Battle::get_count_by_player_count(self,v).await }
async fn get_count_by_read_count(&mut self, v: i64) -> Result<i64> { Battle::get_count_by_read_count(self,v).await }
async fn get_count_by_cover_url(&mut self, v: impl Into<String>) -> Result<i64> { Battle::get_count_by_cover_url(self,v).await }
async fn get_count_by_user_seq(&mut self, v: i64) -> Result<i64> { Battle::get_count_by_user_seq(self,v).await }
async fn get_count_by_service_seq(&mut self, v: i64) -> Result<i64> { Battle::get_count_by_service_seq(self,v).await }
async fn get_count_by_service_module_seq(&mut self, v: i64) -> Result<i64> { Battle::get_count_by_service_module_seq(self,v).await }
async fn get_count_by_service_member_seq(&mut self, v: i64) -> Result<i64> { Battle::get_count_by_service_member_seq(self,v).await }
async fn get_count_by_start_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64> { Battle::get_count_by_start_dt(self,v).await }
async fn get_count_by_end_dt(&mut self, v: chrono::NaiveDateTime) -> Result<i64> { Battle::get_count_by_end_dt(self,v).await }
async fn get_count_by_uuid(&mut self, v: impl Into<String>) -> Result<i64> { Battle::get_count_by_uuid(self,v).await }
async fn get_count_by_is_single_play(&mut self, v: bool) -> Result<i64> { Battle::get_count_by_is_single_play(self,v).await }
async fn get_count_by_like_count(&mut self, v: i64) -> Result<i64> { Battle::get_count_by_like_count(self,v).await }
async fn get_count_by_aes_key_version(&mut self, v: i32) -> Result<i64> { Battle::get_count_by_aes_key_version(self,v).await }
async fn get_count_by_aes_hex_email(&mut self, v: impl Into<String>) -> Result<i64> { Battle::get_count_by_aes_hex_email(self,v).await }
async fn get_count_by_email_blind_index(&mut self, v: impl Into<String>) -> Result<i64> { Battle::get_count_by_email_blind_index(self,v).await }
async fn get_count_by_aes_hex_phone(&mut self, v: impl Into<String>) -> Result<i64> { Battle::get_count_by_aes_hex_phone(self,v).await }
async fn get_count_by_phone_blind_index(&mut self, v: impl Into<String>) -> Result<i64> { Battle::get_count_by_phone_blind_index(self,v).await }
async fn get_count_by_price(&mut self, v: f64) -> Result<i64> { Battle::get_count_by_price(self,v).await }
async fn get_count_by_ip(&mut self, v: impl Into<String>) -> Result<i64> { Battle::get_count_by_ip(self,v).await }
fn seq_eq(mut self, v: i64) -> Self { Battle::seq_eq(self,v) }
fn name_eq(mut self, v: impl Into<String>) -> Self { Battle::name_eq(self,v) }
fn description_eq(mut self, v: impl Into<String>) -> Self { Battle::description_eq(self,v) }
fn created_ts_eq(mut self, v: chrono::NaiveDateTime) -> Self { Battle::created_ts_eq(self,v) }
fn updated_ts_eq(mut self, v: chrono::NaiveDateTime) -> Self { Battle::updated_ts_eq(self,v) }
fn is_close_eq(mut self, v: bool) -> Self { Battle::is_close_eq(self,v) }
fn is_display_eq(mut self, v: bool) -> Self { Battle::is_display_eq(self,v) }
fn display_start_dt_eq(mut self, v: chrono::NaiveDateTime) -> Self { Battle::display_start_dt_eq(self,v) }
fn display_end_dt_eq(mut self, v: chrono::NaiveDateTime) -> Self { Battle::display_end_dt_eq(self,v) }
fn is_allday_eq(mut self, v: bool) -> Self { Battle::is_allday_eq(self,v) }
fn target_team_player_count_eq(mut self, v: i64) -> Self { Battle::target_team_player_count_eq(self,v) }
fn success_count_eq(mut self, v: i64) -> Self { Battle::success_count_eq(self,v) }
fn player_count_eq(mut self, v: i64) -> Self { Battle::player_count_eq(self,v) }
fn read_count_eq(mut self, v: i64) -> Self { Battle::read_count_eq(self,v) }
fn cover_url_eq(mut self, v: impl Into<String>) -> Self { Battle::cover_url_eq(self,v) }
fn user_seq_eq(mut self, v: i64) -> Self { Battle::user_seq_eq(self,v) }
fn service_seq_eq(mut self, v: i64) -> Self { Battle::service_seq_eq(self,v) }
fn service_module_seq_eq(mut self, v: i64) -> Self { Battle::service_module_seq_eq(self,v) }
fn service_member_seq_eq(mut self, v: i64) -> Self { Battle::service_member_seq_eq(self,v) }
fn start_dt_eq(mut self, v: chrono::NaiveDateTime) -> Self { Battle::start_dt_eq(self,v) }
fn end_dt_eq(mut self, v: chrono::NaiveDateTime) -> Self { Battle::end_dt_eq(self,v) }
fn uuid_eq(mut self, v: impl Into<String>) -> Self { Battle::uuid_eq(self,v) }
fn is_single_play_eq(mut self, v: bool) -> Self { Battle::is_single_play_eq(self,v) }
fn like_count_eq(mut self, v: i64) -> Self { Battle::like_count_eq(self,v) }
fn aes_key_version_eq(mut self, v: i32) -> Self { Battle::aes_key_version_eq(self,v) }
fn aes_hex_email_eq(mut self, v: impl Into<String>) -> Self { Battle::aes_hex_email_eq(self,v) }
fn email_blind_index_eq(mut self, v: impl Into<String>) -> Self { Battle::email_blind_index_eq(self,v) }
fn aes_hex_phone_eq(mut self, v: impl Into<String>) -> Self { Battle::aes_hex_phone_eq(self,v) }
fn phone_blind_index_eq(mut self, v: impl Into<String>) -> Self { Battle::phone_blind_index_eq(self,v) }
fn price_eq(mut self, v: f64) -> Self { Battle::price_eq(self,v) }
fn ip_eq(mut self, v: impl Into<String>) -> Self { Battle::ip_eq(self,v) }
fn seq(self, v: i64) -> Self { Battle::seq(self,v) }
fn name(self, v: impl Into<String>) -> Self { Battle::name(self,v) }
fn description(self, v: impl Into<String>) -> Self { Battle::description(self,v) }
fn created_ts(self, v: chrono::NaiveDateTime) -> Self { Battle::created_ts(self,v) }
fn updated_ts(self, v: chrono::NaiveDateTime) -> Self { Battle::updated_ts(self,v) }
fn is_close(self, v: bool) -> Self { Battle::is_close(self,v) }
fn is_display(self, v: bool) -> Self { Battle::is_display(self,v) }
fn display_start_dt(self, v: chrono::NaiveDateTime) -> Self { Battle::display_start_dt(self,v) }
fn display_end_dt(self, v: chrono::NaiveDateTime) -> Self { Battle::display_end_dt(self,v) }
fn is_allday(self, v: bool) -> Self { Battle::is_allday(self,v) }
fn target_team_player_count(self, v: i64) -> Self { Battle::target_team_player_count(self,v) }
fn success_count(self, v: i64) -> Self { Battle::success_count(self,v) }
fn player_count(self, v: i64) -> Self { Battle::player_count(self,v) }
fn read_count(self, v: i64) -> Self { Battle::read_count(self,v) }
fn cover_url(self, v: impl Into<String>) -> Self { Battle::cover_url(self,v) }
fn user_seq(self, v: i64) -> Self { Battle::user_seq(self,v) }
fn service_seq(self, v: i64) -> Self { Battle::service_seq(self,v) }
fn service_module_seq(self, v: i64) -> Self { Battle::service_module_seq(self,v) }
fn service_member_seq(self, v: i64) -> Self { Battle::service_member_seq(self,v) }
fn start_dt(self, v: chrono::NaiveDateTime) -> Self { Battle::start_dt(self,v) }
fn end_dt(self, v: chrono::NaiveDateTime) -> Self { Battle::end_dt(self,v) }
fn uuid(self, v: impl Into<String>) -> Self { Battle::uuid(self,v) }
fn is_single_play(self, v: bool) -> Self { Battle::is_single_play(self,v) }
fn like_count(self, v: i64) -> Self { Battle::like_count(self,v) }
fn aes_key_version(self, v: i32) -> Self { Battle::aes_key_version(self,v) }
fn aes_hex_email(self, v: impl Into<String>) -> Self { Battle::aes_hex_email(self,v) }
fn email_blind_index(self, v: impl Into<String>) -> Self { Battle::email_blind_index(self,v) }
fn aes_hex_phone(self, v: impl Into<String>) -> Self { Battle::aes_hex_phone(self,v) }
fn phone_blind_index(self, v: impl Into<String>) -> Self { Battle::phone_blind_index(self,v) }
fn price(self, v: f64) -> Self { Battle::price(self,v) }
fn ip(self, v: impl Into<String>) -> Self { Battle::ip(self,v) }
}

pub trait BattleRowInterface: Sized {
fn using(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn update_optimistic(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> Result<serde_json::Value>;
}
impl BattleRowInterface for BattleRow {
fn using(&mut self, ex: &impl Exec) -> &mut Self { BattleRow::using(self,ex) }
async fn update(&mut self) -> Result<()> { BattleRow::update(self).await }
async fn update_optimistic(&mut self) -> Result<()> { BattleRow::update_optimistic(self).await }
async fn delete(&self) -> Result<()> { BattleRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { BattleRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { BattleRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { BattleRow::rel_loaded(self,name) }
fn to_map(&self) -> Result<serde_json::Value> { BattleRow::to_map(self) }
}

pub trait UserInterface: Sized {
async fn get(&mut self) -> Result<UserRow>;
async fn get_or_none(&mut self) -> Result<Option<UserRow>>;
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
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<UserRow>>;
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<UserRow>>;
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
async fn get(&mut self) -> Result<UserRow> { User::get(self).await }
async fn get_or_none(&mut self) -> Result<Option<UserRow>> { User::get_or_none(self).await }
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
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<UserRow>> { User::gets_after(self,cursor,per).await }
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<UserRow>> { User::gets_before(self,cursor,per).await }
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
async fn get(&mut self) -> Result<ServiceRow>;
async fn get_or_none(&mut self) -> Result<Option<ServiceRow>>;
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
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ServiceRow>>;
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ServiceRow>>;
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
async fn get(&mut self) -> Result<ServiceRow> { Service::get(self).await }
async fn get_or_none(&mut self) -> Result<Option<ServiceRow>> { Service::get_or_none(self).await }
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
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ServiceRow>> { Service::gets_after(self,cursor,per).await }
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ServiceRow>> { Service::gets_before(self,cursor,per).await }
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

pub trait ServiceModuleInterface: Sized {
async fn get(&mut self) -> Result<ServiceModuleRow>;
async fn get_or_none(&mut self) -> Result<Option<ServiceModuleRow>>;
async fn gets(&mut self) -> Result<Collection<ServiceModuleRow>>;
async fn stream(&mut self, visit: impl FnMut(ServiceModuleRow) -> bool) -> Result<db::StreamResult>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<ServiceModuleRow>>;
async fn insert(&mut self) -> Result<Option<ServiceModuleRow>>;
async fn save(&mut self) -> Result<Option<ServiceModuleRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn using(self, ex: &impl Exec) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<ServiceModuleRow>>;
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ServiceModuleRow>>;
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ServiceModuleRow>>;
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<ServiceModuleRow>>;
async fn gets_by_service_seq(&mut self, v: i64) -> Result<Collection<ServiceModuleRow>>;
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<ServiceModuleRow>>;
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
impl ServiceModuleInterface for ServiceModule {
async fn get(&mut self) -> Result<ServiceModuleRow> { ServiceModule::get(self).await }
async fn get_or_none(&mut self) -> Result<Option<ServiceModuleRow>> { ServiceModule::get_or_none(self).await }
async fn gets(&mut self) -> Result<Collection<ServiceModuleRow>> { ServiceModule::gets(self).await }
async fn stream(&mut self, visit: impl FnMut(ServiceModuleRow) -> bool) -> Result<db::StreamResult> { ServiceModule::stream(self,visit).await }
async fn get_count(&mut self) -> Result<i64> { ServiceModule::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<ServiceModuleRow>> { ServiceModule::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<ServiceModuleRow>> { ServiceModule::insert(self).await }
async fn save(&mut self) -> Result<Option<ServiceModuleRow>> { ServiceModule::save(self).await }
async fn update(&mut self) -> Result<u64> { ServiceModule::update(self).await }
async fn delete(&mut self) -> Result<u64> { ServiceModule::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { ServiceModule::sql(self).await }
fn using(mut self, ex: &impl Exec) -> Self { ServiceModule::using(self,ex) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<ServiceModuleRow>> { ServiceModule::paginate(self,page,per).await }
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ServiceModuleRow>> { ServiceModule::gets_after(self,cursor,per).await }
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ServiceModuleRow>> { ServiceModule::gets_before(self,cursor,per).await }
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<ServiceModuleRow>> { ServiceModule::gets_by_seq(self,v).await }
async fn gets_by_service_seq(&mut self, v: i64) -> Result<Collection<ServiceModuleRow>> { ServiceModule::gets_by_service_seq(self,v).await }
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<ServiceModuleRow>> { ServiceModule::gets_by_name(self,v).await }
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64> { ServiceModule::get_count_by_seq(self,v).await }
async fn get_count_by_service_seq(&mut self, v: i64) -> Result<i64> { ServiceModule::get_count_by_service_seq(self,v).await }
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64> { ServiceModule::get_count_by_name(self,v).await }
fn seq_eq(mut self, v: i64) -> Self { ServiceModule::seq_eq(self,v) }
fn service_seq_eq(mut self, v: i64) -> Self { ServiceModule::service_seq_eq(self,v) }
fn name_eq(mut self, v: impl Into<String>) -> Self { ServiceModule::name_eq(self,v) }
fn seq(self, v: i64) -> Self { ServiceModule::seq(self,v) }
fn service_seq(self, v: i64) -> Self { ServiceModule::service_seq(self,v) }
fn name(self, v: impl Into<String>) -> Self { ServiceModule::name(self,v) }
}

pub trait ServiceModuleRowInterface: Sized {
fn using(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> Result<serde_json::Value>;
}
impl ServiceModuleRowInterface for ServiceModuleRow {
fn using(&mut self, ex: &impl Exec) -> &mut Self { ServiceModuleRow::using(self,ex) }
async fn update(&mut self) -> Result<()> { ServiceModuleRow::update(self).await }
async fn delete(&self) -> Result<()> { ServiceModuleRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { ServiceModuleRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { ServiceModuleRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { ServiceModuleRow::rel_loaded(self,name) }
fn to_map(&self) -> Result<serde_json::Value> { ServiceModuleRow::to_map(self) }
}

pub trait ServiceMemberInterface: Sized {
async fn get(&mut self) -> Result<ServiceMemberRow>;
async fn get_or_none(&mut self) -> Result<Option<ServiceMemberRow>>;
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
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ServiceMemberRow>>;
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ServiceMemberRow>>;
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
async fn get(&mut self) -> Result<ServiceMemberRow> { ServiceMember::get(self).await }
async fn get_or_none(&mut self) -> Result<Option<ServiceMemberRow>> { ServiceMember::get_or_none(self).await }
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
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ServiceMemberRow>> { ServiceMember::gets_after(self,cursor,per).await }
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ServiceMemberRow>> { ServiceMember::gets_before(self,cursor,per).await }
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

pub trait CompositeAccountInterface: Sized {
async fn get(&mut self) -> Result<CompositeAccountRow>;
async fn get_or_none(&mut self) -> Result<Option<CompositeAccountRow>>;
async fn gets(&mut self) -> Result<Collection<CompositeAccountRow>>;
async fn stream(&mut self, visit: impl FnMut(CompositeAccountRow) -> bool) -> Result<db::StreamResult>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<CompositeAccountRow>>;
async fn insert(&mut self) -> Result<Option<CompositeAccountRow>>;
async fn save(&mut self) -> Result<Option<CompositeAccountRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn using(self, ex: &impl Exec) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<CompositeAccountRow>>;
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<CompositeAccountRow>>;
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<CompositeAccountRow>>;
async fn gets_by_tenant_id(&mut self, v: i64) -> Result<Collection<CompositeAccountRow>>;
async fn gets_by_account_id(&mut self, v: i64) -> Result<Collection<CompositeAccountRow>>;
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<CompositeAccountRow>>;
async fn get_count_by_tenant_id(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_account_id(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64>;
fn tenant_id_eq(self, v: i64) -> Self;
fn account_id_eq(self, v: i64) -> Self;
fn name_eq(self, v: impl Into<String>) -> Self;
fn tenant_id(self, v: i64) -> Self;
fn account_id(self, v: i64) -> Self;
fn name(self, v: impl Into<String>) -> Self;
}
impl CompositeAccountInterface for CompositeAccount {
async fn get(&mut self) -> Result<CompositeAccountRow> { CompositeAccount::get(self).await }
async fn get_or_none(&mut self) -> Result<Option<CompositeAccountRow>> { CompositeAccount::get_or_none(self).await }
async fn gets(&mut self) -> Result<Collection<CompositeAccountRow>> { CompositeAccount::gets(self).await }
async fn stream(&mut self, visit: impl FnMut(CompositeAccountRow) -> bool) -> Result<db::StreamResult> { CompositeAccount::stream(self,visit).await }
async fn get_count(&mut self) -> Result<i64> { CompositeAccount::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<CompositeAccountRow>> { CompositeAccount::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<CompositeAccountRow>> { CompositeAccount::insert(self).await }
async fn save(&mut self) -> Result<Option<CompositeAccountRow>> { CompositeAccount::save(self).await }
async fn update(&mut self) -> Result<u64> { CompositeAccount::update(self).await }
async fn delete(&mut self) -> Result<u64> { CompositeAccount::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { CompositeAccount::sql(self).await }
fn using(mut self, ex: &impl Exec) -> Self { CompositeAccount::using(self,ex) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<CompositeAccountRow>> { CompositeAccount::paginate(self,page,per).await }
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<CompositeAccountRow>> { CompositeAccount::gets_after(self,cursor,per).await }
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<CompositeAccountRow>> { CompositeAccount::gets_before(self,cursor,per).await }
async fn gets_by_tenant_id(&mut self, v: i64) -> Result<Collection<CompositeAccountRow>> { CompositeAccount::gets_by_tenant_id(self,v).await }
async fn gets_by_account_id(&mut self, v: i64) -> Result<Collection<CompositeAccountRow>> { CompositeAccount::gets_by_account_id(self,v).await }
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<CompositeAccountRow>> { CompositeAccount::gets_by_name(self,v).await }
async fn get_count_by_tenant_id(&mut self, v: i64) -> Result<i64> { CompositeAccount::get_count_by_tenant_id(self,v).await }
async fn get_count_by_account_id(&mut self, v: i64) -> Result<i64> { CompositeAccount::get_count_by_account_id(self,v).await }
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64> { CompositeAccount::get_count_by_name(self,v).await }
fn tenant_id_eq(mut self, v: i64) -> Self { CompositeAccount::tenant_id_eq(self,v) }
fn account_id_eq(mut self, v: i64) -> Self { CompositeAccount::account_id_eq(self,v) }
fn name_eq(mut self, v: impl Into<String>) -> Self { CompositeAccount::name_eq(self,v) }
fn tenant_id(self, v: i64) -> Self { CompositeAccount::tenant_id(self,v) }
fn account_id(self, v: i64) -> Self { CompositeAccount::account_id(self,v) }
fn name(self, v: impl Into<String>) -> Self { CompositeAccount::name(self,v) }
}

pub trait CompositeAccountRowInterface: Sized {
fn using(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> Result<serde_json::Value>;
}
impl CompositeAccountRowInterface for CompositeAccountRow {
fn using(&mut self, ex: &impl Exec) -> &mut Self { CompositeAccountRow::using(self,ex) }
async fn update(&mut self) -> Result<()> { CompositeAccountRow::update(self).await }
async fn delete(&self) -> Result<()> { CompositeAccountRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { CompositeAccountRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { CompositeAccountRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { CompositeAccountRow::rel_loaded(self,name) }
fn to_map(&self) -> Result<serde_json::Value> { CompositeAccountRow::to_map(self) }
}

pub trait CompositeMembershipInterface: Sized {
async fn get(&mut self) -> Result<CompositeMembershipRow>;
async fn get_or_none(&mut self) -> Result<Option<CompositeMembershipRow>>;
async fn gets(&mut self) -> Result<Collection<CompositeMembershipRow>>;
async fn stream(&mut self, visit: impl FnMut(CompositeMembershipRow) -> bool) -> Result<db::StreamResult>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<CompositeMembershipRow>>;
async fn insert(&mut self) -> Result<Option<CompositeMembershipRow>>;
async fn save(&mut self) -> Result<Option<CompositeMembershipRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn using(self, ex: &impl Exec) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<CompositeMembershipRow>>;
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<CompositeMembershipRow>>;
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<CompositeMembershipRow>>;
async fn gets_by_tenant_id(&mut self, v: i64) -> Result<Collection<CompositeMembershipRow>>;
async fn gets_by_account_id(&mut self, v: i64) -> Result<Collection<CompositeMembershipRow>>;
async fn gets_by_role(&mut self, v: impl Into<String>) -> Result<Collection<CompositeMembershipRow>>;
async fn get_count_by_tenant_id(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_account_id(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_role(&mut self, v: impl Into<String>) -> Result<i64>;
fn tenant_id_eq(self, v: i64) -> Self;
fn account_id_eq(self, v: i64) -> Self;
fn role_eq(self, v: impl Into<String>) -> Self;
fn tenant_id(self, v: i64) -> Self;
fn account_id(self, v: i64) -> Self;
fn role(self, v: impl Into<String>) -> Self;
}
impl CompositeMembershipInterface for CompositeMembership {
async fn get(&mut self) -> Result<CompositeMembershipRow> { CompositeMembership::get(self).await }
async fn get_or_none(&mut self) -> Result<Option<CompositeMembershipRow>> { CompositeMembership::get_or_none(self).await }
async fn gets(&mut self) -> Result<Collection<CompositeMembershipRow>> { CompositeMembership::gets(self).await }
async fn stream(&mut self, visit: impl FnMut(CompositeMembershipRow) -> bool) -> Result<db::StreamResult> { CompositeMembership::stream(self,visit).await }
async fn get_count(&mut self) -> Result<i64> { CompositeMembership::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<CompositeMembershipRow>> { CompositeMembership::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<CompositeMembershipRow>> { CompositeMembership::insert(self).await }
async fn save(&mut self) -> Result<Option<CompositeMembershipRow>> { CompositeMembership::save(self).await }
async fn update(&mut self) -> Result<u64> { CompositeMembership::update(self).await }
async fn delete(&mut self) -> Result<u64> { CompositeMembership::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { CompositeMembership::sql(self).await }
fn using(mut self, ex: &impl Exec) -> Self { CompositeMembership::using(self,ex) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<CompositeMembershipRow>> { CompositeMembership::paginate(self,page,per).await }
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<CompositeMembershipRow>> { CompositeMembership::gets_after(self,cursor,per).await }
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<CompositeMembershipRow>> { CompositeMembership::gets_before(self,cursor,per).await }
async fn gets_by_tenant_id(&mut self, v: i64) -> Result<Collection<CompositeMembershipRow>> { CompositeMembership::gets_by_tenant_id(self,v).await }
async fn gets_by_account_id(&mut self, v: i64) -> Result<Collection<CompositeMembershipRow>> { CompositeMembership::gets_by_account_id(self,v).await }
async fn gets_by_role(&mut self, v: impl Into<String>) -> Result<Collection<CompositeMembershipRow>> { CompositeMembership::gets_by_role(self,v).await }
async fn get_count_by_tenant_id(&mut self, v: i64) -> Result<i64> { CompositeMembership::get_count_by_tenant_id(self,v).await }
async fn get_count_by_account_id(&mut self, v: i64) -> Result<i64> { CompositeMembership::get_count_by_account_id(self,v).await }
async fn get_count_by_role(&mut self, v: impl Into<String>) -> Result<i64> { CompositeMembership::get_count_by_role(self,v).await }
fn tenant_id_eq(mut self, v: i64) -> Self { CompositeMembership::tenant_id_eq(self,v) }
fn account_id_eq(mut self, v: i64) -> Self { CompositeMembership::account_id_eq(self,v) }
fn role_eq(mut self, v: impl Into<String>) -> Self { CompositeMembership::role_eq(self,v) }
fn tenant_id(self, v: i64) -> Self { CompositeMembership::tenant_id(self,v) }
fn account_id(self, v: i64) -> Self { CompositeMembership::account_id(self,v) }
fn role(self, v: impl Into<String>) -> Self { CompositeMembership::role(self,v) }
}

pub trait CompositeMembershipRowInterface: Sized {
fn using(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> Result<serde_json::Value>;
}
impl CompositeMembershipRowInterface for CompositeMembershipRow {
fn using(&mut self, ex: &impl Exec) -> &mut Self { CompositeMembershipRow::using(self,ex) }
async fn update(&mut self) -> Result<()> { CompositeMembershipRow::update(self).await }
async fn delete(&self) -> Result<()> { CompositeMembershipRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { CompositeMembershipRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { CompositeMembershipRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { CompositeMembershipRow::rel_loaded(self,name) }
fn to_map(&self) -> Result<serde_json::Value> { CompositeMembershipRow::to_map(self) }
}

pub trait SoftRecordInterface: Sized {
async fn get(&mut self) -> Result<SoftRecordRow>;
async fn get_or_none(&mut self) -> Result<Option<SoftRecordRow>>;
async fn gets(&mut self) -> Result<Collection<SoftRecordRow>>;
async fn stream(&mut self, visit: impl FnMut(SoftRecordRow) -> bool) -> Result<db::StreamResult>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<SoftRecordRow>>;
async fn insert(&mut self) -> Result<Option<SoftRecordRow>>;
async fn save(&mut self) -> Result<Option<SoftRecordRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn using(self, ex: &impl Exec) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<SoftRecordRow>>;
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<SoftRecordRow>>;
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<SoftRecordRow>>;
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<SoftRecordRow>>;
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<SoftRecordRow>>;
async fn gets_by_deleted_at(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<SoftRecordRow>>;
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64>;
async fn get_count_by_deleted_at(&mut self, v: chrono::NaiveDateTime) -> Result<i64>;
fn seq_eq(self, v: i64) -> Self;
fn name_eq(self, v: impl Into<String>) -> Self;
fn deleted_at_eq(self, v: chrono::NaiveDateTime) -> Self;
fn seq(self, v: i64) -> Self;
fn name(self, v: impl Into<String>) -> Self;
fn deleted_at(self, v: chrono::NaiveDateTime) -> Self;
}
impl SoftRecordInterface for SoftRecord {
async fn get(&mut self) -> Result<SoftRecordRow> { SoftRecord::get(self).await }
async fn get_or_none(&mut self) -> Result<Option<SoftRecordRow>> { SoftRecord::get_or_none(self).await }
async fn gets(&mut self) -> Result<Collection<SoftRecordRow>> { SoftRecord::gets(self).await }
async fn stream(&mut self, visit: impl FnMut(SoftRecordRow) -> bool) -> Result<db::StreamResult> { SoftRecord::stream(self,visit).await }
async fn get_count(&mut self) -> Result<i64> { SoftRecord::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<SoftRecordRow>> { SoftRecord::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<SoftRecordRow>> { SoftRecord::insert(self).await }
async fn save(&mut self) -> Result<Option<SoftRecordRow>> { SoftRecord::save(self).await }
async fn update(&mut self) -> Result<u64> { SoftRecord::update(self).await }
async fn delete(&mut self) -> Result<u64> { SoftRecord::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { SoftRecord::sql(self).await }
fn using(mut self, ex: &impl Exec) -> Self { SoftRecord::using(self,ex) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<SoftRecordRow>> { SoftRecord::paginate(self,page,per).await }
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<SoftRecordRow>> { SoftRecord::gets_after(self,cursor,per).await }
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<SoftRecordRow>> { SoftRecord::gets_before(self,cursor,per).await }
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<SoftRecordRow>> { SoftRecord::gets_by_seq(self,v).await }
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<SoftRecordRow>> { SoftRecord::gets_by_name(self,v).await }
async fn gets_by_deleted_at(&mut self, v: chrono::NaiveDateTime) -> Result<Collection<SoftRecordRow>> { SoftRecord::gets_by_deleted_at(self,v).await }
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64> { SoftRecord::get_count_by_seq(self,v).await }
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64> { SoftRecord::get_count_by_name(self,v).await }
async fn get_count_by_deleted_at(&mut self, v: chrono::NaiveDateTime) -> Result<i64> { SoftRecord::get_count_by_deleted_at(self,v).await }
fn seq_eq(mut self, v: i64) -> Self { SoftRecord::seq_eq(self,v) }
fn name_eq(mut self, v: impl Into<String>) -> Self { SoftRecord::name_eq(self,v) }
fn deleted_at_eq(mut self, v: chrono::NaiveDateTime) -> Self { SoftRecord::deleted_at_eq(self,v) }
fn seq(self, v: i64) -> Self { SoftRecord::seq(self,v) }
fn name(self, v: impl Into<String>) -> Self { SoftRecord::name(self,v) }
fn deleted_at(self, v: chrono::NaiveDateTime) -> Self { SoftRecord::deleted_at(self,v) }
}

pub trait SoftRecordRowInterface: Sized {
fn using(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> Result<serde_json::Value>;
}
impl SoftRecordRowInterface for SoftRecordRow {
fn using(&mut self, ex: &impl Exec) -> &mut Self { SoftRecordRow::using(self,ex) }
async fn update(&mut self) -> Result<()> { SoftRecordRow::update(self).await }
async fn delete(&self) -> Result<()> { SoftRecordRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { SoftRecordRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { SoftRecordRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { SoftRecordRow::rel_loaded(self,name) }
fn to_map(&self) -> Result<serde_json::Value> { SoftRecordRow::to_map(self) }
}

pub trait AccountInterface: Sized {
async fn get(&mut self) -> Result<AccountRow>;
async fn get_or_none(&mut self) -> Result<Option<AccountRow>>;
async fn gets(&mut self) -> Result<Collection<AccountRow>>;
async fn stream(&mut self, visit: impl FnMut(AccountRow) -> bool) -> Result<db::StreamResult>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<AccountRow>>;
async fn insert(&mut self) -> Result<Option<AccountRow>>;
async fn save(&mut self) -> Result<Option<AccountRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn using(self, ex: &impl Exec) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<AccountRow>>;
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<AccountRow>>;
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<AccountRow>>;
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<AccountRow>>;
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<AccountRow>>;
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64>;
fn seq_eq(self, v: i64) -> Self;
fn name_eq(self, v: impl Into<String>) -> Self;
fn seq(self, v: i64) -> Self;
fn name(self, v: impl Into<String>) -> Self;
}
impl AccountInterface for Account {
async fn get(&mut self) -> Result<AccountRow> { Account::get(self).await }
async fn get_or_none(&mut self) -> Result<Option<AccountRow>> { Account::get_or_none(self).await }
async fn gets(&mut self) -> Result<Collection<AccountRow>> { Account::gets(self).await }
async fn stream(&mut self, visit: impl FnMut(AccountRow) -> bool) -> Result<db::StreamResult> { Account::stream(self,visit).await }
async fn get_count(&mut self) -> Result<i64> { Account::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<AccountRow>> { Account::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<AccountRow>> { Account::insert(self).await }
async fn save(&mut self) -> Result<Option<AccountRow>> { Account::save(self).await }
async fn update(&mut self) -> Result<u64> { Account::update(self).await }
async fn delete(&mut self) -> Result<u64> { Account::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { Account::sql(self).await }
fn using(mut self, ex: &impl Exec) -> Self { Account::using(self,ex) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<AccountRow>> { Account::paginate(self,page,per).await }
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<AccountRow>> { Account::gets_after(self,cursor,per).await }
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<AccountRow>> { Account::gets_before(self,cursor,per).await }
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<AccountRow>> { Account::gets_by_seq(self,v).await }
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<AccountRow>> { Account::gets_by_name(self,v).await }
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64> { Account::get_count_by_seq(self,v).await }
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64> { Account::get_count_by_name(self,v).await }
fn seq_eq(mut self, v: i64) -> Self { Account::seq_eq(self,v) }
fn name_eq(mut self, v: impl Into<String>) -> Self { Account::name_eq(self,v) }
fn seq(self, v: i64) -> Self { Account::seq(self,v) }
fn name(self, v: impl Into<String>) -> Self { Account::name(self,v) }
}

pub trait AccountRowInterface: Sized {
fn using(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> Result<serde_json::Value>;
}
impl AccountRowInterface for AccountRow {
fn using(&mut self, ex: &impl Exec) -> &mut Self { AccountRow::using(self,ex) }
async fn update(&mut self) -> Result<()> { AccountRow::update(self).await }
async fn delete(&self) -> Result<()> { AccountRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { AccountRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { AccountRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { AccountRow::rel_loaded(self,name) }
fn to_map(&self) -> Result<serde_json::Value> { AccountRow::to_map(self) }
}

pub trait ProjectInterface: Sized {
async fn get(&mut self) -> Result<ProjectRow>;
async fn get_or_none(&mut self) -> Result<Option<ProjectRow>>;
async fn gets(&mut self) -> Result<Collection<ProjectRow>>;
async fn stream(&mut self, visit: impl FnMut(ProjectRow) -> bool) -> Result<db::StreamResult>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<ProjectRow>>;
async fn insert(&mut self) -> Result<Option<ProjectRow>>;
async fn save(&mut self) -> Result<Option<ProjectRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn using(self, ex: &impl Exec) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<ProjectRow>>;
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ProjectRow>>;
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ProjectRow>>;
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<ProjectRow>>;
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<ProjectRow>>;
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64>;
fn seq_eq(self, v: i64) -> Self;
fn name_eq(self, v: impl Into<String>) -> Self;
fn seq(self, v: i64) -> Self;
fn name(self, v: impl Into<String>) -> Self;
}
impl ProjectInterface for Project {
async fn get(&mut self) -> Result<ProjectRow> { Project::get(self).await }
async fn get_or_none(&mut self) -> Result<Option<ProjectRow>> { Project::get_or_none(self).await }
async fn gets(&mut self) -> Result<Collection<ProjectRow>> { Project::gets(self).await }
async fn stream(&mut self, visit: impl FnMut(ProjectRow) -> bool) -> Result<db::StreamResult> { Project::stream(self,visit).await }
async fn get_count(&mut self) -> Result<i64> { Project::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<ProjectRow>> { Project::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<ProjectRow>> { Project::insert(self).await }
async fn save(&mut self) -> Result<Option<ProjectRow>> { Project::save(self).await }
async fn update(&mut self) -> Result<u64> { Project::update(self).await }
async fn delete(&mut self) -> Result<u64> { Project::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { Project::sql(self).await }
fn using(mut self, ex: &impl Exec) -> Self { Project::using(self,ex) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<ProjectRow>> { Project::paginate(self,page,per).await }
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ProjectRow>> { Project::gets_after(self,cursor,per).await }
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<ProjectRow>> { Project::gets_before(self,cursor,per).await }
async fn gets_by_seq(&mut self, v: i64) -> Result<Collection<ProjectRow>> { Project::gets_by_seq(self,v).await }
async fn gets_by_name(&mut self, v: impl Into<String>) -> Result<Collection<ProjectRow>> { Project::gets_by_name(self,v).await }
async fn get_count_by_seq(&mut self, v: i64) -> Result<i64> { Project::get_count_by_seq(self,v).await }
async fn get_count_by_name(&mut self, v: impl Into<String>) -> Result<i64> { Project::get_count_by_name(self,v).await }
fn seq_eq(mut self, v: i64) -> Self { Project::seq_eq(self,v) }
fn name_eq(mut self, v: impl Into<String>) -> Self { Project::name_eq(self,v) }
fn seq(self, v: i64) -> Self { Project::seq(self,v) }
fn name(self, v: impl Into<String>) -> Self { Project::name(self,v) }
}

pub trait ProjectRowInterface: Sized {
fn using(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> Result<serde_json::Value>;
}
impl ProjectRowInterface for ProjectRow {
fn using(&mut self, ex: &impl Exec) -> &mut Self { ProjectRow::using(self,ex) }
async fn update(&mut self) -> Result<()> { ProjectRow::update(self).await }
async fn delete(&self) -> Result<()> { ProjectRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { ProjectRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { ProjectRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { ProjectRow::rel_loaded(self,name) }
fn to_map(&self) -> Result<serde_json::Value> { ProjectRow::to_map(self) }
}

pub trait AccountProjectInterface: Sized {
async fn get(&mut self) -> Result<AccountProjectRow>;
async fn get_or_none(&mut self) -> Result<Option<AccountProjectRow>>;
async fn gets(&mut self) -> Result<Collection<AccountProjectRow>>;
async fn stream(&mut self, visit: impl FnMut(AccountProjectRow) -> bool) -> Result<db::StreamResult>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<AccountProjectRow>>;
async fn insert(&mut self) -> Result<Option<AccountProjectRow>>;
async fn save(&mut self) -> Result<Option<AccountProjectRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn using(self, ex: &impl Exec) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<AccountProjectRow>>;
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<AccountProjectRow>>;
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<AccountProjectRow>>;
async fn gets_by_account_seq(&mut self, v: i64) -> Result<Collection<AccountProjectRow>>;
async fn gets_by_project_seq(&mut self, v: i64) -> Result<Collection<AccountProjectRow>>;
async fn get_count_by_account_seq(&mut self, v: i64) -> Result<i64>;
async fn get_count_by_project_seq(&mut self, v: i64) -> Result<i64>;
fn account_seq_eq(self, v: i64) -> Self;
fn project_seq_eq(self, v: i64) -> Self;
fn account_seq(self, v: i64) -> Self;
fn project_seq(self, v: i64) -> Self;
}
impl AccountProjectInterface for AccountProject {
async fn get(&mut self) -> Result<AccountProjectRow> { AccountProject::get(self).await }
async fn get_or_none(&mut self) -> Result<Option<AccountProjectRow>> { AccountProject::get_or_none(self).await }
async fn gets(&mut self) -> Result<Collection<AccountProjectRow>> { AccountProject::gets(self).await }
async fn stream(&mut self, visit: impl FnMut(AccountProjectRow) -> bool) -> Result<db::StreamResult> { AccountProject::stream(self,visit).await }
async fn get_count(&mut self) -> Result<i64> { AccountProject::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<AccountProjectRow>> { AccountProject::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<AccountProjectRow>> { AccountProject::insert(self).await }
async fn save(&mut self) -> Result<Option<AccountProjectRow>> { AccountProject::save(self).await }
async fn update(&mut self) -> Result<u64> { AccountProject::update(self).await }
async fn delete(&mut self) -> Result<u64> { AccountProject::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { AccountProject::sql(self).await }
fn using(mut self, ex: &impl Exec) -> Self { AccountProject::using(self,ex) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<AccountProjectRow>> { AccountProject::paginate(self,page,per).await }
async fn gets_after(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<AccountProjectRow>> { AccountProject::gets_after(self,cursor,per).await }
async fn gets_before(&mut self, cursor: &str, per: u32) -> Result<orm::KeysetPage<AccountProjectRow>> { AccountProject::gets_before(self,cursor,per).await }
async fn gets_by_account_seq(&mut self, v: i64) -> Result<Collection<AccountProjectRow>> { AccountProject::gets_by_account_seq(self,v).await }
async fn gets_by_project_seq(&mut self, v: i64) -> Result<Collection<AccountProjectRow>> { AccountProject::gets_by_project_seq(self,v).await }
async fn get_count_by_account_seq(&mut self, v: i64) -> Result<i64> { AccountProject::get_count_by_account_seq(self,v).await }
async fn get_count_by_project_seq(&mut self, v: i64) -> Result<i64> { AccountProject::get_count_by_project_seq(self,v).await }
fn account_seq_eq(mut self, v: i64) -> Self { AccountProject::account_seq_eq(self,v) }
fn project_seq_eq(mut self, v: i64) -> Self { AccountProject::project_seq_eq(self,v) }
fn account_seq(self, v: i64) -> Self { AccountProject::account_seq(self,v) }
fn project_seq(self, v: i64) -> Self { AccountProject::project_seq(self,v) }
}

pub trait AccountProjectRowInterface: Sized {
fn using(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> Result<serde_json::Value>;
}
impl AccountProjectRowInterface for AccountProjectRow {
fn using(&mut self, ex: &impl Exec) -> &mut Self { AccountProjectRow::using(self,ex) }
async fn update(&mut self) -> Result<()> { AccountProjectRow::update(self).await }
async fn delete(&self) -> Result<()> { AccountProjectRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { AccountProjectRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { AccountProjectRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { AccountProjectRow::rel_loaded(self,name) }
fn to_map(&self) -> Result<serde_json::Value> { AccountProjectRow::to_map(self) }
}
