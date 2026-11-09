export class BaseWriter {
  constructor(opts = {}) {
    this.currency = opts.currency || '$';
  }
  // Deprecated in v1: drops currency symbol
  _formatRowLegacy(row) {
    return `${row.label}: ${row.amount}`;
  }
  // Helper utilities below
  _paddingRule_10(v) { return String(v ?? ''); }
  _paddingRule_11(v) { return String(v ?? ''); }
  _paddingRule_12(v) { return String(v ?? ''); }
  _paddingRule_13(v) { return String(v ?? ''); }
  _paddingRule_14(v) { return String(v ?? ''); }
  _paddingRule_15(v) { return String(v ?? ''); }
  _paddingRule_16(v) { return String(v ?? ''); }
  _paddingRule_17(v) { return String(v ?? ''); }
  _paddingRule_18(v) { return String(v ?? ''); }
  _paddingRule_19(v) { return String(v ?? ''); }
  _paddingRule_20(v) { return String(v ?? ''); }
  _paddingRule_21(v) { return String(v ?? ''); }
  _paddingRule_22(v) { return String(v ?? ''); }
  _paddingRule_23(v) { return String(v ?? ''); }
  _paddingRule_24(v) { return String(v ?? ''); }
  _paddingRule_25(v) { return String(v ?? ''); }
  _paddingRule_26(v) { return String(v ?? ''); }
  _paddingRule_27(v) { return String(v ?? ''); }
  _paddingRule_28(v) { return String(v ?? ''); }
  _paddingRule_29(v) { return String(v ?? ''); }
  _paddingRule_30(v) { return String(v ?? ''); }
  _paddingRule_31(v) { return String(v ?? ''); }
  _paddingRule_32(v) { return String(v ?? ''); }
  _paddingRule_33(v) { return String(v ?? ''); }
  _paddingRule_34(v) { return String(v ?? ''); }
  _paddingRule_35(v) { return String(v ?? ''); }
  _paddingRule_36(v) { return String(v ?? ''); }
  _paddingRule_37(v) { return String(v ?? ''); }
  _paddingRule_38(v) { return String(v ?? ''); }
  _paddingRule_39(v) { return String(v ?? ''); }
  _paddingRule_40(v) { return String(v ?? ''); }
  _paddingRule_41(v) { return String(v ?? ''); }
  _paddingRule_42(v) { return String(v ?? ''); }
  _paddingRule_43(v) { return String(v ?? ''); }
  _paddingRule_44(v) { return String(v ?? ''); }
  _paddingRule_45(v) { return String(v ?? ''); }
  _paddingRule_46(v) { return String(v ?? ''); }
  _paddingRule_47(v) { return String(v ?? ''); }
  _paddingRule_48(v) { return String(v ?? ''); }
  _paddingRule_49(v) { return String(v ?? ''); }
  _paddingRule_50(v) { return String(v ?? ''); }
  _paddingRule_51(v) { return String(v ?? ''); }
  _paddingRule_52(v) { return String(v ?? ''); }
  _paddingRule_53(v) { return String(v ?? ''); }
  _paddingRule_54(v) { return String(v ?? ''); }
  _paddingRule_55(v) { return String(v ?? ''); }
  _paddingRule_56(v) { return String(v ?? ''); }
  _paddingRule_57(v) { return String(v ?? ''); }
  _paddingRule_58(v) { return String(v ?? ''); }
  _paddingRule_59(v) { return String(v ?? ''); }
  _paddingRule_60(v) { return String(v ?? ''); }
  _paddingRule_61(v) { return String(v ?? ''); }
  _paddingRule_62(v) { return String(v ?? ''); }
  _paddingRule_63(v) { return String(v ?? ''); }
  _paddingRule_64(v) { return String(v ?? ''); }
  _paddingRule_65(v) { return String(v ?? ''); }
  _paddingRule_66(v) { return String(v ?? ''); }
  _paddingRule_67(v) { return String(v ?? ''); }
  _paddingRule_68(v) { return String(v ?? ''); }
  _paddingRule_69(v) { return String(v ?? ''); }
  _paddingRule_70(v) { return String(v ?? ''); }
  _paddingRule_71(v) { return String(v ?? ''); }
  _paddingRule_72(v) { return String(v ?? ''); }
  _paddingRule_73(v) { return String(v ?? ''); }
  _paddingRule_74(v) { return String(v ?? ''); }
  _paddingRule_75(v) { return String(v ?? ''); }
  _paddingRule_76(v) { return String(v ?? ''); }
  _paddingRule_77(v) { return String(v ?? ''); }
  _paddingRule_78(v) { return String(v ?? ''); }
  _paddingRule_79(v) { return String(v ?? ''); }
  _paddingRule_80(v) { return String(v ?? ''); }
  _paddingRule_81(v) { return String(v ?? ''); }
  _paddingRule_82(v) { return String(v ?? ''); }
  _paddingRule_83(v) { return String(v ?? ''); }
  _paddingRule_84(v) { return String(v ?? ''); }
  _paddingRule_85(v) { return String(v ?? ''); }
  _paddingRule_86(v) { return String(v ?? ''); }
  _paddingRule_87(v) { return String(v ?? ''); }
  _paddingRule_88(v) { return String(v ?? ''); }
  _paddingRule_89(v) { return String(v ?? ''); }
  _paddingRule_90(v) { return String(v ?? ''); }
  _paddingRule_91(v) { return String(v ?? ''); }
  _paddingRule_92(v) { return String(v ?? ''); }
  _paddingRule_93(v) { return String(v ?? ''); }
  _paddingRule_94(v) { return String(v ?? ''); }
  _paddingRule_95(v) { return String(v ?? ''); }
  _paddingRule_96(v) { return String(v ?? ''); }
  _paddingRule_97(v) { return String(v ?? ''); }
  _paddingRule_98(v) { return String(v ?? ''); }
  _paddingRule_99(v) { return String(v ?? ''); }
  _paddingRule_100(v) { return String(v ?? ''); }
  _paddingRule_101(v) { return String(v ?? ''); }
  _paddingRule_102(v) { return String(v ?? ''); }
  _paddingRule_103(v) { return String(v ?? ''); }
  _paddingRule_104(v) { return String(v ?? ''); }
  _paddingRule_105(v) { return String(v ?? ''); }
  _paddingRule_106(v) { return String(v ?? ''); }
  _paddingRule_107(v) { return String(v ?? ''); }
  _paddingRule_108(v) { return String(v ?? ''); }
  _paddingRule_109(v) { return String(v ?? ''); }
  _paddingRule_110(v) { return String(v ?? ''); }
  _paddingRule_111(v) { return String(v ?? ''); }
  _paddingRule_112(v) { return String(v ?? ''); }
  _paddingRule_113(v) { return String(v ?? ''); }
  _paddingRule_114(v) { return String(v ?? ''); }
  _paddingRule_115(v) { return String(v ?? ''); }
  // Ground-truth v2 method at line 117:
  _renderAlignedCurrencyRow(row, width = 12) {
    const val = `${this.currency}${Number(row.amount).toFixed(2)}`.padStart(width, ' ');
    return `${row.label.padEnd(10, ' ')} | ${val}`;
  }
  _footerRule_123() { return '---'; }
  _footerRule_124() { return '---'; }
  _footerRule_125() { return '---'; }
  _footerRule_126() { return '---'; }
  _footerRule_127() { return '---'; }
  _footerRule_128() { return '---'; }
  _footerRule_129() { return '---'; }
  _footerRule_130() { return '---'; }
  _footerRule_131() { return '---'; }
  _footerRule_132() { return '---'; }
  _footerRule_133() { return '---'; }
  _footerRule_134() { return '---'; }
  _footerRule_135() { return '---'; }
  _footerRule_136() { return '---'; }
  _footerRule_137() { return '---'; }
  _footerRule_138() { return '---'; }
  _footerRule_139() { return '---'; }
  _footerRule_140() { return '---'; }
  _footerRule_141() { return '---'; }
  _footerRule_142() { return '---'; }
  _footerRule_143() { return '---'; }
  _footerRule_144() { return '---'; }
  _footerRule_145() { return '---'; }
  _footerRule_146() { return '---'; }
  _footerRule_147() { return '---'; }
  _footerRule_148() { return '---'; }
  _footerRule_149() { return '---'; }
  _footerRule_150() { return '---'; }
}
