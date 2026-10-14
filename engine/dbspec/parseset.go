package dbspec

// SetDocument is the result of one text of a set (docs/dbspec.md "Parsing a set"): the name that the parser reads
// from its header, empty when the header fails; whether the text is external; and what one parse of the text
// returns, its document and positions or its diagnostics.
type SetDocument struct {
	Name        string
	External    bool
	Document    *Document
	Positions   []Position
	Diagnostics []Diagnostic
}

// SetParse is the result of ParseSet: one SetDocument per text, owned first, each in set order, and the diagnostics of
// the set as a whole.
type SetParse struct {
	Documents   []SetDocument
	Diagnostics []Diagnostic
}

// ParseSet parses the texts of one document set (docs/dbspec.md "Parsing a set"). Each text's name is the name the
// parser reads from its header; a name that a later text repeats is a set diagnostic and that text is not parsed.
// Every other text is parsed with the texts of all other named documents as the documents its use lines name.
func ParseSet(owned, external []string) SetParse {
	var out SetParse
	type entry struct {
		text     string
		external bool
		result   int
	}
	named := map[string]string{}
	var parse []entry
	add := func(text string, isExternal bool) {
		name := parseStructure(text, nil).document.name.text
		out.Documents = append(out.Documents, SetDocument{Name: name, External: isExternal})
		index := len(out.Documents) - 1
		if name != "" {
			if _, repeated := named[name]; repeated {
				out.Diagnostics = append(out.Diagnostics, Diagnostic{Rule: RuleNameDuplicate, Line: 1, Column: 10, Message: "document " + name + " appears twice in the document set"})
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
		d := &out.Documents[e.result]
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
