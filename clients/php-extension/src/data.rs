//! 결과를 담는 data class(Diagnostic, ReadResult, ParseResult, Manifest, ManifestResult, RenderResult).
//!
//! 순수 PHP client의 같은 이름 class처럼 `final readonly class`이고 property는 typed `public
//! readonly`다. ext-php-rs의 property는 type이 없고 쓸 수 있으며, getter property의 선언 순서는
//! proc macro의 HashMap 순서라 build마다 달라지므로, 이 class들은 Zend API로 직접 선언한다:
//! property를 선언한 순서가 Reflection, var_dump와 json_encode의 순서다. 객체는 확장만 만든다
//! (생성자는 private이다).

use ext_php_rs::builders::{ClassBuilder, FunctionBuilder};
use ext_php_rs::convert::IntoZval;
use ext_php_rs::exception::PhpException;
use ext_php_rs::ffi::{
    zend_class_entry, zend_object, zend_property_info, zend_string, zend_type, zval,
    _ZEND_TYPE_NAME_BIT, IS_ARRAY, IS_LONG, IS_NULL, IS_STRING, IS_UNDEF, ZEND_ACC_PUBLIC,
    ZEND_ACC_READONLY_CLASS,
};
use ext_php_rs::flags::{ClassFlags, MethodFlags};
use ext_php_rs::prelude::*;
use ext_php_rs::types::{ZendObject, ZendStr, Zval};
use ext_php_rs::zend::{ClassEntry, ExecuteData, ExecutorGlobals};
use std::os::raw::c_int;
use std::ptr;
use std::sync::Mutex;

// zend_compile.h의 property flag ZEND_ACC_READONLY(1 << 7)는 bindgen 출력에 없다.
const ZEND_ACC_READONLY: u32 = 1 << 7;

// 확장을 load하는 PHP binary가 해결하는 Zend API(build.rs의 dynamic_lookup).
unsafe extern "C" {
    fn zend_declare_typed_property(
        ce: *mut zend_class_entry,
        name: *mut zend_string,
        property: *mut zval,
        access_type: c_int,
        doc_comment: *mut zend_string,
        type_: zend_type,
    ) -> *mut zend_property_info;
    fn zend_update_property_ex(
        scope: *const zend_class_entry,
        object: *mut zend_object,
        name: *mut zend_string,
        value: *mut zval,
    );
}

/// property 하나의 PHP type.
#[derive(Clone, Copy)]
pub enum PropertyType {
    String,
    NullableString,
    Int,
    Array,
    NullableArray,
    /// 이 이름의 class 객체 또는 null.
    NullableClass(&'static str),
}

/// data class 하나: 이름과 선언 순서의 property.
pub struct DataClass {
    pub name: &'static str,
    pub properties: &'static [(&'static str, PropertyType)],
}

pub const DIAGNOSTIC: DataClass = DataClass {
    name: "Orm\\Dbspec\\Native\\Diagnostic",
    properties: &[
        ("rule", PropertyType::String),
        ("line", PropertyType::Int),
        ("column", PropertyType::Int),
        ("message", PropertyType::String),
    ],
};

pub const READ_RESULT: DataClass = DataClass {
    name: "Orm\\Dbspec\\Native\\ReadResult",
    properties: &[
        ("text", PropertyType::NullableString),
        ("diagnostics", PropertyType::Array),
    ],
};

pub const PARSE_RESULT: DataClass = DataClass {
    name: "Orm\\Dbspec\\Native\\ParseResult",
    properties: &[
        (
            "document",
            PropertyType::NullableClass("Orm\\Dbspec\\Native\\Document"),
        ),
        ("diagnostics", PropertyType::Array),
    ],
};

pub const MANIFEST: DataClass = DataClass {
    name: "Orm\\Dbspec\\Native\\Manifest",
    properties: &[
        ("manifestText", PropertyType::String),
        ("schemaText", PropertyType::String),
        ("manifestHash", PropertyType::String),
        ("schemaHash", PropertyType::String),
        ("externalText", PropertyType::String),
    ],
};

pub const MANIFEST_RESULT: DataClass = DataClass {
    name: "Orm\\Dbspec\\Native\\ManifestResult",
    properties: &[
        (
            "manifest",
            PropertyType::NullableClass("Orm\\Dbspec\\Native\\Manifest"),
        ),
        ("diagnostics", PropertyType::Array),
    ],
};

pub const RENDER_RESULT: DataClass = DataClass {
    name: "Orm\\Dbspec\\Native\\RenderResult",
    properties: &[
        ("statements", PropertyType::NullableArray),
        ("diagnostics", PropertyType::Array),
    ],
};

/// 확장이 등록하는 모든 data class. ParseResult와 ManifestResult의 property type은 class 이름으로
/// 적으므로 등록 순서와 상관없다.
pub const DATA_CLASSES: [&DataClass; 6] = [
    &DIAGNOSTIC,
    &READ_RESULT,
    &PARSE_RESULT,
    &MANIFEST,
    &MANIFEST_RESULT,
    &RENDER_RESULT,
];

/// 등록한 data class의 class entry(이름, 주소). class entry는 module이 load된 동안 영속한다. module
/// startup에서는 class table을 이름으로 찾을 수 없으므로(ClassEntry::try_find는 실행 중의 class table을
/// 본다) 등록 callback이 그 주소를 적는다.
static REGISTERED: Mutex<Vec<(String, usize)>> = Mutex::new(Vec::new());

fn record(ce: &'static mut ClassEntry) {
    let name = ce.name().map(str::to_string).unwrap_or_default();
    REGISTERED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push((name, ptr::from_mut(ce) as usize));
}

fn class_entry(name: &str) -> Option<*mut zend_class_entry> {
    REGISTERED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .find(|(registered, _)| registered == name)
        .map(|&(_, address)| address as *mut zend_class_entry)
}

/// PHP에서 `new`로 부를 수 없게 하는 private 생성자의 본문이다. 확장은 생성자 없이 객체를 만든다.
extern "C" fn private_constructor(_: &mut ExecuteData, _: &mut Zval) {}

fn zend_type_of(property: PropertyType) -> zend_type {
    let mask = |types: &[u32]| zend_type {
        ptr: ptr::null_mut(),
        type_mask: types.iter().fold(0, |mask, t| mask | (1 << t)),
    };
    match property {
        PropertyType::String => mask(&[IS_STRING]),
        PropertyType::NullableString => mask(&[IS_STRING, IS_NULL]),
        PropertyType::Int => mask(&[IS_LONG]),
        PropertyType::Array => mask(&[IS_ARRAY]),
        PropertyType::NullableArray => mask(&[IS_ARRAY, IS_NULL]),
        PropertyType::NullableClass(class) => zend_type {
            // class 이름은 class entry처럼 영속하는 interned 문자열이다.
            ptr: ptr::from_mut(ZendStr::new_interned(class, true).into_raw()).cast(),
            type_mask: _ZEND_TYPE_NAME_BIT | (1 << IS_NULL),
        },
    }
}

/// module startup에서 data class를 등록하고 그 property를 선언한다.
pub fn register(class: &DataClass) -> Result<(), String> {
    ClassBuilder::new(class.name)
        .flags(
            ClassFlags::Final
                | ClassFlags::NoDynamicProperties
                | ClassFlags::from_bits_retain(ZEND_ACC_READONLY_CLASS),
        )
        .method(
            FunctionBuilder::new("__construct", private_constructor),
            MethodFlags::Private,
        )
        .registration(record)
        .register()
        .map_err(|error| format!("cannot register {}: {error:?}", class.name))?;
    let ce = class_entry(class.name).ok_or_else(|| format!("{} is not registered", class.name))?;
    for &(name, property) in class.properties {
        // 기본값이 없는(IS_UNDEF) typed property는 확장이 값을 쓰기 전까지 초기화되지 않은 상태다.
        // Zval::new()는 null이므로 type을 IS_UNDEF(0)로 바꾼다. null 기본값이면 readonly property가
        // 이미 초기화된 것이 되어 쓸 수 없다.
        let mut default = Zval::new();
        default.u1.type_info = IS_UNDEF;
        let info = unsafe {
            zend_declare_typed_property(
                ce,
                ptr::from_mut(ZendStr::new_interned(name, true).into_raw()),
                &raw mut default,
                (ZEND_ACC_PUBLIC | ZEND_ACC_READONLY) as c_int,
                ptr::null_mut(),
                zend_type_of(property),
            )
        };
        if info.is_null() {
            return Err(format!("cannot declare {}::${name}", class.name));
        }
    }
    Ok(())
}

/// class의 객체를 property 선언 순서의 값으로 만든다. readonly property는 class scope에서 한 번만
/// 쓸 수 있으므로 class를 scope로 쓴다. 값의 type이 다르면 PHP가 낸 TypeError다.
pub fn object(class: &DataClass, values: Vec<Zval>) -> PhpResult<Zval> {
    if values.len() != class.properties.len() {
        return Err(PhpException::default(format!(
            "{} has {} properties, given {} values",
            class.name,
            class.properties.len(),
            values.len()
        )));
    }
    let ce = class_entry(class.name)
        .ok_or_else(|| PhpException::default(format!("{} is not registered", class.name)))?;
    // SAFETY: class entry는 module이 load된 동안 영속한다.
    let ce: &ClassEntry = unsafe { &*ce };
    let mut object = ZendObject::new(ce);
    for (&(name, _), mut value) in class.properties.iter().zip(values) {
        let key = ZendStr::new(name, false);
        unsafe {
            zend_update_property_ex(
                ptr::from_ref(ce),
                ptr::from_mut(&mut *object),
                ptr::from_ref(&*key).cast_mut(),
                &raw mut value,
            );
        }
        // 확장이 만든 값의 type은 선언과 같으므로, 예외는 이 확장의 결함이다.
        if ExecutorGlobals::take_exception().is_some() {
            return Err(PhpException::default(format!(
                "cannot set {}::${name}: the value does not have the declared type",
                class.name
            )));
        }
    }
    object
        .into_zval(false)
        .map_err(|error| PhpException::default(format!("cannot return {}: {error:?}", class.name)))
}

/// 이 확장의 class 객체를 담은 zval을 그 class를 return type으로 선언해 돌려준다.
macro_rules! returned_class {
    ($name:ident, $class:literal) => {
        pub struct $name(pub Zval);

        impl IntoZval for $name {
            const TYPE: ext_php_rs::flags::DataType =
                ext_php_rs::flags::DataType::Object(Some($class));
            const NULLABLE: bool = false;

            fn set_zval(self, zv: &mut Zval, persistent: bool) -> ext_php_rs::error::Result<()> {
                self.0.set_zval(zv, persistent)
            }
        }
    };
}

returned_class!(ReadResultObject, "Orm\\Dbspec\\Native\\ReadResult");
returned_class!(ParseResultObject, "Orm\\Dbspec\\Native\\ParseResult");
returned_class!(ManifestResultObject, "Orm\\Dbspec\\Native\\ManifestResult");
returned_class!(RenderResultObject, "Orm\\Dbspec\\Native\\RenderResult");
