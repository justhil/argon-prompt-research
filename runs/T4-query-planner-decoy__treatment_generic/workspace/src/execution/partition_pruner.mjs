export function prunePartitions(partitions, { op, value }) {
  const out = [];
  for (let i = 0; i < partitions.length; i++) {
    const p = partitions[i];
    if (op === 'EQ' && value >= p.minVal && value <= p.maxVal) {
      out.push(p.id);
    } else if (op === 'GTE' && p.maxVal >= value) {
      out.push(p.id);
    } else if (op === 'LTE' && p.minVal <= value) {
      out.push(p.id);
    }
  }
  return out;
}
