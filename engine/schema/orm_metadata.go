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
	name       string
	path       string
	resource   *ORMDirective
	params     map[string][]string
	operations []string
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
		if publicKeys[public] == nil {
			return ormError(x, "public resolver key is not declared")
		}
	}
	if role == "scope" && x.Args["public"] == "" {
		return ormError(x, "scope field requires a public resolver key")
	}
	return nil
}

func validateORMRoute(route *ormRoute, fields map[string]*ORMDirective, publicKeys map[string]*ORMDirective) error {
	if route.path == "" {
		return fmt.Errorf("route %s: path is required", route.name)
	}
	if len(route.operations) == 0 {
		return fmt.Errorf("route %s: operation is required", route.name)
	}
	params := map[string]int{}
	for _, match := range pathParameter.FindAllStringSubmatch(route.path, -1) {
		params[match[1]]++
	}
	for kind, declarations := range route.params {
		for _, declaration := range declarations {
			param, fieldName, _ := strings.Cut(declaration, "=")
			if params[param] != 1 {
				return fmt.Errorf("route %s: %s parameter %s must occur once in path", route.name, kind, param)
			}
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
		}
	}
	if route.resource != nil {
		param := route.resource.Args["param"]
		if params[param] != 1 {
			return fmt.Errorf("route %s: resource parameter %s must occur once in path", route.name, param)
		}
		entity, field, _ := strings.Cut(route.resource.Args["field"], ".")
		if publicKeys[entity+"."+field] == nil {
			return fmt.Errorf("route %s: resource field is not a public key", route.name)
		}
	} else if slices.Contains(route.operations, "PATCH") || slices.Contains(route.operations, "DELETE") {
		return fmt.Errorf("route %s: PATCH and DELETE require a resource key", route.name)
	}
	if route.resource != nil && slices.Contains(route.operations, "POST") {
		return fmt.Errorf("route %s: POST requires a collection route without a resource key", route.name)
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
