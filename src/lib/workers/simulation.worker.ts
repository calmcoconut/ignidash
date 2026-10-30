/**
 * Simulation execution Web Worker.
 *
 * Runs Monte Carlo (stochastic or historical backtest) simulations in an off-main-thread
 * context. Each worker selects the appropriate engine based on the simulation mode, executes
 * the requested number of simulations, and forwards partial results to the merge worker.
 *
 * The worker is a separate JS realm, so it cannot see the store's clock: the caller passes
 * the resolved `asOf` ISO date as a plain argument, and the worker rebuilds the same fixed
 * clock here. That keeps every run traceable to one explicit date rather than to the
 * worker's wall clock.
 */

import * as Comlink from 'comlink';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { type ISODateString, fixedClock } from '@/lib/calc/clock';
import {
  MonteCarloSimulationEngine,
  LcgHistoricalBacktestSimulationEngine,
  type MultiSimulationResult,
} from '@/lib/calc/simulation-engine';

import type { MergeWorkerAPI } from './merge.worker';

const simulationAPI = {
  async runSimulation(
    inputs: SimulatorInputs,
    asOf: ISODateString,
    baseSeed: number,
    numSimulations: number,
    simulationMode: 'monteCarloStochasticReturns' | 'monteCarloHistoricalReturns',
    mergeWorker: Comlink.Remote<MergeWorkerAPI>,
    onProgress?: () => void
  ): Promise<void> {
    // Rebuild the caller's clock explicitly; the worker never reads its own wall clock.
    const clock = fixedClock(asOf);

    let res: MultiSimulationResult;
    switch (simulationMode) {
      case 'monteCarloStochasticReturns': {
        const engine = new MonteCarloSimulationEngine(inputs, baseSeed, clock);
        res = engine.runMonteCarloSimulation(numSimulations, onProgress);
        break;
      }
      case 'monteCarloHistoricalReturns': {
        const engine = new LcgHistoricalBacktestSimulationEngine(inputs, baseSeed, clock);
        res = engine.runLcgHistoricalBacktest(numSimulations, onProgress);
        break;
      }
    }

    await mergeWorker.addPartialResult(res);
  },
};

Comlink.expose(simulationAPI);

export type SimulationWorkerAPI = typeof simulationAPI;
