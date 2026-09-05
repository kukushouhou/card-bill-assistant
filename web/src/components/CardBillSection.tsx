import { Segmented } from 'antd';
import { AgendaPage } from './AgendaList';
import { useViewState } from '../lib/viewState';

export default function CardBillSection({ cardIds, revision = 0, onChanged }: { cardIds: number[]; revision?: number; onChanged?: () => void }) {
  const scope = [...cardIds].sort((a, b) => a - b).join(',');
  const [view, setView] = useViewState<string>('card-bills-view:' + scope, 'open');
  return <section className="agenda-card-section"><h3>账单中心</h3><Segmented value={view} options={[{ value: 'open', label: '待还账单' }, { value: 'history', label: '历史账单' }]} onChange={setView} />
    <AgendaPage query={'view=' + view + '&cardIds=' + scope} revision={revision} onChanged={onChanged} />
  </section>;
}
