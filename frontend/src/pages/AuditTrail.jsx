import React, { useEffect, useState } from 'react';
import { PageTransition, PageHead, Tag, Card } from '../components/ui';
import { getAuditTrail } from '../apiService';
import { IconFileText } from '@tabler/icons-react';

export default function AuditTrail() {
  const [data, setData] = useState(null);

  useEffect(() => {
    getAuditTrail().then(setData);
  }, []);

  if (!data) return <div style={{ padding: '20px', color: 'var(--text-secondary)' }}>Loading audit trail...</div>;

  return (
    <PageTransition>
      <PageHead 
        eyeb="accountability" 
        title="Immutable ledger and audit trail" 
        sub="Every alert, scenario, and human decision is retained with its source and timestamp."
        rightHtml={<span style={{ fontSize: '12px', color: 'var(--text-accent)', cursor: 'pointer' }}>all events →</span>}
      />
      
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '9px', background: 'var(--bg-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <IconFileText size={18} color="var(--text-accent)" />
            </div>
            <div>
              <p style={{ fontSize: '10px', color: 'var(--text-accent)', margin: '0 0 2px', fontWeight: 500 }}>ACTIVE SCENARIO</p>
              <p style={{ fontSize: '14px', fontWeight: 500, margin: '0 0 2px' }}>{data.active.scenario}</p>
              <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: 0 }}>{data.active.details}</p>
            </div>
          </div>
          <Tag text="action required" tone="danger" />
        </div>
      </Card>
      
      <div style={{ height: '12px' }}></div>
      
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <p style={{ fontSize: '14px', fontWeight: 500, margin: '0 0 2px' }}>historical operations log</p>
            <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: 0 }}>
              records are appended when a decision is made; demo data can be replaced by the backend audit endpoint.
            </p>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>0 events</span>
        </div>
      </Card>
    </PageTransition>
  );
}
