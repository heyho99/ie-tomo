const base = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export const PcIcon = () => (
  <svg {...base}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /><circle cx="12" cy="10" r="2" /></svg>
);
export const PhoneIcon = () => (
  <svg {...base}><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></svg>
);
export const MicIcon = () => (
  <svg {...base}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
);
export const VoiceIcon = () => (
  <svg {...base}><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></svg>
);

export const GearIcon = () => (
  <svg {...base}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
);
export const TomoIcon = ({ size = 56 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none" stroke="#2C3F35" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="24" cy="20" r="11" />
    <path d="M10 44c2-8 7.5-12 14-12s12 4 14 12" />
    <circle cx="20" cy="19" r="1.2" fill="#2C3F35" />
    <circle cx="28" cy="19" r="1.2" fill="#2C3F35" />
    <path d="M20.5 24.5c2 1.6 5 1.6 7 0" />
  </svg>
);

/* 双葉（ロゴ・「新しくはじめる」ボタン）。色は currentColor */
export const SproutIcon = ({ className, size }: { className?: string; size?: number }) => (
  <svg className={className} width={size} height={size} viewBox="6 6 24 24" aria-hidden="true">
    <path d="M18 28v-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    <path d="M18 20c-6 0-9.5-3.6-9.5-9 5.6 0 9.5 3.4 9.5 9z" fill="currentColor" />
    <path d="M18 18c0-5.6 3.6-9.5 10-9.5 0 5.8-3.8 9.5-10 9.5z" fill="currentColor" fillOpacity=".7" />
  </svg>
);

export const LogoMark = () => <SproutIcon className="logo" />;
