// The files that orm took from the examples of @polyspec/kit and keeps in the form of kit (T391, kit
// docs/spec/utilities-and-recipes.md): kit writes no file of orm since 0.0.98, so these are orm's own files, changed here when
// orm adopts a change of kit's example. They keep the form of kit, not the forms that the rules of this repository give its
// own documents and workflows, so those rules skip them.

const KIT_FORM_FILES = [
  '.github/workflows/release.yml',
  '.github/workflows/ci-pipeline.yml',
  '.github/actions/kit-bootstrap/action.yml',
  'PRINCIPLES.md',
  'PRINCIPLES.ko.md',
  '.editorconfig',
  'config/layout.kit.yml',
  'config/composer.schema.json',
  'config/cargo.schema.json',
];

/** The files of orm in the form of kit, as { path: path }, which the document and repository rules skip. */
export function kitCopies(): Record<string, string> {
  return Object.fromEntries(KIT_FORM_FILES.map(file => [file, file]));
}

/** The files in the form of kit, the workflows among them, which the workflow rules of this repository skip. */
export function kitOwnedPaths(): string[] {
  return [...KIT_FORM_FILES];
}
