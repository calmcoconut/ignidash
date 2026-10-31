'use client';

import { ConvexError } from 'convex/values';
import { useMutation } from 'convex/react';
import { useState } from 'react';
import { TargetIcon, PlusIcon, TrashIcon } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

import { api } from '@/convex/_generated/api';
import { DialogTitle, DialogBody, DialogActions } from '@/components/catalyst/dialog';
import { Fieldset, FieldGroup, Field, Label, ErrorMessage, Description } from '@/components/catalyst/fieldset';
import { Divider } from '@/components/catalyst/divider';
import ErrorMessageCard from '@/components/ui/error-message-card';
import { Button } from '@/components/catalyst/button';
import { Input } from '@/components/catalyst/input';
import { Select } from '@/components/catalyst/select';
import { useSelectedPlanId } from '@/hooks/use-selected-plan-id';
import { milestonesToConvex } from '@/lib/utils/data-transformers';
import { MILESTONE_METRIC_OPTIONS, milestonesSchema, type MilestoneInputs } from '@/lib/schemas/inputs/milestone-form-schema';
import { MILESTONE_METRIC_UNITS, MILESTONE_OPERATORS, type MilestoneExpression, type MilestoneLeaf } from '@/lib/calc/milestones';
import type { AccountInputs } from '@/lib/schemas/inputs/account-form-schema';

interface MilestonesDialogProps {
  onClose: () => void;
  milestones: MilestoneInputs[];
  accounts: AccountInputs[];
}

/** What a metric is called on screen. The units come from the evaluator's own record. */
const METRIC_LABELS: Record<(typeof MILESTONE_METRIC_OPTIONS)[number], string> = {
  age: 'Age',
  year: 'Calendar year',
  portfolio: 'Portfolio',
  account: 'Account balance',
  income: 'Income',
  expense: 'Expenses',
  netWorth: 'Net worth',
};

const isLeaf = (expression: MilestoneExpression): expression is MilestoneLeaf => 'metric' in expression;

/** The one group shape this editor writes: an operator and a flat list of children. */
interface EditableGroup {
  op: 'and' | 'or';
  children: MilestoneExpression[];
}

/**
 * A condition as one editable group.
 *
 * A milestone is stored as the evaluator's own `MilestoneExpression`, which may be a bare
 * comparison or a group. The editor writes the group form (one `and`/`or` over comparisons) because
 * that is what a form can express; a bare comparison from an imported file is wrapped in a group of
 * one, which means exactly the same thing, and a nested group is kept untouched and shown read-only
 * rather than flattened and lost.
 */
const asEditableGroup = (condition: MilestoneExpression): EditableGroup =>
  isLeaf(condition) ? { op: 'and', children: [condition] } : { op: condition.op, children: [...condition.children] };

const defaultChild = (accounts: AccountInputs[]): MilestoneLeaf =>
  accounts.length > 0
    ? { metric: 'account', accountId: accounts[0].id, operator: '>=', value: 0 }
    : { metric: 'netWorth', operator: '>=', value: 0 };

/**
 * Plan milestones: add, edit and remove the conditions the engine latches (P1-P7).
 *
 * One dialog over the whole list, saved in one mutation, exactly like the glide path: the plan owns
 * one `milestones` array and the editor owns the list.
 *
 * A milestone carries **no target date**. When it is reached is the simulation's answer — the latch
 * stamps the month start at which the condition first held — so the only time-like values a user
 * writes here are the *thresholds* themselves (`age ≥ 65`, `calendar year ≥ 2035`), which are the
 * time points of the plan. A milestone with no conditions is never reached; that is deliberate, so
 * the hint under an empty group says so instead of the milestone quietly "arriving" in month one.
 */
export default function MilestonesDialog({ onClose, milestones, accounts }: MilestonesDialogProps) {
  const planId = useSelectedPlanId();

  // The editor's working copy: saved whole, so removing a milestone is just removing a row.
  const [draft, setDraft] = useState<MilestoneInputs[]>(() =>
    structuredClone(
      milestones.map((milestone) => ({
        ...milestone,
        condition: asEditableGroup(milestone.condition),
        references: [...milestone.references],
      }))
    )
  );

  const updateMilestones = useMutation(api.milestones.update);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const patch = (index: number, change: Partial<MilestoneInputs>) =>
    setDraft((current) => current.map((milestone, position) => (position === index ? { ...milestone, ...change } : milestone)));

  const patchGroup = (index: number, change: Partial<EditableGroup>) =>
    setDraft((current) =>
      current.map((milestone, position) =>
        position === index ? { ...milestone, condition: { ...asEditableGroup(milestone.condition), ...change } } : milestone
      )
    );

  const patchLeaf = (index: number, childIndex: number, change: Partial<MilestoneLeaf>) =>
    setDraft((current) =>
      current.map((milestone, position) => {
        if (position !== index) return milestone;
        const group = asEditableGroup(milestone.condition);
        const children = group.children.map((child, childPosition) => {
          if (childPosition !== childIndex || !isLeaf(child)) return child;
          // A metric change can drop or add `accountId`, so the patched child is rebuilt rather than
          // spread: a `{ ...child, metric: 'account' }` would keep no account id at all.
          const metric = (change.metric ?? child.metric) as MilestoneLeaf['metric'];
          const operator = change.operator ?? child.operator;
          const value = change.value ?? child.value;

          const patched: MilestoneLeaf =
            metric === 'account'
              ? {
                  metric,
                  accountId:
                    (change as { accountId?: string }).accountId ?? ('accountId' in child ? child.accountId : (accounts[0]?.id ?? '')),
                  operator,
                  value,
                }
              : { metric, operator, value };

          return patched;
        });

        return { ...milestone, condition: { ...group, children } };
      })
    );

  const addMilestone = () =>
    setDraft((current) => [
      ...current,
      {
        id: uuidv4(),
        name: '',
        condition: { op: 'and', children: [defaultChild(accounts)] },
        references: [],
      },
    ]);

  const removeMilestone = (index: number) =>
    setDraft((current) => {
      const removed = current[index];

      return current
        .filter((_, position) => position !== index)
        .map((milestone) => ({ ...milestone, references: milestone.references.filter((reference) => reference !== removed?.id) }));
    });

  const toggleReference = (index: number, referenceId: string) =>
    setDraft((current) =>
      current.map((milestone, position) => {
        if (position !== index) return milestone;
        const references = milestone.references.includes(referenceId)
          ? milestone.references.filter((reference) => reference !== referenceId)
          : [...milestone.references, referenceId];

        return { ...milestone, references };
      })
    );

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    // One parse over the whole list: the per-milestone shape *and* the reference rules (a dangling
    // id, a loop) that only the plan can see.
    const parsed = milestonesSchema.safeParse(draft);
    if (!parsed.success) {
      setSaveError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' · '));
      return;
    }

    try {
      setSaveError(null);
      setIsSubmitting(true);
      await updateMilestones({ planId, milestones: milestonesToConvex(parsed.data) });
      onClose();
    } catch (error) {
      setSaveError(error instanceof ConvexError ? error.message : 'Failed to save milestones.');
      console.error('Error saving milestones: ', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <DialogTitle onClose={onClose}>
        <div className="flex items-center gap-4">
          <TargetIcon className="text-primary size-8 shrink-0" aria-hidden="true" />
          <span>Milestones</span>
        </div>
      </DialogTitle>
      <form onSubmit={onSubmit}>
        <Fieldset aria-label="Plan milestones">
          <DialogBody>
            <FieldGroup>
              {saveError && <ErrorMessageCard errorMessage={saveError} />}
              <Description>
                A milestone is a condition over your plan — <em>net worth ≥ $1M</em>, <em>age ≥ 65</em>. The simulation reports the first
                month each one is reached and it stays reached, so the month it fires is the only date a milestone has.
              </Description>

              {draft.length === 0 && <Description>No milestones yet.</Description>}

              {draft.map((milestone, index) => {
                const group = asEditableGroup(milestone.condition);
                const others = draft.filter((_, position) => position !== index);

                return (
                  <div key={milestone.id} className="rounded-lg border border-stone-200 p-4 dark:border-stone-700">
                    <div className="flex items-start justify-between gap-4">
                      <Field className="flex-1">
                        <Label htmlFor={`milestone-name-${index}`}>Name</Label>
                        <Input
                          id={`milestone-name-${index}`}
                          value={milestone.name}
                          onChange={(event) => patch(index, { name: event.target.value })}
                        />
                      </Field>
                      <Button
                        plain
                        type="button"
                        onClick={() => removeMilestone(index)}
                        aria-label={`Remove ${milestone.name || 'milestone'}`}
                      >
                        <TrashIcon data-slot="icon" />
                      </Button>
                    </div>

                    <div className="mt-4 flex items-center gap-3">
                      <Label htmlFor={`milestone-op-${index}`} className="whitespace-nowrap">
                        Reached when
                      </Label>
                      <Select
                        id={`milestone-op-${index}`}
                        value={group.op}
                        onChange={(event) => patchGroup(index, { op: event.target.value === 'or' ? 'or' : 'and' })}
                        className="w-24"
                      >
                        <option value="and">all of</option>
                        <option value="or">any of</option>
                      </Select>
                      <span className="text-sm text-stone-500 dark:text-stone-400">these hold:</span>
                    </div>

                    <div className="mt-2 flex flex-col gap-2">
                      {group.children.map((child, childIndex) => {
                        if (!isLeaf(child)) {
                          return (
                            <Description key={`nested-${childIndex}`}>
                              A nested group is kept as written; this editor changes one level of conditions.
                            </Description>
                          );
                        }

                        return (
                          <div key={childIndex} className="flex flex-wrap items-end gap-2">
                            <Field className="min-w-32 flex-1">
                              <Label className="sr-only">Metric</Label>
                              <Select
                                value={child.metric}
                                onChange={(event) =>
                                  patchLeaf(index, childIndex, { metric: event.target.value as MilestoneLeaf['metric'] })
                                }
                              >
                                {MILESTONE_METRIC_OPTIONS.map((metric) => (
                                  <option key={metric} value={metric}>
                                    {METRIC_LABELS[metric]}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            {child.metric === 'account' && (
                              <Field className="min-w-32 flex-1">
                                <Label className="sr-only">Account</Label>
                                <Select
                                  value={child.accountId}
                                  onChange={(event) =>
                                    patchLeaf(index, childIndex, { accountId: event.target.value } as Partial<MilestoneLeaf>)
                                  }
                                >
                                  {accounts.map((account) => (
                                    <option key={account.id} value={account.id}>
                                      {account.name}
                                    </option>
                                  ))}
                                </Select>
                              </Field>
                            )}
                            <Field className="w-20">
                              <Label className="sr-only">Operator</Label>
                              <Select
                                value={child.operator}
                                onChange={(event) =>
                                  patchLeaf(index, childIndex, { operator: event.target.value as MilestoneLeaf['operator'] })
                                }
                              >
                                {MILESTONE_OPERATORS.map((operator) => (
                                  <option key={operator} value={operator}>
                                    {operator}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <Field className="w-32">
                              <Label className="sr-only">Threshold</Label>
                              <Input
                                type="number"
                                inputMode="decimal"
                                value={String(child.value)}
                                onChange={(event) =>
                                  patchLeaf(index, childIndex, { value: event.target.value === '' ? 0 : Number(event.target.value) })
                                }
                              />
                            </Field>
                            <Button
                              plain
                              type="button"
                              aria-label="Remove condition"
                              onClick={() =>
                                patchGroup(index, {
                                  children: group.children.filter((_, position) => position !== childIndex),
                                })
                              }
                            >
                              <TrashIcon data-slot="icon" />
                            </Button>
                          </div>
                        );
                      })}

                      {group.children.length === 0 && (
                        <Description>A milestone with no conditions is never reached — add one to make it answer.</Description>
                      )}
                      {group.children.length > 0 && (
                        <Description>
                          Thresholds are in{' '}
                          {MILESTONE_METRIC_UNITS[
                            (group.children.find(isLeaf)?.metric ?? 'netWorth') as keyof typeof MILESTONE_METRIC_UNITS
                          ] === 'currency'
                            ? 'today’s dollars'
                            : 'the metric’s own unit'}
                          . A $0 threshold is not “no threshold”.
                        </Description>
                      )}
                    </div>

                    <Button
                      outline
                      type="button"
                      className="mt-3"
                      onClick={() => patchGroup(index, { children: [...group.children, defaultChild(accounts)] })}
                    >
                      <PlusIcon data-slot="icon" />
                      Condition
                    </Button>

                    {others.length > 0 && (
                      <>
                        <Divider soft className="my-4" />
                        <Field>
                          <Label>Depends on</Label>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {others.map((other) =>
                              // Selected dependencies are filled; the rest are outlined. Catalyst's `Button`
                              // makes `plain`/`outline`/default three separate prop shapes, so the two
                              // states are two elements rather than one with a boolean.
                              milestone.references.includes(other.id) ? (
                                <Button key={other.id} type="button" onClick={() => toggleReference(index, other.id)}>
                                  {other.name || 'Untitled milestone'}
                                </Button>
                              ) : (
                                <Button key={other.id} type="button" outline onClick={() => toggleReference(index, other.id)}>
                                  {other.name || 'Untitled milestone'}
                                </Button>
                              )
                            )}
                          </div>
                          <Description>
                            A dependency is identity, not order: every milestone is evaluated from the same month, so marking this does not
                            delay it. Two milestones that depend on each other are refused.
                          </Description>
                        </Field>
                      </>
                    )}
                  </div>
                );
              })}

              <Button outline type="button" onClick={addMilestone}>
                <PlusIcon data-slot="icon" />
                Milestone
              </Button>
              {draft.length === 0 && <ErrorMessage>Nothing to save yet — add a milestone first.</ErrorMessage>}
            </FieldGroup>
          </DialogBody>
        </Fieldset>
        <DialogActions>
          <Button plain onClick={onClose} className="hidden sm:inline-flex" disabled={isSubmitting}>
            Cancel
          </Button>
          <Button color="rose" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </form>
    </>
  );
}
