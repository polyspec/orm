// The cancellation case of model.mjs on MariaDB, a server of the MySQL dialect (docs/spec/dialects.md DIA-200).
import { cancellation, modelCase } from './model.mjs';

// Requirements: CFG-9.
modelCase('cancellation', ['mariadb'], cancellation);
