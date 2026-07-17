export const UNAVAILABLE = "Unavailable";

export function parseOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatSignedPercent(value: unknown, decimals = 1): string {
  const parsed = parseOptionalNumber(value);
  if (parsed === null) return UNAVAILABLE;
  const prefix = parsed > 0 ? "+" : "";
  return `${prefix}${parsed.toFixed(decimals)}%`;
}

type SignalMovement = {
  signal?: number | null;
  percentage24?: string | number | null;
};

export function selectTopBuyMovers<T extends SignalMovement>(signals: T[], limit: number): T[] {
  return [...signals]
    .filter((signal) => signal.signal === 1 && parseOptionalNumber(signal.percentage24) !== null)
    .sort(
      (left, right) =>
        (parseOptionalNumber(right.percentage24) ?? Number.NEGATIVE_INFINITY) -
        (parseOptionalNumber(left.percentage24) ?? Number.NEGATIVE_INFINITY),
    )
    .slice(0, limit);
}

export const SCORING_PRESENTATION = {
  maxScore: 80,
  sections: [
    {
      label: "Indicator and timeframe",
      points: 40,
      description: "Timeframe contributes up to 20 points and indicator type contributes up to 20 points.",
    },
    {
      label: "Confluence",
      points: 25,
      description: "Two agreeing indicators earn 12 points, three earn 18, four earn 22, and five or more earn 25.",
    },
    {
      label: "24h momentum at entry",
      points: 15,
      description: "Entry-time momentum contributes 0 to 15 points; it is a scoring input, not a trade outcome.",
    },
  ],
  tiers: [
    { tier: "A", minimum: 55 },
    { tier: "B", minimum: 40 },
    { tier: "C", minimum: 0 },
  ],
} as const;
