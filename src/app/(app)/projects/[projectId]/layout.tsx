// A fragment on purpose: the board's lg:h-dvh → flex-1 → min-h-0 chain runs
// straight through here, and any wrapper element would break it
export default function ProjectLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <>
      {children}
      {modal}
    </>
  );
}
