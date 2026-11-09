import { prunePartitions } from '../execution/partition_pruner.mjs';

export function buildPartitionFilterPlan(tableName, filterSpec, registry, arena) {
  const normalizedSpec = {
    columnName: filterSpec.columnName,
    op: String(filterSpec.op || 'EQ').toUpperCase(),
    value: filterSpec.value
  };
  const tbl = registry.getTable(tableName);
  const colSlotId = tbl.columns[normalizedSpec.columnName];
  const exprHandle = arena.createNode(colSlotId, normalizedSpec.op, normalizedSpec.value);
  const selectedPartitions = prunePartitions(tbl.partitions, normalizedSpec);
  return {
    relationId: tbl.relationId,
    exprHandle,
    selectedPartitions
  };
}
