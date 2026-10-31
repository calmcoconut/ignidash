'use client';

import { useState } from 'react';

import SectionSelector from './section-selector';
import ResultsSections from './outputs/results-sections';
import NumbersColumnSections from './inputs/numbers-column-sections';

type ActiveSection = 'results' | 'your-numbers';

export default function MobileMainArea() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('your-numbers');

  const activeSectionComponent = activeSection === 'results' ? <ResultsSections /> : <NumbersColumnSections />;

  return (
    <div className="flex h-full flex-col pt-[7.375rem] lg:pt-[4.3125rem] xl:hidden">
      <SectionSelector activeSection={activeSection} setActiveSection={setActiveSection} />
      {activeSectionComponent}
    </div>
  );
}
