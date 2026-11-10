// The cancellation case of model.mjs on MySQL (docs/spec/dialects.md DIA-200).
import { cancellation, modelCase } from './model.mjs';

// Requirements: CFG-9.
modelCase('cancellation', ['mysql'], cancellation);
