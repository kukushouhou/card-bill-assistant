import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import BusinessRoleRibbon from './BusinessRoleRibbon';

describe('卡片业务身份袖标', () => {
  it.each([
    ['primary', '主卡'],
    ['secondary', '副卡'],
    ['supplementary', '附属卡'],
  ] as const)('显示 %s 身份', (role, label) => {
    render(<BusinessRoleRibbon role={role} />);
    const ribbon = screen.getByText(label);
    expect(ribbon.classList.contains('bank-card-role-ribbon')).toBe(true);
    expect(ribbon.classList.contains(`bank-card-role-${role}`)).toBe(true);
  });

  it('普通卡不显示业务袖标', () => {
    const { container } = render(<BusinessRoleRibbon role="standalone" />);
    expect(container.childElementCount).toBe(0);
  });
});
