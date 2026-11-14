import { render } from 'preact';
import '../../../src/ui/styles.css';
import './app.css';
import { App } from './App.tsx';

render(<App />, document.getElementById('app')!);
