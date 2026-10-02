const P = (d: string, size = 16) =>
  function Icon() {
    return (
      <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {d.split("|").map((x, i) => (
          <path key={i} d={x} />
        ))}
      </svg>
    );
  };

export const IPlus = P("M12 5v14|M5 12h14");
// Settings: the SwarmAgents wrench (public/brand/wrench-small.svg), drawn for 16px.
export const ISettings = P("M9.5 1.99V5.1L12 6.7l2.5-1.6V1.99|M9.5 1.99A5.6 5.6 0 0 0 9.7 12.11V22.4|M14.5 1.99A5.6 5.6 0 0 1 16.59 10.21L9.7 13.8|M14.3 11.4V22.4");
export const ISidebar = P("M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M9 3v18");
export const IAttach = P("M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48", 18);
// Send: solid arrowhead reads as the primary action at small sizes.
export const IUp = () => (
  <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 3.5 20 12h-4.5V20.5h-7V12H4z" />
  </svg>
);
export const IStop = () => (
  <svg aria-hidden="true" focusable="false" width="12" height="12" viewBox="0 0 12 12">
    <rect width="12" height="12" rx="3" fill="currentColor" />
  </svg>
);
export const IX = P("M18 6 6 18|M6 6l12 12", 14);
export const IChevron = P("M9 18l6-6-6-6", 13);
export const IFile = P("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6", 13);
export const IActivity = P("M3 12h4l3-8 4 16 3-8h4");
export const IArrowUp = P("M18 15l-6-6-6 6", 14);
export const IArrowDown = P("M6 9l6 6 6-6", 14);
