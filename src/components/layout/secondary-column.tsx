export default function SecondaryColumn({ children }: { children?: React.ReactNode }) {
  return (
    <aside className="border-border/50 fixed inset-y-0 left-72 hidden w-96 overflow-y-auto border-r px-2 group-data-[animating=true]/sidebar:transition-[left] group-data-[animating=true]/sidebar:duration-200 group-data-[animating=true]/sidebar:ease-in-out group-data-[state=collapsed]/sidebar:left-16 motion-reduce:transition-none sm:px-3 lg:px-4 xl:block print:hidden">
      {children}
    </aside>
  );
}
