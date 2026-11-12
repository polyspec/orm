package dbspec

// SetDocument is the result of one text of a set (docs/spec/dbspec.md "Parsing a set"): the name that the parser reads
// from its header, empty when the header fails; whether the text is external; and what one parse of the text
// returns, its document and positions or its diagnostics.
type SetDocument struct {
	Name        string
	External    bool
	Document    *Document
	Positions   []Position
	Diagnostics []Diagnostic
}

// ParseSet parses the texts of one document set (docs/spec/dbspec.md "Parsing a set") and returns one SetDocument per text,
// owned first, each in set order. Each text's name is the name the parser reads from its header; a text whose name an
// earlier text has is not parsed and carries the diagnostic name.duplicate. Every other text is parsed with the texts
// of all other named documents as the documents its use lines name.
func ParseSet(owned, external []string) []SetDocument {
	var out []SetDocument
	type entry struct {
		text     string
		external bool
		result   int
	}
	named := map[string]string{}
	var parse []entry
	add := func(text string, isExternal bool) {
		name := parseStructure(text, nil).document.name.text
		out = append(out, SetDocument{Name: name, External: isExternal})
		index := len(out) - 1
		if name != "" {
			if _, repeated := named[name]; repeated {
				out[index].Diagnostics = []Diagnostic{{Rule: RuleNameDuplicate, Line: 1, Column: 10, Message: "document " + name + " appears twice in the document set"}}
				return
			}
			named[name] = text
		}
		parse = append(parse, entry{text: text, external: isExternal, result: index})
	}
	for _, text := range owned {
		add(text, false)
	}
	for _, text := range external {
		add(text, true)
	}
	for _, e := range parse {
		d := &out[e.result]
		others := map[string]string{}
		for name, text := range named {
			if name != d.Name {
				others[name] = text
			}
		}
		d.Document, d.Positions, d.Diagnostics = Parse(e.text, others)
		if d.Document != nil {
			d.Document.External = e.external
		}
	}
	return out
}
