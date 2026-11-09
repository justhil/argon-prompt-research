export function computePlatformFeeUnits(subtotalUnits, feeBps = 0) {
  if (!feeBps || feeBps <= 0) return 0;
  return Math.ceil((subtotalUnits * feeBps) / 10000);
}

export function computeTotalWithFee(subtotalUnits, feeBps = 0) {
  const feeUnits = computePlatformFeeUnits(subtotalUnits, feeBps);
  return {
    subtotalUnits,
    feeUnits,
    totalUnits: subtotalUnits + feeUnits
  };
}

export function hasSufficientFunds(balanceUnits, subtotalUnits, feeBps = 0) {
  const { totalUnits } = computeTotalWithFee(subtotalUnits, feeBps);
  return balanceUnits >= totalUnits;
}
