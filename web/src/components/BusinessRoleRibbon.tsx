import type { CardRow } from '../api/types';

export function businessRoleLabel(role: CardRow['businessRole']): string | null {
  if (role === 'primary') return '主卡';
  if (role === 'secondary') return '副卡';
  if (role === 'supplementary') return '附属卡';
  return null;
}

export default function BusinessRoleRibbon({ role }: { role: CardRow['businessRole'] }) {
  const label = businessRoleLabel(role);
  if (!label) return null;
  return (
    <span className="bank-card-role-ribbon-clip" aria-hidden="true">
      <span className={`bank-card-role-ribbon bank-card-role-${role}`}>{label}</span>
    </span>
  );
}
