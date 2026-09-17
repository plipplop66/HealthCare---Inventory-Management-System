import { useEffect, useMemo, useRef, useState } from 'react';
import './auth.css';
import { Icon } from './components/Icon';
import { AuthScreen } from './components/AuthScreen';
import { Button, EmptyOrError } from './components/ui';
import { medrippleApi, usingMockData } from './services/medrippleApi';
import { noSafePlanOutcome } from './services/optimizationOutcome';
import { createPlanSelection, loadSelectedPlan } from './services/planSelection';
import { mapAudit, mapDashboard, mapFacilityDetail } from './services/viewModels';
import { Dashboard } from './pages/Dashboard';
import { FacilityDetail } from './pages/FacilityDetail';
import { RippleSimulator } from './pages/RippleSimulator';
import { PlanReview } from './pages/PlanReview';
import { AuditTrail } from './pages/AuditTrail';

const navItems = [
  ['dashboard', 'dashboard', 'grid'],
  ['facility', 'facility detail', 'building'],
  ['candidates', 'candidates', 'users'],
  ['simulator', 'ripple simulator', 'ripple'],
  ['plan', 'plan review', 'clipboard'],
  ['audit', 'audit trail', 'activity'],
];

let sessionStore;
try { sessionStore = typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { /* Storage may be disabled. */ }
const planSelection = createPlanSelection(sessionStore);

function Shell({ active, onNavigate, children, menuOpen, setMenuOpen, dataLabel, user, onSignOut, facilityCount }) {
  const current = navItems.find(([id]) => id === active)?.[1] || 'dashboard';
  const initials = user?.name?.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'MR';
  return <div className="workspace-shell">
    <aside className={`workspace-sidebar ${menuOpen ? 'open' : ''}`} aria-label="primary navigation">
      <div className="brand-row"><div className="brand-icon"><Icon name="ripple" size={18} /></div><div><strong>medripple</strong><span>care, connected.</span></div><button className="menu-close" aria-label="close navigation" onClick={() => setMenuOpen(false)}><Icon name="close" /></button></div>
      <p className="nav-label">workspace</p>
      <nav>{navItems.map(([id, label, icon]) => <button key={id} className={active === id ? 'active' : ''} onClick={() => { onNavigate(id); setMenuOpen(false); }}><Icon name={icon} size={16} /><span>{label}</span></button>)}</nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-footer"><p><i />network snapshot</p><small>{facilityCount} facilities monitored · refreshes every 30s</small><div className="profile"><div>{initials}</div><p><strong>{user?.name || 'workspace user'}</strong><small>{user?.role?.toLowerCase() || 'operator'} account</small></p><button className="sign-out" type="button" onClick={onSignOut} aria-label="sign out"><Icon name="logout" size={15} /></button></div></div>
    </aside>
    {menuOpen && <button className="sidebar-backdrop" aria-label="close navigation" onClick={() => setMenuOpen(false)} />}
    <main className="workspace-main">
      <header className="workspace-topbar"><button className="menu-open" aria-label="open navigation" onClick={() => setMenuOpen(true)}><Icon name="menu" /></button><p>workspace <Icon name="chevron" size={12} /> <strong>{current}</strong></p><div>{usingMockData && <span className="top-pill mock-pill">MOCK DATA</span>}<span className="top-pill"><i />simulated data · decision support</span><span className="top-pill">{dataLabel || 'loading'}</span></div></header>
      {usingMockData && <p className="mock-banner" role="status">MOCK DATA: this workspace is not connected to the MEDRIPPLE API. Nothing shown here is a real result.</p>}
      <div className="workspace-page">{children}</div>
      <footer>prototype decision support - all transfers require human approval.<span>{dataLabel}</span></footer>
    </main>
  </div>;
}

function App() {
  const [view, setView] = useState('dashboard');
  const [menuOpen, setMenuOpen] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [dashboardError, setDashboardError] = useState(null);
  const [focus, setFocus] = useState(null);
  const [horizonDays, setHorizonDays] = useState(14);
  const [quantity, setQuantity] = useState('');
  const [outcome, setOutcome] = useState(null);
  const [assessError, setAssessError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState({ key: '', data: null, error: null });
  const [version, setVersion] = useState(0);
  const [message, setMessage] = useState('');
  const refreshing = useRef(false);

  const loadDashboard = async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const [summary, facilities, medicines] = await Promise.all([medrippleApi.regionSummary(), medrippleApi.facilities(), medrippleApi.medicines()]);
      setDashboard(mapDashboard(summary, facilities, medicines));
      setDashboardError(null);
    } catch (error) {
      if (error.status === 401) setUser(null);
      else setDashboardError(error);
    } finally { refreshing.current = false; }
  };

  useEffect(() => {
    let active = true;
    medrippleApi.restoreSession()
      .then((sessionUser) => { if (active) setUser(sessionUser); })
      .catch(() => { if (active) setUser(null); })
      .finally(() => { if (active) setAuthReady(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (user) loadDashboard(); }, [user]);
  useEffect(() => {
    if (!user) return undefined;
    const refresh = () => { if (!document.hidden) loadDashboard(); };
    const timer = window.setInterval(refresh, 30000);
    return () => window.clearInterval(timer);
  }, [user]);

  const target = useMemo(() => {
    if (!dashboard) return null;
    const id = focus?.facilityId || dashboard.earliestStockout?.facilityId || dashboard.rows[0]?.id;
    const row = dashboard.rows.find((item) => item.id === id);
    if (!row) return null;
    return { facilityId: row.id, facilityName: row.name, medicineId: focus?.medicineId || row.medicineId, medicineName: row.medicine, unit: row.unit };
  }, [dashboard, focus]);

  const pageKey = view === 'facility' && target ? `facility:${target.facilityId}:${target.medicineId}:${horizonDays}:${version}`
    : view === 'plan' ? `plan:${version}` : view === 'audit' ? `audit:${version}` : '';
  useEffect(() => {
    if (!user || !pageKey) return undefined;
    let active = true;
    setPage({ key: pageKey, data: null, error: null });
    const load = async () => {
      if (view === 'facility') {
        const inventory = await medrippleApi.inventory(target.facilityId, target.medicineId);
        let forecast = null;
        let forecastError = null;
        try { forecast = await medrippleApi.forecast({ facilityId: target.facilityId, medicineId: target.medicineId, horizonDays }); } catch (error) {
          if (error.status === 401) throw error;
          forecastError = error;
        }
        return mapFacilityDetail({ inventory, forecast, forecastError, horizonDays });
      }
      if (view === 'plan') return loadSelectedPlan(planSelection, (id) => medrippleApi.plan(id));
      return mapAudit(await medrippleApi.audit());
    };
    load().then((data) => { if (active) setPage({ key: pageKey, data, error: null }); })
      .catch((error) => { if (!active) return; if (error.status === 401) setUser(null); else setPage({ key: pageKey, data: null, error }); });
    return () => { active = false; };
  }, [user, pageKey]);

  const runAssessment = async () => {
    const amount = Number(quantity);
    if (!target || !Number.isFinite(amount) || amount <= 0) { setAssessError({ message: 'Enter a positive quantity.' }); return; }
    setBusy(true);
    setAssessError(null);
    setOutcome(null);
    planSelection.set(null);
    try {
      const plan = await medrippleApi.optimize({ destinationFacilityId: target.facilityId, medicineId: target.medicineId, quantity: amount, horizonDays });
      planSelection.set({ planId: plan.data.id });
      setOutcome({ plan });
    } catch (error) {
      try {
        const noSafe = noSafePlanOutcome(error, { horizon: horizonDays, quantity: amount });
        planSelection.set(noSafe);
        setOutcome(noSafe);
      } catch (other) { setAssessError(other); }
    } finally { setBusy(false); }
  };

  const decide = async (decision, note) => {
    setBusy(true);
    setMessage('');
    try {
      const { data } = await medrippleApi.decide(page.data.data.id, decision, note);
      setMessage(`Plan is now ${data.plan.status}.`);
      setVersion((current) => current + 1);
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  };

  const transition = async (action, note) => {
    setBusy(true);
    setMessage('');
    try {
      const { data } = await medrippleApi.transition(page.data.data.id, action, note);
      setMessage(`Plan is now ${data.plan.status}.`);
      setVersion((current) => current + 1);
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  };

  const onAuthenticated = (sessionUser) => { setView('dashboard'); setDashboard(null); setUser(sessionUser); };
  const onSignOut = async () => {
    await medrippleApi.logout();
    planSelection.set(null);
    setUser(null);
    setDashboard(null);
    setOutcome(null);
  };
  const openFacility = (facilityId, medicineId) => { setFocus({ facilityId, medicineId }); setView('facility'); };

  const content = (() => {
    if (view === 'dashboard') return <Dashboard data={dashboard} onOpenFacility={openFacility} />;
    if (view === 'candidates') return <EmptyOrError title="No donor assessment yet" copy="Donor candidates come from the optimizer's assessment. Run the ripple simulator to see eligible and rejected donors." actionLabel="open ripple simulator" retry={() => setView('simulator')} />;
    if (view === 'simulator') return <RippleSimulator target={target} horizonDays={horizonDays} quantity={quantity} onQuantity={setQuantity} onHorizon={setHorizonDays} onRun={runAssessment} busy={busy} outcome={outcome} error={assessError} onReview={() => setView('plan')} />;
    if (page.key !== pageKey || (!page.data && !page.error)) return <p role="status">Loading {view} from the API…</p>;
    if (page.error) return <EmptyOrError title="This section is unavailable" copy={page.error.message} retry={() => setVersion((current) => current + 1)} />;
    if (view === 'facility') return <FacilityDetail data={page.data} onAssess={() => setView('simulator')} />;
    if (view === 'plan') {
      if (page.data.noSelectedPlan) return <EmptyOrError title="Select a plan to review" copy="Run a safety assessment in the ripple simulator first. Opening this page never creates a plan." actionLabel="open ripple simulator" retry={() => setView('simulator')} />;
      if (page.data.noSafePlan) return <EmptyOrError title="Your latest assessment found no safe plan" copy="No transfer can be approved. Open the simulator for capacity and reasons." actionLabel="open ripple simulator" retry={() => setView('simulator')} />;
      return <PlanReview key={page.data.data.id} plan={page.data} canDecide={['APPROVER', 'ADMIN'].includes(user?.role)} busy={busy} onDecision={decide} onLifecycle={transition} message={message} />;
    }
    return <AuditTrail data={page.data} />;
  })();

  if (!authReady) return <div className="app-state"><Icon name="ripple" size={28} /><strong>loading medripple</strong><span>checking your session…</span></div>;
  if (!user) return <AuthScreen api={medrippleApi} onAuthenticate={onAuthenticated} />;
  if (dashboardError && !dashboard) return <div className="app-state"><EmptyOrError title="regional workspace unavailable" copy={dashboardError.message} retry={loadDashboard} /><Button onClick={onSignOut}>sign out</Button></div>;
  if (!dashboard) return <div className="app-state"><Icon name="ripple" size={28} /><strong>loading medripple</strong><span>reading the regional snapshot from the API…</span></div>;
  return <Shell active={view} onNavigate={setView} menuOpen={menuOpen} setMenuOpen={setMenuOpen} dataLabel={dashboard.dataFreshness} facilityCount={dashboard.facilitiesMonitored} user={user} onSignOut={onSignOut}>
    {content}
  </Shell>;
}

export default App;
