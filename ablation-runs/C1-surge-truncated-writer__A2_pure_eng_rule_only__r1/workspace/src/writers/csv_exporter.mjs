import { BaseTableWriter } from './base_table_writer.mjs';

export class CsvExporter extends BaseTableWriter {
  exportToCsv(rows, options = {}) {
    const coerced = this._coerceMatrixRecords(rows, options.stripEmpty ?? true);
    const lines = this._renderDelimitedCells(coerced, options.delimiter);
    return lines.join('\n');
  }
}
