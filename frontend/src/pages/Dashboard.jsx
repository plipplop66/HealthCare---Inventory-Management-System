import React, { useEffect, useState } from 'react';
import { PageTransition, PageHead, Button, Grid, Stat, Card, DotState, containerVariants, itemVariants } from '../components/ui';
import { motion } from 'framer-motion';
import { getDashboardData } from '../apiService';
import { IconMapPin } from '@tabler/icons-react';

export default function Dashboard() {
  const [data, setData] = useState(null);

  useEffect(() => {
    getDashboardData().then(setData);
  }, []);

  if (!data) return <div style={{ padding: '20px', color: 'var(--text-secondary)' }}>Loading dashboard...</div>;

  return (
    <PageTransition>
      <PageHead 
        eyeb="regional overview" 
        title="Network resilience at a glance" 
        sub={`${data.totalFacilities} facilities · updated ${data.dataFreshness} · source: ${data.meta.source}`}
        rightHtml={<Button>View all facilities</Button>}
      />
      
      <Grid cols={4}>
        <Stat label="resilience score" value={data.resilienceScore} sub="out of 100" />
        <Stat label="critical facilities" value={data.criticalFacilityCount} sub={`of ${data.totalFacilities} connected`} />
        <Stat label="earliest stockout" value={`${data.earliestStockout.daysRemaining} days`} sub={`${data.earliestStockout.facilityName} · ${data.earliestStockoutDate || data.earliestStockout.stockoutDate}`} />
        <Stat label="regional impact" value={`${data.regionalShortageDaysPrevented} days`} sub="shortage days prevented" />
      </Grid>
      
      <div style={{ height: '16px' }}></div>
      
      <Card>
        <p style={{ fontSize: '14px', fontWeight: 500, margin: '0 0 12px' }}>facility status table / regional map</p>
        <div style={{ overflowX: 'auto' }}>
          <table className="mr-tbl">
            <thead>
              <tr>
                <th>facility & map</th>
                <th>medicine identity</th>
                <th>inventory & depletion</th>
                <th>exact risk</th>
              </tr>
            </thead>
            <motion.tbody variants={containerVariants} initial="hidden" animate="show">
              {data.facilities.map(f => (
                <motion.tr variants={itemVariants} key={f.facilityId} style={{ cursor: 'pointer' }}>
                  <td>
                    {f.facilityName} <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>({f.facilityType})</span><br/>
                    <span style={{ fontSize: '10px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
                      <IconMapPin size={12} /> {f.lat}, {f.lng} (schematic)
                    </span>
                  </td>
                  <td>
                    {f.medicine.genericName} <span style={{ color: 'var(--text-muted)' }}>{f.medicine.strength}</span><br/>
                    <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>{f.medicine.dosageForm}</span>
                  </td>
                  <td>
                    {f.effectiveStock} {f.medicine.unit}<br/>
                    <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                      depleting at {f.dailyDemand} {f.medicine.unit}/day · {f.daysRemaining} days remaining
                    </span>
                  </td>
                  <td>
                    <DotState 
                      label={`${f.risk.label} (${f.risk.score})`} 
                      tone={f.risk.label === 'CRITICAL' ? 'danger' : f.risk.label === 'HIGH' ? 'warning' : f.risk.label === 'MEDIUM' ? 'warning' : 'success'} 
                    />
                    <br/>
                    <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>{f.cause}</span>
                  </td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        </div>
      </Card>
    </PageTransition>
  );
}
