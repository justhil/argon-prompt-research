import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportBuilder } from '../src/exporter/report_builder.mjs';

test('smoke: instance creation', () => {
  const rb = new ReportBuilder();
  assert.ok(rb);
});
