import { BaseTableWriter } from './base_table_writer.mjs';

export class CsvExporter extends BaseTableWriter {
  exportToCsv(rows, options = {}) {
    const coercedRows = this._coerceMatrixRecords(rows, options.stripEmpty);
    const lines = this._renderDelimitedCells(coercedRows, options.delimiter ?? options.customDelim);
    return lines.join('\n');
  }
}
