import { useEffect, useRef, type ReactNode } from 'react';
import type { CardRow } from '../../api/types';
import { MobileFlow } from '../../components/MobilePrimitives';
import CardBillSection from '../../components/CardBillSection';
import { cardGroupTitle } from '../../lib/business-cards';

export default function MobileCardDetail({ cards, main, focusCardId, reloadKey, renderCard, onBack, onChanged }: {
  cards: CardRow[]; main: CardRow; focusCardId: number | null; reloadKey: number;
  renderCard: (card: CardRow) => ReactNode; onBack: () => void; onChanged: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const item = track.current?.querySelector<HTMLElement>('[data-card-id="' + (focusCardId ?? main.id) + '"]');
    if (item && track.current) track.current.scrollLeft = item.offsetLeft - track.current.offsetLeft;
  }, [focusCardId, main.id]);
  return <MobileFlow title={cardGroupTitle(main.bankName, cards)} onBack={onBack} className="mobile-card-detail">
    <div className="mobile-card-detail-carousel" ref={track} style={{ display: 'flex', overflowX: 'auto', scrollSnapType: 'x mandatory', gap: 14, padding: '4px 0 16px' }}>
      {cards.map(card => <div key={card.id} data-card-id={card.id} style={{ flex: '0 0 92%', scrollSnapAlign: 'center' }}>{renderCard(card)}</div>)}
    </div>
    <CardBillSection cardIds={cards.map(card => card.id)} revision={reloadKey} onChanged={onChanged} />
  </MobileFlow>;
}
