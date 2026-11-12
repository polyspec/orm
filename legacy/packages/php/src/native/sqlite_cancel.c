#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1

#include <stdio.h>

typedef struct {
    char *path;
    sqlite3_int64 slot;
} OrmCancelState;

static void destroy_state(void *opaque)
{
    OrmCancelState *state = (OrmCancelState *) opaque;
    if (state != NULL) {
        sqlite3_free(state->path);
        sqlite3_free(state);
    }
}

static int cancellation_requested(void *opaque)
{
    OrmCancelState *state = (OrmCancelState *) opaque;
    FILE *file = fopen(state->path, "rb");
    unsigned char flags = 0;
    unsigned char active = 0;
    size_t count;

    if (file == NULL) {
        return 0;
    }
    count = fread(&flags, 1, 1, file);
    if (count == 1 && (flags & 2) != 0 && state->slot > 0
        && fseek(file, (long) state->slot, SEEK_SET) == 0) {
        count = fread(&active, 1, 1, file);
    } else {
        count = 0;
    }
    fclose(file);
    return count == 1 && (flags & 2) != 0 && active == 1;
}

static void attach_state(sqlite3_context *context, int argc, sqlite3_value **argv)
{
    sqlite3 *database = sqlite3_context_db_handle(context);
    OrmCancelState *state = (OrmCancelState *) sqlite3_user_data(context);
    const unsigned char *path = sqlite3_value_text(argv[0]);
    sqlite3_int64 slot = sqlite3_value_int64(argv[1]);

    if (path == NULL) {
        sqlite3_result_error(context, "missing cancellation state path", -1);
        return;
    }
    sqlite3_free(state->path);
    state->path = sqlite3_mprintf("%s", path);
    if (state->path == NULL) {
        sqlite3_result_error_nomem(context);
        return;
    }
    state->slot = slot;
    sqlite3_progress_handler(database, 1000, cancellation_requested, state);
    sqlite3_result_int(context, 1);
}

int sqlite3_ormcancel_init(sqlite3 *database, char **error, const sqlite3_api_routines *api)
{
    OrmCancelState *state;

    SQLITE_EXTENSION_INIT2(api);
    state = sqlite3_malloc(sizeof(*state));
    if (state == NULL) {
        return SQLITE_NOMEM;
    }
    state->path = sqlite3_mprintf("");
    if (state->path == NULL) {
        sqlite3_free(state);
        return SQLITE_NOMEM;
    }
    return sqlite3_create_function_v2(
        database,
        "orm_cancel_attach",
        2,
        SQLITE_UTF8,
        state,
        attach_state,
        NULL,
        NULL,
        destroy_state
    );
}

int sqlite3_polyspec_orm_init(sqlite3 *database, char **error, const sqlite3_api_routines *api)
{
    return sqlite3_ormcancel_init(database, error, api);
}
