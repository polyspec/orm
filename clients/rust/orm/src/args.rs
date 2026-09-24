//! Condition values: the kinds a column accepts, the argument traits generated
//! chain methods use, the null value, and the ORM functions.

use chrono::{NaiveDate, NaiveDateTime};

use crate::core::Core;
use crate::model::Model;
use crate::value::{Param, Point};

/// The null condition value: `IS NULL`, or `IS NOT NULL` with `ne`. It is
/// accepted only by nullable columns.
#[derive(Debug, Clone, Copy)]
pub struct Null;

/// An ORM function value. It carries the function kind and its arguments; the
/// model method that receives it records the column and the operator, and the
/// planner renders SQL for the connection dialect.
#[derive(Debug, Clone, PartialEq)]
pub struct Func {
    pub(crate) name: &'static str,
    pub(crate) args: Vec<Param>,
    pub(crate) column: bool,
}

fn value_func(name: &'static str, args: Vec<Param>) -> Func {
    Func { name, args, column: false }
}

fn column_func(name: &'static str, args: Vec<Param>) -> Func {
    Func { name, args, column: true }
}

/// The current time of the connection.
pub fn now() -> Func {
    value_func("now", vec![])
}
/// The current date of the connection.
pub fn today() -> Func {
    value_func("today", vec![])
}
/// The current time minus n seconds.
pub fn seconds_ago(n: i64) -> Func {
    value_func("seconds_ago", vec![Param::I64(n)])
}
/// The current time minus n minutes.
pub fn minutes_ago(n: i64) -> Func {
    value_func("minutes_ago", vec![Param::I64(n)])
}
/// The current time minus n hours.
pub fn hours_ago(n: i64) -> Func {
    value_func("hours_ago", vec![Param::I64(n)])
}
/// The current time minus n days.
pub fn days_ago(n: i64) -> Func {
    value_func("days_ago", vec![Param::I64(n)])
}
/// The current time minus n months.
pub fn months_ago(n: i64) -> Func {
    value_func("months_ago", vec![Param::I64(n)])
}
/// The current time plus n seconds.
pub fn seconds_later(n: i64) -> Func {
    value_func("seconds_later", vec![Param::I64(n)])
}
/// The current time plus n minutes.
pub fn minutes_later(n: i64) -> Func {
    value_func("minutes_later", vec![Param::I64(n)])
}
/// The current time plus n hours.
pub fn hours_later(n: i64) -> Func {
    value_func("hours_later", vec![Param::I64(n)])
}
/// The current time plus n days.
pub fn days_later(n: i64) -> Func {
    value_func("days_later", vec![Param::I64(n)])
}
/// The current time plus n months.
pub fn months_later(n: i64) -> Func {
    value_func("months_later", vec![Param::I64(n)])
}
/// The weekday of a date or time column, 1 (Sunday) to 7.
pub fn day_of_week() -> Func {
    column_func("day_of_week", vec![])
}
/// The year of a date or time column.
pub fn year() -> Func {
    column_func("year", vec![])
}
/// The month of a date or time column.
pub fn month() -> Func {
    column_func("month", vec![])
}
/// The date part of a date or time column.
pub fn date() -> Func {
    column_func("date", vec![])
}
/// The distance in meters from a point column to the point.
pub fn distance(longitude: f64, latitude: f64) -> Func {
    column_func("distance", vec![Param::F64(longitude), Param::F64(latitude)])
}
/// The longitude of a point column.
pub fn point_x() -> Func {
    column_func("point_x", vec![])
}
/// The latitude of a point column.
pub fn point_y() -> Func {
    column_func("point_y", vec![])
}

/// Column value kinds. A generated chain method bounds each argument with the
/// kind of its column; the `*Null` kinds also accept [`Null`].
pub mod kind {
    macro_rules! kinds {
        ($($name:ident),*) => { $( #[doc(hidden)] pub struct $name; )* };
    }
    kinds!(
        Int,
        IntNull,
        Float,
        FloatNull,
        Decimal,
        DecimalNull,
        Text,
        TextNull,
        Bool,
        BoolNull,
        Time,
        TimeNull,
        Bytes,
        BytesNull,
        Point,
        PointNull,
        Styled,
        StyledNull
    );
}

/// One condition value as the runtime records it.
#[derive(Clone)]
pub enum Value {
    One(Param),
    List(Vec<Param>),
    Pair(Param, Param),
    Null,
    Func(Func),
    Sub(Box<Core>),
}

/// A value of an equality condition: one value, a list (`IN`), null (nullable
/// columns), a value function, or an unexecuted model (a subquery).
pub trait EqArg<K> {
    fn into_value(self) -> Value;
}

/// A value of an ordering comparison: one value or a value function.
pub trait CmpArg<K> {
    fn into_value(self) -> Value;
}

/// A value of a `between` condition: a fixed two-value array.
pub trait BetweenArg<K> {
    fn into_value(self) -> Value;
}

/// A value of a `lk`/`lb` condition.
pub trait LikeArg {
    fn into_value(self) -> Value;
}

impl LikeArg for &str {
    fn into_value(self) -> Value {
        Value::One(Param::Str(self.to_owned()))
    }
}

impl LikeArg for String {
    fn into_value(self) -> Value {
        Value::One(Param::Str(self))
    }
}

impl LikeArg for &String {
    fn into_value(self) -> Value {
        Value::One(Param::Str(self.clone()))
    }
}

macro_rules! scalar {
    ($t:ty, $conv:expr, $($k:ident),*) => {
        $(
            impl EqArg<kind::$k> for $t {
                fn into_value(self) -> Value { Value::One(($conv)(self)) }
            }
            impl CmpArg<kind::$k> for $t {
                fn into_value(self) -> Value { Value::One(($conv)(self)) }
            }
            impl EqArg<kind::$k> for Vec<$t> {
                fn into_value(self) -> Value { Value::List(self.into_iter().map($conv).collect()) }
            }
            impl EqArg<kind::$k> for &[$t] {
                fn into_value(self) -> Value { Value::List(self.iter().cloned().map($conv).collect()) }
            }
            impl BetweenArg<kind::$k> for [$t; 2] {
                fn into_value(self) -> Value { let [a, b] = self; Value::Pair(($conv)(a), ($conv)(b)) }
            }
        )*
    };
}

fn int<T: Into<i64>>(v: T) -> Param {
    Param::I64(v.into())
}

scalar!(i64, int, Int, IntNull, Float, FloatNull, Decimal, DecimalNull);
scalar!(i32, int, Int, IntNull, Float, FloatNull, Decimal, DecimalNull);
scalar!(i16, int, Int, IntNull, Float, FloatNull, Decimal, DecimalNull);
scalar!(u32, int, Int, IntNull, Float, FloatNull, Decimal, DecimalNull);
scalar!(u8, int, Int, IntNull, Float, FloatNull, Decimal, DecimalNull);
scalar!(u64, |v: u64| Param::I64(v as i64), Int, IntNull, Float, FloatNull, Decimal, DecimalNull);
scalar!(usize, |v: usize| Param::I64(v as i64), Int, IntNull, Float, FloatNull, Decimal, DecimalNull);
scalar!(f64, Param::F64, Float, FloatNull, Decimal, DecimalNull);
scalar!(f32, |v: f32| Param::F64(v as f64), Float, FloatNull, Decimal, DecimalNull);
scalar!(bool, Param::Bool, Bool, BoolNull);
scalar!(String, Param::Str, Text, TextNull, Decimal, DecimalNull, Time, TimeNull);
scalar!(&str, |v: &str| Param::Str(v.to_owned()), Text, TextNull, Decimal, DecimalNull, Time, TimeNull);
scalar!(NaiveDateTime, Param::DateTime, Time, TimeNull);
scalar!(NaiveDate, Param::Date, Time, TimeNull);
scalar!(Vec<u8>, Param::Bytes, Bytes, BytesNull);

macro_rules! nullable {
    ($($k:ident),*) => {
        $(
            impl EqArg<kind::$k> for Null {
                fn into_value(self) -> Value { Value::Null }
            }
        )*
    };
}
nullable!(IntNull, FloatNull, DecimalNull, TextNull, BoolNull, TimeNull, BytesNull, PointNull, StyledNull);

macro_rules! funcs {
    ($($k:ident),*) => {
        $(
            impl EqArg<kind::$k> for Func {
                fn into_value(self) -> Value { Value::Func(self) }
            }
            impl CmpArg<kind::$k> for Func {
                fn into_value(self) -> Value { Value::Func(self) }
            }
        )*
    };
}
funcs!(Int, IntNull, Float, FloatNull, Decimal, DecimalNull, Text, TextNull, Bool, BoolNull, Time, TimeNull, Bytes, BytesNull, Point, PointNull);

impl<K, M: Model> EqArg<K> for M {
    fn into_value(self) -> Value {
        Value::Sub(Box::new(self.into_core()))
    }
}

/// The compared value of a column function condition.
pub trait Compared {
    fn into_param(self) -> Param;
}

macro_rules! compared {
    ($($t:ty => $conv:expr),*) => {
        $( impl Compared for $t { fn into_param(self) -> Param { ($conv)(self) } } )*
    };
}
compared!(i64 => Param::I64, i32 => |v: i32| Param::I64(v as i64), u32 => |v: u32| Param::I64(v as i64),
    f64 => Param::F64, f32 => |v: f32| Param::F64(v as f64), bool => Param::Bool, String => Param::Str,
    &str => |v: &str| Param::Str(v.to_owned()), NaiveDateTime => Param::DateTime, NaiveDate => Param::Date);

/// A value stored with `set_<col>`.
pub trait SetArg {
    fn into_param(self) -> Param;
}

macro_rules! set_arg {
    ($($t:ty => $conv:expr),*) => {
        $( impl SetArg for $t { fn into_param(self) -> Param { ($conv)(self) } } )*
    };
}
set_arg!(i64 => Param::I64, i32 => |v: i32| Param::I64(v as i64), f64 => Param::F64, bool => Param::Bool,
    String => Param::Str, NaiveDateTime => Param::DateTime, NaiveDate => Param::Date, Vec<u8> => Param::Bytes,
    Point => Param::Point);

/// Anything a raw fragment binds.
pub fn bind(v: impl Into<Param>) -> Param {
    v.into()
}

/// The argument of `and`/`or`: a group callback, a joined model placed as a
/// group (generated per model), or `()` for a connector written as its own call.
pub trait GroupArg<M> {
    fn apply(self, conn: &'static str, core: &mut Core);
}

impl<M: Model, F: FnOnce(M) -> M> GroupArg<M> for F {
    fn apply(self, conn: &'static str, core: &mut Core) {
        let g = self(M::from_core(core.group()));
        core.add_group(conn, g.into_core());
    }
}

impl<M> GroupArg<M> for () {
    fn apply(self, conn: &'static str, core: &mut Core) {
        core.connector(conn);
    }
}

/// The binds of a raw fragment: `()`, a tuple, an array, or a vector.
pub trait Binds {
    fn into_binds(self) -> Vec<Param>;
}

impl Binds for () {
    fn into_binds(self) -> Vec<Param> {
        Vec::new()
    }
}

impl<T: Into<Param>, const N: usize> Binds for [T; N] {
    fn into_binds(self) -> Vec<Param> {
        self.into_iter().map(Into::into).collect()
    }
}

impl<T: Into<Param>> Binds for Vec<T> {
    fn into_binds(self) -> Vec<Param> {
        self.into_iter().map(Into::into).collect()
    }
}

macro_rules! tuple_binds {
    ($(($($t:ident $v:ident),+))*) => {
        $(
            impl<$($t: Into<Param>),+> Binds for ($($t,)+) {
                fn into_binds(self) -> Vec<Param> {
                    let ($($v,)+) = self;
                    vec![$($v.into()),+]
                }
            }
        )*
    };
}
tuple_binds!((A a) (A a, B b) (A a, B b, C c) (A a, B b, C c, D d) (A a, B b, C c, D d, E e) (A a, B b, C c, D d, E e, F f));

/// A value stored in a nullable column: the value, an `Option`, or [`Null`].
pub trait IntoNullable<T> {
    fn into_nullable(self) -> Option<T>;
}

impl<T> IntoNullable<T> for Option<T> {
    fn into_nullable(self) -> Option<T> {
        self
    }
}

impl<T> IntoNullable<T> for Null {
    fn into_nullable(self) -> Option<T> {
        None
    }
}

macro_rules! nullable_values {
    ($($from:ty => $to:ty),*) => {
        $( impl IntoNullable<$to> for $from { fn into_nullable(self) -> Option<$to> { Some(self.into()) } } )*
    };
}
nullable_values!(i32 => i32, i32 => i64, i64 => i64, f64 => f64, f32 => f64, i32 => f64, bool => bool, String => String,
    &str => String, NaiveDateTime => NaiveDateTime, NaiveDate => NaiveDate, Vec<u8> => Vec<u8>, &[u8] => Vec<u8>, Point => Point);

/// The output of `add_column_<col>_alias_<name>`: a format with `%s` for the
/// column, or a column function.
pub enum ColumnFormat {
    Text(String),
    Func(Func),
}

/// A value accepted as a column format.
pub trait IntoColumnFormat {
    fn into_column_format(self) -> ColumnFormat;
}

impl IntoColumnFormat for &str {
    fn into_column_format(self) -> ColumnFormat {
        ColumnFormat::Text(self.to_owned())
    }
}

impl IntoColumnFormat for String {
    fn into_column_format(self) -> ColumnFormat {
        ColumnFormat::Text(self)
    }
}

impl IntoColumnFormat for Func {
    fn into_column_format(self) -> ColumnFormat {
        ColumnFormat::Func(self)
    }
}

impl Core {
    /// Adds a formatted or function column under an output name.
    pub fn add_column_as(&mut self, column: &str, name: &str, format: impl IntoColumnFormat) {
        match format.into_column_format() {
            ColumnFormat::Text(f) => self.add_column_format(column, name, &f),
            ColumnFormat::Func(f) => self.add_column_func(column, name, f),
        }
    }
}
