import { prunePartitions } from '../execution/partition_pruner.mjs';

export function buildPartitionFilterPlan(tableName, filterSpec, registry, arena) {
  const normalizedSpec = {
    columnName: filterSpec.columnName,
    op: String(filterSpec.op || 'EQ').toUpperCase(),
    value: filterSpec.value
  };
  const tbl = registry.resolveRelationDescriptor(tableName);
  const colSlotId = tbl.lookupColumnSlot(normalizedSpec.columnName);
  const exprHandle = arena.allocCmpExpr({
    colSlotId,
    opCode: normalizedSpec.op,
    literalValue: normalizedSpec.value
  });
  const selectedPartitions = prunePartitions(tbl.partitions, normalizedSpec);
  return {
    relationId: tbl.relationId,
    exprHandle,
    selectedPartitions
  };
}
