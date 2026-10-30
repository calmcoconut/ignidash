'use client';

import { Sankey, ResponsiveContainer } from 'recharts';
import type { SankeyNodeProps } from 'recharts';

import { formatCompactCurrency } from '@/lib/utils/number-formatters';
import type { AnnualCashFlowLedger, CashFlowSankeyNode } from '@/lib/calc/data-extractors/cash-flow-ledger';
import { buildCashFlowSankey, ledgerEntryForAge, totalLedgerInflows } from '@/lib/calc/data-extractors/cash-flow-ledger';

import { ChartEmptyState } from '../chart-primitives';

const NODE_LABEL_GAP = 6;

const renderNode = ({ x, y, width, height, payload }: SankeyNodeProps) => {
  const node = payload as unknown as CashFlowSankeyNode;
  const labelOnLeft = node.kind === 'outflow' || node.kind === 'reinvested';
  const labelX = labelOnLeft ? x - NODE_LABEL_GAP : x + width + NODE_LABEL_GAP;

  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={node.color} rx={2} />
      <text
        x={labelX}
        y={y + height / 2}
        textAnchor={labelOnLeft ? 'end' : 'start'}
        dominantBaseline="middle"
        fontSize={11}
        fill="currentColor"
      >
        {node.name}
      </text>
    </g>
  );
};

interface SingleSimulationCashFlowSankeyChartProps {
  ledger: AnnualCashFlowLedger[];
  age: number;
}

export default function SingleSimulationCashFlowSankeyChart({ ledger, age }: SingleSimulationCashFlowSankeyChartProps) {
  const entry = ledgerEntryForAge(ledger, age);
  if (!entry) {
    return <ChartEmptyState />;
  }

  const { nodes, links } = buildCashFlowSankey(entry);
  if (links.length === 0) {
    return <ChartEmptyState message="No cash flows in the selected year." />;
  }

  const totalInflow = totalLedgerInflows(entry);

  return (
    <div className="h-96 w-full sm:h-[28rem] [&_g:focus]:outline-none [&_svg:focus]:outline-none">
      <ResponsiveContainer width="100%" height="100%">
        <Sankey
          data={{ nodes, links }}
          nameKey="name"
          nodePadding={16}
          nodeWidth={12}
          margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
          link={{ stroke: 'var(--muted-foreground)', strokeOpacity: 0.18 }}
          node={renderNode}
          tabIndex={-1}
        />
      </ResponsiveContainer>
      <p className="text-muted-foreground mt-2 text-xs">
        {`Cash flow ledger for ${entry.yearLabel} (age ${entry.age}). Inflows cover ${formatCompactCurrency(totalInflow, 1)}; `}
        {`investment returns of ${formatCompactCurrency(entry.returns, 1)} are reinvested in place and are not cash.`}
      </p>
    </div>
  );
}
