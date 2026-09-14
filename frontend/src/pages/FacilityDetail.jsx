import React, { useEffect, useState } from 'react';
import { PageTransition, PageHead, Button, DarkBanner, Grid, Stat, Card, Tag } from '../components/ui';
import { getFacilityDetails } from '../apiService';
import { IconShieldCheck, IconAlertTriangle } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { ComposedChart, Area, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceDot } from 'recharts';

const CustomTooltip = ({ active, payload, label, unit }) => {
  if (active && payload && payload.length) {
    return (
      <div className="glass" style={{ background: 'rgba(15, 23, 42, 0.9)', padding: '10px', borderRadius: '8px', border: '1px solid var(--border)' }}>
        <p style={{ margin: '0 0 8px', fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>{label}</p>
        {payload.map(p => (
          <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', fontSize: '11.5px', marginBottom: '4px' }}>
            <span style={{ color: p.color }}>{p.name}:</span>
            <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{p.value} {unit}</span>
          </div>
        ))}
      </div>
    );
  }
  return null;
};

export default function FacilityDetail() {
  const [data, setData] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    getFacilityDetails('f_001').then(setData);
  }, []);

  if (!data) return <div style={{ padding: '20px', color: 'var(--text-secondary)' }}>Loading facility...</div>;

  return (
    <PageTransition>
      <PageHead 
        eyeb="facility intelligence" 
        title={`${data.facilityName} (${data.facilityId})`} 
        sub={`${data.facilityType} · ${data.region} · Snapshot: ${data.dataContext.asOfDate}`}
        rightHtml={<Button primary onClick={() => navigate('/candidates')}>View safe candidates</Button>}
      />
      
      <DarkBanner>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <p style={{ fontSize: '11px', color: '#A9CDD9', margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <IconAlertTriangle size={14} /> ACTIVE MEDICINE RISK · {data.meta.source} {data.meta.fallback ? '(Fallback)' : ''}
            </p>
            <p style={{ fontSize: '20px', fontWeight: 500, margin: '0 0 4px' }}>{data.medicine.genericName} <span style={{ color: '#A9CDD9', fontSize: '14px' }}>{data.medicine.strength}</span></p>
            <p style={{ fontSize: '11px', color: '#A9CDD9', margin: 0 }}>
              {data.medicine.dosageForm} · base unit: {data.medicine.unit} · {data.risk.decisionSupportLabel}
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <p style={{ fontSize: '11px', color: '#A9CDD9', margin: '0 0 4px' }}>risk score</p>
            <p style={{ fontSize: '26px', fontWeight: 500, margin: 0 }}>{data.risk.score}<span style={{ fontSize: '13px', color: '#A9CDD9' }}>/100</span></p>
            <span style={{ background: '#E24B4A', color: '#fff', fontSize: '10px', padding: '2px 10px', borderRadius: '9px', display: 'inline-block', marginTop: '4px' }}>
              {data.risk.label}
            </span>
          </div>
        </div>
      </DarkBanner>
      
      <div style={{ height: '16px' }}></div>
      
      <Grid cols={4}>
        <Stat label={`effective stock (${data.inventory.unit})`} value={`${data.inventory.effectiveStock} ${data.inventory.unit}`} sub={`recorded: ${data.inventory.recordedStock} | excluded: ${data.inventory.excludedStock}`} />
        <Stat label="daily demand" value={`${data.forecast.dailyDemand} ${data.inventory.unit}/day`} sub="forecast.dailyDemand" />
        <Stat label="replenishment" value={`${data.replenishment.quantity} ${data.inventory.unit}`} sub={`${data.replenishment.status} · expected ${data.replenishment.expectedDate}`} />
        <Stat label="coverage remaining" value={`${data.forecast.daysRemaining} days`} sub={`projected stockout: ${data.forecast.projectedStockoutDate}`} />
      </Grid>
      
      <div style={{ height: '16px' }}></div>
      
      <Grid cols={2} style={{ gridTemplateColumns: '2fr 1fr' }}>
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <p style={{ fontSize: '13px', fontWeight: 500, margin: '0 0 4px' }}>forecast timeline</p>
            <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>Live intelligence projection</span>
          </div>
          <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '0 0 14px' }}>
            Interactive projection mapping effective stock, replenishment, and protected stock.
          </p>
          
          <div style={{ width: '100%', height: '220px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data.projection} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorStock" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#38BDF8" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#38BDF8" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="day" stroke="var(--text-muted)" fontSize={10} tickLine={false} axisLine={false} />
                <YAxis stroke="var(--text-muted)" fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip content={<CustomTooltip unit={data.inventory.unit} />} />
                
                {/* Protected Stock Line plotted from data value */}
                <ReferenceLine y={data.inventory.protectedStock} stroke="#F59E0B" strokeDasharray="3 3" label={{ position: 'insideTopLeft', value: 'Protected Stock', fill: '#F59E0B', fontSize: 10 }} />
                
                {/* Bar for replenishment */}
                <Bar dataKey="replenishment" fill="#10B981" name="Incoming Supply" radius={[4, 4, 0, 0]} maxBarSize={30} />
                
                {/* Area for Closing Stock */}
                <Area type="monotone" dataKey="closingStock" stroke="#38BDF8" strokeWidth={2} fillOpacity={1} fill="url(#colorStock)" name="Closing Stock" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          
          {data.forecast.daysRemaining < 14 && (
            <div style={{ marginTop: '16px', background: 'var(--bg-danger)', borderRadius: '8px', padding: '10px 14px', border: '1px solid var(--border-danger)' }}>
              <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-danger)', margin: 0, display: 'flex', alignItems: 'center', gap: '4px' }}>
                <IconAlertTriangle size={14} /> projected stockout on {data.forecast.projectedStockoutDate}
              </p>
              <p style={{ fontSize: '11px', color: 'var(--text-danger)', margin: '2px 0 0' }}>
                Replenishment ({data.replenishment.quantity} {data.inventory.unit}) arrives {data.replenishment.arrivesBeforeStockout ? 'before' : 'after'} stockout date. Shortage gap: {data.forecast.shortageGapDays} days.
              </p>
            </div>
          )}
        </Card>
        
        <Card>
          <p style={{ fontSize: '13px', fontWeight: 500, margin: '0 0 12px' }}>why this is flagged</p>
          
          <p style={{ fontSize: '10.5px', color: 'var(--text-secondary)', margin: '0 0 2px' }}>primary cause</p>
          <p style={{ fontSize: '12px', fontWeight: 500, margin: '0 0 2px', color: 'var(--text-primary)' }}>{data.risk.cause}</p>
          
          <div style={{ height: '12px' }}></div>
          
          <p style={{ fontSize: '10.5px', color: 'var(--text-secondary)', margin: '0 0 2px' }}>forecast confidence</p>
          <p style={{ fontSize: '12px', fontWeight: 500, margin: '0 0 2px', color: 'var(--text-primary)' }}>{data.confidence.label}</p>
          <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '0 0 14px' }}>{data.confidence.reason} Data quality: {data.confidence.dataQuality}</p>
          
          <p style={{ fontSize: '10.5px', color: 'var(--text-secondary)', margin: '0 0 2px' }}>data freshness</p>
          <p style={{ fontSize: '12px', fontWeight: 500, margin: 0, color: 'var(--text-primary)' }}>Simulation: {data.dataContext.simulationDate} ({data.dataContext.dataLabel})</p>
        </Card>
      </Grid>
      
      <div style={{ height: '16px' }}></div>
      
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <p style={{ fontSize: '11px', color: 'var(--primary-brand)', margin: '0 0 4px', fontWeight: 500 }}>SAFE WORKFLOW</p>
            <p style={{ fontSize: '14px', fontWeight: 500, margin: 0 }}>resolve this alert in three clear steps</p>
          </div>
          <div style={{ display: 'flex', gap: '22px', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}><b>1</b> review safe multi-source candidates</span>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}><b>2</b> verify replenishment timing and cold-chain</span>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}><b>3</b> send a plan for pharmacist approval</span>
            <Button primary onClick={() => navigate('/candidates')}>Review candidates</Button>
          </div>
        </div>
      </Card>
    </PageTransition>
  );
}
