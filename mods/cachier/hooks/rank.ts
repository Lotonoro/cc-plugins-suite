// The nearest-rank percentile, the one the mod takes. A leaf: it imports nothing, so a module that only ranks values pulls in none of another's imports.

// The `p`th percentile (a whole number, 1 to 100): the ceil(p·n/100)-th smallest of the n values, worked out in integers as floor((p·n + 99) / 100) so no
// float rounds the rank. No values give 0.
export const percentileOf = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.floor((p * sorted.length + 99) / 100)
  return sorted[rank - 1] ?? 0
}
