import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router';

export function useSourceScroll() {
  const location = useLocation();
  useLayoutEffect(() => {
    const desired = Number(location.state?.sourceScrollTop ?? 0);
    if (!desired) return;
    const root = document.getElementById('root');
    const main = document.querySelector('.route-outlet');
    if (!root || !main) return;
    let stopped = false;
    const restore = () => {
      if (stopped) return;
      if (matchMedia('(max-width: 1023px)').matches) root.scrollTop = desired;
      else window.scrollTo(0, desired);
    };
    const stop = () => { stopped = true; observer.disconnect(); };
    const observer = new ResizeObserver(restore); observer.observe(main);
    const frame = requestAnimationFrame(restore);
    window.addEventListener('wheel', stop, { passive: true }); window.addEventListener('touchstart', stop, { passive: true });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('wheel', stop); window.removeEventListener('touchstart', stop); };
  }, [location.pathname]);
}
