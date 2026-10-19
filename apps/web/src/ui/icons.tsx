import type { ReactNode, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconCoin = ({ size = 18, ...r }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...r}>
    <circle cx="12" cy="12" r="10" fill="#fbbf24" />
    <circle cx="12" cy="12" r="10" fill="none" stroke="#b45309" strokeWidth="1.5" />
    <circle cx="12" cy="12" r="6.2" fill="none" stroke="#b45309" strokeWidth="1.3" opacity="0.7" />
    <path d="M12 8v8M9.8 10.2c.5-.8 1.3-1.1 2.2-1.1 1.2 0 2.1.6 2.1 1.5 0 2-4.3 1-4.3 3 0 .9.9 1.5 2.2 1.5.9 0 1.7-.3 2.2-1" stroke="#92400e" strokeWidth="1.3" fill="none" strokeLinecap="round" />
  </svg>
);

export const IconHelp = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M9.4 9.2a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.2-2.6 3.9" />
    <circle cx="12" cy="17.4" r="0.6" fill="currentColor" />
  </Svg>
);

export const IconBag = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 8h13l-1 12h-11z" />
    <path d="M9 8V6.5a3 3 0 0 1 6 0V8" />
  </Svg>
);

export const IconSpark = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />
  </Svg>
);

export const IconGauge = (p: P) => (
  <Svg {...p}>
    <path d="M4 17a8.5 8.5 0 1 1 16 0" />
    <path d="M12 17l4-5" />
    <circle cx="12" cy="17" r="1" fill="currentColor" />
  </Svg>
);

export const IconLogout = (p: P) => (
  <Svg {...p}>
    <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
    <path d="M15 8l4 4-4 4M19 12H9" />
  </Svg>
);

export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
  </Svg>
);

export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </Svg>
);

export const IconSunrise = (p: P) => (
  <Svg {...p}>
    <path d="M6 17a6 6 0 0 1 12 0" />
    <path d="M12 6V3.5M4.5 10l1.5 1.5M19.5 10L18 11.5M2.5 17h19M7 21h10" />
  </Svg>
);

export const IconMic = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Svg>
);

export const IconSend = (p: P) => (
  <Svg {...p}>
    <path d="M4 12L20 4l-5 16-3.2-6.3z" />
    <path d="M11.8 13.7L20 4" />
  </Svg>
);

export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);

export const IconChevron = (p: P) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);

export const IconKeyboard = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7 14h10" />
  </Svg>
);

export const IconFlag = (p: P) => (
  <Svg {...p}>
    <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
  </Svg>
);

export const IconWalk = (p: P) => (
  <Svg {...p}>
    <circle cx="13" cy="4.5" r="1.8" />
    <path d="M9 21l2.2-6.5L9 12l1.5-4.5L14 9l2.5 3M13.2 14.2L15 21M7.5 11.5L9 8" />
  </Svg>
);

export const IconStop = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
);

export const IconCompass = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M15.5 8.5l-2 5-5 2 2-5z" />
  </Svg>
);

export const IconTag = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 12.5V4.5h8l9 9-8 8z" />
    <circle cx="8" cy="9" r="1" fill="currentColor" />
  </Svg>
);

export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconMinus = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);
