package schema

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
)

var pathParameter = regexp.MustCompile(`\{([a-z][a-z0-9_]*)\}`)

// ValidateORM checks the semantic part of the orm:* extension after Build has
// resolved physical foreign keys and unique constraints. It intentionally
// does not generate routes or CRUD code.
func (m *Manifest) ValidateORM() error {
	fields := map[string]*ORMDirective{}
	publicKeys := map[string]*ORMDirective{}
	routes := map[string]*ormRoute{}
	for _, x := range m.ORM {
		switch x.Kind {
		case "field":
			if _, exists := fields[x.Name]; exists {
				return ormError(x, "duplicate field declaration")
			}
			fields[x.Name] = x
		case "public-key":
			key := x.Args["entity"] + "." + x.Args["field"]
			if _, exists := publicKeys[key]; exists {
				return ormError(x, "duplicate public key")
			}
			publicKeys[key] = x
		case "route":
			if _, exists := routes[x.Name]; exists {
				return ormError(x, "duplicate route")
			}
			routes[x.Name] = &ormRoute{name: x.Name, params: map[string][]string{}}
		}
	}
	for _, entity := range m.Entities {
		for _, column := range entity.Columns {
			if column.FK && fields[entity.Name+"."+column.Name] == nil {
				return fmt.Errorf("entity %s: FK field %s has no orm:field role", entity.Name, column.Name)
			}
		}
	}
	for key, x := range publicKeys {
		entityName, fieldName, _ := strings.Cut(key, ".")
		entity := m.Entities[entityName]
		if entity == nil {
			return ormError(x, "public key entity is not declared")
		}
		column := entity.Column(fieldName)
		if column == nil {
			return ormError(x, "public key field is not declared")
		}
		if column.Nullable || !column.UK || !hasSingleUnique(entity, fieldName) {
			return ormError(x, "public key must be non-null and single-column unique")
		}
		if x.Args["type"] == "uuid" && (column.Type != "string" || column.Len != 36) {
			return ormError(x, "uuid public key must be varchar(36)")
		}
	}
	for _, x := range m.ORM {
		switch x.Kind {
		case "field":
			if err := validateORMField(m, x, publicKeys); err != nil {
				return err
			}
		case "resource-key":
			route := routes[x.Args["route"]]
			if route == nil {
				return ormError(x, "resource route is not declared")
			}
			if route.resource != nil {
				return ormError(x, "route has more than one resource key")
			}
			route.resource = x
		case "path":
			route := routes[x.Args["route"]]
			if route == nil {
				return ormError(x, "path route is not declared")
			}
			if route.path != "" {
				return ormError(x, "route has more than one path")
			}
			if !strings.HasPrefix(x.Name, "/") {
				return ormError(x, "path must start with /")
			}
			route.path = x.Name
		case "scope", "filter":
			route := routes[x.Args["route"]]
			if route == nil {
				return ormError(x, "route is not declared")
			}
			key := x.Args["param"] + "=" + x.Args["field"]
			seen := route.params[x.Kind]
			if slices.Contains(seen, key) {
				return ormError(x, "duplicate route parameter")
			}
			route.params[x.Kind] = append(seen, key)
		case "operation":
			route := routes[x.Args["route"]]
			if route == nil {
				return ormError(x, "operation route is not declared")
			}
			method := x.Args["method"]
			if slices.Contains(route.operations, method) {
				return ormError(x, "duplicate route operation")
			}
			route.operations = append(route.operations, method)
		case "permission":
			route := routes[x.Args["route"]]
			if route == nil {
				return ormError(x, "permission route is not declared")
			}
			field := fields[x.Args["owner"]]
			if field == nil || field.Args["relation"] != "owner" {
				return ormError(x, "permission owner must be an owner field")
			}
			route.permissions = append(route.permissions, x.Args["action"])
		}
	}
	for _, route := range routes {
		if err := validateORMRoute(route, fields, publicKeys); err != nil {
			return err
		}
	}
	return nil
}

type ormRoute struct {
	name        string
	path        string
	resource    *ORMDirective
	params      map[string][]string
	operations  []string
	permissions []string
}

func validateORMField(m *Manifest, x *ORMDirective, publicKeys map[string]*ORMDirective) error {
	entity, field, ok := strings.Cut(x.Name, ".")
	if !ok {
		return ormError(x, "field must be entity.field")
	}
	e := m.Entities[entity]
	if e == nil {
		return ormError(x, "field entity is not declared")
	}
	c := e.Column(field)
	if c == nil {
		return ormError(x, "field is not declared")
	}
	if !c.FK || c.Ref == nil || c.Ref.Entity+"."+c.Ref.Column != x.Args["fk"] {
		return ormError(x, "fk does not match the physical schema")
	}
	role := x.Args["relation"]
	if role == "scope" {
		if c.Nullable || x.Args["required"] != "true" {
			return ormError(x, "scope field must be non-null and required=true")
		}
		if _, err := strconv.Atoi(x.Args["order"]); err != nil || x.Args["order"] == "" {
			return ormError(x, "scope field requires a positive order")
		}
	}
	if public := x.Args["public"]; public != "" {
		key := publicKeys[public]
		if key == nil {
			return ormError(x, "public resolver key is not declared")
		}
		entityName, fieldName, _ := strings.Cut(public, ".")
		entity := m.Entities[entityName]
		column := entity.Column(fieldName)
		if column == nil || column.Nullable || !column.UK || len(entity.Unique) == 0 || !hasSingleUnique(entity, fieldName) {
			return ormError(x, "public resolver key must be non-null and single-column unique")
		}
		if key.Args["type"] == "uuid" && (column.Type != "string" || column.Len != 36) {
			return ormError(x, "uuid public resolver key must be varchar(36)")
		}
	}
	if role == "scope" && x.Args["public"] == "" {
		return ormError(x, "scope field requires a public resolver key")
	}
	return nil
}

func hasSingleUnique(entity *Entity, field string) bool {
	for _, unique := range entity.Unique {
		if len(unique) == 1 && unique[0] == field {
			return true
		}
	}
	return false
}

func validateORMRoute(route *ormRoute, fields map[string]*ORMDirective, publicKeys map[string]*ORMDirective) error {
	if route.path == "" {
		return fmt.Errorf("route %s: path is required", route.name)
	}
	if len(route.operations) == 0 {
		return fmt.Errorf("route %s: operation is required", route.name)
	}
	params := map[string]int{}
	pathOrder := []string{}
	for _, match := range pathParameter.FindAllStringSubmatch(route.path, -1) {
		params[match[1]]++
		pathOrder = append(pathOrder, match[1])
	}
	declaredParams := map[string]bool{}
	for _, declaration := range route.params["scope"] {
		param, fieldName, _ := strings.Cut(declaration, "=")
		declaredParams[param] = true
		field := fields[fieldName]
		if field == nil {
			continue
		}
		if field.Args["public"] == "" {
			return fmt.Errorf("route %s: scope field %s has no public resolver", route.name, fieldName)
		}
	}
	for kind, declarations := range route.params {
		for _, declaration := range declarations {
			param, fieldName, _ := strings.Cut(declaration, "=")
			if params[param] != 1 {
				return fmt.Errorf("route %s: %s parameter %s must occur once in path", route.name, kind, param)
			}
			declaredParams[param] = true
			field := fields[fieldName]
			if field == nil {
				return fmt.Errorf("route %s: %s field %s is not declared", route.name, kind, fieldName)
			}
			if kind == "scope" && field.Args["relation"] != "scope" {
				return fmt.Errorf("route %s: field %s is not a scope field", route.name, fieldName)
			}
			if kind == "filter" && field.Args["relation"] == "scope" {
				return fmt.Errorf("route %s: scope field cannot be a filter", route.name)
			}
			if kind == "filter" && field.Args["public"] == "" {
				return fmt.Errorf("route %s: filter field %s has no public resolver", route.name, fieldName)
			}
		}
	}
	if route.resource != nil {
		declaredParams[route.resource.Args["param"]] = true
	}
	for i, declaration := range route.params["scope"] {
		param, fieldName, _ := strings.Cut(declaration, "=")
		field := fields[fieldName]
		want, _ := strconv.Atoi(field.Args["order"])
		if want != i+1 {
			return fmt.Errorf("route %s: scope %s must have order %d", route.name, param, i+1)
		}
		if i >= len(pathOrder) || pathOrder[i] != param {
			return fmt.Errorf("route %s: scope path order does not match declarations", route.name)
		}
	}
	for _, param := range pathOrder {
		if !declaredParams[param] {
			return fmt.Errorf("route %s: path parameter %s is not declared", route.name, param)
		}
	}
	if route.resource != nil {
		param := route.resource.Args["param"]
		if params[param] != 1 {
			return fmt.Errorf("route %s: resource parameter %s must occur once in path", route.name, param)
		}
		entity, field, _ := strings.Cut(route.resource.Args["field"], ".")
		key := publicKeys[entity+"."+field]
		if key == nil || key.Args["stable"] != "true" || key.Args["unique"] != "true" {
			return fmt.Errorf("route %s: resource field is not a public key", route.name)
		}
	} else if slices.Contains(route.operations, "PATCH") || slices.Contains(route.operations, "DELETE") {
		return fmt.Errorf("route %s: PATCH and DELETE require a resource key", route.name)
	}
	if route.resource != nil && slices.Contains(route.operations, "POST") {
		return fmt.Errorf("route %s: POST requires a collection route without a resource key", route.name)
	}
	if route.resource == nil && (slices.Contains(route.operations, "PATCH") || slices.Contains(route.operations, "DELETE")) {
		return fmt.Errorf("route %s: collection mutation requires an explicit resource or bulk contract", route.name)
	}
	for _, method := range route.operations {
		action := map[string]string{"POST": "create", "PATCH": "update", "DELETE": "delete"}[method]
		if action != "" && !slices.Contains(route.permissions, action) {
			return fmt.Errorf("route %s: %s requires permission action=%s", route.name, method, action)
		}
	}
	return nil
}

func ormError(x *ORMDirective, message string) error {
	return &BuildError{x.Line, "%% orm:" + x.Kind + ": " + message}
}

// Stable output order is useful to profile validators that report all routes.
func ormRouteNames(routes map[string]*ormRoute) []string {
	names := make([]string, 0, len(routes))
	for name := range routes {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
