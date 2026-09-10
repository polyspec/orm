package engine

// Entity is the compiled form of one YAML table. S0 uses a fixed instance
// (a subset of platform's `battle` table); the YAML loader replaces it in S1.
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
	Hash: "s0-battle-v1",
	Entities: map[string]*Entity{
		"battle": battleEntity(),
	},
}

func battleEntity() *Entity {
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
		{"target_team_player_count", "i32", false, false},
		{"success_count", "i32", false, false},
		{"player_count", "i32", false, false},
		{"read_count", "i32", false, false},
		{"cover_url", "string", true, false},
		{"user_seq", "i64", false, false},
		{"service_seq", "i64", false, false},
		{"service_module_seq", "i64", false, false},
		{"service_member_seq", "i64", false, false},
		{"start_dt", "datetime", false, false},
		{"end_dt", "datetime", false, false},
		{"uuid", "string", true, false},
		{"is_single_play", "bool", false, false},
		{"like_count", "i32", false, false},
	}
	e := &Entity{Name: "battle", Table: "battle", PrimaryKey: "seq", Columns: map[string]Column{}}
	for _, c := range cols {
		e.Columns[c.name] = Column{Type: c.typ, Nullable: c.nullable, Lazy: c.lazy}
		if !c.lazy {
			e.DefaultColumns = append(e.DefaultColumns, c.name)
		}
	}
	return e
}
