import React from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { 
  IconActivity, 
  IconLayoutDashboard, 
  IconBuildingHospital, 
  IconUsers, 
  IconFileCheck, 
  IconHistory, 
  IconHelpCircle, 
  IconLogout,
  IconChevronRight
} from '@tabler/icons-react';

import Dashboard from './pages/Dashboard';
import FacilityDetail from './pages/FacilityDetail';
import Candidates from './pages/Candidates';
import RippleSimulator from './pages/RippleSimulator';
import PlanReview from './pages/PlanReview';
import AuditTrail from './pages/AuditTrail';

const NavItem = ({ to, icon: Icon, label, badge }) => {
  const location = useLocation();
  const isActive = location.pathname === to || (to === '/' && location.pathname === '/dashboard');
  
  return (
    <Link to={to} className={`mr-nav ${isActive ? 'active' : ''}`} style={{ padding: '10px 12px', color: isActive ? '#fff' : '#9AA7B4', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', textDecoration: 'none' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <Icon size={16} />
        {label}
      </span>
      {badge && (
        <span style={{ background: '#2C3A47', color: '#9AA7B4', fontSize: '10px', padding: '1px 7px', borderRadius: '9px' }}>
          {badge}
        </span>
      )}
    </Link>
  );
};

const Layout = ({ children }) => {
  const location = useLocation();
  
  // Create breadcrumb from pathname
  const pathNames = {
    '/': 'dashboard',
    '/dashboard': 'dashboard',
    '/facility': 'facility detail',
    '/candidates': 'candidates',
    '/simulator': 'ripple simulator',
    '/plan': 'plan review',
    '/audit': 'audit trail'
  };
  const currentPath = pathNames[location.pathname] || 'dashboard';

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--surface-0)' }}>
      {/* Sidebar */}
      <div className="glass" style={{ width: '240px', background: 'var(--surface-1)', borderRight: '1px solid var(--border)', flexShrink: 0, padding: '24px 0', display: 'flex', flexDirection: 'column', zIndex: 10 }}>
        <div style={{ padding: '0 20px 24px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '38px', height: '38px', borderRadius: '12px', background: 'var(--primary-brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 20px rgba(56, 189, 248, 0.4)' }}>
            <IconActivity size={20} color="#0B1120" />
          </div>
          <div>
            <p style={{ color: '#fff', fontSize: '16px', fontWeight: 600, letterSpacing: '-0.5px', margin: 0 }}>medripple</p>
            <p style={{ color: 'var(--text-accent)', fontSize: '11px', fontWeight: 500, margin: 0 }}>care, connected.</p>
          </div>
        </div>
        
        <p style={{ padding: '12px 24px 8px', color: 'var(--text-secondary)', fontSize: '10px', letterSpacing: '1px', margin: 0, textTransform: 'uppercase', fontWeight: 600 }}>workspace</p>
        
        <NavItem to="/dashboard" icon={IconLayoutDashboard} label="dashboard" />
        <NavItem to="/facility" icon={IconBuildingHospital} label="facility detail" />
        <NavItem to="/candidates" icon={IconUsers} label="candidates" badge="5" />
        <NavItem to="/simulator" icon={IconActivity} label="ripple simulator" />
        <NavItem to="/plan" icon={IconFileCheck} label="plan review" />
        <NavItem to="/audit" icon={IconHistory} label="audit trail" />

        <div style={{ flex: 1 }}></div>
        
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)' }}>
          <p style={{ fontSize: '11.5px', color: 'var(--text-primary)', margin: 0, fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ color: 'var(--text-success)', filter: 'drop-shadow(0 0 6px var(--text-success))' }}>●</span> network snapshot
          </p>
          <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '4px 0 16px' }}>8 facilities connected</p>
          <p style={{ fontSize: '11.5px', color: 'var(--text-primary)', margin: '0 0 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', transition: 'color 0.2s' }} className="hover-highlight">
            <IconHelpCircle size={16} /> workspace guide
          </p>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', padding: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: '12px', border: '1px solid var(--border)', transition: 'background 0.2s' }}>
            <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'var(--primary-brand)', color: '#0B1120', fontSize: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              DA
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: '12px', color: '#fff', fontWeight: 500, margin: 0 }}>demo approver</p>
              <p style={{ fontSize: '10px', color: 'var(--text-secondary)', margin: 0 }}>approver account</p>
            </div>
            <IconLogout size={16} color="var(--text-secondary)" />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div className="glass" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 32px', borderBottom: '1px solid var(--border)', background: 'var(--surface-1)', zIndex: 5 }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500, letterSpacing: '0.5px', textTransform: 'uppercase' }}>
            workspace <IconChevronRight size={14} /> <span style={{ color: 'var(--primary-brand)' }}>{currentPath}</span>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <span className="mr-pill" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><span style={{ color: 'var(--text-danger)', fontSize: '10px', filter: 'drop-shadow(0 0 4px var(--text-danger))' }}>●</span> demo workspace</span>
            <span className="mr-pill">live fixture</span>
          </div>
        </div>
        
        {/* Page Content */}
        <div style={{ padding: '24px 28px', overflowY: 'auto', flex: 1 }}>
          <AnimatePresence mode="wait">
            <Routes location={location} key={location.pathname}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/facility" element={<FacilityDetail />} />
              <Route path="/candidates" element={<Candidates />} />
              <Route path="/simulator" element={<RippleSimulator />} />
              <Route path="/plan" element={<PlanReview />} />
              <Route path="/audit" element={<AuditTrail />} />
            </Routes>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};

export default function App() {
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  );
}
