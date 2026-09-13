package schema

import "testing"

func TestValidateORMMetadata(t *testing.T) {
	m := &Manifest{Entities: map[string]*Entity{
		"company": {Name: "company", Columns: []*Col{{Name: "seq", Type: "i64", PK: true}, {Name: "uuid", Type: "string", UK: true}}, cols: map[string]*Col{}},
		"product": {Name: "product", Columns: []*Col{{Name: "company_seq", Type: "i64", FK: true, Ref: &Ref{Entity: "company", Column: "seq"}}}, cols: map[string]*Col{}},
	}, Order: []string{"company", "product"}}
	for _, entity := range m.Entities {
		for _, column := range entity.Columns {
			entity.cols[column.Name] = column
		}
	}
	m.ORM = []*ORMDirective{
		{Kind: "public-key", Args: map[string]string{"entity": "company", "field": "uuid", "type": "uuid", "unique": "true", "stable": "true"}},
		{Kind: "field", Name: "product.company_seq", Args: map[string]string{"relation": "scope", "fk": "company.seq", "public": "company.uuid", "required": "true", "order": "1"}},
		{Kind: "route", Name: "product.collection", Args: map[string]string{}},
		{Kind: "path", Name: "/company/{company_uuid}/product", Args: map[string]string{"route": "product.collection"}},
		{Kind: "scope", Args: map[string]string{"route": "product.collection", "param": "company_uuid", "field": "product.company_seq"}},
		{Kind: "operation", Args: map[string]string{"route": "product.collection", "method": "GET"}},
	}
	if err := m.ValidateORM(); err != nil {
		t.Fatal(err)
	}
	crud, err := m.BuildCRUDManifest()
	if err != nil || len(crud.Routes) != 1 || crud.Routes[0].ID != "product.collection" || crud.Routes[0].Scopes[0].Param != "company_uuid" {
		t.Fatalf("CRUD manifest: %+v, error=%v", crud, err)
	}
}

func TestValidateORMRejectsResourceWithoutPublicKey(t *testing.T) {
	m := &Manifest{ORM: []*ORMDirective{
		{Kind: "route", Name: "product.item", Args: map[string]string{}},
		{Kind: "path", Name: "/product/{product_uuid}", Args: map[string]string{"route": "product.item"}},
		{Kind: "resource-key", Args: map[string]string{"route": "product.item", "param": "product_uuid", "field": "product.uuid"}},
		{Kind: "operation", Args: map[string]string{"route": "product.item", "method": "GET"}},
	}}
	if err := m.ValidateORM(); err == nil {
		t.Fatal("resource without public key was accepted")
	}
}
