import { Icon } from '../components/Icon';
import { Card, PageHead, SourceBadge, StatusPill } from '../components/ui';

const ICONS = { RESERVE: 'check', REJECT: 'close', DISPATCH: 'arrow', DELIVER: 'check', CANCEL: 'close' };
const TONES = { RESERVE: 'approved', REJECT: 'rejected', DISPATCH: 'neutral', DELIVER: 'approved', CANCEL: 'rejected' };

export function AuditTrail({ data }) {
  return <>
    <PageHead eyebrow="accountability" title="Audit trail" copy="Human decisions and lifecycle events recorded by the API: reservation, rejection, dispatch, delivery and cancellation." />
    <SourceBadge meta={data.meta} label="audit records" />
    <Card className="audit-card">
      <div className="card-heading"><div><h2>recorded events</h2><p>newest first; each entry is the API's audit record for a plan</p></div><span className="muted">{data.rows.length} events</span></div>
      {data.rows.length ? <div className="audit-list">{data.rows.map((row) => <article key={row.id}>
        <div className={`audit-icon ${TONES[row.action]}`}><Icon name={ICONS[row.action]} /></div>
        <div><h3>{row.title}</h3><p>{row.note || 'No note recorded'}</p><small>plan {row.planId}{row.revalidated ? ` · revalidated by ${row.revalidationModel || 'the intelligence service'}` : ''}</small></div>
        <div><strong>{row.actor}</strong><small>{row.status ? `status after: ${row.status}` : ''}</small></div>
        <div><span>{row.at}</span><small>audit {row.id}</small></div>
        <StatusPill tone={TONES[row.action]}>{row.action}</StatusPill>
      </article>)}</div> : <div className="empty-audit"><Icon name="clipboard" /><p>no decisions recorded yet</p><small>approving, rejecting, dispatching, delivering or cancelling a plan adds an event here.</small></div>}
      {data.hidden > 0 && <p className="muted audit-hidden">{data.hidden} recorded event(s) of other types are not shown.</p>}
    </Card>
  </>;
}
