/**
 * The tax-optimization skill prompt (§7-A2).
 *
 * `tax-optimization.md` is the reviewed artifact; `tax-optimization.ts` is the copy Convex
 * bundles. This test byte-compares them, so editing one without the other fails the suite. The
 * rest of the file pins what the prompt must keep saying: the marker on the first line, every hard
 * rule, and the stance (rank the engine's variants by the user's goal, never recommend one).
 *
 * Run Prettier on the .md before regenerating the mirror: `proseWrap` is `preserve`, but a
 * changed `printWidth` or an explicit `--prose-wrap always` would rewrap the prose and move every
 * byte in the mirror with it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TAX_OPTIMIZATION_SKILL_MARKER, TAX_OPTIMIZATION_SKILL_PROMPT, TAX_OPTIMIZATION_SKILL_VERSION } from './tax-optimization';

const mdPath = fileURLToPath(new URL('./tax-optimization.md', import.meta.url));
const markdown = readFileSync(mdPath, 'utf8');

describe('tax-optimization prompt: markdown and TypeScript mirror', () => {
  it('are byte-identical', () => {
    expect(TAX_OPTIMIZATION_SKILL_PROMPT).toBe(markdown);
  });

  it('starts with the stable marker as the first line', () => {
    expect(markdown.split('\n')[0]).toBe(TAX_OPTIMIZATION_SKILL_MARKER);
    expect(TAX_OPTIMIZATION_SKILL_PROMPT.startsWith(TAX_OPTIMIZATION_SKILL_MARKER)).toBe(true);
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('is versioned', () => {
    expect(TAX_OPTIMIZATION_SKILL_VERSION).toBe(2);
    expect(markdown).toContain(`# Tax-optimization skill (v${TAX_OPTIMIZATION_SKILL_VERSION})`);
  });
});

describe('tax-optimization prompt: hard rules', () => {
  // One distinctive phrase per numbered rule in "## Hard rules".
  const rules = [
    '**No number without a tool result.**',
    '**Deterministic mode, one fixed seed.**',
    '**Budget: at most 6 variants and at most 12 tool calls per turn.**',
    '**Monte Carlo only on request.**',
    '**A refused patch is a refusal, not a puzzle.**',
    '**Nothing is written.**',
    '**State assumptions and limits.**',
    '**A plan that cannot be simulated is an answer too.**',
  ];

  it('keeps all eight', () => {
    expect(markdown).toContain('## Hard rules');
    for (const rule of rules) expect(markdown).toContain(rule);

    // Eight numbered rules, no more and no fewer.
    const hardRules = markdown.slice(markdown.indexOf('## Hard rules'), markdown.indexOf('## Stance'));
    const numbered = hardRules.split('\n').filter((line) => /^\d+\. \*\*/.test(line));
    expect(numbered).toHaveLength(rules.length);
  });
});

describe('tax-optimization prompt: stance (F1, rank never recommend)', () => {
  it('keeps the stance heading and the two stance lines', () => {
    expect(markdown).toContain('## Stance: rank, never recommend');
    expect(markdown).toContain('The user picks the goal; you show what the engine computed and what each variant costs.');
    expect(markdown).toContain('If the user asks you to choose, say the engine cannot rank beyond the goal they set, restate the');
  });

  it('keeps the goal in the user’s hands and forbids picking a variant', () => {
    expect(markdown).toContain('The user ranks variants by one goal they choose');
    expect(markdown).toContain('Never say which variant you would pick.');
    expect(markdown).toContain('Never call one "best", "optimal", "right" or "what you');
  });

  it('never recommends', () => {
    expect(markdown).not.toContain('I recommend');
    expect(markdown).not.toContain('you should choose');
  });
});

describe('tax-optimization prompt: what the engine does not model', () => {
  it('names the gaps the eval set deliberately leaves out', () => {
    expect(markdown).toContain('- **Federal income tax.**');
  });

  it('reports the California return the engine computes, and names what it still omits', () => {
    // P3-P8 shipped: the state return is settled, so the limit is the list of questions it does not
    // answer — not "no state figure exists".
    expect(markdown).toContain('jurisdictions.california.reported');
    expect(markdown).toContain('jurisdictions.california.notModelled');
    expect(markdown).toContain('`none` the plan is not a resident');
    expect(markdown).not.toContain('do not report a California income tax figure');
    expect(markdown).not.toContain('pending (`jurisdictions.california`)');
  });

  it('offers every filing status the engine prices, the separate return included', () => {
    // MFS shipped with the couples work (P3-P1b). A prompt that still called it unavailable would
    // have the agent refuse a lever `simulateVariant` accepts.
    expect(markdown).toContain('single, married filing jointly, married filing separately, and head of');
    expect(markdown).toContain('priced as **two** returns, one per spouse');
    expect(markdown).toContain('"filingStatus":"marriedFilingSeparately"');
    expect(markdown).not.toContain('separately is not available');
    // What the separate return costs, stated correctly: the senior deduction is forfeited outright
    // (`SeniorDeductionTable.eligible.marriedFilingSeparately` is false, and the engine returns zero
    // before it reads any age), while only the early-withdrawal gate falls back to the primary's age.
    expect(markdown).toContain('the early-withdrawal gate');
    expect(markdown).toContain('cannot claim the senior deduction at all');
    expect(markdown).not.toContain('senior-deduction gates use the primary');
  });

  it('stops calling itemized deductions and the SALT cap unmodelled', () => {
    // P3-P3 shipped: the engine takes the larger of the standard deduction and the itemized total,
    // applying the §164 cap and the §213 floor. What remains unmodelled is the *marginal* effect, and
    // the prompt has to say which — otherwise the agent refuses a deduction the plan can enter.
    expect(markdown).not.toContain('**Itemized deductions and the SALT cap are not modelled.**');
    expect(markdown).not.toContain('The standard deduction applies');
    expect(markdown).toContain('**Itemized deductions and the SALT cap are modelled; the marginal effect of one is not.**');
    expect(markdown).toContain('with the §164 SALT cap and its phase-down');
    expect(markdown).toContain('priced against a fixed deduction');
  });

  it('separates what the analytics answers from what it does not', () => {
    // The analytics reports IRMAA (the surcharge is a liability line), and it reports the ACA premium
    // tax credit too: an opted-in plan's settled return carries the refundable §36B credit and
    // `cliffs.aca.credit` is that figure. A prompt that still lumped them together would make the
    // agent refuse a credit the tool returns and offer a prerequisite list it has already been given.
    // Assertions are flattened, so a rewrap of the prose cannot pass this test on a changed claim.
    const flat = markdown.replace(/\s+/g, ' ');

    expect(markdown).toContain('**IRMAA is modelled**');
    expect(flat).toContain('**The ACA premium tax credit is modelled, for a plan that opts in.**');
    expect(flat).toContain('`taxSettings.aca.optIn` with a stated SLCSP premium');
    expect(flat).toContain('Quote `cliffs.aca.credit`');
    // Refundable, so it is a refund and not a liability line — the one fact that decides which tool
    // result a reported ACA figure can come from.
    expect(flat).toContain('it does **not** appear in `lifetimeTaxes` or `perYearTaxes`');
    // Not opted in: prerequisites, described as that plan's missing inputs rather than an absence.
    expect(flat).toContain('`supported` is `false` and `prerequisites` names the inputs the credit would need');
    expect(flat).toContain('rather than that the credit is unmodelled');
    // The rule the agent must keep: the number comes from a tool result, never from the model.
    expect(flat).toContain('never state an ACA number no tool result carries');
    // Provenance and the suspended ceiling. `resolvedYear` names the vendored table that actually
    // priced the credit — a return past the last vendored year is priced from the nearest prior row —
    // and `cliffThreshold` is `null`, not 400 % of the FPL, where §36B(i) suspends the cliff (the 2024
    // and 2025 rows). A prompt that stated a flat 400 % would have the model invent a cliff for those
    // years, and one silent on `resolvedYear` would let it quote 2027 law as a 2029 return's own.
    expect(flat).toContain('`resolvedYear` is the vendored coverage year whose table priced the credit');
    expect(flat).toContain('priced from the nearest prior row');
    expect(flat).toContain("say which year's law priced it rather than implying current-year law");
    expect(flat).toContain('`cliffThreshold` is 400 % of the poverty line where that ceiling applies');
    expect(flat).toContain('§36B(i) suspends the 400 % cliff');
    expect(flat).toContain('no cliff at all, not a cliff at zero');
    // The old flat claim, gone: it named a 400 % threshold the ARPA coverage years do not have.
    expect(flat).not.toContain('the `cliffThreshold` (400 % of the poverty line)');
    // The old claim, gone — it said no ACA figure could exist at all.
    expect(flat).not.toContain('ACA premium credits are not modelled');
    expect(flat).not.toContain('never report an ACA number');
    expect(flat).not.toContain('ACA cliff comes back as not evaluated');
    // Roth conversions and ladders are modelled as transactions with five-year clocks and IRMAA lookahead.
    expect(markdown).toContain('**Roth conversions and the Roth ladder are modelled as transactions.**');
    expect(markdown).toContain('Five-year clocks');
    expect(markdown).toContain('cliffs.irmaa.projected');
    expect(markdown).toContain('marginalRates.rothConversion');
  });
});

describe('tax-optimization prompt: the analytics lever (§7-A3)', () => {
  it('documents the analytics tool and the three things to read in it', () => {
    expect(markdown).toContain('## Reading the tax analytics');
    expect(markdown).toContain('`getTaxAnalytics(year)`');
    expect(markdown).toContain('**Bracket headroom.**');
    expect(markdown).toContain('**The next dollar.**');
    expect(markdown).toContain('**The cliffs.**');
    // Headroom is a taxable figure, not a gross withdrawal: grossing it up is the arithmetic the
    // hard rules forbid.
    expect(markdown).toContain('These are **taxable** amounts, not');
  });

  it('points at the tool field that states the senior-deduction forfeiture', () => {
    // The forfeiture has to be quotable from a tool result, not inferred from a smaller total: the
    // analytics reports the ruleset's `available` flag, the `claimed` amount and the rule in
    // `deniedBy`, and the prompt names exactly those.
    expect(markdown).toContain('**The deduction.**');
    expect(markdown).toContain('`deductions.seniorDeduction`');
    expect(markdown).toContain('`deniedBy`');
    expect(markdown).toContain('never infer a');
    expect(markdown).not.toContain('deductions are not modelled');
  });

  it('keeps the lever inside the stance', () => {
    expect(markdown).toContain('**Report capacity, not a choice.**');
    expect(markdown).toContain('and you never say');
    expect(markdown).toContain('which size you would choose');
  });

  it('promises only the tools that exist', () => {
    // getConversionSchedule is not a tool; conversions are patched through planPatch.
    expect(markdown).not.toContain('getConversionSchedule');
  });
});
