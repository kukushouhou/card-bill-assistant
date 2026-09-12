import { useEffect, useRef, type HTMLAttributes } from 'react';
import { attachCardMotion } from './cardMotion';
import BorderGlow from '../BorderGlow/BorderGlow';
import { paletteVars } from './palettes';
import './bank-card-surface.css';

type BankCardSurfaceProps = HTMLAttributes<HTMLDivElement> & {
  palette: number;
  stacked?: boolean;
  mobile?: boolean;
};

/** 独立卡面：只处理材质、堆叠和交互，业务内容及操作由使用方传入。 */
export default function BankCardSurface({
  palette, stacked = false, mobile = false, className = '', style, children, ...props
}: BankCardSurfaceProps) {
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let detach: (() => void) | undefined;
    const configure = () => {
      detach?.();
      detach = !reduced.matches
        ? attachCardMotion(element, mobile)
        : undefined;
    };
    configure();
    reduced.addEventListener('change', configure);
    return () => {
      detach?.();
      reduced.removeEventListener('change', configure);
    };
  }, [mobile]);

  return (
    <div ref={stage} className={`bank-card-stage${stacked ? ' bank-card-stack-wrap' : ''}`}>
      <div
        {...props}
        className={`bank-card bank-card-surface${stacked ? ' bank-card-stack' : ''} ${className}`}
        style={{ ...paletteVars(palette), ...style }}
      >
        <BorderGlow
          className="bank-card-face bank-card-border-glow"
          backgroundColor="var(--bcs-ink)"
          borderRadius={14}
          glowRadius={16}
          externalControl={mobile}
          animated={false}
        >
          <div className="bank-card-content">{children}</div>
        </BorderGlow>
      </div>
    </div>
  );
}
