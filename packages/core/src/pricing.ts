export interface ModelPrice {
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface PricingCatalog {
  version: string;
  updatedAt: string;
  source: string;
  currency: "USD";
  models: Readonly<Record<string, ModelPrice>>;
}

export const DEFAULT_PRICING_CATALOG: PricingCatalog = {
  version: "local-unpriced-v1",
  updatedAt: "2026-07-20T00:00:00.000Z",
  source:
    "Bundled local configuration; no model rates are enabled until maintainers verify a versioned source.",
  currency: "USD",
  models: {},
};

export function estimateUsageCost(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  },
  catalog: PricingCatalog = DEFAULT_PRICING_CATALOG,
): number | null {
  const price = catalog.models[model.toLowerCase()];
  if (price === undefined) {
    return null;
  }
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const uncached = Math.max(0, usage.inputTokens - cached);
  return (
    (uncached / 1_000_000) * price.inputPerMillionUsd +
    (cached / 1_000_000) * price.cachedInputPerMillionUsd +
    (usage.outputTokens / 1_000_000) * price.outputPerMillionUsd
  );
}
