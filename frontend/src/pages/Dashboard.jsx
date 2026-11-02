import { Button, Card, PageHead, RiskPill, SourceBadge, Stat } from '../components/ui';
import { formatCover, formatDays, formatQuantity } from '../services/viewModels';

export function Dashboard({ data, onOpenFacility }) {
  const earliest = data.earliestStockout;
  return <>
    <PageHead
      eyebrow="regional overview"
      title="Network resilience at a glance"
      copy={`${data.facilitiesMonitored} facilities monitored · ${data.medicines.join(', ') || 'no medicine reported'} · ${data.dataFreshness.toLowerCase()}`}
      action={earliest && <Button onClick={() => onOpenFacility(earliest.facilityId)}>open earliest stockout</Button>}
    />
    <SourceBadge meta={data.meta} label="dashboard data" />
    <div className="stat-grid four">
      <Stat label="resilience score" value={Number.isFinite(data.resilienceScore) ? `${data.resilienceScore} / 100` : 'Unavailable'} detail="100 minus the average facility risk score" />
      <Stat label="earliest stockout" value={earliest ? formatDays(earliest.daysRemaining) : 'None projected'} detail={earliest?.facilityName || 'No facility has a projected stockout'} tone={earliest ? 'critical' : ''} />
      <Stat label="critical count" value={Number.isFinite(data.criticalCount) ? String(data.criticalCount) : 'Unavailable'} detail={`of ${data.facilitiesMonitored} facilities`} tone={data.criticalCount ? 'critical' : ''} />
      <Stat label="facilities monitored" value={String(data.facilitiesMonitored)} detail="facilities reported by the API" />
    </div>
    {data.alerts.length > 0 && <Card className="alert-card"><h2>alerts</h2><ul className="alert-list">{data.alerts.map((alert) => <li key={alert.facilityId}>
      <button className="facility-link" onClick={() => onOpenFacility(alert.facilityId)}>{alert.facilityName}</button>
      <span>{formatCover(alert.daysRemaining)} · {alert.cause}</span>
      <RiskPill label={alert.riskLabel} />
    </li>)}</ul></Card>}
    <Card className="facility-status">
      <div className="card-heading"><div><h2>facility status</h2><p>Risk labels are the API's snapshot labels from recorded stock and demand. Open a facility for the intelligence forecast.</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>facility</th><th>medicine</th><th>effective stock</th><th>cover</th><th>risk label</th></tr></thead><tbody>{data.rows.map((row) => <tr key={row.id}>
        <td><button className="facility-link" onClick={() => onOpenFacility(row.id, row.medicineId)}>{row.name}</button><small>{row.id} · {row.type}</small></td>
        <td>{row.medicine}</td>
        <td>{formatQuantity(row.effectiveStock, row.unit)}</td>
        <td>{formatCover(row.daysRemaining)}</td>
        <td><RiskPill label={row.riskLabel} score={row.riskScore} /></td>
      </tr>)}</tbody></table></div>
    </Card>
  </>;
}
