/** Regenerate simulation button with random seed and disabled-state logic. */
import { RefreshCwIcon } from 'lucide-react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';

import { useSimulationStatus } from '@/lib/stores/simulator-store';

import { useSelectedPlanId } from './use-selected-plan-id';
import { useSimulationSettingsData } from './use-convex-data';

export function useRegenSimulation() {
  const planId = useSelectedPlanId();

  const simulationSettings = useSimulationSettingsData();
  const simulationMode = simulationSettings?.simulationMode;
  const simulationStatus = useSimulationStatus();

  const isDisabled = !simulationSettings || simulationStatus === 'loading' || simulationMode === 'fixedReturns';

  const updateSimulationSettings = useMutation(api.simulation_settings.update);
  const handleClick = async () => {
    if (!isDisabled) {
      await updateSimulationSettings({
        simulationSettings: { ...simulationSettings, simulationSeed: Math.floor(Math.random() * 1000) },
        planId,
      });
    }
  };

  return { icon: RefreshCwIcon, label: 'Regenerate Simulation', handleClick, isDisabled };
}
