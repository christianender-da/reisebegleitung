import { render } from 'preact';
import '../../../src/ui/styles.css';
import './app.css';
import { syncThemeColor } from './theme.ts';
import { App } from './App.tsx';

syncThemeColor();

render(<App />, document.getElementById('app')!);

// Service Worker für Benachrichtigungen (Web Push)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
