import { useState } from 'react';
import { Icon } from './Icon';

export function AuthScreen({ onAuthenticate, api, notice = '' }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setError('');
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (mode === 'signup' && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const session = mode === 'login'
        ? await api.login({ email, password })
        : await api.register({ name, email, password });
      onAuthenticate(session.user);
    } catch (requestError) {
      setError(requestError.message || 'We could not complete that request.');
    } finally {
      setBusy(false);
    }
  };

  const signingUp = mode === 'signup';
  return <main className="auth-page">
    <section className="auth-intro" aria-label="MEDRIPPLE introduction">
      <div className="auth-brand"><span className="auth-brand-mark"><Icon name="ripple" size={23} /></span><div><strong>MEDRIPPLE</strong><span>Care, connected.</span></div></div>
      <div className="auth-copy"><p className="eyebrow">REGIONAL RESILIENCE WORKSPACE</p><h1>Make shortage decisions with the whole network in view.</h1><p>Review projected medicine risk, compare safe transfer plans, and preserve an accountable decision record.</p></div>
      <ul className="auth-benefits">
        <li><Icon name="ripple" /> Forecast and ripple simulation</li>
        <li><Icon name="shield" /> Safety-constrained transfer plans</li>
        <li><Icon name="clipboard" /> Human approval and audit history</li>
      </ul>
      <p className="auth-boundary"><Icon name="alert" />All records are simulated. This is decision support, not clinical advice or an autonomous transfer system.</p>
    </section>
    <section className="auth-panel-wrap">
      <form className="auth-panel" onSubmit={submit} noValidate>
        <div className="auth-tabs" role="tablist" aria-label="Account access">
          <button type="button" role="tab" aria-selected={!signingUp} className={!signingUp ? 'selected' : ''} onClick={() => switchMode('login')}>Sign in</button>
          <button type="button" role="tab" aria-selected={signingUp} className={signingUp ? 'selected' : ''} onClick={() => switchMode('signup')}>Create account</button>
        </div>
        <div className="auth-heading"><p className="eyebrow">{signingUp ? 'NEW WORKSPACE ACCOUNT' : 'WELCOME BACK'}</p><h2>{signingUp ? 'Create an operator account' : 'Sign in to MEDRIPPLE'}</h2><p>{signingUp ? 'New accounts can explore the workspace. Approval authority is assigned after organisational verification.' : 'Use your approved workspace credentials to continue.'}</p></div>
        {signingUp && <label className="auth-field">Full name<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength="120" required placeholder="Your name" /></label>}
        <label className="auth-field">Email address<input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" type="email" maxLength="254" required placeholder="name@organisation.org" /></label>
        <label className="auth-field">Password<input value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={signingUp ? 'new-password' : 'current-password'} type="password" minLength="10" maxLength="200" required placeholder="At least 10 characters" /></label>
        {signingUp && <label className="auth-field">Confirm password<input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" type="password" minLength="10" maxLength="200" required placeholder="Repeat your password" /></label>}
        {notice && !error && <p className="auth-error" role="status"><Icon name="alert" size={16} />{notice}</p>}
        {error && <p className="auth-error" role="alert"><Icon name="alert" size={16} />{error}</p>}
        <button className="mr-button primary auth-submit" disabled={busy} type="submit">{busy ? 'Please wait…' : signingUp ? 'Create account' : 'Sign in'}<Icon name="arrow" /></button>
        {!signingUp && <p className="auth-privacy">Accounts and decisions are stored in the database. Create your own account; approval authority is assigned separately.</p>}
        <p className="auth-privacy">By continuing, you acknowledge this prototype uses simulated operational data. Never enter patient data or clinical records.</p>
      </form>
    </section>
  </main>;
}
