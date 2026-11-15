/** Empfängerseite eines Teilen-Links (/r/<token>): ohne Anmeldung, nur ansehen */
import { render } from 'preact';
import '../../../src/ui/styles.css';
import './app.css';
import { SharedView, type Lang } from '../../../src/ui/index.ts';

const lang: Lang = navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en';
document.documentElement.lang = lang;
const token = location.pathname.split('/')[2] ?? '';

render(
  <main class="shell plain">
    <SharedView dataUrl={`/r/${encodeURIComponent(token)}/data`} liteUrl={`/r/${encodeURIComponent(token)}/lite`} lang={lang} />
  </main>,
  document.getElementById('app')!,
);
