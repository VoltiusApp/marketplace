// Standalone marketplace plugin — types inlined, no runtime deps on host internals.
// Build: npm run build  →  dist/index.js

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function register(api: any): (() => void) | void {
  if (!api.isActive()) return;

  api.themes.register({
    id: "navy-green",
    name: "Navy Green",
    uiFontFamily: "'Inter Variable', system-ui, sans-serif",
    uiFontSize: 14,
    terminalFontFamily: "'Source Code Pro', monospace",
    terminalFontSize: 17,
    ui: {
      bgTerminal: "#141729",
      bgBase: "#1d2033",
      bgSidebar: "#282b3d",
      bgCard: "#282b3d",
      bgCardHover: "#32364a",
      bgCardAvatar: "#004878",
      bgInput: "#3e4257",
      bgInputHover: "#838696",
      bgElevated: "#202334",
      bgModal: "#1a1d2f",
      border: "#3e4257",
      borderHover: "#FFFFFF00",
      textDim: "#8d91a5",
      textMuted: "#5a5e72",
      textSecondary: "#85899d",
      textPrimary: "#ffffff",
      textBright: "#ffffff",
      accent: "#21b568",
      accentHover: "#1da05a",
      tabBg: "#202334",
      tabActiveBg: "#173636",
      tabActiveText: "#21b568",
      tabActiveBorder: "#21b568",
      vaultTabBg: "#202436",
      vaultTabActiveBg: "#2c2f3f",
      statusConnected: "#21b568",
      statusError: "#FF4444",
      statusConnecting: "#F59E0B",
      statusWarning: "#F59E0B",
      textNotice: "#a4b3ba",
    },
    terminal: {
      background: "#141729",
      foreground: "#21a646",
      cursor: "#21b568",
      selectionBackground: "#1b6648",
      black: "#1e2035",
      red: "#ff5555",
      green: "#21b568",
      yellow: "#eca843",
      blue: "#4d9de0",
      magenta: "#b87fd4",
      cyan: "#2091d5",
      white: "#c8d0e0",
      brightBlack: "#5a5e72",
      brightRed: "#FF0000",
      brightGreen: "#3ed79d",
      brightYellow: "#eca855",
      brightBlue: "#6aaeef",
      brightMagenta: "#cc99e8",
      brightCyan: "#2091f6",
      brightWhite: "#ffffff",
    },
  });

  return () => {
    api.themes.unregister("navy-green");
  };
}
