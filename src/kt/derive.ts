/**
 * Pure helpers that turn the site's display data into numbers and decisions.
 * Kept apart from the HTTP client so each rule can be unit-tested against the
 * shapes the site actually sends.
 */

import { parseCzechNumber } from './client.js';

/** A diary amount, parsed from the display string the site sends. */
export interface Quantity {
  /** Multiple of `unit`, e.g. 150 for "150 x 1 ml", 1 for "porce (30 g)". */
  count: number;
  /** The unit's title as the site shows it, e.g. "porce (30 g)" or "1 ml". */
  unit: string;
  /** Total grams, when the unit states its weight; otherwise null. */
  grams: number | null;
  /** Total millilitres, when the unit states its volume; otherwise null. */
  ml: number | null;
}

const UNIT_SCALE: Record<string, { kind: 'grams' | 'ml'; factor: number }> = {
  g: { kind: 'grams', factor: 1 },
  kg: { kind: 'grams', factor: 1000 },
  ml: { kind: 'ml', factor: 1 },
  l: { kind: 'ml', factor: 1000 },
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Parses the diary's amount strings: "porce (30 g)", "150 x 1 ml",
 * "2 x kus (55 g)", "1,5 x porce", "porce". Returns null for an empty string.
 */
export function parseAmount(display: string): Quantity | null {
  const text = display.trim();
  if (text === '') return null;
  const multiplied = /^([\d\s  ,.]+?)\s*x\s+(.+)$/i.exec(text);
  const count = multiplied ? parseCzechNumber(multiplied[1]) : 1;
  const unit = (multiplied ? multiplied[2] : text) as string;
  if (count === null) return null;

  // The unit's own size: "(30 g)" inside a portion name, or the bare "1 ml" / "g".
  const size = /\(([\d\s  ,.]+)\s*(g|kg|ml|l)\)/i.exec(unit) ?? /^([\d\s  ,.]*)\s*(g|kg|ml|l)$/i.exec(unit);
  let grams: number | null = null;
  let ml: number | null = null;
  if (size) {
    const per = size[1]?.trim() ? parseCzechNumber(size[1]) : 1;
    const scale = UNIT_SCALE[(size[2] as string).toLowerCase()];
    if (per !== null && scale) {
      const total = round1(count * per * scale.factor);
      if (scale.kind === 'grams') grams = total;
      else ml = total;
    }
  }
  return { count, unit, grams, ml };
}

const NOISE_TOKEN = /^(?:\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l|%|kcal|kj)?|g|kg|ml|l|%|kcal|kj|x)$/i;

/**
 * The site's autocomplete matches whole phrases, so "skyr natur 42 g bílkovin"
 * finds nothing while "skyr natur" finds plenty. Returns the queries to try in
 * order: as given, without numbers and units, then dropping words from the end.
 */
export function searchFallbacks(query: string): string[] {
  const original = query.trim();
  if (/^\d{8,14}$/.test(original)) return [original];
  const words = original.split(/\s+/).filter(w => !NOISE_TOKEN.test(w));
  const out = [original];
  for (let n = words.length; n >= 1; n--) out.push(words.slice(0, n).join(' '));
  return [...new Set(out.filter(q => q.length >= 2))];
}

/** "65 min", "1 h 5 min", "1,5 h" → minutes; null when there is no duration (e.g. steps). */
export function parseMinutes(display: string): number | null {
  const hours = /([\d,.]+)\s*h\b/i.exec(display);
  const minutes = /([\d,.]+)\s*min/i.exec(display);
  if (!hours && !minutes) return null;
  return Math.round((hours ? (parseCzechNumber(hours[1]) ?? 0) * 60 : 0) + (minutes ? (parseCzechNumber(minutes[1]) ?? 0) : 0));
}

/**
 * Activities already in the diary that look like the one about to be logged:
 * a duration within ±20 %. Garmin and other watch imports land in the diary on
 * their own, so logging the same workout from another app counts it twice.
 */
export function likelyDuplicates<T extends { duration: string }>(existing: T[], minutes: number, tolerance = 0.2): T[] {
  return existing.filter(a => {
    const d = parseMinutes(a.duration);
    return d !== null && d > 0 && Math.abs(d - minutes) <= tolerance * Math.max(d, minutes);
  });
}

/** The site's statistics summary with its display strings turned into numbers. */
export interface StatisticSummary {
  energyUnit: string;
  eaten: number | null;
  goal: number | null;
  burnedByActivities: number | null;
  drinkLitres: number | null;
  drinkGoalLitres: number | null;
  /** Basal metabolic rate, kcal/day. */
  basal: number | null;
  /** Activity multiplier the site applies to the basal rate (e.g. 1.55). */
  activityFactor: number | null;
  /** Energy the activity factor adds on top of the basal rate. */
  activityFactorEnergy: number | null;
  bmi: number | null;
  bmiCategory: string | null;
  weightKg: number | null;
  weightGoalKg: number | null;
}

export function parseStatisticSummary(data: unknown): StatisticSummary {
  const s = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof s[key] === 'string' && s[key] !== '' ? (s[key] as string) : null);
  // amr comes with a decimal point ("1.55"), everything else with a comma.
  const num = (key: string) => parseCzechNumber(s[key]);
  return {
    energyUnit: text('energyUnit') ?? 'kcal',
    eaten: num('todayEnergy'),
    goal: num('todayEnergyTarget'),
    burnedByActivities: num('todayActivity'),
    drinkLitres: num('todayDrink'),
    drinkGoalLitres: num('todayDrinkTarget'),
    basal: num('basal'),
    activityFactor: typeof s['amr'] === 'string' ? (Number(s['amr'].replace(',', '.')) || null) : num('amr'),
    activityFactorEnergy: num('amrEnergy'),
    bmi: num('bmi'),
    bmiCategory: text('bmiCategory'),
    weightKg: num('weight'),
    weightGoalKg: num('weightTarget') || null,
  };
}

/** Main meals (breakfast, lunch, dinner) by diary slot id. */
const MAIN_MEALS = { '1': 'breakfast', '3': 'lunch', '5': 'dinner' } as const;

/**
 * Whether a day looks fully logged. A day with food but under half the energy
 * goal, or with two of the three main meals missing, is most likely a day the
 * user stopped logging, and would drag averages down if counted as eaten.
 */
export function dayCompleteness(energy: number | null, goal: number | null, mealsLogged: string[]): {
  logged: boolean;
  partial: boolean;
  reasons: string[];
} {
  const logged = (energy ?? 0) > 0 || mealsLogged.length > 0;
  if (!logged) return { logged, partial: false, reasons: [] };
  const reasons: string[] = [];
  if (goal && (energy ?? 0) < goal / 2) reasons.push('under half of the energy goal');
  const missing = Object.entries(MAIN_MEALS).filter(([id]) => !mealsLogged.includes(id)).map(([, name]) => name);
  if (missing.length >= 2) reasons.push(`no ${missing.join(' or ')} logged`);
  return { logged, partial: reasons.length > 0, reasons };
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
