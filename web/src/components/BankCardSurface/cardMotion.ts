type Point = { x: number; y: number };
type Motion = {
  element: HTMLElement;
  surface: HTMLElement;
  glow: HTMLElement;
  flow: HTMLElement | null;
  mobile: boolean;
  front: Point;
  middle: Point;
  back: Point;
};

const origin = (): Point => ({ x: 0, y: 0 });
const clamp = (value: number) => Math.max(-1, Math.min(1, value));
const properties = [
  '--bcs-front-rx', '--bcs-front-ry', '--bcs-middle-rx', '--bcs-middle-ry', '--bcs-back-rx', '--bcs-back-ry',
];
const cards = new Map<Element, Motion>();
const visible = new Set<Motion>();
let observer: IntersectionObserver | undefined;
let sizes: ResizeObserver | undefined;
let pointer: Point | null = null;
let hoverEnabled = false;
let frame = 0;
let previousTime = 0;

function schedule() {
  if (!frame && visible.size && !document.hidden) frame = requestAnimationFrame(tick);
}

function follow(current: Point, target: Point, factor: number) {
  current.x += (target.x - current.x) * factor;
  current.y += (target.y - current.y) * factor;
  const distance = Math.abs(current.x - target.x) + Math.abs(current.y - target.y);
  if (distance < 0.001) Object.assign(current, target);
  return distance;
}

type Sample = { motion: Motion; rect: DOMRect; hovered: boolean };

function scrollParent(element: HTMLElement) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return document.scrollingElement as HTMLElement;
}

/** 沿真实矩形边缘行走：左上 → 右上 → 右下 → 左下，保持原组件的光效。 */
function setMobileGlow(sample: Sample, progress: number, strength: number) {
  if (!visible.has(sample.motion)) return;
  const t = Math.max(0, Math.min(1, progress)) * 3;
  const x = t <= 1 ? t : t <= 2 ? 1 : 3 - t;
  const y = t <= 1 ? 0 : t <= 2 ? t - 1 : 1;
  const angle = Math.atan2((y - 0.5) * sample.rect.height, (x - 0.5) * sample.rect.width) * 180 / Math.PI + 90;
  sample.motion.glow.style.setProperty('--cursor-angle', `${((angle + 360) % 360).toFixed(3)}deg`);
  sample.motion.glow.style.setProperty('--edge-proximity', strength > 0 ? (30 + 68 * strength).toFixed(3) : '0');
}

/** 直接从滚动位置取进度，前进与倒放共用同一条路径，松手不会自行跑圈。 */
function updateMobileFlow(samples: Sample[]) {
  const groups = new Map<HTMLElement, Sample[]>();
  for (const sample of samples) {
    const { mobile, flow } = sample.motion;
    if (!mobile || !flow || !sample.rect.width || !sample.rect.height) continue;
    const group = groups.get(flow) ?? [];
    group.push(sample);
    groups.set(flow, group);
  }
  // 先读完每组布局；虚拟列表只需要当前挂载的卡片及其前后缓冲行。
  const layouts = [...groups].map(([flow, group]) => {
    const inline = flow.dataset.cardFlow === 'inline';
    const scroller = inline ? flow : scrollParent(flow);
    const offset = inline ? scroller.scrollLeft : scroller.scrollTop;
    const range = inline ? scroller.scrollWidth - scroller.clientWidth : scroller.scrollHeight - scroller.clientHeight;
    const total = inline ? flow.scrollWidth : flow.scrollHeight;
    const flowRect = flow.getBoundingClientRect();
    const position = range > 0 ? Math.max(0, Math.min(1, offset / range)) * total : 0;
    const ordered = group.map(sample => ({
      sample,
      start: (inline ? sample.rect.left - flowRect.left : sample.rect.top - flowRect.top) + (flow === scroller ? offset : 0),
    })).sort((a, b) => a.start - b.start || a.sample.rect.left - b.sample.rect.left);
    // 平板双列按从左到右衔接，同一行共享该行的滚动区间。
    const rows: typeof ordered[] = [];
    for (const item of ordered) {
      const row = rows.at(-1);
      if (!inline && row && Math.abs(row[0].start - item.start) < 1) row.push(item);
      else rows.push([item]);
    }
    const slots = rows.flatMap((row, index) => {
      const length = Math.max(1, (rows[index + 1]?.[0].start ?? total) - row[0].start);
      return row.map((item, column) => ({ sample: item.sample, start: row[0].start + length * column / row.length, length: length / row.length }));
    });
    return { group, slots, position };
  });
  for (const { group, slots, position } of layouts) {
    group.forEach(sample => setMobileGlow(sample, 0, 0));
    let index = slots.findIndex((slot, i) => position >= slot.start && (position < slot.start + slot.length || i === slots.length - 1));
    // 列表的入场位移或内边距不应让起点暂时落在第一张卡之前。
    if (index < 0 && position === 0 && slots.length) index = 0;
    if (index < 0) continue;
    const slot = slots[index];
    const progress = Math.max(0, Math.min(1, (position - slot.start) / slot.length));
    const next = slots[index + 1];
    const handoff = next ? Math.max(0, (progress - 0.9) / 0.1) : 0;
    setMobileGlow(slot.sample, progress / 0.9, 1 - handoff);
    if (next && handoff > 0) setMobileGlow(next.sample, 0, handoff);
  }
}

/** 桌面使用 Border Glow 原生卡内交互；这里只驱动手机滚动路径和独立层倾转。 */
function tick(time: number) {
  frame = 0;
  const elapsed = previousTime ? Math.min(time - previousTime, 32) : 16;
  previousTime = time;
  let settling = false;
  const samples = [...cards.values()].filter(motion => motion.mobile || visible.has(motion)).map(motion => ({ motion, rect: motion.surface.getBoundingClientRect(), hovered: hoverEnabled && !motion.mobile && motion.element.matches(':hover') }));
  updateMobileFlow(samples);
  for (const { motion, rect, hovered } of samples) {
    if (!rect.width || !rect.height) continue;
    const style = motion.element.style;

    const tilt = hovered && pointer ? {
      x: clamp((pointer.x - rect.left) / rect.width * 2 - 1),
      y: clamp((pointer.y - rect.top) / rect.height * 2 - 1),
    } : origin();
    // 前、中、后三层具有各自的倾角幅度和惯性，绝不旋转整摞外层。
    const deltas = [
      follow(motion.front, tilt, 1 - Math.exp(-elapsed / 65)),
      follow(motion.middle, tilt, 1 - Math.exp(-elapsed / 90)),
      follow(motion.back, tilt, 1 - Math.exp(-elapsed / 115)),
    ];
    settling ||= deltas.some(delta => delta > 0.001);
    const { front, middle, back } = motion;
    if ([front, middle, back].some(pose => Math.abs(pose.x) + Math.abs(pose.y) > 0.001)) {
      motion.element.dataset.cardTilting = 'true';
      style.setProperty('--bcs-front-rx', `${(-front.y * 3).toFixed(3)}deg`);
      style.setProperty('--bcs-front-ry', `${(front.x * 4).toFixed(3)}deg`);
      style.setProperty('--bcs-middle-rx', `${(-middle.y * 2.25).toFixed(3)}deg`);
      style.setProperty('--bcs-middle-ry', `${(middle.x * 3).toFixed(3)}deg`);
      style.setProperty('--bcs-back-rx', `${(-back.y * 1.65).toFixed(3)}deg`);
      style.setProperty('--bcs-back-ry', `${(back.x * 2.2).toFixed(3)}deg`);
    } else {
      delete motion.element.dataset.cardTilting;
    }
  }
  if (settling) schedule();
  else previousTime = 0;
}

function onPointer(event: PointerEvent) {
  if (event.pointerType !== 'mouse') return;
  pointer = { x: event.clientX, y: event.clientY };
  hoverEnabled = true;
  schedule();
}

function leave() { hoverEnabled = false; schedule(); }
function onPointerOut(event: PointerEvent) { if (!event.relatedTarget) leave(); }
function onVisibility() {
  if (document.hidden) { cancelAnimationFrame(frame); frame = 0; previousTime = 0; }
  else schedule();
}

export function attachCardMotion(element: HTMLElement, mobile: boolean) {
  const surface = element.firstElementChild as HTMLElement;
  const motion: Motion = { element, surface, glow: surface.firstElementChild as HTMLElement, flow: element.closest<HTMLElement>('[data-card-flow]'), mobile, front: origin(), middle: origin(), back: origin() };
  if (!observer) {
    observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const card = cards.get(entry.target);
        if (!card) return;
        if (entry.isIntersecting) { visible.add(card); card.element.dataset.cardVisible = 'true'; }
        else { visible.delete(card); delete card.element.dataset.cardVisible; delete card.element.dataset.cardTilting; card.front = origin(); card.middle = origin(); card.back = origin(); }
      });
      schedule();
    });
    sizes = new ResizeObserver(schedule);
    document.addEventListener('pointermove', onPointer, { passive: true });
    document.addEventListener('pointerout', onPointerOut, { passive: true });
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    document.addEventListener('click', schedule);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', leave);
    window.addEventListener('resize', schedule);
  }
  cards.set(element, motion);
  observer.observe(element);
  sizes?.observe(motion.surface);
  return () => {
    observer?.unobserve(element);
    sizes?.unobserve(motion.surface);
    cards.delete(element);
    visible.delete(motion);
    delete element.dataset.cardVisible;
    delete element.dataset.cardTilting;
    properties.forEach(property => element.style.removeProperty(property));
    motion.glow.style.removeProperty('--cursor-angle');
    motion.glow.style.removeProperty('--edge-proximity');
    if (!cards.size) {
      observer?.disconnect(); sizes?.disconnect(); observer = undefined; sizes = undefined;
      cancelAnimationFrame(frame); frame = 0; previousTime = 0; pointer = null; hoverEnabled = false;
      document.removeEventListener('pointermove', onPointer);
      document.removeEventListener('pointerout', onPointerOut);
      document.removeEventListener('scroll', schedule, true);
      document.removeEventListener('click', schedule);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', leave);
      window.removeEventListener('resize', schedule);
    }
  };
}
