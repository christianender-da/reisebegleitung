import { render } from 'preact';
import '../../../src/ui/styles.css';
import './app.css';
import { App } from './App.tsx';

render(<App />, document.getElementById('app')!);

// Service Worker für Benachrichtigungen (Web Push)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
