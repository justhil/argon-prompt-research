export class PredicateArena {
  constructor() {
    this.nodes = [];
  }

  allocCmpExpr({ colSlotId, opCode, literalValue }) {
    if (typeof colSlotId !== 'number' || !opCode) {
      throw new Error('allocCmpExpr requires numeric colSlotId and opCode');
    }
    this.nodes.push({ colSlotId, opCode, literalValue });
    return this.nodes.length;
  }

  getExpr(handle) {
    return this.nodes[handle - 1] || null;
  }
}
