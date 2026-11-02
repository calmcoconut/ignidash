/**
 * MCP prompts and resources. See `./registry.ts` for the contract.
 */

import { NOT_MODELED_LIST } from '../utils/sys_prompt_utils';

import type { McpPrompt, McpResource } from './types';

const SETUP_INTERVIEW_TEXT = `Set up or update an Ignidash retirement plan for me by interviewing me. Work through these steps in order.

1. Call list_plans. If I already have a plan I want to keep, call clone_plan on it and work on the copy, unless I tell you otherwise.

2. Interview me one section at a time, in this order:
   - timeline: birth dates (both spouses' if we are married), life expectancy, when we plan to retire, and any children under 19 (their birth month and year, for Social Security children's benefits)
   - accounts: each account's type, balance, and owner
   - income: salary and Social Security
   - expenses
   - debts and property
   - contributions
   - tax settings: filing status and California residency
   Ask only for what the tools' input schemas need. Before you write a section, call get_schema to see its shape.

3. Write each section with the tools as soon as I answer it. Confirm what was saved, then move on to the next section.

4. When every section is done, call analyze_plan with the plan's id and calls: [{ "tool": "getPlanSummary" }]. Read the headline numbers back to me.

5. Every number you state must come from a tool result. Do not estimate or recall figures.

6. If I ask which option to pursue, compare the options and rank them. Do not recommend one.

7. When a question touches something Ignidash does not model, read the resource ignidash://help/limitations and say so plainly.`;

export const MCP_PROMPTS: McpPrompt[] = [
  {
    name: 'setup_interview',
    description: 'Set up or update an Ignidash plan by interview',
    text: SETUP_INTERVIEW_TEXT,
  },
];

const LIMITATIONS_TEXT = `# Ignidash: what is not modeled

Ignidash cannot simulate these. You may explain them educationally, but say they are not part of the simulation.

${NOT_MODELED_LIST}

If a user asks about one of these, acknowledge the limitation directly. Do not suggest a workaround inside Ignidash.
`;

export const MCP_RESOURCES: McpResource[] = [
  {
    uri: 'ignidash://help/limitations',
    name: 'Known limitations',
    description: 'The features Ignidash does not model, as the AI chat lists them.',
    mimeType: 'text/markdown',
    text: LIMITATIONS_TEXT,
  },
];
