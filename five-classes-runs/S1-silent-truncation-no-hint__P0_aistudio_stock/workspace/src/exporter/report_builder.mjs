import { BaseWriter } from './base_writer.mjs';

export class ReportBuilder extends BaseWriter {
  exportMatrix(rows) {
    return rows.map(r => this._renderAlignedCurrencyRow(r)).join('\n');
  }
}
