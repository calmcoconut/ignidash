import { cn } from '@/lib/utils';

interface SectionContainerProps {
  showBottomBorder: boolean;
  children: React.ReactNode;
  location?: 'default' | 'drawer';
  className?: string;
}

export default function SectionContainer({ children, showBottomBorder, location = 'default', className }: SectionContainerProps) {
  const isDrawer = location === 'drawer';
  const outerXMarginClass = isDrawer ? '-mx-2 sm:-mx-3' : '-mx-2 sm:-mx-3 lg:-mx-4';
  const innerXMarginClass = isDrawer ? 'mx-2 sm:mx-3' : 'mx-2 sm:mx-3 lg:mx-4';

  return (
    <div className={cn('py-5', { 'border-border/50 border-b': showBottomBorder }, outerXMarginClass, className)}>
      <div className={innerXMarginClass}>{children}</div>
    </div>
  );
}
