import type { JSX } from 'preact';

export function Icon({
  name,
  ...props
}: {
  name:
    | 'arrow'
    | 'plus'
    | 'close'
    | 'refresh'
    | 'chevron'
    | 'globe'
    | 'check'
    | 'shield'
    | 'chart'
    | 'external'
    | 'edit';
} & JSX.IntrinsicElements['svg']) {
  const paths: Record<string, JSX.Element> = {
    arrow: (
      <>
        <path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6.1 6.1A8 8 0 0 1 19.8 11M4.2 13a8 8 0 0 0 13.7 4.9" />
      </>
    ),
    chevron: <path d="m8 10 4 4 4-4" />,
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    chart: (
      <>
        <path d="M4 4v16h16M7 15l4-5 4 3 5-7" />
      </>
    ),
    external: (
      <>
        <path d="M14 4h6v6m0-6-9 9M10 4H4v16h16v-6" />
      </>
    ),
    edit: (
      <>
        <path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14v6Z" />
      </>
    ),
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
