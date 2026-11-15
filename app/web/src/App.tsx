/** Eigenständige App: Anmeldung mit Passkey, danach die Reisebegleitung */
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { createJourneyApi, JourneyView, type Lang } from '../../../src/ui/index.ts';

const lang: Lang = navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en';
document.documentElement.lang = lang;

const TEXT = {
  de: {
    title: 'Reisebegleitung',
    beta: 'Beta',
    loginNote: 'Beta-Version – Angaben ohne Gewähr. Details im README des Projekts.',
    loading: 'Lädt …',
    login: 'Mit Passkey anmelden',
    loginFailed: 'Anmeldung fehlgeschlagen. Bitte erneut versuchen.',
    setupTitle: 'Einrichten',
    setupText: 'Gib den Einrichtungscode ein (npm run app:setup-code) oder deinen Wiederherstellungscode und lege einen Passkey an.',
    useCode: 'Einrichtungs- oder Wiederherstellungscode verwenden',
    code: 'Code',
    createPasskey: 'Passkey erstellen',
    codeInvalid: 'Code ungültig oder abgelaufen.',
    passkeyFailed: 'Passkey konnte nicht erstellt werden.',
    recoveryTitle: 'Dein Wiederherstellungscode',
    recoveryText: 'Speichere ihn jetzt sicher (z. B. im Passwort-Manager). Er wird nur dieses eine Mal angezeigt und ersetzt einen früheren Code.',
    saved: 'Gespeichert',
    addPasskey: 'Passkey hinzufügen',
    added: 'Passkey hinzugefügt.',
    logout: 'Abmelden',
    noContact:
      'Noch nicht fertig eingerichtet: In app/wrangler.jsonc fehlt bei „CONTACT“ eine Kontaktangabe (E-Mail oder URL). Transitous verlangt sie für jede Anfrage.',
    rateLimited: 'Zu viele Versuche. Bitte eine Minute warten.',
  },
  en: {
    title: 'Journey companion',
    beta: 'Beta',
    loginNote: 'Beta version – no guarantee of accuracy. Details in the project README.',
    loading: 'Loading …',
    login: 'Sign in with passkey',
    loginFailed: 'Sign-in failed. Please try again.',
    setupTitle: 'Set up',
    setupText: 'Enter the setup code (npm run app:setup-code) or your recovery code and create a passkey.',
    useCode: 'Use setup or recovery code',
    code: 'Code',
    createPasskey: 'Create passkey',
    codeInvalid: 'Code invalid or expired.',
    passkeyFailed: 'Passkey could not be created.',
    recoveryTitle: 'Your recovery code',
    recoveryText: 'Store it safely now (e.g. in a password manager). It is shown only once and replaces any earlier code.',
    saved: 'Saved',
    addPasskey: 'Add passkey',
    added: 'Passkey added.',
    logout: 'Sign out',
    noContact: 'Setup incomplete: "CONTACT" in app/wrangler.jsonc needs a contact (e-mail or URL). Transitous requires it for every request.',
    rateLimited: 'Too many attempts. Please wait a minute.',
  },
}[lang];

interface Status {
  loggedIn: boolean;
  hasPasskey: boolean;
  configured: boolean;
  version: string;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? String(res.status));
  return data;
}

type RegOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];
type AuthOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];

async function createPasskey(code?: string): Promise<string | null> {
  const { options, challengeId } = await post<{ options: RegOptions; challengeId: string }>('/api/auth/register/options', { code });
  const response = await startRegistration({ optionsJSON: options });
  const r = await post<{ recoveryCode: string | null }>('/api/auth/register/verify', { challengeId, response, code });
  return r.recoveryCode;
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);

  const check = useCallback(() => {
    fetch('/api/auth/status', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useEffect(check, [check]);

  if (!status) return <main class="shell">{TEXT.loading}</main>;
  if (recovery)
    return (
      <main class="shell">
        <div class="card">
          <h2>{TEXT.recoveryTitle}</h2>
          <p>{TEXT.recoveryText}</p>
          <p class="code">{recovery}</p>
          <button class="rb-btn rb-primary" onClick={() => setRecovery(null)}>
            {TEXT.saved}
          </button>
        </div>
      </main>
    );
  if (!status.loggedIn)
    return (
      <main class="shell">
        <div class="top">
          <h1>
            {TEXT.title} <span class="rb-beta">{TEXT.beta}</span>
          </h1>
        </div>
        <Login status={status} onDone={(code) => (code ? setRecovery(code) : null, check())} />
      </main>
    );
  return <Main status={status} onLoggedOut={check} />;
}

function Login({ status, onDone }: { status: Status; onDone: (recoveryCode: string | null) => void }) {
  const [showCode, setShowCode] = useState(!status.hasPasskey);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function login() {
    setBusy(true);
    setError('');
    try {
      const { options, challengeId } = await post<{ options: AuthOptions; challengeId: string }>('/api/auth/login/options');
      const response = await startAuthentication({ optionsJSON: options });
      await post('/api/auth/login/verify', { challengeId, response });
      onDone(null);
    } catch (e) {
      setError(String(e).includes('rate-limited') ? TEXT.rateLimited : TEXT.loginFailed);
    } finally {
      setBusy(false);
    }
  }

  async function register(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(await createPasskey(code));
    } catch (err) {
      const s = String(err);
      setError(s.includes('code') ? TEXT.codeInvalid : s.includes('rate-limited') ? TEXT.rateLimited : TEXT.passkeyFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="card">
      {status.hasPasskey && (
        <button class="rb-btn rb-primary" disabled={busy} onClick={login}>
          {TEXT.login}
        </button>
      )}
      {status.hasPasskey && !showCode && (
        <p>
          <button class="rb-btn rb-btn-small" onClick={() => setShowCode(true)}>
            {TEXT.useCode}
          </button>
        </p>
      )}
      {showCode && (
        <form onSubmit={register}>
          <h2>{TEXT.setupTitle}</h2>
          <p class="rb-muted">{TEXT.setupText}</p>
          <label>
            {TEXT.code}
            <input value={code} autocomplete="one-time-code" autocapitalize="characters" spellcheck={false} onInput={(e) => setCode((e.target as HTMLInputElement).value)} />
          </label>
          <button class="rb-btn rb-primary" type="submit" disabled={busy || code.trim().length < 8}>
            {TEXT.createPasskey}
          </button>
        </form>
      )}
      {error && <p class="rb-error">{error}</p>}
      <p class="rb-muted rb-small">{TEXT.loginNote}</p>
    </div>
  );
}

function Main({ status, onLoggedOut }: { status: Status; onLoggedOut: () => void }) {
  const api = useMemo(() => createJourneyApi('/api/journey', { onUnauthorized: onLoggedOut }), [onLoggedOut]);
  const [note, setNote] = useState('');

  async function addPasskey() {
    try {
      await createPasskey();
      setNote(TEXT.added);
    } catch {
      setNote(TEXT.passkeyFailed);
    }
  }

  async function logout() {
    await post('/api/auth/logout').catch(() => {});
    onLoggedOut();
  }

  return (
    <main class="shell">
      <div class="top">
        <h1>
          {TEXT.title} <span class="rb-beta">{TEXT.beta}</span>
        </h1>
        <button class="rb-btn rb-btn-small" onClick={logout}>
          {TEXT.logout}
        </button>
      </div>
      {note && <p class="rb-muted">{note}</p>}
      {!status.configured && <div class="card notice">{TEXT.noContact}</div>}
      <div class="card journey">
        <JourneyView api={api} canEdit lang={lang} />
      </div>
      <p class="foot rb-small">
        <button class="rb-btn rb-btn-small" onClick={addPasskey}>
          {TEXT.addPasskey}
        </button>{' '}
        <a href="https://github.com/christianender-da/reisebegleitung" target="_blank" rel="noopener noreferrer">
          reisebegleitung {status.version}
        </a>
      </p>
    </main>
  );
}
