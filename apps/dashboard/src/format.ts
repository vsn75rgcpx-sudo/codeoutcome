export function formatToken(value: string | null, available = true): string {
  if (!available || value === null) return "unavailable";
  const number = BigInt(value);
  const units = [
    { threshold: 1_000_000_000_000n, suffix: "T" },
    { threshold: 1_000_000_000n, suffix: "B" },
    { threshold: 1_000_000n, suffix: "M" },
    { threshold: 1_000n, suffix: "K" },
  ];
  const unit = units.find((candidate) => number >= candidate.threshold);
  if (unit === undefined) return number.toLocaleString();
  const tenths = (number * 10n) / unit.threshold;
  return `${tenths / 10n}.${tenths % 10n}${unit.suffix}`;
}

export function formatInteger(value: number | null): string {
  return value === null ? "unavailable" : value.toLocaleString();
}

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "unavailable";
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

export function formatDate(value: string | null): string {
  if (value === null) return "unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unavailable" : date.toLocaleString();
}

export function shortId(value: string | null): string {
  return value === null ? "unavailable" : value.slice(0, 10);
}
