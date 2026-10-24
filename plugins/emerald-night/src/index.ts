// Standalone marketplace plugin — types inlined, no runtime deps on host internals.
// Build: npm run build  →  dist/index.js

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function register(api: any): (() => void) | void {
  if (!api.isActive()) return;

  api.themes.register({
    id: "emerald-night",
	name: "Emerald Night",
	uiFontFamily: "'Inter Variable', system-ui, sans-serif",
	uiFontSize: 15,
	terminalFontFamily: "'JetBrains Mono', monospace",
	terminalFontSize: 15,
	ui: {
	  bgTerminal: "#141729",
	  bgStatusBar: "#1e2033",
	  bgBase: "#1e2033",
	  bgToolbar: "#010318",
	  bgCard: "#121525",
	  bgCardHover: "#2d73e040",
	  bgCardAvatar: "#5fe2f746",
	  bgInput: "#141D2B",
	  bgInputHover: "#2A3F5A",
	  bgElevated: "#1e2e42",
	  bgModal: "#1a1d2f",
	  border: "#1e2d42",
	  borderHover: "#ffffff00",
	  textDim: "#7fa7b8",
	  textMuted: "#8d91a5",
	  textSecondary: "#8d91a5",
	  textPrimary: "#d2dcea",
	  textBright: "#e2ebf8",
	  accent: "#4e97de",
	  accentHover: "#76a9dc",
	  tabBg: "#202436",
	  tabActiveBg: "#1c3736",
	  tabActiveText: "#23b568",
	  tabActiveBorder: "#23b56840",
	  vaultTabBg: "#2d2f3f",
	  vaultTabActiveBg: "#2d2f3f",
	  statusConnected: "#22C55E",
	  statusError: "#EF4444",
	  statusConnecting: "#F59E0B",
	  statusWarning: "#F59E0B",
	  textNotice: "#6b8aab"
	},
	terminal: {
	  background: "#141729",
	  foreground: "#21b568",
	  cursor: "#21b568",
	  selectionBackground: "#6366f133",
	  black: "#1a1a26",
	  red: "#ef4444",
	  green: "#22c55e",
	  yellow: "#eab308",
	  blue: "#3b82f6",
	  magenta: "#a855f7",
	  cyan: "#06b6d4",
	  white: "#e2e8f0",
	  brightBlack: "#64748b",
	  brightRed: "#f87171",
	  brightGreen: "#4ade80",
	  brightYellow: "#facc15",
	  brightBlue: "#60a5fa",
	  brightMagenta: "#c084fc",
	  brightCyan: "#22d3ee",
	  brightWhite: "#f8fafc",
    },
  });

  return () => {
    api.themes.unregister("emerald-night");
  };
}
