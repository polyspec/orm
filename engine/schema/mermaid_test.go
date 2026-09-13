package schema

import (
	"strings"
	"testing"
)

const example = `erDiagram
  battle {
    bigint       seq                 PK  "auto"
    varchar(191) name
    text         description             "? lazy"
    datetime(6)  created_ts              "=now"
    datetime(6)  updated_ts              "=now onupdate"
    tinyint      is_close                "=0 bool"
    varchar(255) aes_hex_email           "? aes,hex"
    text         curlfile_serialize_files
    text         upload_archive          "? curlfile,serialize"
    text         yaml_settings
    int          aes_key_version         "=1"
    varbinary(16) ip                     "ip"
    varchar(36)  uuid                UK  "?"
    bigint       user_seq            FK
    bigint       updated_user_seq    FK  "? -> user.seq"
    bigint       service_seq         FK
    decimal(13_3) review_star            "=0 평점 평균"
    bigint       game_group_seq      FK
    int          game_group_number       "=1"
  }
  battle_item {
    bigint  seq          PK "auto"
    bigint  battle_seq   FK
    int     order_number    "=0"
  }

  service ||--o{ battle      : service_seq
  user    ||--o{ battle      : "updated_user_seq (updater / updated_battles) cascade"
  battle  ||--o{ battle_item : "battle_seq (battle / items)"
  %% a plain comment
  %% unique   battle (game_group_seq, game_group_number)
  %% index    battle (service_seq, is_close)              ik
  %% fulltext battle (name, description)
  %% timestamps battle created_ts updated_ts
  %% predicate battle display : ` + "`seq` > 0" + `
`

func TestParseExample(t *testing.T) {
	d, err := Parse(example)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Entities) != 2 || d.Entities[0].Name != "battle" || len(d.Entities[0].Columns) != 19 {
		t.Fatalf("entities: %+v", d.Entities)
	}
	cols := map[string]*DColumn{}
	for _, c := range d.Entities[0].Columns {
		cols[c.Name] = c
	}
	if c := cols["seq"]; !c.Auto || c.Keys[0] != "PK" || c.Nullable {
		t.Errorf("seq: %+v", c)
	}
	if c := cols["description"]; !c.Nullable || !c.Lazy {
		t.Errorf("description: %+v", c)
	}
	if c := cols["updated_ts"]; c.Default == nil || *c.Default != "now" || !c.OnUpdate {
		t.Errorf("updated_ts: %+v", c)
	}
	if c := cols["is_close"]; !c.Bool || *c.Default != "0" {
		t.Errorf("is_close: %+v", c)
	}
	if c := cols["aes_hex_email"]; strings.Join(c.Styles, ",") != "aes,hex" || !c.Nullable {
		t.Errorf("aes_hex_email: %+v", c)
	}
	if c := cols["curlfile_serialize_files"]; len(c.Styles) != 0 {
		t.Errorf("curlfile_serialize_files parser styles: %+v", c)
	}
	if c := cols["upload_archive"]; strings.Join(c.Styles, ",") != "curlfile,serialize" || !c.Nullable {
		t.Errorf("upload_archive: %+v", c)
	}
	if c := cols["ip"]; strings.Join(c.Styles, ",") != "ip" {
		t.Errorf("ip: %+v", c)
	}
	if c := cols["updated_user_seq"]; c.Ref != "user.seq" || !c.Nullable || c.Keys[0] != "FK" {
		t.Errorf("updated_user_seq: %+v", c)
	}
	if c := cols["review_star"]; c.Type != "decimal(13_3)" || c.Describe != "평점 평균" || *c.Default != "0" {
		t.Errorf("review_star: %+v", c)
	}
	if len(d.Relations) != 3 {
		t.Fatalf("relations: %d", len(d.Relations))
	}
	r := d.Relations[1]
	if r.Parent != "user" || r.Child != "battle" || strings.Join(r.FKs, ",") != "updated_user_seq" || r.ChildName != "updater" || r.ParentName != "updated_battles" || r.OnDelete != "cascade" || r.Cardinality != "||--o{" {
		t.Errorf("relation: %+v", r)
	}
	if r := d.Relations[0]; strings.Join(r.FKs, ",") != "service_seq" || r.ChildName != "" || r.ParentName != "" {
		t.Errorf("relation0: %+v", r)
	}
	if len(d.Directives) != 5 {
		t.Fatalf("directives: %d", len(d.Directives))
	}
	if x := d.Directives[1]; x.Kind != "index" || x.Name != "ik" || strings.Join(x.Columns, ",") != "service_seq,is_close" {
		t.Errorf("index: %+v", x)
	}
	if x := d.Directives[4]; x.Kind != "predicate" || x.Name != "display" || x.Raw != "`seq` > 0" {
		t.Errorf("predicate: %+v", x)
	}
}

func TestCheckDirectiveParsesAndValidatesColumns(t *testing.T) {
	d, err := Parse("erDiagram\n item {\n integer id PK\n integer quantity\n }\n %% check item positive_quantity : `quantity` >= 0\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Directives) != 1 || d.Directives[0].Kind != "check" || d.Directives[0].Name != "positive_quantity" || d.Directives[0].Raw != "`quantity` >= 0" {
		t.Fatalf("check directive: %+v", d.Directives)
	}
	m, err := Build(d)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Entities["item"].Checks) != 1 || m.Entities["item"].Checks[0].Expr != "`quantity` >= 0" {
		t.Fatalf("manifest checks: %+v", m.Entities["item"].Checks)
	}
	bad, err := Parse("erDiagram\n item {\n integer id PK\n }\n %% check item valid : `missing` > 0\n")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Build(bad); err == nil || !strings.Contains(err.Error(), "unknown column") {
		t.Fatalf("unknown CHECK column accepted: %v", err)
	}
}

func TestParseORMDirectives(t *testing.T) {
	src := `erDiagram
  product {
    bigint company_seq FK
  }
  %% orm:field product.company_seq relation=scope fk=company.seq public=company.uuid required=true order=1
  %% orm:route product.collection
  %% orm:path /company/{company_uuid}/product
  %% orm:scope route=product.collection param=company_uuid field=product.company_seq
  %% orm:operation route=product.collection method=GET
`
	d, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.ORM) != 5 || d.ORM[0].Name != "product.company_seq" || d.ORM[0].Args["relation"] != "scope" {
		t.Fatalf("ORM directives: %+v", d.ORM)
	}
}

func TestParseORMDirectiveRejectsContinuationAndUnknownOption(t *testing.T) {
	for _, src := range []string{
		"erDiagram\n  item {\n    bigint seq PK\n  }\n  %% orm:route item\n  public=item.uuid\n",
		"erDiagram\n  item {\n    bigint seq PK\n  }\n  %% orm:route item typo=true\n",
		"erDiagram\n  item {\n    bigint seq PK\n  }\n  %% orm:route item\n  %% orm:route item\n",
	} {
		if _, err := Parse(src); err == nil {
			t.Fatalf("invalid ORM directive accepted: %q", src)
		}
	}
}

func TestParseCompositeRelationLabel(t *testing.T) {
	d, err := Parse("erDiagram\n parent ||--o{ child : \"(tenant_id, parent_id) (parent / children) cascade\"\n")
	if err != nil {
		t.Fatal(err)
	}
	r := d.Relations[0]
	if strings.Join(r.FKs, ",") != "tenant_id,parent_id" || r.ChildName != "parent" || r.ParentName != "children" || r.OnDelete != "cascade" {
		t.Fatalf("composite relation label differs: %#v", r)
	}
}

func TestParseErrors(t *testing.T) {
	cases := map[string]string{
		"battle {\n}": "must start with erDiagram",
		"erDiagram\n battle {\n  bigint seq PK\n":           "unterminated",
		"erDiagram\n battle {\n  seq\n }":                   "bad column line",
		"erDiagram\n battle {\n  bigint x \"bool int\"\n }": "exclusive",
		"erDiagram\n battle {\n  bigint x \"-> user\"\n }":  "table.column",
		"erDiagram\n a ||--o{ b : \"\"":                     "must name the FK column",
		"erDiagram\n a ||--o{ b : \"x (c / p) weird\"":      "unknown label word",
		"erDiagram\n %% unique battle service_seq":          "expected (col",
		"erDiagram\n %% unique battle (a) nm":               "only index takes a name",
		"erDiagram\n what is this":                          "unrecognized line",
	}
	for src, want := range cases {
		_, err := Parse(src)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: got %v, want %q", src, err, want)
		}
	}
}

func TestCommentsAreManifestData(t *testing.T) {
	src := "erDiagram\n  account {\n    bigint seq PK\n    varchar(64) email\n  }\n  %% table_comment account \"customer account\"\n  %% column_comment account email \"login address\"\n"
	d, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	m, err := Build(d)
	if err != nil {
		t.Fatal(err)
	}
	if m.Entities["account"].Comment != "customer account" || m.Entities["account"].Column("email").Comment != "login address" {
		t.Fatalf("comments not retained: %#v", m.Entities["account"])
	}
	first := m.SchemaHash
	d.Directives[0].Raw = "changed"
	m2, err := Build(d)
	if err != nil {
		t.Fatal(err)
	}
	if first == m2.SchemaHash {
		t.Fatal("table comment did not affect schema hash")
	}
}
