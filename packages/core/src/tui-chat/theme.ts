/**
 * Lodestone — Theme System
 *
 * Defines color palettes for the TUI and provides preset themes.
 * Themes control all visual aspects: colors, borders, spinners, markdown rendering.
 */

// ─── Theme Type ──────────────────────────────────────────────────────────────

export interface ThemeColors {
  text: string;       // Primary text
  dim: string;        // Dimmed/muted text
  accent: string;     // Primary accent (headings, important)
  accent2: string;    // Secondary accent (bullets, highlights)
  border: string;    // Borders, dividers
  userBg: string;    // User message background
  userText: string;  // User message text
  sysText: string;   // System text
  tool: string;      // Tool indicators
  code: string;      // Code text
  error: string;     // Error indicators
  success: string;   // Success indicators
  quote: string;    // Quote text
  quoteBorder: string; // Quote border
  warn: string;      // Warning indicators
  info: string;      // Info indicators
  purple: string;    // Drift/special indicators
  pink: string;      // Skills/lessons
}

export interface ThemeMarkdownStyles {
  heading: (s: string) => string;
  bold: (s: string) => string;
  italic: (s: string) => string;
  strikethrough: (s: string) => string;
  underline: (s: string) => string;
  link: (s: string) => string;
  linkUrl: (s: string) => string;
  code: (s: string) => string;
  codeBlock: (s: string) => string;
  codeBlockBorder: (s: string) => string;
  quote: (s: string) => string;
  quoteBorder: (s: string) => string;
  hr: (s: string) => string;
  listBullet: (s: string) => string;
  highlightCode: (code: string) => string[];
}

export interface Theme {
  name: string;
  description: string;
  colors: ThemeColors;
  markdown: ThemeMarkdownStyles;
  statusBar: {
    bg: string;
    separator: string;
    icon: string;
  };
  spinner: string[];
}

// ─── ANSI Helpers ─────────────────────────────────────────────────────────────

export const R = '\x1B[0m';
export const B = '\x1B[1m';
export const D = '\x1B[2m';
export const I = '\x1B[3m';

/**
 * Convert a hex color string to a 24-bit foreground ANSI escape sequence.
 * @param c - Hex color string (e.g. "#FF6EC7").
 * @returns ANSI escape sequence for foreground color.
 */
export function fg(c: string): string {
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  return `\x1B[38;2;${r};${g};${b}m`;
}

/**
 * Convert a hex color string to a 24-bit background ANSI escape sequence.
 * @param c - Hex color string (e.g. "#1E232A").
 * @returns ANSI escape sequence for background color.
 */
export function bg(c: string): string {
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  return `\x1B[48;2;${r};${g};${b}m`;
}

// ─── Markdown Theme Builder ──────────────────────────────────────────────────

function buildMarkdownTheme(colors: ThemeColors): ThemeMarkdownStyles {
  return {
    heading: (s: string) => `${B}${fg(colors.accent)}${s}${R}`,
    bold: (s: string) => `${B}${s}${R}`,
    italic: (s: string) => `${I}${s}${R}`,
    strikethrough: (s: string) => `\x1B[9m${s}${R}`,
    underline: (s: string) => `\x1B[4m${s}${R}`,
    link: (s: string) => `${fg(colors.success)}${s}${R}`,
    linkUrl: (s: string) => `${D}${s}${R}`,
    code: (s: string) => `${fg(colors.code)}${s}${R}`,
    codeBlock: (s: string) => `${fg(colors.code)}${s}${R}`,
    codeBlockBorder: (s: string) => `${fg(colors.border)}${s}${R}`,
    quote: (s: string) => `${fg(colors.quote)}${s}${R}`,
    quoteBorder: (s: string) => `${fg(colors.quoteBorder)}${s}${R}`,
    hr: (s: string) => `${fg(colors.border)}${s}${R}`,
    listBullet: (s: string) => `${fg(colors.accent2)}${s}${R}`,
    highlightCode: (code: string) => code.split('\n').map((line: string) => `${fg(colors.code)}${line}`),
  };
}

// ─── Spinner Presets ─────────────────────────────────────────────────────────

const DOTS_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BLOCK_SPINNER = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '▊', '▋', '▌'];
const SIMPLE_SPINNER = ['-', '\\', '|', '/'];
const PULSE_SPINNER = ['●', '◉', '○', '◎'];

// ─── Built-in Themes ─────────────────────────────────────────────────────────

export const THEMES: Record<string, Theme> = {
  dark: {
    name: 'dark',
    description: 'OpenClaw-inspired dark palette (default)',
    colors: {
      text: '#E8E3D5',
      dim: '#7B7F87',
      accent: '#F6C453',
      accent2: '#F2A65A',
      border: '#3C414B',
      userBg: '#2B2F36',
      userText: '#F3EEE0',
      sysText: '#9BA3B2',
      tool: '#F6C453',
      code: '#F0C987',
      error: '#DC2626',
      success: '#7DD3A5',
      quote: '#8CC8FF',
      quoteBorder: '#3B4D6B',
      warn: '#FBBF24',
      info: '#60A5FA',
      purple: '#A78BFA',
      pink: '#F472B6',
    },
    markdown: buildMarkdownTheme({
      text: '#E8E3D5', dim: '#7B7F87', accent: '#F6C453', accent2: '#F2A65A',
      border: '#3C414B', userBg: '#2B2F36', userText: '#F3EEE0', sysText: '#9BA3B2',
      tool: '#F6C453', code: '#F0C987', error: '#DC2626', success: '#7DD3A5',
      quote: '#8CC8FF', quoteBorder: '#3B4D6B', warn: '#FBBF24', info: '#60A5FA',
      purple: '#A78BFA', pink: '#F472B6',
    }),
    statusBar: { bg: '#1E232A', separator: '│', icon: '🔮' },
    spinner: DOTS_SPINNER,
  },

  midnight: {
    name: 'midnight',
    description: 'Deeper blues and cyans — cool and calm',
    colors: {
      text: '#C9D1D9',
      dim: '#6E7681',
      accent: '#79C0FF',
      accent2: '#58A6FF',
      border: '#21262D',
      userBg: '#161B22',
      userText: '#E6EDF3',
      sysText: '#8B949E',
      tool: '#79C0FF',
      code: '#A5D6FF',
      error: '#F85149',
      success: '#56D364',
      quote: '#D2A8FF',
      quoteBorder: '#30363D',
      warn: '#E3B341',
      info: '#58A6FF',
      purple: '#D2A8FF',
      pink: '#FF7EB6',
    },
    markdown: buildMarkdownTheme({
      text: '#C9D1D9', dim: '#6E7681', accent: '#79C0FF', accent2: '#58A6FF',
      border: '#21262D', userBg: '#161B22', userText: '#E6EDF3', sysText: '#8B949E',
      tool: '#79C0FF', code: '#A5D6FF', error: '#F85149', success: '#56D364',
      quote: '#D2A8FF', quoteBorder: '#30363D', warn: '#E3B341', info: '#58A6FF',
      purple: '#D2A8FF', pink: '#FF7EB6',
    }),
    statusBar: { bg: '#0D1117', separator: '│', icon: '🌙' },
    spinner: BLOCK_SPINNER,
  },

  forest: {
    name: 'forest',
    description: 'Greens and earths — natural and grounding',
    colors: {
      text: '#D4E4D0',
      dim: '#7A8B72',
      accent: '#A8D86E',
      accent2: '#8FC93A',
      border: '#3D4A36',
      userBg: '#2A3325',
      userText: '#E8F0E4',
      sysText: '#94A689',
      tool: '#A8D86E',
      code: '#C8E68A',
      error: '#E05555',
      success: '#6BCB77',
      quote: '#B8D8A0',
      quoteBorder: '#4A5A42',
      warn: '#E5C07B',
      info: '#7ECEC1',
      purple: '#9FC5A8',
      pink: '#E8A0B0',
    },
    markdown: buildMarkdownTheme({
      text: '#D4E4D0', dim: '#7A8B72', accent: '#A8D86E', accent2: '#8FC93A',
      border: '#3D4A36', userBg: '#2A3325', userText: '#E8F0E4', sysText: '#94A689',
      tool: '#A8D86E', code: '#C8E68A', error: '#E05555', success: '#6BCB77',
      quote: '#B8D8A0', quoteBorder: '#4A5A42', warn: '#E5C07B', info: '#7ECEC1',
      purple: '#9FC5A8', pink: '#E8A0B0',
    }),
    statusBar: { bg: '#1E261A', separator: '│', icon: '🌿' },
    spinner: SIMPLE_SPINNER,
  },

  light: {
    name: 'light',
    description: 'Clean light theme for bright terminals',
    colors: {
      text: '#24292F',
      dim: '#6E7781',
      accent: '#0969DA',
      accent2: '#0550AE',
      border: '#D0D7DE',
      userBg: '#F6F8FA',
      userText: '#1F2328',
      sysText: '#656D76',
      tool: '#0969DA',
      code: '#0A3069',
      error: '#CF222E',
      success: '#1A7F37',
      quote: '#6639BA',
      quoteBorder: '#D0D7DE',
      warn: '#9A6700',
      info: '#0969DA',
      purple: '#8250DF',
      pink: '#BF3989',
    },
    markdown: buildMarkdownTheme({
      text: '#24292F', dim: '#6E7781', accent: '#0969DA', accent2: '#0550AE',
      border: '#D0D7DE', userBg: '#F6F8FA', userText: '#1F2328', sysText: '#656D76',
      tool: '#0969DA', code: '#0A3069', error: '#CF222E', success: '#1A7F37',
      quote: '#6639BA', quoteBorder: '#D0D7DE', warn: '#9A6700', info: '#0969DA',
      purple: '#8250DF', pink: '#BF3989',
    }),
    statusBar: { bg: '#F6F8FA', separator: '│', icon: '🔮' },
    spinner: DOTS_SPINNER,
  },

  cyber: {
    name: 'cyber',
    description: 'Neon pinks and greens — retro-futuristic',
    colors: {
      text: '#E0E0E0',
      dim: '#6B6B6B',
      accent: '#FF0080',
      accent2: '#FF6EC7',
      border: '#2D2D2D',
      userBg: '#1A1A2E',
      userText: '#EAEAEA',
      sysText: '#888888',
      tool: '#00FF9F',
      code: '#00FFC8',
      error: '#FF3333',
      success: '#00FF9F',
      quote: '#BF5FFF',
      quoteBorder: '#3D3D5C',
      warn: '#FFD700',
      info: '#00BFFF',
      purple: '#BF5FFF',
      pink: '#FF6EC7',
    },
    markdown: buildMarkdownTheme({
      text: '#E0E0E0', dim: '#6B6B6B', accent: '#FF0080', accent2: '#FF6EC7',
      border: '#2D2D2D', userBg: '#1A1A2E', userText: '#EAEAEA', sysText: '#888888',
      tool: '#00FF9F', code: '#00FFC8', error: '#FF3333', success: '#00FF9F',
      quote: '#BF5FFF', quoteBorder: '#3D3D5C', warn: '#FFD700', info: '#00BFFF',
      purple: '#BF5FFF', pink: '#FF6EC7',
    }),
    statusBar: { bg: '#0D0D1A', separator: '║', icon: '⚡' },
    spinner: PULSE_SPINNER,
  },
};

export const THEME_NAMES = Object.keys(THEMES);
export const DEFAULT_THEME = 'dark';

/**
 * Look up a theme by name, falling back to the default theme if not found.
 * @param name - Theme name (e.g. "dark", "midnight", "forest", "light", "cyber").
 * @returns The matching Theme object or the default dark theme.
 */
export function getTheme(name: string): Theme {
  return THEMES[name] ?? THEMES[DEFAULT_THEME];
}

// ─── Theme-aware Formatting Helpers ───────────────────────────────────────────

/**
 * Create a set of theme-aware formatting helpers for the TUI.
 * @param t - The theme to derive formatters from.
 * @returns Object with formatting functions for timestamps, durations, user/assistant/tool labels.
 */
export function themeFormatters(t: Theme) {
  const P = t.colors;
  return {
    R, B, D, I, fg, bg,
    formatTimestamp: (ts: number) =>
      new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    formatDuration: (ms: number) => {
      if (ms < 1000) return `${ms}ms`;
      return `${(ms / 1000).toFixed(1)}s`;
    },
    user: (name: string, ts: number) =>
      `**you** ${D}${new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}${R}`,
    assistant: (name: string, ts: number) =>
      `${B}${fg(P.accent)}${t.statusBar.icon}${R} ${name}`,
    tool: (icon: string, name: string) =>
      `${fg(P.success)}${icon}${R} ${fg(P.tool)}${name}${R}`,
  };
}