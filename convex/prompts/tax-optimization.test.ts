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
    expect(TAX_OPTIMIZATION_SKILL_VERSION).toBe(1);
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

  it('separates what the analytics answers from what it does not', () => {
    // The analytics reports IRMAA (the surcharge is a liability line) and cannot report ACA. A
    // prompt that lumped them together would make the agent refuse a cliff it has and quote one it
    // does not.
    expect(markdown).toContain('**IRMAA is modelled**');
    expect(markdown).toContain('**ACA premium credits are not modelled**');
    expect(markdown).toContain('never report an ACA number');
    // A conversion still cannot be run; only its next dollar can be priced.
    expect(markdown).toContain('**Roth conversions are not modelled as a transaction.**');
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

  it('keeps the lever inside the stance', () => {
    expect(markdown).toContain('**Report capacity, not a choice.**');
    expect(markdown).toContain('and you never say');
    expect(markdown).toContain('which size you would choose');
  });

  it('promises only the tools that exist', () => {
    // The conversion-schedule lever is deferred until P3-P5 is wired; naming it here would send the
    // agent looking for a tool it cannot call.
    expect(markdown).not.toContain('getConversionSchedule');
    expect(markdown).not.toContain('conversion schedule');
  });
});
