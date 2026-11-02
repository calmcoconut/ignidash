import type { Metadata } from 'next';
import { CircleQuestionMarkIcon } from 'lucide-react';
import { Disclosure, DisclosureButton, DisclosurePanel } from '@headlessui/react';
import { MinusSmallIcon, PlusSmallIcon } from '@heroicons/react/24/outline';

import { Text } from '@/components/catalyst/text';
import { DescriptionDetails, DescriptionList, DescriptionTerm } from '@/components/catalyst/description-list';
import { Divider } from '@/components/catalyst/divider';

export const metadata: Metadata = {
  title: 'Help Center',
  description: 'Get answers to common questions about Ignidash, how the simulator works, and what the engine does not model.',
  openGraph: {
    title: 'Help Center - Ignidash',
    description: 'Get answers to common questions about Ignidash, how the simulator works, and what the engine does not model.',
  },
};

const faqs = [
  {
    question: 'How should I get started with Ignidash?',
    answer: (
      <>
        If you would like to see a demo plan for Simulator to quickly explore the tool, create a new plan with the{' '}
        <strong className="underline">Demo Plan</strong> template of your choosing. This can be done with the Create button in Dashboard.
        <br />
        <br />
        Once you&apos;re ready to work on your own plan, create a new one or use the blank plan that was created automatically when you
        opened your account. I recommend customizing your Numbers with a{' '}
        <strong className="underline">Fixed Returns Simulation Mode</strong> until the Results are to your liking. After that, you can
        explore the other Simulation Modes to see how your plan performs under different market conditions and assumptions.
        <br />
        <br />
        The <strong className="underline">Monte Carlo modes</strong> are particularly useful for understanding the range of possible
        outcomes. You can drill down into full individual simulations by clicking on rows in the table at the bottom of Results.{' '}
        <strong>Tip:</strong> To find relevant simulations to explore, sort the table by metrics you care about!
      </>
    ),
  },
  {
    question: 'How can I check my vulnerability to sequence of returns risk?',
    answer: (
      <>
        You have two good options.
        <br />
        <br />
        First, you can use the <strong className="underline">Historical Returns Simulation Mode</strong> (in Simulation Settings) with{' '}
        <strong className="underline">Historical Retirement Start Year</strong> set to a historical year with a market crash, like 1929 for
        the Great Depression. This will make the market crash in your simulation at the same time as your retirement, which is the classic
        sequence of returns risk scenario.
        <br />
        <br />
        Second, you can use one of the two <strong className="underline">Monte Carlo Simulation Modes</strong> to check your Success %
        across 500 simulations. You can then drill down into failed simulations from the table at the bottom of Results by sorting by the
        Success column and clicking on one of the rows for a failed simulation. Chances are high that many of the failed simulations will
        involve market crashes early in retirement, which you can see from the Returns tab.
      </>
    ),
  },
  {
    question: 'How can I try out different options for incomes or expenses within a single Simulator plan?',
    answer:
      'You can disable (and then re-enable) individual incomes, expenses, and contributions using the Disable button in the three dot menu next to each. This keeps the data in the plan, but excludes it from the simulation results.',
  },
  {
    question: 'Can I choose not to automatically reinvest dividends and interest?',
    answer:
      'Yes, per taxable brokerage account: turn on "Pay dividends and interest as cash" in the account. The income then funds spending before any withdrawal. Reinvested income (the default) is added to the cost basis, so it is not taxed again when the shares are sold. Either way it is taxed in the year it is earned. Tax-advantaged accounts always reinvest.',
  },
  {
    question: "Why doesn't investment income, such as dividends and interest, show up in the Cash Flow tab?",
    answer: (
      <>
        Since Ignidash automatically reinvests dividends and interest, this investment income never becomes available as cash to spend;
        instead, it immediately contributes to portfolio growth. You can see this growth reflected in your account balances in the Portfolio
        tab and in the Returns tab.
        <br />
        <br />
        If you need to see investment income for tax purposes, check out the Taxes tab. And if you feel strongly about seeing investment
        income in Cash Flow, feel free to reach out through the contact info at the top of the page!
      </>
    ),
  },
];

export default function HelpPage() {
  return (
    <main className="mx-auto min-h-dvh max-w-7xl px-2 pt-[4.25rem] pb-[2.125rem] sm:px-3 lg:px-4">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="mt-8 space-y-8">
          <div className="flex items-center gap-4">
            <CircleQuestionMarkIcon className="text-primary h-12 w-12" />
            <div>
              <h1 className="mb-2 text-3xl font-bold">Help Center</h1>
              <p className="text-muted-foreground text-sm">Last updated: October 31, 2026</p>
            </div>
          </div>
        </div>
        <Divider soft />
        <div className="space-y-8">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl dark:text-white">Frequently asked questions</h2>
            <Text className="mt-2">
              These pages document this deployment: a single self-hosted instance, one operator account, and no outside services. There is
              no support desk behind it — the answers above and the limitations below are the reference, and the source is the reference for
              everything else.
            </Text>
          </div>
          <dl className="divide-y divide-stone-900/10 dark:divide-white/10">
            {faqs.map((faq) => (
              <Disclosure key={faq.question} as="div" className="py-6 first:pt-0 last:pb-0">
                <dt>
                  <DisclosureButton className="group flex w-full items-start justify-between text-left text-stone-900 dark:text-white">
                    <span className="text-sm/7 font-semibold">{faq.question}</span>
                    <span className="ml-6 flex h-7 items-center">
                      <PlusSmallIcon aria-hidden="true" className="size-6 group-data-open:hidden" />
                      <MinusSmallIcon aria-hidden="true" className="size-6 group-not-data-open:hidden" />
                    </span>
                  </DisclosureButton>
                </dt>
                <DisclosurePanel as="dd" className="mt-2 pr-12">
                  <p className="text-sm/7 text-stone-600 dark:text-stone-400">{faq.answer}</p>
                </DisclosurePanel>
              </Disclosure>
            ))}
          </dl>
        </div>
        <Divider soft />
        <div className="space-y-8">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl dark:text-white">Known limitations</h2>
            <Text className="mt-2">
              Ignidash is in beta. The simulation engine is dependable for what it models, and this page lists what it does not, so a
              missing feature reads as a limit rather than as a bug. Every item below is a deliberate boundary of the model, not a queue of
              promised work.
            </Text>
          </div>
          <DescriptionList>
            <DescriptionTerm>Social Security</DescriptionTerm>
            <DescriptionDetails>
              An income line you enter, adjusted for its claim age against the earner&apos;s own full retirement age. For a couple, a
              spousal benefit (up to half the other member&apos;s PIA, less your own, reduced for a claim before your full retirement age)
              is added from the later of the two claims, and on the first death the survivor receives the larger of their own benefit and
              the deceased&apos;s, reduced if the survivor starts it before their survivor full retirement age; a survivor claim age lets
              the survivor benefit start before the survivor&apos;s own. Children entered on the timeline are paid half the parent&apos;s
              PIA (three quarters after a parent&apos;s death) to 18, or 19 as a student, within the family maximum. Before full retirement
              age the earnings test withholds $1 for every $2 earned over the limit ($1 for $3 in the year you reach it), and the benefit is
              recomputed upward at full retirement age. A member&apos;s record is their one Social Security line, or the one that carries a
              PIA when they have several; a line without a PIA still counts for the survivor rule, but not for the spousal benefit, children
              or the family maximum. Not modelled: a spouse&apos;s benefit for caring for a child under 16, a worker&apos;s earnings
              withholding the spouse&apos;s benefit, and the test&apos;s calendar-year timing (it runs on plan years, after the excess is
              earned).
            </DescriptionDetails>

            <DescriptionTerm>Roth conversions</DescriptionTerm>
            <DescriptionDetails>
              Only the pre-tax share is taxed, using the Form 8606 pro-rata split of the nondeductible basis you enter on the traditional
              IRA. The engine does not read past Form 8606 filings, so a basis you leave blank counts as zero.
            </DescriptionDetails>

            <DescriptionTerm>State income tax</DescriptionTerm>
            <DescriptionDetails>California only — no other state, and no part-year residency.</DescriptionDetails>

            <DescriptionTerm>Estate, trust, business and rental tax</DescriptionTerm>
            <DescriptionDetails>
              Not modelled, and neither is future tax law: the vendored rulesets are applied across the projection, with later years
              projected in today&apos;s dollars.
            </DescriptionDetails>

            <DescriptionTerm>ACA premium tax credit</DescriptionTerm>
            <DescriptionDetails>
              The federal §36B credit, plus a Covered California state subsidy you enter from your eligibility notice (the state&apos;s
              schedule is not built in). Both stop for anyone on Medicare. No Alaska or Hawaii poverty lines.
            </DescriptionDetails>

            <DescriptionTerm>Medicare premiums</DescriptionTerm>
            <DescriptionDetails>
              IRMAA is charged per member on Medicare (from 65, or a later enrollment age). The base Part B, Part D and supplemental
              premiums are expenses only if you turn them on in tax settings, since your expenses may already include them. Premiums are
              held flat in today&apos;s dollars, not grown faster than inflation.
            </DescriptionDetails>

            <DescriptionTerm>Net-worth journal</DescriptionTerm>
            <DescriptionDetails>
              Manual entry. By design there is no automatic brokerage sync or outside data feed — the deployment makes no outbound calls.
            </DescriptionDetails>

            <DescriptionTerm>Tax optimization</DescriptionTerm>
            <DescriptionDetails>
              No optimizer inside the engine. The AI skill ranks engine-computed variants against a goal you pick and never recommends one.
            </DescriptionDetails>
          </DescriptionList>
        </div>
      </div>
    </main>
  );
}
