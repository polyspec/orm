/* Native implementation of Model's dynamic DSL (packages/php/src/Model.php). */
#include "php.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_closures.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_smart_str.h"
#include "model_dsl.h"
#include "model_native_methods.h"

static zval *prop(model_state *s, const char *name) { return model_state_property(s, name); }
static zval *at(zval *a, const char *key) { return Z_TYPE_P(a)==IS_ARRAY ? zend_hash_str_find(Z_ARRVAL_P(a),key,strlen(key)) : NULL; }
static bool is_str(zval *v,const char *s) { return v && Z_TYPE_P(v)==IS_STRING && zend_string_equals_cstr(Z_STR_P(v),s,strlen(s)); }
static void throw_orm(const char *code,const char *message)
{
    zend_string *n=zend_string_init("Polyspec\\Orm\\OrmException",sizeof("Polyspec\\Orm\\OrmException")-1,0);zend_class_entry *ce=zend_lookup_class(n);zend_string_release(n);
    if(!ce){zend_throw_error(NULL,"Polyspec\\Orm\\OrmException is not loaded");return;}zval ex,a[2],rv;object_init_ex(&ex,ce);ZVAL_STRING(&a[0],code);ZVAL_STRING(&a[1],message);ZVAL_UNDEF(&rv);
    zend_call_method_with_2_params(Z_OBJ(ex),ce,NULL,"__construct",&rv,&a[0],&a[1]);zval_ptr_dtor(&a[0]);zval_ptr_dtor(&a[1]);if(!Z_ISUNDEF(rv))zval_ptr_dtor(&rv);if(EG(exception)==NULL)zend_throw_exception_object(&ex);else zval_ptr_dtor(&ex);
}

static bool invoke(zval *object,const char *method,uint32_t argc,zval *argv,zval *rv)
{
    zval fn; ZVAL_STRING(&fn,method);
    zend_result rc=call_user_function(NULL,object,&fn,rv,argc,argv);
    zval_ptr_dtor(&fn); return rc==SUCCESS && EG(exception)==NULL;
}
static bool static_call(const char *class_name,const char *method,uint32_t argc,zval *argv,zval *rv)
{
    smart_str f={0}; smart_str_appends(&f,class_name); smart_str_appends(&f,"::"); smart_str_appends(&f,method); smart_str_0(&f);
    zval fn; ZVAL_STR(&fn,f.s); zend_result rc=call_user_function(EG(function_table),NULL,&fn,rv,argc,argv);
    zval_ptr_dtor(&fn); return rc==SUCCESS && EG(exception)==NULL;
}
static bool call_chain(const char *method,zend_string *class_name,zend_string *name,zval *rv)
{
    zval a[2]; ZVAL_STR_COPY(&a[0],class_name); ZVAL_STR_COPY(&a[1],name);
    bool ok=static_call("Polyspec\\Orm\\Chain",method,2,a,rv); zval_ptr_dtor(&a[0]);zval_ptr_dtor(&a[1]);return ok;
}
static zend_string *snake(zend_string *s)
{
    smart_str o={0}; for(size_t i=0;i<ZSTR_LEN(s);i++){unsigned char c=ZSTR_VAL(s)[i];if(i&&c>='A'&&c<='Z')smart_str_appendc(&o,'_');smart_str_appendc(&o,c>='A'&&c<='Z'?(char)(c+32):(char)c);}smart_str_0(&o);return o.s?o.s:zend_string_init("",0,0);
}
static bool prefixed(zend_string *n,const char *p)
{ size_t l=strlen(p);return ZSTR_LEN(n)>l&&!memcmp(ZSTR_VAL(n),p,l)&&ZSTR_VAL(n)[l]>='A'&&ZSTR_VAL(n)[l]<='Z'; }
static bool arity(model_state *s,zend_string *name,zval *args,uint32_t n)
{
    if(zend_hash_num_elements(Z_ARRVAL_P(args))==n)return true;
    zend_string *m=strpprintf(0,"%s takes %u argument%s",ZSTR_VAL(name),n,n==1?"":"s");throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);return false;
}
static zend_string *column(zval *meta,zend_string *pascal)
{
    zval a[2],rv;ZVAL_COPY(&a[0],meta);ZVAL_STR_COPY(&a[1],pascal);ZVAL_UNDEF(&rv);
    bool ok=static_call("Polyspec\\Orm\\Chain","columnName",2,a,&rv);zval_ptr_dtor(&a[0]);zval_ptr_dtor(&a[1]);
    if(!ok||Z_TYPE(rv)!=IS_STRING){if(!Z_ISUNDEF(rv))zval_ptr_dtor(&rv);return zend_string_init("",0,0);}zend_string *r=Z_STR(rv);return r;
}
static bool function_column(zval *value)
{
    if(Z_TYPE_P(value)!=IS_OBJECT)return false;zend_string *n=zend_string_init("Polyspec\\Orm\\Func",sizeof("Polyspec\\Orm\\Func")-1,0);zend_class_entry *ce=zend_lookup_class(n);zend_string_release(n);if(!ce||!instanceof_function(Z_OBJCE_P(value),ce))return false;
    zval rv;ZVAL_UNDEF(&rv);zval *v=zend_read_property(ce,Z_OBJ_P(value),"column",6,1,&rv);bool yes=Z_TYPE_P(v)==IS_TRUE;if(!Z_ISUNDEF(rv))zval_ptr_dtor(&rv);return yes;
}
static bool get_meta(zend_object *obj,zval *meta)
{
    zend_string *cn=zend_string_init(ZSTR_VAL(obj->ce->name),ZSTR_LEN(obj->ce->name),0);
    zval fn; smart_str f={0};smart_str_append(&f,cn);smart_str_appends(&f,"::meta");smart_str_0(&f);ZVAL_STR(&fn,f.s);
    bool ok=call_user_function(EG(function_table),NULL,&fn,meta,0,NULL)==SUCCESS&&EG(exception)==NULL;
    zval_ptr_dtor(&fn);zend_string_release(cn);return ok;
}
static bool output_name(model_state *s,zval *meta,zend_string *pascal,zend_string **key)
{
    if(!ZSTR_LEN(pascal)){throw_orm("CONFIG","an added column needs a name that is not a column: ");return false;}
    zend_string *c=column(meta,pascal);bool exists=ZSTR_LEN(c)>0;zend_string_release(c);
    if(exists){zend_string *m=strpprintf(0,"an added column needs a name that is not a column: %s",ZSTR_VAL(pascal));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);return false;}
    *key=snake(pascal); if(zend_hash_exists(Z_ARRVAL_P(prop(s,"outputs")),*key)){zend_string *m=strpprintf(0,"column name %s is already added",ZSTR_VAL(*key));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);zend_string_release(*key);return false;}return true;
}
static bool dsl_add_column_call(zval *model,zend_string *name,zend_string *rest,zval *args)
{
    model_state *s=model_state_of(Z_OBJ_P(model));zval meta;ZVAL_UNDEF(&meta);if(!get_meta(Z_OBJ_P(model),&meta))return false;
    zend_string *col=column(&meta,rest);
    if(ZSTR_LEN(col)){
        if(!arity(s,name,args,0)){zend_string_release(col);zval_ptr_dtor(&meta);return false;}
        bool found=false;zval *item;ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(prop(s,"add_columns")),item){if(Z_TYPE_P(item)==IS_STRING&&zend_string_equals(Z_STR_P(item),col)){found=true;break;}}ZEND_HASH_FOREACH_END();
        if(found)zend_string_release(col);else{model_state_property_separate(s,"add_columns");add_next_index_str(prop(s,"add_columns"),col);}zval_ptr_dtor(&meta);return true;
    }
    zend_string_release(col);const char *alias=php_memnstr(ZSTR_VAL(rest),"Alias",5,ZSTR_VAL(rest)+ZSTR_LEN(rest));
    if(alias&&alias>ZSTR_VAL(rest)){
        zend_string *left=zend_string_init(ZSTR_VAL(rest),alias-ZSTR_VAL(rest),0);col=column(&meta,left);zend_string_release(left);
        if(ZSTR_LEN(col)&&alias+5<ZSTR_VAL(rest)+ZSTR_LEN(rest)){
            if(!arity(s,name,args,1)){zend_string_release(col);zval_ptr_dtor(&meta);return false;}
            zend_string *out_name=zend_string_init(alias+5,ZSTR_VAL(rest)+ZSTR_LEN(rest)-(alias+5),0),*key=NULL;
            if(!output_name(s,&meta,out_name,&key)){zend_string_release(col);zend_string_release(out_name);zval_ptr_dtor(&meta);return false;}
            zval *fn=zend_hash_index_find(Z_ARRVAL_P(args),0);if(!fn||!function_column(fn)){zend_string *m=strpprintf(0,"%s takes a column function",ZSTR_VAL(name));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);zend_string_release(col);zend_string_release(out_name);zend_string_release(key);zval_ptr_dtor(&meta);return false;}
            zval item,tuple;array_init(&item);array_init(&tuple);add_next_index_str(&tuple,col);Z_TRY_ADDREF_P(fn);add_next_index_zval(&tuple,fn);add_assoc_zval(&item,"fn",&tuple);model_state_property_separate(s,"outputs");zend_hash_update(Z_ARRVAL_P(prop(s,"outputs")),key,&item);zend_string_release(key);zend_string_release(out_name);zval_ptr_dtor(&meta);return true;
        }
        zend_string_release(col);
    }
    if(!arity(s,name,args,1)){zval_ptr_dtor(&meta);return false;}
    zval *callback=zend_hash_index_find(Z_ARRVAL_P(args),0);
    if(!callback||Z_TYPE_P(callback)!=IS_OBJECT||!instanceof_function(Z_OBJCE_P(callback),zend_ce_closure)){zend_string *m=strpprintf(0,"%s takes a callback that returns a model",ZSTR_VAL(name));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);zval_ptr_dtor(&meta);return false;}
    zend_string *key=NULL;if(!output_name(s,&meta,rest,&key)){zval_ptr_dtor(&meta);return false;}zval item;array_init(&item);Z_TRY_ADDREF_P(callback);add_assoc_zval(&item,"sub",callback);model_state_property_separate(s,"outputs");zend_hash_update(Z_ARRVAL_P(prop(s,"outputs")),key,&item);zend_string_release(key);zval_ptr_dtor(&meta);return true;
}
static bool dsl_add_join(zval *model,zend_string *kind,zend_string *left,zend_string *right,zval *child)
{
    model_state *s=model_state_of(Z_OBJ_P(model));if(Z_TYPE_P(prop(s,"group_of"))!=IS_NULL){model_native_fail(s,"join is not allowed inside a group callback");return true;}
    if(Z_TYPE_P(prop(model_state_of(Z_OBJ_P(child)),"conn"))!=IS_NULL){model_native_fail(s,"a join child cannot have its own connection");return true;}
    zval *entry;ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(prop(s,"joins")),entry){zval *old=at(entry,"child");if(old&&Z_TYPE_P(old)==IS_OBJECT&&Z_OBJ_P(old)==Z_OBJ_P(child)){model_native_fail(s,"the model is already joined");return true;}}ZEND_HASH_FOREACH_END();
    zval join;array_init(&join);add_assoc_str(&join,"kind",zend_string_copy(kind));add_assoc_str(&join,"left",zend_string_copy(left));add_assoc_str(&join,"right",zend_string_copy(right));Z_TRY_ADDREF_P(child);add_assoc_zval(&join,"child",child);model_state_property_separate(s,"joins");add_next_index_zval(prop(s,"joins"),&join);return true;
}
static bool dsl_named(zval *model,zend_string *key,zend_string *method,zval *result)
{
    model_state *s=model_state_of(Z_OBJ_P(model));zval *v=zend_hash_find(Z_ARRVAL_P(prop(s,"news")),key);if(v){ZVAL_COPY(result,v);return true;}
    zval *row=prop(s,"row");if(Z_TYPE_P(row)==IS_ARRAY){zval *related=at(row,"related"),*extra=at(row,"extra");v=related&&Z_TYPE_P(related)==IS_ARRAY?zend_hash_find(Z_ARRVAL_P(related),key):NULL;if(v==NULL&&extra&&Z_TYPE_P(extra)==IS_ARRAY)v=zend_hash_find(Z_ARRVAL_P(extra),key);if(v){ZVAL_COPY(result,v);return true;}}
    zend_string *m=strpprintf(0,"%s::%s: the row has no value %s",ZSTR_VAL(Z_OBJCE_P(model)->name),ZSTR_VAL(method),ZSTR_VAL(key));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);return false;
}
static bool dsl_by(zval *model,zval *keys,zval *args,zval *result)
{
    zend_object *copy=zend_objects_clone_obj(Z_OBJ_P(model));if(!copy)return false;ZVAL_OBJ(result,copy);zval *where=prop(model_state_of(Z_OBJ_P(result)),"where"),*items=at(where,"items");zend_string *conn=zend_string_init(items&&Z_TYPE_P(items)==IS_ARRAY&&zend_hash_num_elements(Z_ARRVAL_P(items))?"and":"",items&&Z_TYPE_P(items)==IS_ARRAY&&zend_hash_num_elements(Z_ARRVAL_P(items))?3:0,0);bool ok=model_dsl_where_chain(result,conn,keys,args);zend_string_release(conn);if(!ok&&EG(exception)!=NULL){zval_ptr_dtor(result);ZVAL_UNDEF(result);return false;}return true;
}
static bool add_item(model_state *s,zend_string *conn,zval *node)
{
    zval *where=prop(s,"where"),*items=at(where,"items"),*pending=at(where,"pending");
    if(!items||Z_TYPE_P(items)!=IS_ARRAY||!pending||Z_TYPE_P(pending)!=IS_STRING){zend_throw_error(NULL,"Model where state is invalid");return false;}
    zend_string *used=conn;
    if(Z_STRLEN_P(pending)&&ZSTR_LEN(conn)){zend_string *m=strpprintf(0,"connector %s follows connector %s",ZSTR_VAL(conn),Z_STRVAL_P(pending));model_native_fail(s,ZSTR_VAL(m));zend_string_release(m);return false;}
    if(Z_STRLEN_P(pending))used=Z_STR_P(pending);
    if(zend_hash_num_elements(Z_ARRVAL_P(items))==0)used=ZSTR_EMPTY_ALLOC();
    else if(!ZSTR_LEN(used)){model_native_fail(s,"condition without and/or after another condition");return false;}
    zend_string *used_copy=zend_string_copy(used);
    SEPARATE_ARRAY(where);items=at(where,"items");pending=at(where,"pending");
    if(Z_STRLEN_P(pending)){zval_ptr_dtor(pending);ZVAL_EMPTY_STRING(pending);}
    add_assoc_str(node,"conn",used_copy);
    return zend_hash_next_index_insert(Z_ARRVAL_P(items),node)!=NULL;
}
static const char *operator_name(zval *op)
{
    if (is_str(op, "ne")) return "not_eq";
    if (is_str(op, "gt")) return "gt";
    if (is_str(op, "lt")) return "lt";
    if (is_str(op, "ge")) return "gte";
    if (is_str(op, "le")) return "lte";
    if (is_str(op, "lk")) return "contains";
    if (is_str(op, "lb")) return "contains_binary";
    return "eq";
}

static bool predicate_build(zval *model, zval *key, zval *value, zval *rest, bool single, zval *out, zend_long *extra)
{
    zval *op=at(key,"op"),*column_name=at(key,"column"),*compare=at(key,"compare");
    zend_string *column=column_name&&Z_TYPE_P(column_name)==IS_STRING?Z_STR_P(column_name):ZSTR_EMPTY_ALLOC();
    *extra=0; array_init(out);
    if(is_str(op,"tuple")||is_str(op,"ne_tuple")) {
        zval *cols=at(key,"columns");uint32_t width=cols&&Z_TYPE_P(cols)==IS_ARRAY?zend_hash_num_elements(Z_ARRVAL_P(cols)):0;
        if(Z_TYPE_P(value)!=IS_ARRAY||!zend_array_is_list(Z_ARRVAL_P(value))){throw_orm("CONFIG","tuple values must be a list");goto fail;}
        if(!zend_hash_num_elements(Z_ARRVAL_P(value))){throw_orm("EMPTY_IN","tuple condition received an empty list");goto fail;}
        zval *row;ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(value),row){if(Z_TYPE_P(row)!=IS_ARRAY||!zend_array_is_list(Z_ARRVAL_P(row))||zend_hash_num_elements(Z_ARRVAL_P(row))!=width){zend_string *m=strpprintf(0,"each tuple value group needs %u values",width);throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);goto fail;}}ZEND_HASH_FOREACH_END();
        add_assoc_string(out,"op",is_str(op,"tuple")?"tuple_in":"tuple_not_in");if(cols){Z_TRY_ADDREF_P(cols);add_assoc_zval(out,"cols",cols);}Z_TRY_ADDREF_P(value);add_assoc_zval(out,"value",value);add_assoc_string(out,"kind","tuple");return true;
    }
    if(is_str(op,"between")) {
        if(Z_TYPE_P(value)!=IS_ARRAY||!zend_array_is_list(Z_ARRVAL_P(value))||zend_hash_num_elements(Z_ARRVAL_P(value))!=2){zend_string *m=strpprintf(0,"between value for %s must be a two-value array",ZSTR_VAL(column));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);goto fail;}
        add_assoc_str(out,"column",zend_string_copy(column));add_assoc_string(out,"op","between");Z_TRY_ADDREF_P(value);add_assoc_zval(out,"value",value);add_assoc_string(out,"kind","between");return true;
    }
    add_assoc_str(out,"column",zend_string_copy(column));
    if(compare&&Z_TYPE_P(compare)==IS_STRING&&Z_STRLEN_P(compare)) {
        if(Z_TYPE_P(value)!=IS_OBJECT||!instanceof_function(Z_OBJCE_P(value),model_native_class_entry())){zend_string *m=strpprintf(0,"column comparison on %s requires a model",ZSTR_VAL(column));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);goto fail;}
        zend_string *op_name=strpprintf(0,"%s_col",operator_name(op));add_assoc_str(out,"op",op_name);Z_TRY_ADDREF_P(value);add_assoc_zval(out,"ref",value);Z_TRY_ADDREF_P(compare);add_assoc_zval(out,"refCol",compare);add_assoc_string(out,"kind","ref");return true;
    }
    const char *op_name=operator_name(op);bool equality=(!op||(Z_TYPE_P(op)==IS_STRING&&Z_STRLEN_P(op)==0))||is_str(op,"ne");
    if(Z_TYPE_P(value)==IS_NULL&&(is_str(op,"lk")||is_str(op,"lb"))){add_assoc_string(out,"op",(char*)op_name);add_assoc_null(out,"value");add_assoc_string(out,"kind","value");return true;}
    if(Z_TYPE_P(value)==IS_NULL){
        if(!equality){zend_string *m=strpprintf(0,"null is not accepted by the %s operator",is_str(op,"ne")?"ne":is_str(op,"gt")?"gt":is_str(op,"lt")?"lt":is_str(op,"ge")?"ge":"le");throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);goto fail;}
        zval meta;ZVAL_UNDEF(&meta);if(!get_meta(Z_OBJ_P(model),&meta))goto fail;zval *columns=at(&meta,"columns"),*cm=columns&&Z_TYPE_P(columns)==IS_ARRAY?zend_hash_find(Z_ARRVAL_P(columns),column):NULL,*nullable=cm?at(cm,"nullable"):NULL;
        if(!nullable||Z_TYPE_P(nullable)!=IS_TRUE){zval *entity=at(&meta,"entity");zend_string *m=strpprintf(0,"%s.%s is not nullable",entity&&Z_TYPE_P(entity)==IS_STRING?Z_STRVAL_P(entity):"model",ZSTR_VAL(column));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);zval_ptr_dtor(&meta);goto fail;}
        zval_ptr_dtor(&meta);add_assoc_string(out,"op",is_str(op,"ne")?"is_not_null":"is_null");add_assoc_string(out,"kind","null");return true;
    }
    if(Z_TYPE_P(value)==IS_OBJECT){
        zend_string *fn_name=zend_string_init("Polyspec\\Orm\\Func",sizeof("Polyspec\\Orm\\Func")-1,0);zend_class_entry *fn_ce=zend_lookup_class(fn_name);zend_string_release(fn_name);
        if(fn_ce&&instanceof_function(Z_OBJCE_P(value),fn_ce)){
            if(function_column(value)){
                if(!single){throw_orm("CONFIG","a column function is accepted only by a single-key condition");goto fail;}
                if(zend_hash_num_elements(Z_ARRVAL_P(rest))!=1){zend_string *m=strpprintf(0,"column function on %s requires one compared value",ZSTR_VAL(column));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);goto fail;}
                zval *comp=zend_hash_index_find(Z_ARRVAL_P(rest),0);add_assoc_string(out,"op",(char*)op_name);Z_TRY_ADDREF_P(value);add_assoc_zval(out,"fn",value);Z_TRY_ADDREF_P(comp);add_assoc_zval(out,"value",comp);add_assoc_string(out,"kind","fn");*extra=1;return true;
            }
            add_assoc_string(out,"op",(char*)op_name);Z_TRY_ADDREF_P(value);add_assoc_zval(out,"fn",value);add_assoc_string(out,"kind","valueFn");return true;
        }
        if(instanceof_function(Z_OBJCE_P(value),model_native_class_entry())){
            if(!equality){zend_string *m=strpprintf(0,"a subquery is not accepted by the %s operator",is_str(op,"ne")?"ne":is_str(op,"gt")?"gt":is_str(op,"lt")?"lt":is_str(op,"ge")?"ge":is_str(op,"le")?"le":is_str(op,"lk")?"lk":"lb");throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);goto fail;}
            add_assoc_string(out,"op",is_str(op,"ne")?"not_in":"in");Z_TRY_ADDREF_P(value);add_assoc_zval(out,"sub",value);add_assoc_string(out,"kind","sub");return true;
        }
    }
    if(Z_TYPE_P(value)==IS_ARRAY){
        if(!equality){zend_string *m=strpprintf(0,"a list is not accepted by the %s operator",is_str(op,"ne")?"ne":is_str(op,"gt")?"gt":is_str(op,"lt")?"lt":is_str(op,"ge")?"ge":is_str(op,"le")?"le":is_str(op,"lk")?"lk":"lb");throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);goto fail;}
        if(!zend_hash_num_elements(Z_ARRVAL_P(value))){zend_string *m=strpprintf(0,"%s received an empty list",ZSTR_VAL(column));throw_orm("EMPTY_IN",ZSTR_VAL(m));zend_string_release(m);goto fail;}
        add_assoc_string(out,"op",is_str(op,"ne")?"not_in":"in");zval normalized;array_init_size(&normalized,zend_hash_num_elements(Z_ARRVAL_P(value)));zval *entry;ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(value),entry){zval copy;ZVAL_COPY(&copy,entry);add_next_index_zval(&normalized,&copy);}ZEND_HASH_FOREACH_END();add_assoc_zval(out,"value",&normalized);add_assoc_string(out,"kind","list");return true;
    }
    add_assoc_string(out,"op",(char*)op_name);Z_TRY_ADDREF_P(value);add_assoc_zval(out,"value",value);add_assoc_string(out,"kind","value");return true;
fail:
    zval_ptr_dtor(out);ZVAL_UNDEF(out);return false;
}

bool model_dsl_where_chain(zval *model,zend_string *conn,zval *keys,zval *args)
{
    model_state *s=model_state_of(Z_OBJ_P(model));uint32_t key_count=zend_hash_num_elements(Z_ARRVAL_P(keys)),arg_index=0;
    for(uint32_t i=0;i<key_count;i++){
        zval *key=zend_hash_index_find(Z_ARRVAL_P(keys),i),*value=zend_hash_index_find(Z_ARRVAL_P(args),arg_index++);
        if(!value){zend_string *m=strpprintf(0,"the condition expects %u values",key_count);throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);return false;}
        zval rest;array_init(&rest);for(uint32_t j=arg_index;j<zend_hash_num_elements(Z_ARRVAL_P(args));j++){zval *rest_value=zend_hash_index_find(Z_ARRVAL_P(args),j);if(rest_value){zval copy;ZVAL_COPY(&copy,rest_value);add_next_index_zval(&rest,&copy);}}
        zval pred;zend_long extra=0;bool valid=predicate_build(model,key,value,&rest,key_count==1,&pred,&extra);zval_ptr_dtor(&rest);if(!valid)return false;arg_index+=(uint32_t)extra;
        zval node;array_init(&node);add_assoc_zval(&node,"pred",&pred);zval *kc=at(key,"conn");zend_string *use=i==0?conn:(kc&&Z_TYPE_P(kc)==IS_STRING?Z_STR_P(kc):ZSTR_EMPTY_ALLOC());if(!add_item(s,use,&node)){if(EG(exception)==NULL)model_native_fail(s,"failed to append condition");return false;}
    }
    if(arg_index!=zend_hash_num_elements(Z_ARRVAL_P(args))){zend_string *m=strpprintf(0,"the condition expects %u values, got %u",key_count,zend_hash_num_elements(Z_ARRVAL_P(args)));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);return false;}return true;
}

PHP_METHOD(Polyspec_Orm_Model,prefixed)
{
    static const char *const scalar_types[]={"string","string"};if(!model_reject_null_scalar_args(execute_data,scalar_types,2))RETURN_THROWS();
    zend_string *name,*prefix;ZEND_PARSE_PARAMETERS_START(2,2)Z_PARAM_STR(name)Z_PARAM_STR(prefix)ZEND_PARSE_PARAMETERS_END();
    RETURN_BOOL(prefixed(name,ZSTR_VAL(prefix)));
}
PHP_METHOD(Polyspec_Orm_Model,arity)
{
    static const char *const scalar_types[]={"string",NULL,"int"};if(!model_reject_null_scalar_args(execute_data,scalar_types,3))RETURN_THROWS();
    zend_string *name;zval *args;zend_long count;ZEND_PARSE_PARAMETERS_START(3,3)Z_PARAM_STR(name)Z_PARAM_ARRAY(args)Z_PARAM_LONG(count)ZEND_PARSE_PARAMETERS_END();
    if(count<0||zend_hash_num_elements(Z_ARRVAL_P(args))!=(uint32_t)count){zend_string *m=strpprintf(0,"%s takes %lld argument%s",ZSTR_VAL(name),(long long)count,count==1?"":"s");throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);RETURN_THROWS();}
    RETURN_NULL();
}
PHP_METHOD(Polyspec_Orm_Model,outputName)
{
    static const char *const scalar_types[]={"string"};if(!model_reject_null_scalar_args(execute_data,scalar_types,1))RETURN_THROWS();
    zend_string *pascal;ZEND_PARSE_PARAMETERS_START(1,1)Z_PARAM_STR(pascal)ZEND_PARSE_PARAMETERS_END();
    zval meta;ZVAL_UNDEF(&meta);if(!get_meta(Z_OBJ_P(getThis()),&meta))RETURN_THROWS();zend_string *key=NULL;
    bool ok=output_name(model_state_of(Z_OBJ_P(getThis())),&meta,pascal,&key);zval_ptr_dtor(&meta);if(!ok)RETURN_THROWS();RETURN_STR(key);
}
PHP_METHOD(Polyspec_Orm_Model,addColumnCall)
{
    static const char *const scalar_types[]={"string","string",NULL};if(!model_reject_null_scalar_args(execute_data,scalar_types,3))RETURN_THROWS();
    zend_string *name,*rest;zval *args;ZEND_PARSE_PARAMETERS_START(3,3)Z_PARAM_STR(name)Z_PARAM_STR(rest)Z_PARAM_ARRAY(args)ZEND_PARSE_PARAMETERS_END();
    if(!dsl_add_column_call(getThis(),name,rest,args)&&EG(exception)!=NULL)RETURN_THROWS();RETURN_ZVAL(getThis(),1,0);
}
PHP_METHOD(Polyspec_Orm_Model,addJoin)
{
    static const char *const scalar_types[]={"string","string","string",NULL};if(!model_reject_null_scalar_args(execute_data,scalar_types,4))RETURN_THROWS();
    zend_string *kind,*left,*right;zval *child;ZEND_PARSE_PARAMETERS_START(4,4)Z_PARAM_STR(kind)Z_PARAM_STR(left)Z_PARAM_STR(right)Z_PARAM_OBJECT(child)ZEND_PARSE_PARAMETERS_END();
    if(!instanceof_function(Z_OBJCE_P(child),model_native_class_entry())){throw_orm("CONFIG","join takes the joined model");RETURN_THROWS();}
    dsl_add_join(getThis(),kind,left,right,child);RETURN_ZVAL(getThis(),1,0);
}
PHP_METHOD(Polyspec_Orm_Model,named)
{
    static const char *const scalar_types[]={"string","string"};if(!model_reject_null_scalar_args(execute_data,scalar_types,2))RETURN_THROWS();
    zend_string *key,*method;ZEND_PARSE_PARAMETERS_START(2,2)Z_PARAM_STR(key)Z_PARAM_STR(method)ZEND_PARSE_PARAMETERS_END();
    if(!dsl_named(getThis(),key,method,return_value))RETURN_THROWS();
}
PHP_METHOD(Polyspec_Orm_Model,whereChain)
{
    static const char *const scalar_types[]={"string",NULL,NULL};if(!model_reject_null_scalar_args(execute_data,scalar_types,3))RETURN_THROWS();
    zend_string *conn;zval *keys,*args;ZEND_PARSE_PARAMETERS_START(3,3)Z_PARAM_STR(conn)Z_PARAM_ARRAY(keys)Z_PARAM_ARRAY(args)ZEND_PARSE_PARAMETERS_END();
    if(!model_dsl_where_chain(getThis(),conn,keys,args)&&EG(exception)!=NULL)RETURN_THROWS();RETURN_NULL();
}
PHP_METHOD(Polyspec_Orm_Model,predicate)
{
    static const char *const scalar_types[]={NULL,NULL,NULL,"bool"};if(!model_reject_null_scalar_args(execute_data,scalar_types,4))RETURN_THROWS();
    zval *key,*value,*rest;bool single;ZEND_PARSE_PARAMETERS_START(4,4)Z_PARAM_ARRAY(key)Z_PARAM_ZVAL(value)Z_PARAM_ARRAY(rest)Z_PARAM_BOOL(single)ZEND_PARSE_PARAMETERS_END();
    zval pred;zend_long extra=0;if(!predicate_build(getThis(),key,value,rest,single,&pred,&extra))RETURN_THROWS();array_init(return_value);add_next_index_zval(return_value,&pred);add_next_index_long(return_value,extra);
}
PHP_METHOD(Polyspec_Orm_Model,by)
{
    zval *keys,*args;ZEND_PARSE_PARAMETERS_START(2,2)Z_PARAM_ARRAY(keys)Z_PARAM_ARRAY(args)ZEND_PARSE_PARAMETERS_END();
    if(!dsl_by(getThis(),keys,args,return_value))RETURN_THROWS();
}

PHP_METHOD(Polyspec_Orm_Model,__call)
{
    static const char *const scalar_types[] = {"string", NULL};
    if (!model_reject_null_scalar_args(execute_data, scalar_types, 2)) RETURN_THROWS();
    zend_string *name;zval *args;ZEND_PARSE_PARAMETERS_START(2,2)Z_PARAM_STR(name)Z_PARAM_ARRAY(args)ZEND_PARSE_PARAMETERS_END();
    zend_object *obj=Z_OBJ_P(getThis());model_state *s=model_state_of(obj);zval meta;ZVAL_UNDEF(&meta);
    if(!get_meta(obj,&meta))RETURN_THROWS();zval *entity=at(&meta,"entity");
    static const char *terminal[]={"getsBy","getBy","getCountBy"};
    for(size_t i=0;i<3;i++)if(prefixed(name,terminal[i])){
        zend_string *suffix=zend_string_init(ZSTR_VAL(name)+strlen(terminal[i]),ZSTR_LEN(name)-strlen(terminal[i]),0);zval keys,clone;ZVAL_UNDEF(&keys);ZVAL_UNDEF(&clone);
        if(!call_chain("parse",obj->ce->name,suffix,&keys)){zend_string_release(suffix);zval_ptr_dtor(&meta);RETURN_THROWS();}zend_string_release(suffix);
        if(!dsl_by(getThis(),&keys,args,&clone)){zval_ptr_dtor(&keys);zval_ptr_dtor(&meta);RETURN_THROWS();}
        const char *method=i==0?"gets":i==1?"get":"getCount";zval_ptr_dtor(&keys);zval_ptr_dtor(&meta);zval rv;
        if(!invoke(&clone,method,0,NULL,&rv)){zval_ptr_dtor(&clone);RETURN_THROWS();}zval_ptr_dtor(&clone);RETURN_ZVAL(&rv,0,0);
    }
    if(prefixed(name,"orderBy")){zval keys;zend_string *suffix=zend_string_init(ZSTR_VAL(name)+7,ZSTR_LEN(name)-7,0);if(!call_chain("order",obj->ce->name,suffix,&keys)){zend_string_release(suffix);zval_ptr_dtor(&meta);RETURN_THROWS();}zend_string_release(suffix);uint32_t argc=zend_hash_num_elements(Z_ARRVAL_P(args));if(argc>(zend_hash_num_elements(Z_ARRVAL(keys))==1?1:0)){zend_string *m=strpprintf(0,"%s accepts %s",ZSTR_VAL(name),zend_hash_num_elements(Z_ARRVAL(keys))==1?"one column function":"no argument");throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);zval_ptr_dtor(&keys);zval_ptr_dtor(&meta);RETURN_THROWS();}zval *arg=zend_hash_index_find(Z_ARRVAL_P(args),0);if(arg&&!function_column(arg)){zend_string *m=strpprintf(0,"%s accepts a column function only",ZSTR_VAL(name));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);zval_ptr_dtor(&keys);zval_ptr_dtor(&meta);RETURN_THROWS();}zval *entry;ZEND_HASH_FOREACH_VAL(Z_ARRVAL(keys),entry){zval item;array_init(&item);zval *c=at(entry,"column"),*d=at(entry,"desc");if(c){Z_TRY_ADDREF_P(c);add_assoc_zval(&item,"column",c);}if(d){Z_TRY_ADDREF_P(d);add_assoc_zval(&item,"desc",d);}if(arg){Z_TRY_ADDREF_P(arg);add_assoc_zval(&item,"fn",arg);}model_state_property_separate(s,"order");add_next_index_zval(prop(s,"order"),&item);}ZEND_HASH_FOREACH_END();zval_ptr_dtor(&keys);zval_ptr_dtor(&meta);RETURN_ZVAL(getThis(),1,0);}
    if(prefixed(name,"match")){if(!arity(s,name,args,0)){zval_ptr_dtor(&meta);RETURN_NULL();}zval pair;zend_string *suffix=zend_string_init(ZSTR_VAL(name)+5,ZSTR_LEN(name)-5,0);zval nullv;ZVAL_NULL(&nullv);zval a[3];ZVAL_COPY(&a[0],&nullv);ZVAL_COPY(&a[1],&meta);ZVAL_STR_COPY(&a[2],suffix);bool ok=static_call("Polyspec\\Orm\\Chain","pair",3,a,&pair);zval_ptr_dtor(&a[0]);zval_ptr_dtor(&a[1]);zval_ptr_dtor(&a[2]);zend_string_release(suffix);if(!ok){zval_ptr_dtor(&meta);RETURN_THROWS();}model_state_property_separate(s,"matches");add_next_index_zval(prop(s,"matches"),&pair);zval_ptr_dtor(&meta);RETURN_ZVAL(getThis(),1,0);}
    if(prefixed(name,"alias")){if(!arity(s,name,args,0)){zval_ptr_dtor(&meta);RETURN_NULL();}zend_string *suffix=zend_string_init(ZSTR_VAL(name)+5,ZSTR_LEN(name)-5,0),*v=snake(suffix);zend_string_release(suffix);zend_string *old=Z_STR_P(prop(s,"alias"));zend_string_release(old);ZVAL_STR(prop(s,"alias"),v);zval_ptr_dtor(&meta);RETURN_ZVAL(getThis(),1,0);}
    if(prefixed(name,"new")){if(!arity(s,name,args,1)){zval_ptr_dtor(&meta);RETURN_NULL();}zend_string *attr=zend_string_init(ZSTR_VAL(name)+3,ZSTR_LEN(name)-3,0),*c=column(&meta,attr);if(ZSTR_LEN(c)){zend_string *m=strpprintf(0,"%s is a column of %s; use set%s",ZSTR_VAL(attr),entity&&Z_TYPE_P(entity)==IS_STRING?Z_STRVAL_P(entity):"",ZSTR_VAL(attr));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);zend_string_release(c);zend_string_release(attr);zval_ptr_dtor(&meta);RETURN_THROWS();}zend_string_release(c);zend_string *key=snake(attr);zval *v=zend_hash_index_find(Z_ARRVAL_P(args),0);zval copied;ZVAL_COPY(&copied,v);model_state_property_separate(s,"news");zend_hash_update(Z_ARRVAL_P(prop(s,"news")),key,&copied);zend_string_release(key);zend_string_release(attr);zval_ptr_dtor(&meta);RETURN_ZVAL(getThis(),1,0);}
    if(prefixed(name,"addColumn")){
        zend_string *rest=zend_string_init(ZSTR_VAL(name)+9,ZSTR_LEN(name)-9,0);bool ok=dsl_add_column_call(getThis(),name,rest,args);zend_string_release(rest);zval_ptr_dtor(&meta);
        if(!ok&&EG(exception)!=NULL)RETURN_THROWS();RETURN_ZVAL(getThis(),1,0);
    }
    static const char *simple_prefixes[]={"removeColumn","groupBy","keyName","plus","minus","sum","avg"};
    for(size_t p=0;p<sizeof(simple_prefixes)/sizeof(simple_prefixes[0]);p++)if(prefixed(name,simple_prefixes[p])){
        const char *prefix=simple_prefixes[p];size_t plen=strlen(prefix);zend_string *rest=zend_string_init(ZSTR_VAL(name)+plen,ZSTR_LEN(name)-plen,0),*c=column(&meta,rest);zend_string_release(rest);if(!ZSTR_LEN(c)){zend_string_release(c);continue;}
        uint32_t want=(!strcmp(prefix,"plus")||!strcmp(prefix,"minus"))?1:0;if(!arity(s,name,args,want)){zend_string_release(c);zval_ptr_dtor(&meta);RETURN_NULL();}
        if(!strcmp(prefix,"removeColumn")){bool exists=false;zval *v;ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(prop(s,"remove_columns")),v)if(Z_TYPE_P(v)==IS_STRING&&zend_string_equals(Z_STR_P(v),c))exists=true;ZEND_HASH_FOREACH_END();if(!exists){model_state_property_separate(s,"remove_columns");add_next_index_str(prop(s,"remove_columns"),c);}else zend_string_release(c);}
        else if(!strcmp(prefix,"groupBy")){model_state_property_separate(s,"group_by");add_next_index_str(prop(s,"group_by"),c);}
        else if(!strcmp(prefix,"keyName")){zend_string *old=Z_TYPE_P(prop(s,"key_name"))==IS_STRING?Z_STR_P(prop(s,"key_name")):NULL;if(old)zend_string_release(old);ZVAL_STR(prop(s,"key_name"),c);}
        else if(!strcmp(prefix,"plus")||!strcmp(prefix,"minus")){zval *cols=at(&meta,"columns"),*cm=cols&&Z_TYPE_P(cols)==IS_ARRAY?zend_hash_find(Z_ARRVAL_P(cols),c):NULL,*ty=cm?at(cm,"type"):NULL;bool numeric=ty&&Z_TYPE_P(ty)==IS_STRING&&(is_str(ty,"i16")||is_str(ty,"i32")||is_str(ty,"i64")||is_str(ty,"f64")||is_str(ty,"decimal"));zval *codec=cm?at(cm,"codec"):NULL;if(!codec||Z_TYPE_P(codec)!=IS_ARRAY||zend_hash_num_elements(Z_ARRVAL_P(codec))!=0)numeric=false;if(!numeric){zend_string *m=strpprintf(0,"%s requires a numeric column",ZSTR_VAL(name));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);zend_string_release(c);zval_ptr_dtor(&meta);RETURN_THROWS();}zval spec;array_init(&spec);zval *v=zend_hash_index_find(Z_ARRVAL_P(args),0);add_assoc_zval(&spec,!strcmp(prefix,"plus")?"plus":"minus",v);Z_TRY_ADDREF_P(v);zval *sets=prop(s,"sets");SEPARATE_ARRAY(sets);model_state_property_separate(s,"sets");zend_hash_update(Z_ARRVAL_P(prop(s,"sets")),c,&spec);zend_string_release(c);}
        else {zval *cols=at(&meta,"columns"),*cm=cols&&Z_TYPE_P(cols)==IS_ARRAY?zend_hash_find(Z_ARRVAL_P(cols),c):NULL,*ty=cm?at(cm,"type"):NULL,*codec=cm?at(cm,"codec"):NULL;bool numeric=ty&&Z_TYPE_P(ty)==IS_STRING&&(is_str(ty,"i16")||is_str(ty,"i32")||is_str(ty,"i64")||is_str(ty,"f64")||is_str(ty,"decimal"))&&codec&&Z_TYPE_P(codec)==IS_ARRAY&&zend_hash_num_elements(Z_ARRVAL_P(codec))==0;if(!numeric){zend_string *m=strpprintf(0,"%s requires a numeric column",ZSTR_VAL(name));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);zend_string_release(c);zval_ptr_dtor(&meta);RETURN_THROWS();}zend_string *old=Z_TYPE_P(prop(s,"agg_fn"))==IS_STRING?Z_STR_P(prop(s,"agg_fn")):NULL;if(old)zend_string_release(old);ZVAL_STR(prop(s,"agg_fn"),zend_string_init(prefix,strlen(prefix),0));old=Z_TYPE_P(prop(s,"agg"))==IS_STRING?Z_STR_P(prop(s,"agg")):NULL;if(old)zend_string_release(old);ZVAL_STR(prop(s,"agg"),c);}
        zval_ptr_dtor(&meta);RETURN_ZVAL(getThis(),1,0);
    }
    if(prefixed(name,"possible")){if(!arity(s,name,args,1)){zval_ptr_dtor(&meta);RETURN_NULL();}zval *hash=at(&meta,"manifest_hash");zend_string *rest=zend_string_init(ZSTR_VAL(name)+8,ZSTR_LEN(name)-8,0);zval a[2],found;ZVAL_STR_COPY(&a[0],Z_STR_P(hash));ZVAL_STR_COPY(&a[1],rest);bool ok=static_call("Polyspec\\Orm\\Chain","schemaColumnName",2,a,&found);zval_ptr_dtor(&a[0]);zval_ptr_dtor(&a[1]);zend_string_release(rest);if(!ok){zval_ptr_dtor(&meta);RETURN_THROWS();}if(Z_TYPE(found)!=IS_STRING||!Z_STRLEN(found)){zend_string *m=strpprintf(0,"%s: no model has the column %s",ZSTR_VAL(name),ZSTR_VAL(name)+8);throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);zval_ptr_dtor(&found);zval_ptr_dtor(&meta);RETURN_THROWS();}zval value;array_init(&value);add_assoc_zval(&value,"column",&found);zval *v=zend_hash_index_find(Z_ARRVAL_P(args),0);add_assoc_zval(&value,"value",v);Z_TRY_ADDREF_P(v);zval_ptr_dtor(prop(s,"possible"));ZVAL_COPY_VALUE(prop(s,"possible"),&value);zval_ptr_dtor(&meta);RETURN_ZVAL(getThis(),1,0);}
    if(prefixed(name,"forceIndex")){if(!arity(s,name,args,0)){zval_ptr_dtor(&meta);RETURN_NULL();}zend_string *rest=zend_string_init(ZSTR_VAL(name)+10,ZSTR_LEN(name)-10,0),*idx=snake(rest);zend_string_release(rest);zval *indexes=at(&meta,"indexes");if(!indexes||Z_TYPE_P(indexes)!=IS_ARRAY||!zend_hash_exists(Z_ARRVAL_P(indexes),idx)){zend_string *m=strpprintf(0,"%s has no index %s",entity&&Z_TYPE_P(entity)==IS_STRING?Z_STRVAL_P(entity):"model",ZSTR_VAL(idx));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);zend_string_release(idx);zval_ptr_dtor(&meta);RETURN_THROWS();}zend_string *old=Z_STR_P(prop(s,"index"));zend_string_release(old);ZVAL_STR(prop(s,"index"),idx);zval_ptr_dtor(&meta);RETURN_ZVAL(getThis(),1,0);}
    if(prefixed(name,"get")){
        if(!arity(s,name,args,0)){zval_ptr_dtor(&meta);RETURN_THROWS();}zend_string *rest=zend_string_init(ZSTR_VAL(name)+3,ZSTR_LEN(name)-3,0),*key=snake(rest);zend_string_release(rest);zval named;
        bool ok=dsl_named(getThis(),key,name,&named);zend_string_release(key);zval_ptr_dtor(&meta);if(!ok)RETURN_THROWS();RETURN_ZVAL(&named,0,0);
    }
    if(prefixed(name,"join")||prefixed(name,"leftJoin")){
        bool left=prefixed(name,"leftJoin");size_t prefix_len=left?8:4;
        if(zend_hash_num_elements(Z_ARRVAL_P(args))!=1){zend_string *m=strpprintf(0,"%s takes the joined model",ZSTR_VAL(name));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);zval_ptr_dtor(&meta);RETURN_THROWS();}
        zval *child=zend_hash_index_find(Z_ARRVAL_P(args),0);if(Z_TYPE_P(child)!=IS_OBJECT||!instanceof_function(Z_OBJCE_P(child),model_native_class_entry())){zend_string *m=strpprintf(0,"%s takes the joined model",ZSTR_VAL(name));throw_orm("CONFIG",ZSTR_VAL(m));zend_string_release(m);zval_ptr_dtor(&meta);RETURN_THROWS();}
        zval child_meta,pair;ZVAL_UNDEF(&child_meta);if(!get_meta(Z_OBJ_P(child),&child_meta)){zval_ptr_dtor(&meta);RETURN_THROWS();}
        zend_string *suffix=zend_string_init(ZSTR_VAL(name)+prefix_len,ZSTR_LEN(name)-prefix_len,0);zval call_args[3];ZVAL_COPY(&call_args[0],&meta);ZVAL_COPY(&call_args[1],&child_meta);ZVAL_STR_COPY(&call_args[2],suffix);
        bool ok=static_call("Polyspec\\Orm\\Chain","pair",3,call_args,&pair);zval_ptr_dtor(&call_args[0]);zval_ptr_dtor(&call_args[1]);zval_ptr_dtor(&call_args[2]);zend_string_release(suffix);zval_ptr_dtor(&child_meta);
        if(!ok){zval_ptr_dtor(&meta);RETURN_THROWS();}zval *l=zend_hash_index_find(Z_ARRVAL(pair),0),*r=zend_hash_index_find(Z_ARRVAL(pair),1);zend_string *kind=zend_string_init(left?"left":"inner",left?4:5,0);
        dsl_add_join(getThis(),kind,Z_STR_P(l),Z_STR_P(r),child);zend_string_release(kind);zval_ptr_dtor(&pair);zval_ptr_dtor(&meta);RETURN_ZVAL(getThis(),1,0);
    }
    if(prefixed(name,"and")||prefixed(name,"or")){bool is_and=prefixed(name,"and");zend_string *suffix=zend_string_init(ZSTR_VAL(name)+(is_and?3:2),ZSTR_LEN(name)-(is_and?3:2),0),*uc=zend_string_init(ZSTR_VAL(suffix),ZSTR_LEN(suffix),0);if(ZSTR_LEN(uc))ZSTR_VAL(uc)[0]=(char)(ZSTR_VAL(uc)[0]>='a'&&ZSTR_VAL(uc)[0]<='z'?ZSTR_VAL(uc)[0]-32:ZSTR_VAL(uc)[0]);zval keys;if(!call_chain("parse",obj->ce->name,uc,&keys)){zend_string_release(suffix);zend_string_release(uc);zval_ptr_dtor(&meta);RETURN_THROWS();}zend_string_release(suffix);zend_string_release(uc);zend_string *c=zend_string_init(is_and?"and":"or",is_and?3:2,0);bool ok=model_dsl_where_chain(getThis(),c,&keys,args);zend_string_release(c);zval_ptr_dtor(&keys);zval_ptr_dtor(&meta);if(!ok&&EG(exception)!=NULL)RETURN_THROWS();RETURN_ZVAL(getThis(),1,0);}
    /* Unknown dynamic calls retain the client grammar: they are parsed as a predicate and never silently ignored. */
    zval keys;zend_string *pascal=zend_string_init(ZSTR_VAL(name),ZSTR_LEN(name),0);if(ZSTR_LEN(pascal)&&ZSTR_VAL(pascal)[0]>='a'&&ZSTR_VAL(pascal)[0]<='z')ZSTR_VAL(pascal)[0]-=32;
    if(!call_chain("parse",obj->ce->name,pascal,&keys)){zend_string_release(pascal);zval_ptr_dtor(&meta);RETURN_THROWS();}zend_string_release(pascal);zend_string *empty=zend_string_init("",0,0);bool ok=model_dsl_where_chain(getThis(),empty,&keys,args);zend_string_release(empty);zval_ptr_dtor(&keys);zval_ptr_dtor(&meta);if(!ok&&EG(exception)!=NULL)RETURN_THROWS();RETURN_ZVAL(getThis(),1,0);
}
