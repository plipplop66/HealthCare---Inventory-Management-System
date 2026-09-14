import React, { useEffect, useState } from 'react';
import { PageTransition, PageHead, Button, Card, Tag, DarkBanner, Grid, DotState, containerVariants, itemVariants } from '../components/ui';
import { motion } from 'framer-motion';
import { getRippleSimulation } from '../apiService';
import { IconShieldCheck, IconAlertTriangle } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';

const FacilityRow = ({ f }) => (
  <motion.tr variants={itemVariants}>
    <td>
      <span style={{ color: 'var(--primary-brand)', fontSize: '10px', fontWeight: 600 }}>{f.role.toUpperCase()}</span><br/>
      {f.facilityName} <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>({f.facilityType})</span>
    </td>
    <td>
      <span style={{ color: 'var(--text-primary)' }}>{f.effectiveStock}</span> 
      <span style={{ color: f.transferIn ? 'var(--text-success)' : 'inherit' }}> +{f.transferIn}</span> 
      <span style={{ color: f.transferOut ? 'var(--text-warning)' : 'inherit' }}> -{f.transferOut}</span><br/>
      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
        after: {f.stockAfterTransfers} · prot: {f.protectedStock}
      </span>
    </td>
    <td>
      {f.shortageDays} days<br/>
      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
        unmet: {f.unmetDemand}
      </span>
    </td>
    <td>
      <DotState 
        label={`${f.riskLabel} (${f.riskScore})`} 
        tone={f.riskLabel === 'CRITICAL' ? 'danger' : f.riskLabel === 'HIGH' ? 'warning' : f.riskLabel === 'MEDIUM' ? 'warning' : 'success'} 
      /><br/>
      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
        ending: {f.endingStock}
      </span>
    </td>
  </motion.tr>
);

export default function RippleSimulator() {
  const [data, setData] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    getRippleSimulation().then(setData);
  }, []);

  if (!data) return <div style={{ padding: '20px', color: 'var(--text-secondary)' }}>Loading simulation...</div>;

  const t = data.transfers[0];

  return (
    <PageTransition>
      <PageHead 
        eyeb="intervention modeling" 
        title={`${data.horizon}-day ripple simulation`} 
        sub={`Simulating ${data.transfers.length} transfer(s) · source: ${data.meta.source}`}
        rightHtml={<Button primary onClick={() => navigate('/plan')}>Submit evaluated plan</Button>}
      />
      
      <Grid cols={2}>
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <p style={{ fontSize: '13px', fontWeight: 500, margin: 0, color: 'var(--text-primary)' }}>before/after consequence</p>
            <Tag text="validated outcome" tone="success" />
          </div>
          <table className="mr-tbl" style={{ marginBottom: 0 }}>
            <thead>
              <tr>
                <th>facility</th>
                <th>stock movement</th>
                <th>shortage</th>
                <th>outcome</th>
              </tr>
            </thead>
            <motion.tbody variants={containerVariants} initial="hidden" animate="show">
              {data.facilities.map(f => <FacilityRow key={f.facilityId} f={f} />)}
            </motion.tbody>
          </table>
        </Card>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <DarkBanner>
            <p style={{ fontSize: '11px', color: '#A9CDD9', margin: '0 0 4px', fontWeight: 500 }}>TRANSFER EVALUATION</p>
            <p style={{ fontSize: '14px', fontWeight: 500, margin: '0 0 8px' }}>
              {t.donor} → {t.recipient}
            </p>
            <div style={{ display: 'flex', gap: '16px', fontSize: '11.5px', color: '#A9CDD9', marginBottom: '8px' }}>
              <span>{t.medicine}</span>
              <span style={{ color: '#fff', fontWeight: 500 }}>{t.quantity} {t.unit}</span>
            </div>
            <div style={{ fontSize: '10px', color: 'rgba(169, 205, 217, 0.7)' }}>
              Batch: {t.batch.number} (exp {t.batch.expiry})<br/>
              Route: {t.distanceKm} km · {t.travelHours} hrs · {t.coldChainAvailable ? 'cold-chain ok' : 'NO cold-chain'}
            </div>
            {!t.eligible && (
              <div style={{ background: '#451a1d', padding: '6px', borderRadius: '4px', marginTop: '8px', color: '#fca5a5', fontSize: '10px' }}>
                INELIGIBLE: {t.rejectionCodes.join(', ')}
              </div>
            )}
          </DarkBanner>
          
          <Card>
            <p style={{ fontSize: '13px', fontWeight: 500, margin: '0 0 12px' }}>regional impact summary</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <p style={{ fontSize: '10.5px', color: 'var(--text-secondary)', margin: '0 0 2px' }}>shortage days prevented</p>
                <p style={{ fontSize: '18px', fontWeight: 500, margin: 0, color: 'var(--text-success)' }}>{data.regionalOutcome.shortageDaysPrevented}</p>
                <p style={{ fontSize: '10px', color: 'var(--text-muted)' }}>before: {data.regionalOutcome.stockoutDaysBefore} · after: {data.regionalOutcome.stockoutDaysAfter}</p>
              </div>
              <div>
                <p style={{ fontSize: '10.5px', color: 'var(--text-secondary)', margin: '0 0 2px' }}>unmet demand reduced</p>
                <p style={{ fontSize: '18px', fontWeight: 500, margin: 0, color: 'var(--text-success)' }}>{data.regionalOutcome.unmetDemandReduced}</p>
                <p style={{ fontSize: '10px', color: 'var(--text-muted)' }}>before: {data.regionalOutcome.unmetDemandBefore} · after: {data.regionalOutcome.unmetDemandAfter}</p>
              </div>
            </div>
            
            <div style={{ height: '1px', background: 'var(--border)', margin: '12px 0' }}></div>
            
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              <span style={{ color: 'var(--text-primary)' }}>New risks:</span> {data.regionalOutcome.newRisks} · 
              <span style={{ color: 'var(--text-primary)' }}> Improved facilities:</span> {data.regionalOutcome.improvedFacilities}
            </div>
          </Card>
        </div>
      </Grid>
      
      <div style={{ height: '16px' }}></div>
      
      <div style={{ textAlign: 'right' }}>
        <p style={{ fontSize: '11.5px', color: 'var(--text-secondary)', margin: '0 0 8px' }}>
          Safe to recommend: <span style={{ color: data.regionalOutcome.safeToRecommend ? 'var(--text-success)' : 'var(--text-danger)', fontWeight: 500 }}>{data.regionalOutcome.safeToRecommend ? 'TRUE' : 'FALSE'}</span>
        </p>
        <Button primary onClick={() => navigate('/plan')} disabled={!data.regionalOutcome.safeToRecommend}>Forward safe plan to review</Button>
      </div>
    </PageTransition>
  );
}
