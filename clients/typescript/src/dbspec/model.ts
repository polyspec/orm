// The parsed dbspec document (docs/dbspec.md). Every object of a parsed
// document is frozen. Comment lines (`#` to the end of the line) are kept on
// the line that follows them; `closingComments` belong to the closing brace
// of a block, or to the end of the document.

export type DbspecRule =
  | 'signature'
  | 'header'
  | 'syntax'
  | 'order'
  | 'name.format'
  | 'name.length'
  | 'name.duplicate'
  | 'type'
  | 'column'
  | 'key'
  | 'foreign_key'
  | 'check'
  | 'setting'
  | 'use'
  | 'diagram'
  | 'limit'
  | 'encoding'
  | 'plan'
  | 'chain'
  | 'compare'
  | 'mermaid';

/** One SCHEMA_INVALID diagnostic: the rule, the 1-based line and column of the offending token, and a message. */
export interface DbspecDiagnostic {
  readonly rule: DbspecRule;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export type DbspecType =
  | { readonly kind: 'i16' | 'i32' | 'i64' | 'bool' | 'f64' | 'text' | 'bytes' | 'uuid' | 'date' }
  | { readonly kind: 'decimal'; readonly precision: number; readonly scale: number }
  | { readonly kind: 'varchar'; readonly length: number }
  | { readonly kind: 'time' | 'datetime'; readonly precision: number };

/** A default: `now`, or a literal in its canonical text (`'pending'`, `1.00`, `true`). */
export type DbspecDefault = { readonly kind: 'now' } | { readonly kind: 'literal'; readonly text: string };

export type DbspecAction = 'restrict' | 'cascade' | 'set_null';

export type DbspecCodecStage = 'ordered_json' | 'aes' | 'hex' | 'gz' | 'base64' | 'serialize' | 'yaml' | 'ip';

export interface DbspecColumn {
  readonly comments: readonly string[];
  readonly name: string;
  readonly type: DbspecType;
  readonly nullable: boolean;
  readonly identity: boolean;
  readonly default: DbspecDefault | null;
}

export interface DbspecPrimaryKey {
  readonly comments: readonly string[];
  readonly columns: readonly string[];
}

export interface DbspecUnique {
  readonly comments: readonly string[];
  readonly name: string;
  readonly columns: readonly string[];
}

export interface DbspecIndexColumn {
  readonly name: string;
  readonly descending: boolean;
}

export interface DbspecIndex {
  readonly comments: readonly string[];
  readonly name: string;
  readonly columns: readonly DbspecIndexColumn[];
}

export interface DbspecForeignKey {
  readonly comments: readonly string[];
  readonly name: string;
  readonly columns: readonly string[];
  readonly table: string;
  readonly references: readonly string[];
  readonly onDelete: DbspecAction;
  readonly onUpdate: DbspecAction;
}

export interface DbspecCheck {
  readonly comments: readonly string[];
  readonly name: string;
  /** The expression in canonical text, without the enclosing parentheses. */
  readonly expression: string;
}

export type DbspecSetting = { readonly comments: readonly string[] } & (
  | { readonly kind: 'entity'; readonly name: string }
  | { readonly kind: 'updated' | 'soft_delete' | 'aes_version'; readonly column: string }
  | { readonly kind: 'select_explicit'; readonly columns: readonly string[] }
  | { readonly kind: 'codec'; readonly column: string; readonly stages: readonly DbspecCodecStage[] }
  | { readonly kind: 'blind_index'; readonly column: string; readonly indexColumn: string }
  | { readonly kind: 'navigation'; readonly foreignKey: string; readonly childName: string; readonly parentName: string }
  | { readonly kind: 'immutable' }
  | {
      readonly kind: 'audit';
      readonly into: string;
      readonly operation: string;
      readonly action: string;
      readonly previous: string;
    }
);

export interface DbspecSettings {
  readonly comments: readonly string[];
  readonly settings: readonly DbspecSetting[];
  readonly closingComments: readonly string[];
}

export interface DbspecTable {
  readonly comments: readonly string[];
  readonly name: string;
  readonly columns: readonly DbspecColumn[];
  readonly primaryKey: DbspecPrimaryKey;
  readonly uniques: readonly DbspecUnique[];
  readonly indexes: readonly DbspecIndex[];
  readonly foreignKeys: readonly DbspecForeignKey[];
  readonly checks: readonly DbspecCheck[];
  readonly settings: DbspecSettings | null;
  readonly closingComments: readonly string[];
}

export interface DbspecUse {
  readonly comments: readonly string[];
  readonly document: string;
  readonly tables: readonly string[];
}

export interface DbspecPlacement {
  readonly comments: readonly string[];
  readonly table: string;
  readonly x: number;
  readonly y: number;
}

export interface DbspecDiagram {
  readonly comments: readonly string[];
  readonly name: string;
  readonly placements: readonly DbspecPlacement[];
  readonly closingComments: readonly string[];
}

export interface DbspecDocument {
  readonly name: string;
  readonly uses: readonly DbspecUse[];
  readonly tables: readonly DbspecTable[];
  readonly diagrams: readonly DbspecDiagram[];
  readonly closingComments: readonly string[];
}
