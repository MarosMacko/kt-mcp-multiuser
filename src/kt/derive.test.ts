import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dayCompleteness, likelyDuplicates, mapLimit, parseAmount, parseMinutes, parseStatisticSummary, searchFallbacks } from './derive.js';

test('parses the diary amount strings seen on the site', () => {
  // Live shapes from 23.11.2026.
  assert.deepEqual(parseAmount('porce (30 g)'), { count: 1, unit: 'porce (30 g)', grams: 30, ml: null });
  assert.deepEqual(parseAmount('150 x 1 ml'), { count: 150, unit: '1 ml', grams: null, ml: 150 });
  assert.deepEqual(parseAmount('50 x 1 g'), { count: 50, unit: '1 g', grams: 50, ml: null });
  assert.deepEqual(parseAmount('porce'), { count: 1, unit: 'porce', grams: null, ml: null });
});

test('multiplies portions with decimal commas and larger units', () => {
  assert.deepEqual(parseAmount('2 x kus (55 g)'), { count: 2, unit: 'kus (55 g)', grams: 110, ml: null });
  assert.deepEqual(parseAmount('1,5 x sklenice (250 ml)'), { count: 1.5, unit: 'sklenice (250 ml)', grams: null, ml: 375 });
  assert.deepEqual(parseAmount('0,5 x porce'), { count: 0.5, unit: 'porce', grams: null, ml: null });
  assert.deepEqual(parseAmount('balení (1 kg)'), { count: 1, unit: 'balení (1 kg)', grams: 1000, ml: null });
  assert.equal(parseAmount(''), null);
});

test('search fallbacks drop numbers and units, then trailing words', () => {
  // "skyr natur 42 g bílkovin" found nothing on the site, "skyr natur" plenty.
  assert.deepEqual(searchFallbacks('skyr natur 42 g bílkovin'), [
    'skyr natur 42 g bílkovin',
    'skyr natur bílkovin',
    'skyr natur',
    'skyr',
  ]);
  assert.deepEqual(searchFallbacks('mléko 1,5%'), ['mléko 1,5%', 'mléko']);
  assert.deepEqual(searchFallbacks('vejce'), ['vejce']);
  assert.deepEqual(searchFallbacks('8594003840117'), ['8594003840117']);
});

test('reads activity durations, and none for step imports', () => {
  assert.equal(parseMinutes('65 min'), 65);
  assert.equal(parseMinutes('1 h 5 min'), 65);
  assert.equal(parseMinutes('1,5 h'), 90);
  assert.equal(parseMinutes(''), null);
});

test('flags an activity of similar length as a likely duplicate', () => {
  const day = [
    { title: 'Garmin aktivita (Silový trénink)', duration: '65 min' },
    { title: 'Garmin aktivita (Kroky)', duration: '' },
  ];
  assert.equal(likelyDuplicates(day, 60).length, 1);
  assert.equal(likelyDuplicates(day, 70).length, 1);
  assert.equal(likelyDuplicates(day, 30).length, 0);
});

test('normalises the statistics summary to numbers', () => {
  // Live shape from 23.11.2026, trimmed.
  const s = parseStatisticSummary({
    todayEnergy: '1 056', todayEnergyTarget: '2 500', energyUnit: 'kcal', todayDrink: '0,1', todayDrinkTarget: '3,3',
    todayActivity: '473', basal: '1 921', amr: '1.55', amrEnergy: '579', bmi: '24,8', bmiCategory: 'norma',
    weight: '82', weightTarget: '80', weekEnergy: [],
  });
  assert.equal(s.eaten, 1056);
  assert.equal(s.goal, 2500);
  assert.equal(s.burnedByActivities, 473);
  assert.equal(s.drinkLitres, 0.1);
  assert.equal(s.basal, 1921);
  assert.equal(s.activityFactor, 1.55);
  assert.equal(s.activityFactorEnergy, 579);
  assert.equal(s.bmi, 24.8);
  assert.equal(s.weightGoalKg, 80);
});

test('tells logged, partial and empty days apart', () => {
  assert.deepEqual(dayCompleteness(0, 2500, []), { logged: false, partial: false, reasons: [] });
  assert.deepEqual(dayCompleteness(2300, 2500, ['1', '3', '5']), { logged: true, partial: false, reasons: [] });
  assert.equal(dayCompleteness(2300, 2500, ['3', '5']).partial, false);
  const half = dayCompleteness(900, 2500, ['1', '2']);
  assert.equal(half.partial, true);
  assert.deepEqual(half.reasons, ['under half of the energy goal', 'no lunch or dinner logged']);
});

test('mapLimit keeps order and caps concurrency', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 3, 2, 4], 2, async n => {
    running++;
    peak = Math.max(peak, running);
    await new Promise(r => setTimeout(r, n));
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20, 40]);
  assert.equal(peak, 2);
});
