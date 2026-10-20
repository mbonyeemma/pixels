import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useGame } from '../state';
import { gameClient } from '../net/client';
import { loadLastLogin, loadToken } from '../net/storage';
import { validateLogin, isLoginValid } from '../net/validation';
import { useTypingHandlers } from '../hooks/useTyping';
import { IconCheck } from './icons';
import { SignInWithWalletSlot, WalletHostSlot } from '../wallet/slots';

export default function LoginScreen() {
  const loginError = useGame((s) => s.loginError);
  const loading = useGame((s) => s.loading);
  const last = useMemo(() => loadLastLogin(), []);
  const canContinue = useMemo(() => !!loadToken() && !!last?.username, [last]);
  const [username, setUsername] = useState(last?.username ?? '');
  const [email, setEmail] = useState(last?.email ?? '');
  const [touched, setTouched] = useState({ username: false, email: false });
  const [submitted, setSubmitted] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const typing = useTypingHandlers();
  const uid = useId();

  const errors = validateLogin(username, email);
  const showUser = (touched.username || submitted) && errors.username;
  const showEmail = (touched.email || submitted) && errors.email;
  const userOk = touched.username && !errors.username;
  const emailOk = touched.email && !errors.email;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setSubmitted(true);
    if (!isLoginValid(errors)) {
      (errors.username ? userRef.current : emailRef.current)?.focus();
      return;
    }
    void gameClient.login(username, email);
  };

  const blur = (field: 'username' | 'email') => {
    setTouched((t) => ({ ...t, [field]: true }));
    typing.onBlur();
  };

  return (
    <main className="login">
      <div className="login-bg" aria-hidden="true">
        {Array.from({ length: 14 }, (_, i) => (
          <i key={i} style={{ ['--i' as string]: i }} />
        ))}
      </div>
      <div className="login-wrap">
        <header className="brand">
          <div className="brand-logo" aria-hidden="true">
            {Array.from({ length: 9 }, (_, i) => (
              <i key={i} />
            ))}
          </div>
          <h1>Pixels</h1>
          <p>A tiny multiplayer town. Wander around, chat, shop and chase missions with your AI guide.</p>
        </header>

        <form className="login-card glass" onSubmit={submit} noValidate aria-labelledby={`${uid}-title`}>
          <h2 id={`${uid}-title`}>Enter the town</h2>

          {loginError ? (
            <div className="alert alert--error" role="alert">
              {loginError}
            </div>
          ) : null}

          {canContinue ? (
            <button type="button" className="btn btn--accent btn--block continue" disabled={loading} onClick={() => void gameClient.resume()}>
              Continue as <strong>{last?.username}</strong>
            </button>
          ) : null}

          <div className="field">
            <label htmlFor={`${uid}-u`}>Username</label>
            <div className="input-wrap">
              <input
                ref={userRef}
                id={`${uid}-u`}
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={16}
                placeholder="e.g. pixel_pal"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onFocus={typing.onFocus}
                onBlur={() => blur('username')}
                aria-invalid={!!showUser}
                aria-describedby={`${uid}-ue`}
                required
              />
              {userOk ? <IconCheck className="input-ok" size={16} /> : null}
            </div>
            <div id={`${uid}-ue`} className={`field-msg${showUser ? ' field-msg--error' : ''}`} aria-live="polite">
              {showUser ? errors.username : '3-16 letters, numbers or underscores.'}
            </div>
          </div>

          <div className="field">
            <label htmlFor={`${uid}-e`}>Email</label>
            <div className="input-wrap">
              <input
                ref={emailRef}
                id={`${uid}-e`}
                name="email"
                type="email"
                autoComplete="email"
                autoCapitalize="off"
                spellCheck={false}
                maxLength={120}
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onFocus={typing.onFocus}
                onBlur={() => blur('email')}
                aria-invalid={!!showEmail}
                aria-describedby={`${uid}-ee`}
                required
              />
              {emailOk ? <IconCheck className="input-ok" size={16} /> : null}
            </div>
            <div id={`${uid}-ee`} className={`field-msg${showEmail ? ' field-msg--error' : ''}`} aria-live="polite">
              {showEmail ? errors.email : 'Used as your account ID. We never email you.'}
            </div>
          </div>

          <button type="submit" className="btn btn--primary btn--block btn--lg" disabled={loading}>
            {loading ? (
              <>
                <span className="spinner spinner--sm" aria-hidden="true" /> Entering…
              </>
            ) : (
              'Enter the town'
            )}
          </button>

          <SignInWithWalletSlot />

          <p className="login-note">No password needed in this preview – we only use your email as your account ID.</p>
          <p className="login-note login-note--dim">Coins and items are mock, in-game only: they have no real-world value.</p>
        </form>
      </div>
      <WalletHostSlot />
    </main>
  );
}
