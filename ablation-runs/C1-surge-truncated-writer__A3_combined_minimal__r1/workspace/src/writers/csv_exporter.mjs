import { BaseTableWriter } from './base_table_writer.mjs';

export class CsvExporter extends BaseTableWriter {
  exportToCsv(rows, options = {}) {
    const coercedRows = this._coerceMatrixRecords(rows, options.stripEmpty ?? true);
    const lines = this._renderDelimitedCells(coercedRows, options.delimiter);
    return lines.join('\n');
  }
}
