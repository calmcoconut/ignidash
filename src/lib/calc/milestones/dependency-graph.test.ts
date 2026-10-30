import { describe, expect, it } from 'vitest';

import { findMilestoneCycles, formatMilestoneCycle } from './index';
import type { MilestoneCycle, MilestoneDependency } from './index';

/**
 * P1-P7: milestone reference cycles.
 *
 * The row requires a plan containing a cycle to be rejected, and the rejection to be actionable:
 * every case below asserts the **loop of names**, not just that a cycle was found. A cycle is
 * reported closed — the first name repeats at the end — because the closing edge is exactly the
 * one the user has to cut.
 */

const node = (id: string, references: readonly string[], name = id): MilestoneDependency => ({ id, name, references });

describe('an acyclic plan', () => {
  it('reports nothing for an empty plan', () => {
    expect(findMilestoneCycles([])).toEqual([]);
  });

  it('reports nothing for milestones with no references', () => {
    expect(findMilestoneCycles([node('a', []), node('b', [])])).toEqual([]);
  });

  it('accepts a chain', () => {
    // c depends on b depends on a: a valid order exists (a, then b, then c).
    expect(findMilestoneCycles([node('c', ['b']), node('b', ['a']), node('a', [])])).toEqual([]);
  });

  it('accepts a diamond, where one milestone is reached by two paths', () => {
    // d ← b ← a, d ← c ← a. Two paths to d is not a loop.
    expect(findMilestoneCycles([node('d', ['b', 'c']), node('b', ['a']), node('c', ['a']), node('a', [])])).toEqual([]);
  });

  it('accepts a reference to an id the plan does not contain', () => {
    // A dangling reference has no outgoing edges, so it can close no loop. Rejecting it is the
    // plan-level superRefine's job, not the graph's.
    expect(findMilestoneCycles([node('a', ['missing'])])).toEqual([]);
  });
});

describe('a plan with a cycle', () => {
  it('reports a two-milestone loop as the closed path', () => {
    const milestones = [node('pay-off', ['sell-rental'], 'Pay off mortgage'), node('sell-rental', ['pay-off'], 'Sell the rental')];
    const cycles = findMilestoneCycles(milestones);

    expect(cycles).toHaveLength(1);
    expect(cycles[0].path).toEqual(['Pay off mortgage', 'Sell the rental', 'Pay off mortgage']);
    expect(cycles[0].ids).toEqual(['pay-off', 'sell-rental', 'pay-off']);
  });

  it('reports a three-milestone loop and leaves the leading tail out of the path', () => {
    // tail → a → b → c → a. Only a, b and c are in the loop; `tail` merely reaches it.
    const milestones = [node('tail', ['a']), node('a', ['b']), node('b', ['c']), node('c', ['a'])];
    const cycles = findMilestoneCycles(milestones);

    expect(cycles).toHaveLength(1);
    expect(cycles[0].path).toEqual(['a', 'b', 'c', 'a']);
  });

  it('reports the loop the DFS closes, not the order the plan lists its milestones in', () => {
    // b is declared first, so the walk enters the loop at b and closes on b.
    const cycles = findMilestoneCycles([node('b', ['c']), node('a', ['b']), node('c', ['a'])]);

    expect(cycles).toHaveLength(1);
    expect(cycles[0].path).toEqual(['b', 'c', 'a', 'b']);
  });

  it('reports a self-reference as a loop of one', () => {
    const cycles = findMilestoneCycles([node('a', ['a'], 'Retire with $1M')]);

    expect(cycles).toHaveLength(1);
    expect(cycles[0].path).toEqual(['Retire with $1M', 'Retire with $1M']);
    expect(cycles[0].ids).toEqual(['a', 'a']);
  });

  it('reports two disjoint loops separately', () => {
    const milestones = [node('a', ['b']), node('b', ['a']), node('c', ['d']), node('d', ['c'])];
    const cycles = findMilestoneCycles(milestones);

    expect(cycles.map((cycle) => cycle.path)).toEqual([
      ['a', 'b', 'a'],
      ['c', 'd', 'c'],
    ]);
  });

  it('reports both loops when they share a milestone', () => {
    // a → b → a, and b → c → b. One shared node, two loops, one edge each to remove.
    const milestones = [node('a', ['b']), node('b', ['a', 'c']), node('c', ['b'])];

    expect(findMilestoneCycles(milestones).map((cycle) => cycle.path)).toEqual([
      ['a', 'b', 'a'],
      ['b', 'c', 'b'],
    ]);
  });

  it('keeps the ids and names parallel, so a caller can select the milestones', () => {
    const cycles = findMilestoneCycles([node('a', ['b'], 'Alpha'), node('b', ['a'], 'Beta')]);
    const [cycle] = cycles;

    expect(cycle.ids).toHaveLength(cycle.path.length);
    expect(cycle.ids).toEqual(['a', 'b', 'a']);
    expect(cycle.path).toEqual(['Alpha', 'Beta', 'Alpha']);
  });
});

describe('determinism and purity', () => {
  it('reports the same cycles in the same order on every call', () => {
    const milestones = [node('a', ['b']), node('b', ['a']), node('c', ['c'])];
    expect(findMilestoneCycles(milestones)).toEqual(findMilestoneCycles(milestones));
    // Declaration order decides: the a/b loop is reported before the self-reference.
    expect(findMilestoneCycles(milestones).map((cycle) => cycle.path)).toEqual([
      ['a', 'b', 'a'],
      ['c', 'c'],
    ]);
  });

  it('does not mutate the plan it was given', () => {
    const milestones = [node('a', ['b']), node('b', ['a'])];
    const before = JSON.parse(JSON.stringify(milestones));
    findMilestoneCycles(milestones);
    expect(JSON.parse(JSON.stringify(milestones))).toEqual(before);
  });

  it('resolves a duplicated id the same way however the walk reaches it', () => {
    // First declaration wins; the second `a` cannot invent a loop the first one does not have.
    const milestones = [node('a', []), node('a', ['a']), node('b', ['a'])];
    expect(findMilestoneCycles(milestones)).toEqual([]);
  });
});

describe('the message', () => {
  it('names the loop in the user`s own words, closing back on the first milestone', () => {
    const cycle: MilestoneCycle = findMilestoneCycles([
      node('pay-off', ['sell-rental'], 'Pay off mortgage'),
      node('sell-rental', ['pay-off'], 'Sell the rental'),
    ])[0];

    expect(formatMilestoneCycle(cycle)).toBe('Pay off mortgage → Sell the rental → Pay off mortgage');
  });

  it('reads as a loop for a self-reference too', () => {
    const cycle = findMilestoneCycles([node('a', ['a'], 'Buy the boat')])[0];
    expect(formatMilestoneCycle(cycle)).toBe('Buy the boat → Buy the boat');
  });
});
