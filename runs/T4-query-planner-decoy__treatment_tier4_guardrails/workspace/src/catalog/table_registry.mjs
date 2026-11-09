export class TableRegistry {
  constructor() {
    this.relations = new Map();
  }

  registerRelation({ relationId, name, columns, partitions }) {
    const colMap = new Map(columns.map(c => [c.name, c]));
    this.relations.set(name, { relationId, name, colMap, partitions });
  }

  resolveRelationDescriptor(tableName) {
    const rel = this.relations.get(tableName);
    if (!rel) throw new Error(`Unknown relation: ${tableName}`);
    return {
      relationId: rel.relationId,
      partitions: rel.partitions,
      lookupColumnSlot(colName) {
        const col = rel.colMap.get(colName);
        if (!col) throw new Error(`Unknown column ${colName} on ${tableName}`);
        return col.slotId;
      }
    };
  }
}
