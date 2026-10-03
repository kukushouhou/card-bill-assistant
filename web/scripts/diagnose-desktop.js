// Issue #1 只读快照：在异常仍在屏幕上时粘贴到 DevTools Console。
// 不读取表单、卡号、Cookie 或本地存储，不发请求，不改变页面或浏览器设置。
(() => {
  const describe = element => element ? { tag: element.tagName, classes: element.getAttribute('class') } : null;
  const bounds = element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const css = element => {
    const style = getComputedStyle(element);
    return Object.fromEntries(['display', 'visibility', 'opacity', 'pointer-events', 'position', 'z-index',
      'left', 'top', 'width', 'height', 'transform', 'zoom', 'overflow', 'filter', 'backdrop-filter',
      'animation-name', 'animation-play-state', 'transition-duration'].map(key => [key, style.getPropertyValue(key)]));
  };
  const sample = element => {
    const rect = bounds(element);
    const inViewport = rect.width > 0 && rect.height > 0 && rect.x < innerWidth && rect.y < innerHeight
      && rect.x + rect.width > 0 && rect.y + rect.height > 0;
    const x = (Math.max(0, rect.x) + Math.min(innerWidth, rect.x + rect.width)) / 2;
    const y = (Math.max(0, rect.y) + Math.min(innerHeight, rect.y + rect.height)) / 2;
    const hits = inViewport ? document.elementsFromPoint(x, y) : [];
    return {
      element: describe(element), parent: describe(element.parentElement), connected: element.isConnected,
      outsideRoot: !document.getElementById('root')?.contains(element), rect, css: css(element), inViewport,
      hitInside: Boolean(hits[0] && element.contains(hits[0])), hits: hits.slice(0, 4).map(describe),
    };
  };
  const skinPath = value => {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && url.pathname.startsWith('/api/skins/assets/') ? url.pathname : null;
    } catch { return null; }
  };
  const report = {
    // Windows 10/11 的 UA 可能相同，真实 OS build 请另附 winver，不能从 UA 推断。
    userAgent: navigator.userAgent,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, visualScale: visualViewport?.scale },
    environment: { forcedColors: matchMedia('(forced-colors: active)').matches,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, dark: matchMedia('(prefers-color-scheme: dark)').matches },
    capabilities: {
      fontFace: typeof FontFace === 'function', imageDecode: typeof HTMLImageElement.prototype.decode === 'function',
      resizeObserver: typeof ResizeObserver === 'function', pointerEvent: typeof PointerEvent === 'function',
      structuredClone: typeof structuredClone === 'function',
      where: CSS.supports('selector(:where(body))'), has: CSS.supports('selector(body:has(div))'),
      logicalInset: CSS.supports('inset-inline-start', '1px'), cssVariables: CSS.supports('color', 'var(--test)'),
      colorMix: CSS.supports('color', 'color-mix(in srgb, red, blue)'),
      backdropFilter: CSS.supports('backdrop-filter', 'blur(1px)'), maskComposite: CSS.supports('mask-composite', 'intersect'),
    },
    root: { skin: document.documentElement.dataset.skin, mode: document.documentElement.dataset.mode,
      css: css(document.documentElement), bodyCss: css(document.body) },
    triggers: [...document.querySelectorAll('[aria-expanded], .bank-card-settings, .ant-dropdown-open, .ant-popover-open')].map(element => ({
      ...sample(element), expanded: element.getAttribute('aria-expanded'), disabled: element.getAttribute('aria-disabled') ?? element.hasAttribute('disabled'),
    })),
    popups: [...document.querySelectorAll('.ant-select-dropdown, .ant-dropdown, .ant-popover')].map(sample),
    stylesheets: [...document.querySelectorAll('link[data-skin-dynamic]')].map(link => ({
      path: skinPath(link.href), state: link.dataset.skinDynamic, media: link.media, hasSheet: Boolean(link.sheet),
    })),
    resources: performance.getEntriesByType('resource').filter(entry => skinPath(entry.name)).map(entry => ({
      path: skinPath(entry.name), initiator: entry.initiatorType, duration: entry.duration,
      // 0 不能解释为成功或失败；结合 Network 的状态、MIME、响应内容和拦截原因判断。
      status: entry.responseStatus ?? null, transferSize: entry.transferSize,
    })),
  };
  console.info('[desktop-compatibility]', report);
  return report;
})();
