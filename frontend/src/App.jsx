import { useEffect, useMemo, useRef, useState } from 'react';
import './auth.css';
import { Icon } from './components/Icon';
import { AuthScreen } from './components/AuthScreen';
import { SelectionBar } from './components/SelectionBar';
import { Button, EmptyOrError } from './components/ui';
import { medrippleApi, usingMockData } from './services/medrippleApi';
import { completeSelection } from './services/selection';
import { createWorkspace } from './services/workspace';
import { mapCandidates } from './services/evidence';
import { Dashboard } from './pages/Dashboard';
import { Candidates } from './pages/Candidates';
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
  const workspace = useMemo(() => createWorkspace({ api: medrippleApi, storage: sessionStore }), []);
  const [view, setView] = useState('dashboard');
  const [menuOpen, setMenuOpen] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [dashboardError, setDashboardError] = useState(null);
  const [selection, setSelectionState] = useState(() => workspace.selection.get());
  const [assessment, setAssessment] = useState(null);
  const [assessError, setAssessError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState({ key: '', data: null, error: null });
  const [version, setVersion] = useState(0);
  const [message, setMessage] = useState('');
  const refreshing = useRef(false);

  const updateSelection = (patch) => setSelectionState(workspace.selection.set(patch));

  const loadDashboard = async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const loaded = await workspace.loadDashboard();
      setDashboard(loaded.dashboard);
      setCatalog(loaded.catalog);
      setSelectionState(workspace.selection.set(completeSelection(workspace.selection.get(), loaded.catalog, loaded.dashboard)));
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

  // The latest assessment is restored by plan ID after a refresh; opening a page never re-optimizes.
  useEffect(() => {
    if (!user || assessment || !workspace.hasAssessment()) return;
    workspace.loadAssessment().then(setAssessment).catch((error) => { if (error.status === 401) setUser(null); else setAssessError(error); });
  }, [user]);

  const pageKey = view === 'facility' && selection.facilityId && selection.medicineId ? `facility:${selection.facilityId}:${selection.medicineId}:${selection.horizonDays}:${version}`
    : view === 'plan' ? `plan:${version}` : view === 'candidates' ? `candidates:${version}` : view === 'audit' ? `audit:${version}` : '';
  useEffect(() => {
    if (!user || !pageKey) return undefined;
    let active = true;
    setPage({ key: pageKey, data: null, error: null });
    const load = view === 'facility' ? () => workspace.loadFacility(selection)
      : view === 'plan' ? () => workspace.loadAssessment().then((result) => ({ assessment: result }))
        : view === 'candidates' ? () => workspace.loadAssessment().then((result) => ({ candidates: mapCandidates(result) }))
        : () => workspace.loadAudit();
    load().then((data) => { if (active) setPage({ key: pageKey, data, error: null }); })
      .catch((error) => { if (!active) return; if (error.status === 401) setUser(null); else setPage({ key: pageKey, data: null, error }); });
    return () => { active = false; };
  }, [user, pageKey]);

  const runAssessment = async () => {
    const unit = catalog?.medicines.find((item) => item.id === selection.medicineId)?.unit;
    setBusy(true);
    setAssessError(null);
    setAssessment(null);
    try {
      setAssessment(await workspace.runAssessment(selection, unit));
    } catch (error) {
      if (error.status === 401) setUser(null);
      else setAssessError(error);
    } finally { setBusy(false); }
  };

  const decide = async (decision, note) => {
    setBusy(true);
    setMessage('');
    try {
      const { data } = await medrippleApi.decide(page.data.assessment.plan.data.id, decision, note);
      setMessage(`Plan is now ${data.plan.status}.`);
      setVersion((current) => current + 1);
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  };

  const transition = async (action, note) => {
    setBusy(true);
    setMessage('');
    try {
      const { data } = await medrippleApi.transition(page.data.assessment.plan.data.id, action, note);
      setMessage(`Plan is now ${data.plan.status}.`);
      setVersion((current) => current + 1);
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  };

  const onAuthenticated = (sessionUser) => { setView('dashboard'); setDashboard(null); setUser(sessionUser); };
  const onSignOut = async () => {
    await medrippleApi.logout();
    workspace.reset();
    setSelectionState(workspace.selection.get());
    setUser(null);
    setDashboard(null);
    setAssessment(null);
  };
  const openFacility = (facilityId, medicineId) => {
    updateSelection(medicineId ? { facilityId, medicineId } : { facilityId });
    setView('facility');
  };

  const content = (() => {
    if (view === 'dashboard') return <Dashboard data={dashboard} onOpenFacility={openFacility} />;
    if (view === 'simulator') return <RippleSimulator catalog={catalog} selection={selection} onSelection={updateSelection} onRun={runAssessment} busy={busy} assessment={assessment} error={assessError} onReview={() => setView('plan')} />;
    const selectionBar = view === 'facility' && <SelectionBar catalog={catalog} selection={selection} onChange={updateSelection} showQuantity={false} />;
    if (page.key !== pageKey || (!page.data && !page.error)) return <>{selectionBar}<p role="status">Loading {view} from the API…</p></>;
    if (page.error) return <>{selectionBar}<EmptyOrError title="This section is unavailable" copy={page.error.message} retry={() => setVersion((current) => current + 1)} /></>;
    if (view === 'facility') return <>{selectionBar}<FacilityDetail data={page.data} onAssess={() => setView('simulator')} /></>;
    if (view === 'candidates') return <Candidates data={page.data.candidates} onOpenSimulator={() => setView('simulator')} />;
    if (view === 'plan') {
      const selected = page.data.assessment;
      if (!selected) return <EmptyOrError title="Select a plan to review" copy="Run a safety assessment in the ripple simulator first. Opening this page never creates a plan." actionLabel="open ripple simulator" retry={() => setView('simulator')} />;
      if (selected.kind === 'MISSING') return <EmptyOrError title="The selected plan is no longer available" copy="Run a new assessment in the ripple simulator." actionLabel="open ripple simulator" retry={() => setView('simulator')} />;
      if (selected.kind === 'NO_SAFE_PLAN') return <EmptyOrError title="Your latest assessment found no safe plan" copy="No transfer can be approved. Open the simulator for capacity and reasons." actionLabel="open ripple simulator" retry={() => setView('simulator')} />;
      return <PlanReview key={selected.plan.data.id} plan={selected.plan} canDecide={['APPROVER', 'ADMIN'].includes(user?.role)} busy={busy} onDecision={decide} onLifecycle={transition} message={message} />;
    }
    return <AuditTrail data={page.data} />;
  })();

  if (!authReady) return <div className="app-state"><Icon name="ripple" size={28} /><strong>loading medripple</strong><span>checking your session…</span></div>;
  if (!user) return <AuthScreen api={medrippleApi} onAuthenticate={onAuthenticated} />;
  if (dashboardError && !dashboard) return <div className="app-state"><EmptyOrError title="regional workspace unavailable" copy={dashboardError.message} retry={loadDashboard} /><Button onClick={onSignOut}>sign out</Button></div>;
  if (!dashboard || !catalog) return <div className="app-state"><Icon name="ripple" size={28} /><strong>loading medripple</strong><span>reading the regional snapshot from the API…</span></div>;
  return <Shell active={view} onNavigate={setView} menuOpen={menuOpen} setMenuOpen={setMenuOpen} dataLabel={dashboard.dataFreshness} facilityCount={dashboard.facilitiesMonitored} user={user} onSignOut={onSignOut}>
    {content}
  </Shell>;
}

export default App;
