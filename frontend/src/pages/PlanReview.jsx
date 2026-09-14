import React, { useEffect, useState } from 'react';
import { PageTransition, PageHead, Tag, Card, Grid } from '../components/ui';
import { getPlanReview } from '../apiService';
import { IconShieldCheck, IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';

export default function PlanReview() {
  const [data, setData] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    getPlanReview().then(setData);
  }, []);

  if (!data) return <div style={{ padding: '20px', color: 'var(--text-secondary)' }}>Loading plan review...</div>;

  const t = data.batches[0];

  return (
    <PageTransition>
      <PageHead 
        eyeb={`plan id: ${data.planId} · ${data.status}`} 
        title="Final Transfer Instructions" 
        sub={`${data.solver.name} ${data.solver.modelVersion} · ${data.meta.source} ${data.meta.fallback ? '(Fallback)' : ''}`}
        rightHtml={<Tag text="human approval required" tone="warning" />}
      />
      
      <div style={{ background: 'var(--surface-1)', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', borderLeft: '4px solid var(--primary-brand)', fontSize: '11.5px', color: 'var(--text-secondary)' }}>
        <p style={{ margin: '0 0 4px', color: 'var(--text-primary)', fontWeight: 500 }}>
          Destination: {data.destination.facilityName} ({data.destination.facilityId})
        </p>
        <p style={{ margin: '0 0 4px' }}>
          {data.medicine.genericName} {data.medicine.strength} {data.medicine.dosageForm} · {data.allocatedQuantity} of {data.requestedQuantity} {data.medicine.unit} allocated.
        </p>
        <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '4px' }}>
          <IconInfoCircle size={14} /> DECISION SUPPORT ONLY. Pharmacist authorization required before physical transfer. 
          Solver validation: {data.solver.validationPassed ? <span style={{ color: 'var(--text-success)' }}>PASSED</span> : <span style={{ color: 'var(--text-danger)' }}>FAILED</span>}
        </p>
      </div>
      
      <Grid cols={2} style={{ gridTemplateColumns: '2fr 1fr' }}>
        <Card>
          <p style={{ fontSize: '11px', color: 'var(--primary-brand)', margin: '0 0 4px', fontWeight: 600 }}>SAFE SOURCING ROUTE</p>
          <p style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 4px' }}>Instruction Set (Batch 1/1)</p>
          <p style={{ fontSize: '11.5px', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
            The plan uses eligible donors while preserving each donor's protected stock floor.
          </p>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderTop: '0.5px solid var(--border)', paddingTop: '14px' }}>
            <div style={{ display: 'flex', gap: '12px' }}>
              <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: 'rgba(56, 189, 248, 0.2)', color: 'var(--primary-brand)', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                1
              </div>
              <div>
                <p style={{ fontSize: '10px', color: 'var(--text-secondary)', margin: '0 0 2px' }}>Source facility</p>
                <p style={{ fontSize: '13px', fontWeight: 500, margin: '0 0 2px', color: 'var(--text-primary)' }}>{t.source.facilityName} ({t.source.facilityId})</p>
                <p style={{ fontSize: '11.5px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>Deliver <b>{t.quantity} {data.medicine.unit}</b> of {data.medicine.genericName}</p>
                <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', margin: '6px 0 0', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span>Batch: {t.batch.number} · Expiry: {t.batch.expiryDate}</span>
                  <span>Departure Day: {t.timing.departureDay} · Arrival Date: {t.timing.arrivalDate}</span>
                  <span>Route: {t.routeSafety.distanceKm} km ({t.routeSafety.travelHours}h) · Cold-chain: {t.routeSafety.coldChainAvailable ? 'Yes' : 'NO'}</span>
                </div>
              </div>
            </div>
            
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: '10.5px', color: 'var(--text-secondary)', margin: '0 0 4px' }}>donor protection check</p>
              <div style={{ background: 'rgba(255,255,255,0.05)', padding: '6px 10px', borderRadius: '6px', display: 'inline-block', textAlign: 'left' }}>
                <p style={{ margin: '0 0 2px', fontSize: '10px', color: 'var(--text-muted)' }}>Safe capacity: {t.donorProtection.safeCapacity} {data.medicine.unit}</p>
                <p style={{ margin: '0 0 2px', fontSize: '10px', color: 'var(--text-muted)' }}>Retained floor: {t.donorProtection.retainedFloor} {data.medicine.unit}</p>
                <p style={{ margin: 0, fontSize: '10px', color: 'var(--text-success)' }}>Outcome: {t.donorProtection.simulationOutcome} risk</p>
              </div>
            </div>
          </div>
        </Card>
        
        <Card>
          <p style={{ fontSize: '14px', fontWeight: 500, margin: '0 0 14px' }}>execution summary</p>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', padding: '6px 0', borderBottom: '0.5px solid var(--border)' }}>
            <span style={{ color: 'var(--text-secondary)' }}>rationale</span>
            <span style={{ fontWeight: 500, color: 'var(--text-primary)', textAlign: 'right', maxWidth: '140px' }}>{data.decision.rationale}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', padding: '6px 0', borderBottom: '0.5px solid var(--border)' }}>
            <span style={{ color: 'var(--text-secondary)' }}>shortage prevented</span>
            <span style={{ fontWeight: 500, color: 'var(--text-success)' }}>{data.decision.shortageDaysPrevented} days</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', padding: '6px 0', borderBottom: '0.5px solid var(--border)' }}>
            <span style={{ color: 'var(--text-secondary)' }}>unmet demand reduced</span>
            <span style={{ fontWeight: 500, color: 'var(--text-success)' }}>{data.decision.unmetDemandReduced} {data.medicine.unit}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', padding: '6px 0 14px' }}>
            <span style={{ color: 'var(--text-secondary)' }}>safe to recommend</span>
            <span style={{ fontWeight: 500, color: data.decision.safeToRecommend ? 'var(--text-success)' : 'var(--text-danger)' }}>{data.decision.safeToRecommend ? 'TRUE' : 'FALSE'}</span>
          </div>
          
          <label style={{ fontSize: '10.5px', color: 'var(--text-secondary)' }}>approval note <span style={{ color: 'var(--text-muted)' }}>optional</span></label>
          <textarea 
            placeholder="Add an operational note for the audit trail" 
            style={{ width: '100%', minHeight: '50px', margin: '6px 0 12px', padding: '8px', borderRadius: '8px', border: '0.5px solid var(--border)', background: 'rgba(255,255,255,0.05)', fontSize: '11.5px', fontFamily: 'inherit', color: 'var(--text-primary)' }}
          ></textarea>
          
          <button 
            onClick={() => navigate('/audit')} 
            disabled={!data.decision.safeToRecommend || data.status !== 'PROPOSED' || !data.solver.validationPassed}
            style={{ 
              width: '100%', cursor: 'pointer', background: 'var(--primary-brand)', color: '#0B1120', border: 'none', padding: '10px', borderRadius: '8px', fontSize: '13px', marginBottom: '8px', fontWeight: 500, transition: 'box-shadow 0.2s', 
              boxShadow: '0 0 10px rgba(56, 189, 248, 0.2)',
              opacity: (!data.decision.safeToRecommend || data.status !== 'PROPOSED' || !data.solver.validationPassed) ? 0.5 : 1
            }}
          >
            approve transfers ✓
          </button>
          <button style={{ width: '100%', cursor: 'pointer', background: 'var(--bg-danger)', color: 'var(--text-danger)', border: 'none', padding: '10px', borderRadius: '8px', fontSize: '13px', marginBottom: '10px' }}>
            reject and re-route
          </button>
          
          <p onClick={() => navigate('/audit')} style={{ fontSize: '11px', color: 'var(--text-accent)', margin: 0, textAlign: 'center', cursor: 'pointer' }}>
            view decision record →
          </p>
        </Card>
      </Grid>
    </PageTransition>
  );
}
