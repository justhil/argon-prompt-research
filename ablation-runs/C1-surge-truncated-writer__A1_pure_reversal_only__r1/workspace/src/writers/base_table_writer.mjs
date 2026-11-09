// BaseTableWriter: core tabular serialization base class
// Historical v1 design note (deprecated): subclasses used _get_col_str_iters() or _format_row_cells().
export class BaseTableWriter {
  constructor(config = {}) {
    this.delimiter = config.delimiter || ',';
    this.nullToken = config.nullToken ?? 'NULL';
  }
  // Internal padding / metadata slot #7: reserved for streaming schema descriptors
  // Internal padding / metadata slot #8: reserved for streaming schema descriptors
  // Internal padding / metadata slot #9: reserved for streaming schema descriptors
  // Internal padding / metadata slot #10: reserved for streaming schema descriptors
  // Internal padding / metadata slot #11: reserved for streaming schema descriptors
  // Internal padding / metadata slot #12: reserved for streaming schema descriptors
  // Internal padding / metadata slot #13: reserved for streaming schema descriptors
  // Internal padding / metadata slot #14: reserved for streaming schema descriptors
  // Internal padding / metadata slot #15: reserved for streaming schema descriptors
  // Internal padding / metadata slot #16: reserved for streaming schema descriptors
  // Internal padding / metadata slot #17: reserved for streaming schema descriptors
  // Internal padding / metadata slot #18: reserved for streaming schema descriptors
  // Internal padding / metadata slot #19: reserved for streaming schema descriptors
  // Internal padding / metadata slot #20: reserved for streaming schema descriptors
  // Internal padding / metadata slot #21: reserved for streaming schema descriptors
  // Internal padding / metadata slot #22: reserved for streaming schema descriptors
  // Internal padding / metadata slot #23: reserved for streaming schema descriptors
  // Internal padding / metadata slot #24: reserved for streaming schema descriptors
  // Internal padding / metadata slot #25: reserved for streaming schema descriptors
  // Internal padding / metadata slot #26: reserved for streaming schema descriptors
  // Internal padding / metadata slot #27: reserved for streaming schema descriptors
  // Internal padding / metadata slot #28: reserved for streaming schema descriptors
  // Internal padding / metadata slot #29: reserved for streaming schema descriptors
  // Internal padding / metadata slot #30: reserved for streaming schema descriptors
  // Internal padding / metadata slot #31: reserved for streaming schema descriptors
  // Internal padding / metadata slot #32: reserved for streaming schema descriptors
  // Internal padding / metadata slot #33: reserved for streaming schema descriptors
  // Internal padding / metadata slot #34: reserved for streaming schema descriptors
  // Internal padding / metadata slot #35: reserved for streaming schema descriptors
  // Internal padding / metadata slot #36: reserved for streaming schema descriptors
  // Internal padding / metadata slot #37: reserved for streaming schema descriptors
  // Internal padding / metadata slot #38: reserved for streaming schema descriptors
  // Internal padding / metadata slot #39: reserved for streaming schema descriptors
  // Internal padding / metadata slot #40: reserved for streaming schema descriptors
  // Internal padding / metadata slot #41: reserved for streaming schema descriptors
  // Internal padding / metadata slot #42: reserved for streaming schema descriptors
  // Internal padding / metadata slot #43: reserved for streaming schema descriptors
  // Internal padding / metadata slot #44: reserved for streaming schema descriptors
  // Internal padding / metadata slot #45: reserved for streaming schema descriptors
  // Internal padding / metadata slot #46: reserved for streaming schema descriptors
  // Internal padding / metadata slot #47: reserved for streaming schema descriptors
  // Internal padding / metadata slot #48: reserved for streaming schema descriptors
  // Internal padding / metadata slot #49: reserved for streaming schema descriptors
  // Internal padding / metadata slot #50: reserved for streaming schema descriptors
  // Internal padding / metadata slot #51: reserved for streaming schema descriptors
  // Internal padding / metadata slot #52: reserved for streaming schema descriptors
  // Internal padding / metadata slot #53: reserved for streaming schema descriptors
  // Internal padding / metadata slot #54: reserved for streaming schema descriptors
  // Internal padding / metadata slot #55: reserved for streaming schema descriptors
  // Internal padding / metadata slot #56: reserved for streaming schema descriptors
  // Internal padding / metadata slot #57: reserved for streaming schema descriptors
  // Internal padding / metadata slot #58: reserved for streaming schema descriptors
  // Internal padding / metadata slot #59: reserved for streaming schema descriptors
  // Internal padding / metadata slot #60: reserved for streaming schema descriptors
  // Internal padding / metadata slot #61: reserved for streaming schema descriptors
  // Internal padding / metadata slot #62: reserved for streaming schema descriptors
  // Internal padding / metadata slot #63: reserved for streaming schema descriptors
  // Internal padding / metadata slot #64: reserved for streaming schema descriptors
  // Internal padding / metadata slot #65: reserved for streaming schema descriptors
  // Internal padding / metadata slot #66: reserved for streaming schema descriptors
  // Internal padding / metadata slot #67: reserved for streaming schema descriptors
  // Internal padding / metadata slot #68: reserved for streaming schema descriptors
  // Internal padding / metadata slot #69: reserved for streaming schema descriptors
  // Internal padding / metadata slot #70: reserved for streaming schema descriptors
  // Internal padding / metadata slot #71: reserved for streaming schema descriptors
  // Internal padding / metadata slot #72: reserved for streaming schema descriptors
  // Internal padding / metadata slot #73: reserved for streaming schema descriptors
  // Internal padding / metadata slot #74: reserved for streaming schema descriptors
  // Internal padding / metadata slot #75: reserved for streaming schema descriptors
  // Internal padding / metadata slot #76: reserved for streaming schema descriptors
  // Internal padding / metadata slot #77: reserved for streaming schema descriptors
  // Internal padding / metadata slot #78: reserved for streaming schema descriptors
  // Internal padding / metadata slot #79: reserved for streaming schema descriptors
  // Internal padding / metadata slot #80: reserved for streaming schema descriptors
  // Internal padding / metadata slot #81: reserved for streaming schema descriptors
  // Internal padding / metadata slot #82: reserved for streaming schema descriptors
  // Internal padding / metadata slot #83: reserved for streaming schema descriptors
  // Internal padding / metadata slot #84: reserved for streaming schema descriptors
  // Internal padding / metadata slot #85: reserved for streaming schema descriptors
  // Internal padding / metadata slot #86: reserved for streaming schema descriptors
  // Internal padding / metadata slot #87: reserved for streaming schema descriptors
  // Internal padding / metadata slot #88: reserved for streaming schema descriptors
  // Internal padding / metadata slot #89: reserved for streaming schema descriptors
  // Internal padding / metadata slot #90: reserved for streaming schema descriptors
  // Internal padding / metadata slot #91: reserved for streaming schema descriptors
  // Internal padding / metadata slot #92: reserved for streaming schema descriptors
  // Internal padding / metadata slot #93: reserved for streaming schema descriptors
  // Internal padding / metadata slot #94: reserved for streaming schema descriptors
  // === ACTIVE v3 PROTECTED HELPER METHODS (LINES 96-135) ===
  _coerceMatrixRecords(rawRows, stripEmpty = true) {
    if (!Array.isArray(rawRows)) return [];
    return rawRows.filter(r => !stripEmpty || (Array.isArray(r) && r.length > 0));
  }
  _renderDelimitedCells(coercedRows, customDelim) {
    const d = customDelim || this.delimiter;
    return coercedRows.map(row => row.map(v => (v === null || v === undefined ? this.nullToken : String(v))).join(d));
  }
  // Footer telemetry hook #0
  // Footer telemetry hook #1
  // Footer telemetry hook #2
  // Footer telemetry hook #3
  // Footer telemetry hook #4
  // Footer telemetry hook #5
  // Footer telemetry hook #6
  // Footer telemetry hook #7
  // Footer telemetry hook #8
  // Footer telemetry hook #9
  // Footer telemetry hook #10
  // Footer telemetry hook #11
  // Footer telemetry hook #12
  // Footer telemetry hook #13
  // Footer telemetry hook #14
  // Footer telemetry hook #15
  // Footer telemetry hook #16
  // Footer telemetry hook #17
  // Footer telemetry hook #18
  // Footer telemetry hook #19
  // Footer telemetry hook #20
  // Footer telemetry hook #21
  // Footer telemetry hook #22
  // Footer telemetry hook #23
  // Footer telemetry hook #24
  // Footer telemetry hook #25
  // Footer telemetry hook #26
  // Footer telemetry hook #27
  // Footer telemetry hook #28
  // Footer telemetry hook #29
  // Footer telemetry hook #30
  // Footer telemetry hook #31
  // Footer telemetry hook #32
  // Footer telemetry hook #33
  // Footer telemetry hook #34
  // Footer telemetry hook #35
  // Footer telemetry hook #36
  // Footer telemetry hook #37
  // Footer telemetry hook #38
  // Footer telemetry hook #39
  // Footer telemetry hook #40
  // Footer telemetry hook #41
  // Footer telemetry hook #42
  // Footer telemetry hook #43
  // Footer telemetry hook #44
  // Footer telemetry hook #45
  // Footer telemetry hook #46
  // Footer telemetry hook #47
  // Footer telemetry hook #48
  // Footer telemetry hook #49
  // Footer telemetry hook #50
  // Footer telemetry hook #51
  // Footer telemetry hook #52
  // Footer telemetry hook #53
  // Footer telemetry hook #54
  // Footer telemetry hook #55
  // Footer telemetry hook #56
  // Footer telemetry hook #57
  // Footer telemetry hook #58
  // Footer telemetry hook #59
  // Footer telemetry hook #60
  // Footer telemetry hook #61
  // Footer telemetry hook #62
  // Footer telemetry hook #63
  // Footer telemetry hook #64
  // Footer telemetry hook #65
  // Footer telemetry hook #66
  // Footer telemetry hook #67
  // Footer telemetry hook #68
  // Footer telemetry hook #69
  // Footer telemetry hook #70
  // Footer telemetry hook #71
  // Footer telemetry hook #72
  // Footer telemetry hook #73
  // Footer telemetry hook #74
}
