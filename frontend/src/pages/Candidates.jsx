import React, { useEffect, useState } from 'react';
import { PageTransition, PageHead, Button, Grid, Stat, Card, Tag, containerVariants, itemVariants } from '../components/ui';
import { motion } from 'framer-motion';
import { getCandidates } from '../apiService';
import { IconShieldCheck, IconAlertCircle, IconAlertTriangle } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';

export default function Candidates() {
  const [data, setData] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    getCandidates().then(setData);
  }, []);

  if (!data) return <div style={{ padding: '20px', color: 'var(--text-secondary)' }}>Loading candidates...</div>;

  const hasSafePlan = data.candidates.some(c => c.status === 'SELECTED');

  return (
    <PageTransition>
      <PageHead 
        eyeb="transfer safety" 
        title="Optimizer candidates evaluated" 
        sub={`Requested ${data.requestedQuantity} ${data.unit} for PHC-VLR-001`}
        rightHtml={<Button primary onClick={() => navigate('/simulator')} disabled={!hasSafePlan}>Simulate best transfer</Button>}
      />
      
      {!hasSafePlan ? (
        <div style={{ background: 'var(--bg-danger)', borderRadius: '12px', padding: '16px 20px', marginBottom: '16px', border: '1px solid var(--border-danger)' }}>
          <p style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-danger)', margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <IconAlertCircle size={18} /> NO_SAFE_PLAN: No viable donor candidates found
          </p>
          <p style={{ fontSize: '12px', color: 'var(--text-danger)', margin: '0 0 12px' }}>
            All potential donors would violate their protected safety stock or cold-chain constraints. The solver could not meet the {data.requestedQuantity} {data.unit} demand.
          </p>
          <div style={{ background: 'rgba(255,255,255,0.1)', padding: '10px', borderRadius: '8px' }}>
            <p style={{ fontSize: '11px', fontWeight: 500, margin: '0 0 4px', color: 'var(--text-danger)' }}>ESCALATION SUGGESTIONS:</p>
            <ul style={{ fontSize: '11.5px', color: 'var(--text-danger)', margin: 0, paddingLeft: '20px' }}>
              <li>Trigger an emergency procurement request for PHC-VLR-001.</li>
              <li>Consult the District Health Officer to override protected stock thresholds.</li>
              <li>Check alternative medicine formulations if clinically appropriate.</li>
            </ul>
          </div>
        </div>
      ) : (
        <div style={{ background: 'var(--bg-warning)', borderRadius: '12px', padding: '14px 18px', marginBottom: '16px' }}>
          <p style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-warning)', margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <IconAlertTriangle size={16} /> downstream ripple danger evaluated
          </p>
          <p style={{ fontSize: '11.5px', color: 'var(--text-warning)', margin: 0 }}>
            Solver evaluates multi-source splits to avoid breaching any individual facility's protected safety stock.
          </p>
        </div>
      )}
      
      <Grid cols={3}>
        <Stat label="total safe capacity" value={`${data.totalSafeCapacity} ${data.unit}`} sub={`Across ${data.counts.selected + data.counts.eligibleNotSelected} eligible donors`} />
        <Stat label="allocated quantity" value={`${data.allocatedQuantity} ${data.unit}`} sub={`Requested: ${data.requestedQuantity} ${data.unit}`} />
        <Stat label="candidate counts" value={`${data.counts.selected} selected`} sub={`${data.counts.rejected} rejected | ${data.counts.eligibleNotSelected} eligible-not-selected`} />
      </Grid>
      
      <div style={{ height: '16px' }}></div>
      
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
          <p style={{ fontSize: '13px', fontWeight: 500, margin: 0, color: 'var(--text-primary)' }}>donor assessment</p>
          <Tag text="human review required" tone="warning" />
        </div>
        <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '0 0 12px' }}>
          exact presentation matching, retained floor, route conditions ({data.maxTravelHours}h limit), and expiry are checked for every option.
        </p>
        
        <div style={{ overflowX: 'auto' }}>
          <table className="mr-tbl">
            <thead>
              <tr>
                <th>facility</th>
                <th>current position & protection</th>
                <th>allocation & route</th>
                <th>feasibility reasons</th>
              </tr>
            </thead>
            <motion.tbody variants={containerVariants} initial="hidden" animate="show">
              {data.candidates.map(c => (
                <motion.tr variants={itemVariants} key={c.facilityId}>
                  <td>
                    <span style={{ color: 'var(--text-primary)' }}>{c.facilityName}</span><br/>
                    <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                      {c.facilityId} · {c.facilityType}
                    </span>
                  </td>
                  <td>
                    {c.effectiveStock} {data.unit} available<br/>
                    <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                      Demand: {c.predictedDailyDemand}/day · Risk: {c.baselineRiskLabel} ({c.baselineRiskScore})<br/>
                      Retained Floor: {c.retainedFloor} {data.unit} (Equity: {c.equityUplift})<br/>
                      Safe Capacity: {c.safeCapacity} {data.unit}
                    </span>
                  </td>
                  <td>
                    <span style={{ color: c.status === 'SELECTED' ? 'var(--text-success)' : 'inherit' }}>
                      {c.status} ({c.allocatedQuantity} {data.unit})
                    </span><br/>
                    <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                      {c.distanceKm} km · {c.travelHours} hrs · {c.coldChainAvailable ? 'cold-chain ok' : 'NO cold-chain'}
                    </span>
                  </td>
                  <td>
                    {c.status === 'SELECTED' ? (
                      <Tag text="safe candidate" tone="success" />
                    ) : (
                      <>
                        <Tag text="rejected" tone="danger" />
                        <ul style={{ paddingLeft: '14px', margin: '6px 0 0', fontSize: '10.5px', color: 'var(--text-secondary)' }}>
                          {c.rejectionReasons.map((reason, i) => (
                            <li key={i}>{reason}</li>
                          ))}
                        </ul>
                        <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '4px' }}>
                          Codes: {c.rejectionCodes.join(', ')}
                        </div>
                      </>
                    )}
                  </td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        </div>
      </Card>
      
      <div style={{ height: '14px' }}></div>
      
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p style={{ fontSize: '11.5px', color: 'var(--text-secondary)', margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <IconShieldCheck size={16} /> candidates[].safeCapacity represents genuine safety based on full horizon logic.
        </p>
        <Button primary onClick={() => navigate('/simulator')} disabled={!hasSafePlan}>Compare safe plan</Button>
      </div>
    </PageTransition>
  );
}
