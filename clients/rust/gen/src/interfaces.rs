// Code generated from contracts/interfaces.json; DO NOT EDIT.
#![allow(unused_imports, unused_mut, async_fn_in_trait)]
use super::*;
use orm::{Collection, Page, Result};
use orm::db::{self, Exec};

pub trait BattleInterface: Sized {
async fn get(&mut self) -> Result<Option<BattleRow>>;
async fn gets(&mut self) -> Result<Collection<BattleRow>>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<BattleRow>>;
async fn insert(&mut self) -> Result<Option<BattleRow>>;
async fn save(&mut self) -> Result<Option<BattleRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn new() -> Self;
fn bind(self, ex: &impl Exec) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<BattleRow>>;
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
async fn gets_by_aes_hex_email(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>>;
async fn gets_by_aes_hex_phone(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>>;
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
fn aes_hex_email(self, v: impl Into<String>) -> Self;
fn aes_hex_phone(self, v: impl Into<String>) -> Self;
fn price(self, v: f64) -> Self;
fn ip(self, v: impl Into<String>) -> Self;
}
impl BattleInterface for Battle {
async fn get(&mut self) -> Result<Option<BattleRow>> { Battle::get(self).await }
async fn gets(&mut self) -> Result<Collection<BattleRow>> { Battle::gets(self).await }
async fn get_count(&mut self) -> Result<i64> { Battle::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<BattleRow>> { Battle::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<BattleRow>> { Battle::insert(self).await }
async fn save(&mut self) -> Result<Option<BattleRow>> { Battle::save(self).await }
async fn update(&mut self) -> Result<u64> { Battle::update(self).await }
async fn delete(&mut self) -> Result<u64> { Battle::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { Battle::sql(self).await }
fn new() -> Self { Battle::new() }
fn bind(mut self, ex: &impl Exec) -> Self { Battle::bind(self,ex) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<BattleRow>> { Battle::paginate(self,page,per).await }
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
async fn gets_by_aes_hex_email(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>> { Battle::gets_by_aes_hex_email(self,v).await }
async fn gets_by_aes_hex_phone(&mut self, v: impl Into<String>) -> Result<Collection<BattleRow>> { Battle::gets_by_aes_hex_phone(self,v).await }
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
async fn get_count_by_aes_hex_email(&mut self, v: impl Into<String>) -> Result<i64> { Battle::get_count_by_aes_hex_email(self,v).await }
async fn get_count_by_aes_hex_phone(&mut self, v: impl Into<String>) -> Result<i64> { Battle::get_count_by_aes_hex_phone(self,v).await }
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
fn aes_hex_email_eq(mut self, v: impl Into<String>) -> Self { Battle::aes_hex_email_eq(self,v) }
fn aes_hex_phone_eq(mut self, v: impl Into<String>) -> Self { Battle::aes_hex_phone_eq(self,v) }
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
fn aes_hex_email(self, v: impl Into<String>) -> Self { Battle::aes_hex_email(self,v) }
fn aes_hex_phone(self, v: impl Into<String>) -> Self { Battle::aes_hex_phone(self,v) }
fn price(self, v: f64) -> Self { Battle::price(self,v) }
fn ip(self, v: impl Into<String>) -> Self { Battle::ip(self,v) }
}

pub trait BattleRowInterface: Sized {
fn bind(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn update_optimistic(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> serde_json::Value;
}
impl BattleRowInterface for BattleRow {
fn bind(&mut self, ex: &impl Exec) -> &mut Self { BattleRow::bind(self,ex) }
async fn update(&mut self) -> Result<()> { BattleRow::update(self).await }
async fn update_optimistic(&mut self) -> Result<()> { BattleRow::update_optimistic(self).await }
async fn delete(&self) -> Result<()> { BattleRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { BattleRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { BattleRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { BattleRow::rel_loaded(self,name) }
fn to_map(&self) -> serde_json::Value { BattleRow::to_map(self) }
}

pub trait UserInterface: Sized {
async fn get(&mut self) -> Result<Option<UserRow>>;
async fn gets(&mut self) -> Result<Collection<UserRow>>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<UserRow>>;
async fn insert(&mut self) -> Result<Option<UserRow>>;
async fn save(&mut self) -> Result<Option<UserRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn new() -> Self;
fn bind(self, ex: &impl Exec) -> Self;
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
async fn get_count(&mut self) -> Result<i64> { User::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<UserRow>> { User::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<UserRow>> { User::insert(self).await }
async fn save(&mut self) -> Result<Option<UserRow>> { User::save(self).await }
async fn update(&mut self) -> Result<u64> { User::update(self).await }
async fn delete(&mut self) -> Result<u64> { User::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { User::sql(self).await }
fn new() -> Self { User::new() }
fn bind(mut self, ex: &impl Exec) -> Self { User::bind(self,ex) }
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
fn bind(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> serde_json::Value;
}
impl UserRowInterface for UserRow {
fn bind(&mut self, ex: &impl Exec) -> &mut Self { UserRow::bind(self,ex) }
async fn update(&mut self) -> Result<()> { UserRow::update(self).await }
async fn delete(&self) -> Result<()> { UserRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { UserRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { UserRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { UserRow::rel_loaded(self,name) }
fn to_map(&self) -> serde_json::Value { UserRow::to_map(self) }
}

pub trait ServiceInterface: Sized {
async fn get(&mut self) -> Result<Option<ServiceRow>>;
async fn gets(&mut self) -> Result<Collection<ServiceRow>>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<ServiceRow>>;
async fn insert(&mut self) -> Result<Option<ServiceRow>>;
async fn save(&mut self) -> Result<Option<ServiceRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn new() -> Self;
fn bind(self, ex: &impl Exec) -> Self;
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
async fn get_count(&mut self) -> Result<i64> { Service::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<ServiceRow>> { Service::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<ServiceRow>> { Service::insert(self).await }
async fn save(&mut self) -> Result<Option<ServiceRow>> { Service::save(self).await }
async fn update(&mut self) -> Result<u64> { Service::update(self).await }
async fn delete(&mut self) -> Result<u64> { Service::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { Service::sql(self).await }
fn new() -> Self { Service::new() }
fn bind(mut self, ex: &impl Exec) -> Self { Service::bind(self,ex) }
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
fn bind(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> serde_json::Value;
}
impl ServiceRowInterface for ServiceRow {
fn bind(&mut self, ex: &impl Exec) -> &mut Self { ServiceRow::bind(self,ex) }
async fn update(&mut self) -> Result<()> { ServiceRow::update(self).await }
async fn delete(&self) -> Result<()> { ServiceRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { ServiceRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { ServiceRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { ServiceRow::rel_loaded(self,name) }
fn to_map(&self) -> serde_json::Value { ServiceRow::to_map(self) }
}

pub trait ServiceModuleInterface: Sized {
async fn get(&mut self) -> Result<Option<ServiceModuleRow>>;
async fn gets(&mut self) -> Result<Collection<ServiceModuleRow>>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<ServiceModuleRow>>;
async fn insert(&mut self) -> Result<Option<ServiceModuleRow>>;
async fn save(&mut self) -> Result<Option<ServiceModuleRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn new() -> Self;
fn bind(self, ex: &impl Exec) -> Self;
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<ServiceModuleRow>>;
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
async fn get(&mut self) -> Result<Option<ServiceModuleRow>> { ServiceModule::get(self).await }
async fn gets(&mut self) -> Result<Collection<ServiceModuleRow>> { ServiceModule::gets(self).await }
async fn get_count(&mut self) -> Result<i64> { ServiceModule::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<ServiceModuleRow>> { ServiceModule::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<ServiceModuleRow>> { ServiceModule::insert(self).await }
async fn save(&mut self) -> Result<Option<ServiceModuleRow>> { ServiceModule::save(self).await }
async fn update(&mut self) -> Result<u64> { ServiceModule::update(self).await }
async fn delete(&mut self) -> Result<u64> { ServiceModule::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { ServiceModule::sql(self).await }
fn new() -> Self { ServiceModule::new() }
fn bind(mut self, ex: &impl Exec) -> Self { ServiceModule::bind(self,ex) }
async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<ServiceModuleRow>> { ServiceModule::paginate(self,page,per).await }
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
fn bind(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> serde_json::Value;
}
impl ServiceModuleRowInterface for ServiceModuleRow {
fn bind(&mut self, ex: &impl Exec) -> &mut Self { ServiceModuleRow::bind(self,ex) }
async fn update(&mut self) -> Result<()> { ServiceModuleRow::update(self).await }
async fn delete(&self) -> Result<()> { ServiceModuleRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { ServiceModuleRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { ServiceModuleRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { ServiceModuleRow::rel_loaded(self,name) }
fn to_map(&self) -> serde_json::Value { ServiceModuleRow::to_map(self) }
}

pub trait ServiceMemberInterface: Sized {
async fn get(&mut self) -> Result<Option<ServiceMemberRow>>;
async fn gets(&mut self) -> Result<Collection<ServiceMemberRow>>;
async fn get_count(&mut self) -> Result<i64>;
async fn gets_count(&mut self) -> Result<Collection<ServiceMemberRow>>;
async fn insert(&mut self) -> Result<Option<ServiceMemberRow>>;
async fn save(&mut self) -> Result<Option<ServiceMemberRow>>;
async fn update(&mut self) -> Result<u64>;
async fn delete(&mut self) -> Result<u64>;
async fn sql(&mut self) -> Result<db::Sql>;
fn new() -> Self;
fn bind(self, ex: &impl Exec) -> Self;
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
async fn get_count(&mut self) -> Result<i64> { ServiceMember::get_count(self).await }
async fn gets_count(&mut self) -> Result<Collection<ServiceMemberRow>> { ServiceMember::gets_count(self).await }
async fn insert(&mut self) -> Result<Option<ServiceMemberRow>> { ServiceMember::insert(self).await }
async fn save(&mut self) -> Result<Option<ServiceMemberRow>> { ServiceMember::save(self).await }
async fn update(&mut self) -> Result<u64> { ServiceMember::update(self).await }
async fn delete(&mut self) -> Result<u64> { ServiceMember::delete(self).await }
async fn sql(&mut self) -> Result<db::Sql> { ServiceMember::sql(self).await }
fn new() -> Self { ServiceMember::new() }
fn bind(mut self, ex: &impl Exec) -> Self { ServiceMember::bind(self,ex) }
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
fn bind(&mut self, ex: &impl Exec) -> &mut Self;
async fn update(&mut self) -> Result<()>;
async fn delete(&self) -> Result<()>;
async fn delete_cascade(&self) -> Result<()>;
fn has(&self, name: &str) -> bool;
fn rel_loaded(&self, name: &str) -> bool;
fn to_map(&self) -> serde_json::Value;
}
impl ServiceMemberRowInterface for ServiceMemberRow {
fn bind(&mut self, ex: &impl Exec) -> &mut Self { ServiceMemberRow::bind(self,ex) }
async fn update(&mut self) -> Result<()> { ServiceMemberRow::update(self).await }
async fn delete(&self) -> Result<()> { ServiceMemberRow::delete(self).await }
async fn delete_cascade(&self) -> Result<()> { ServiceMemberRow::delete_cascade(self).await }
fn has(&self, name: &str) -> bool { ServiceMemberRow::has(self,name) }
fn rel_loaded(&self, name: &str) -> bool { ServiceMemberRow::rel_loaded(self,name) }
fn to_map(&self) -> serde_json::Value { ServiceMemberRow::to_map(self) }
}
