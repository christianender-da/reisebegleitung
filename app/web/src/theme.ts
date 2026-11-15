/**
 * Farbe der Statusleiste (theme-color) passend zum Hell-/Dunkelmodus.
 * iOS wertet in installierten Web-Apps die beiden <meta media="…">-Varianten nicht zuverlässig aus
 * und zeigt dann auch im Dunkelmodus eine helle Leiste – deshalb eine einzige Angabe, per Skript gesetzt.
 */
const COLORS = { light: '#f4f5f7', dark: '#111418' } as const;

export function syncThemeColor(): void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = mq.matches ? COLORS.dark : COLORS.light;
    document.head.appendChild(meta);
  };
  apply();
  mq.addEventListener?.('change', apply);
}
