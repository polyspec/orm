package engine

// Entity is the compiled form of one YAML table. S0 uses a fixed instance
// (a subset of platform's `author` table); the YAML loader replaces it in S1.
type Entity struct {
	Name           string
	Table          string
	PrimaryKey     string
	Columns        map[string]Column
	DefaultColumns []string
}

type Column struct {
	Type     string
	Nullable bool
	Lazy     bool
}

type SchemaSet struct {
	Hash     string
	Entities map[string]*Entity
}

// Schema is the active compiled schema. Hash is what clients must echo back.
var Schema = SchemaSet{
	Hash: "s0-author-v1",
	Entities: map[string]*Entity{
		"author": authorEntity(),
	},
}

func authorEntity() *Entity {
	cols := []struct {
		name, typ string
		nullable  bool
		lazy      bool
	}{
		{"seq", "i64", false, false},
		{"name", "string", false, false},
		{"description", "text", true, true},
		{"created_ts", "datetime", false, false},
		{"updated_ts", "datetime", false, false},
		{"is_close", "bool", false, false},
		{"is_display", "bool", false, false},
		{"display_start_dt", "datetime", true, false},
		{"display_end_dt", "datetime", true, false},
		{"is_allday", "bool", false, false},
		{"target_club_reader_count", "i32", false, false},
		{"success_count", "i32", false, false},
		{"reader_count", "i32", false, false},
		{"read_count", "i32", false, false},
		{"photo_url", "string", true, false},
		{"user_seq", "i64", false, false},
		{"service_seq", "i64", false, false},
		{"service_region_seq", "i64", false, false},
		{"service_member_seq", "i64", false, false},
		{"start_dt", "datetime", false, false},
		{"end_dt", "datetime", false, false},
		{"uuid", "string", true, false},
		{"is_single_work", "bool", false, false},
		{"like_count", "i32", false, false},
	}
	e := &Entity{Name: "author", Table: "author", PrimaryKey: "seq", Columns: map[string]Column{}}
	for _, c := range cols {
		e.Columns[c.name] = Column{Type: c.typ, Nullable: c.nullable, Lazy: c.lazy}
		if !c.lazy {
			e.DefaultColumns = append(e.DefaultColumns, c.name)
		}
	}
	return e
}
