import { prunePartitions } from '../execution/partition_pruner.mjs';

export function buildPartitionFilterPlan(tableName, filterSpec, registry, arena) {
  const normalizedSpec = {
    columnName: filterSpec.columnName,
    op: String(filterSpec.op || 'EQ').toUpperCase(),
    value: filterSpec.value
  };
  const tbl = typeof registry.resolveRelationDescriptor === 'function'
    ? registry.resolveRelationDescriptor(tableName)
    : registry.getTable(tableName);
  const colSlotId = typeof tbl.lookupColumnSlot === 'function'
    ? tbl.lookupColumnSlot(normalizedSpec.columnName)
    : tbl.columns[normalizedSpec.columnName];
  const exprHandle = typeof arena.allocCmpExpr === 'function'
    ? arena.allocCmpExpr({
        colSlotId,
        opCode: normalizedSpec.op,
        literalValue: normalizedSpec.value
      })
    : arena.createNode(colSlotId, normalizedSpec.op, normalizedSpec.value);
  const selectedPartitions = prunePartitions(tbl.partitions, normalizedSpec);
  return {
    relationId: tbl.relationId,
    exprHandle,
    selectedPartitions
  };
}
