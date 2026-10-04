// Continuous pages retain their space; only a small nearby window owns canvases.
export async function mountPdfReader(pdf, host, fileName, translate, loadingTask) {
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const toolbar = make('div', 'pdf-toolbar');
  const input = make('input');
  input.type = 'number'; input.min = 1; input.max = pdf.numPages; input.value = 1;
  input.setAttribute('aria-label', translate('PDF 页码'));
  const count = make('span', '', `/ ${pdf.numPages}`);
  const smaller = make('button', '', '−'), larger = make('button', '', '+');
  smaller.setAttribute('aria-label', translate('缩小 PDF'));
  larger.setAttribute('aria-label', translate('放大 PDF'));
  const fit = make('button', '', translate('适应宽度'));
  const hint = make('span', 'pdf-scroll-hint', translate('连续滚动阅读'));
  toolbar.append(input, count, smaller, larger, fit, hint);
  const surface = make('div', 'pdf-surface pdf-continuous');
  surface.tabIndex = 0; surface.setAttribute('aria-label', fileName);
  const stack = make('div', 'pdf-page-stack'); surface.append(stack);
  const details = make('details', 'pdf-text');
  const summary = make('summary', '', translate('提取当前页文字'));
  const text = make('pre'); details.append(summary, text);
  host.append(toolbar, surface, details);
  const first = await pdf.getPage(1), initial = first.getViewport({scale: 1});
  const slots = Array.from({length: pdf.numPages}, (_, index) => {
    const box = make('div', 'pdf-page');
    box.setAttribute('aria-label', `${translate('PDF 页码')} ${index + 1}`);
    box.dataset.page = index + 1;
    const label = make('span', 'pdf-page-placeholder', `${index + 1} / ${pdf.numPages}`);
    box.append(label); stack.append(box);
    return {box, label, width: initial.width, height: initial.height, canvas: null, task: null, version: -1};
  });
  let zoom = null, scale = 1, version = 0, current = 0, wanted = new Set(), running = false;
  let stopped = false, frame = 0, resizeTimer, textVersion = 0;
  function pageScale(slot) {
    return zoom === null ? Math.min(scale, Math.max(160,surface.clientWidth-40)/slot.width) : scale;
  }
  function dimensions(slot) {
    const value = pageScale(slot);
    slot.box.style.width = `${slot.width * value}px`;
    slot.box.style.height = `${slot.height * value}px`;
  }
  function release(slot) {
    slot.task?.cancel(); slot.task = null;
    if (slot.canvas) { slot.canvas.remove(); slot.canvas.width = 0; slot.canvas.height = 0; slot.canvas = null; }
    slot.label.hidden = false; slot.version = -1;
  }
  function pageAtScroll() {
    const y = surface.scrollTop + surface.clientHeight * .25;
    let low = 0, high = slots.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if (slots[middle].box.offsetTop <= y) low = middle; else high = middle - 1;
    }
    return low;
  }
  async function extract() {
    if (!details.open) return;
    const token = ++textVersion, pageIndex = current;
    text.textContent = translate('正在准备预览…');
    try {
      const page = await pdf.getPage(pageIndex + 1), content = await page.getTextContent();
      if (stopped || token !== textVersion || pageIndex !== current) return;
      text.textContent = content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('') || translate('本页没有可提取的文字，可能是扫描件。');
    } catch { if (!stopped && token === textVersion) text.textContent = translate('此页无法显示，请下载原文件查看。'); }
  }
  async function drain() {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped) {
        const index = [...wanted].sort((a,b) => Math.abs(a-current)-Math.abs(b-current)).find(i => slots[i].version !== version);
        if (index === undefined) break;
        const slot = slots[index], token = version;
        slot.version = token;
        try {
          const page = await pdf.getPage(index + 1);
          if (stopped || token !== version || !wanted.has(index)) continue;
          slot.version = token;
          const original = page.getViewport({scale: 1});
          slot.width = original.width; slot.height = original.height; dimensions(slot);
          const value = pageScale(slot);
          const ratio = Math.max(.1, Math.min(devicePixelRatio || 1, 2, 4096 / (Math.max(slot.width,slot.height) * value)));
          const viewport = page.getViewport({scale: value * ratio});
          const canvas = make('canvas'); canvas.setAttribute('aria-label', `${fileName} · ${index + 1}`);
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          slot.canvas = canvas; slot.box.append(canvas);
          const render = page.render({canvasContext: canvas.getContext('2d'), viewport}); slot.task = render;
          await render.promise;
          if (!stopped && token === version && wanted.has(index) && slot.canvas === canvas) slot.label.hidden = true;
          if (slot.task === render) slot.task = null;
        } catch (error) {
          if (error.name !== 'RenderingCancelledException' && !stopped && token === version && wanted.has(index)) {
            slot.canvas?.remove(); slot.canvas = null; slot.label.hidden = false;
            slot.label.textContent = translate('此页无法显示，请下载原文件查看。');
          }
        }
      }
    } finally { running = false; }
  }
  function updateWindow() {
    if (stopped) return;
    const next = pageAtScroll();
    if (next !== current) { current = next; extract(); }
    if (document.activeElement !== input) input.value = current + 1;
    const desired = new Set();
    // Cover the viewport and one page ahead/behind, bounded independently of document length.
    for (let i = Math.max(0,current-2); i <= Math.min(slots.length-1,current+3); i++) desired.add(i);
    for (const index of wanted) if (!desired.has(index)) release(slots[index]);
    wanted = desired; drain();
  }
  function layout() {
    if (stopped) return;
    const old = slots[current], offset = surface.scrollTop - old.box.offsetTop;
    const oldScale = scale;
    scale = zoom ?? Math.min(1.5, Math.max(160, surface.clientWidth - 40) / initial.width);
    version++;
    for (const slot of slots) { release(slot); dimensions(slot); }
    surface.scrollTop = Math.max(0,old.box.offsetTop + offset * scale / oldScale);
    updateWindow();
  }
  function jump() {
    const index = Math.max(0,Math.min(slots.length-1,Math.floor(Number(input.value)||1)-1));
    input.value = index + 1;
    surface.scrollTo({top: slots[index].box.offsetTop - 16, behavior: 'auto'}); updateWindow();
  }
  input.onchange = jump;
  input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); jump(); } };
  smaller.onclick = () => { zoom = Math.max(.25,scale*.8); layout(); };
  larger.onclick = () => { zoom = Math.min(3,scale*1.25); layout(); };
  fit.onclick = () => { zoom = null; layout(); };
  details.ontoggle = extract;
  surface.addEventListener('scroll', () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; updateWindow(); });
  }, {passive:true});
  let width = surface.clientWidth;
  const observer = new ResizeObserver(() => {
    if (width === surface.clientWidth) return;
    width = surface.clientWidth; clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (zoom === null) layout(); },120);
  });
  observer.observe(surface);
  window.addEventListener('pagehide', () => {
    stopped = true; textVersion++; observer.disconnect(); clearTimeout(resizeTimer); cancelAnimationFrame(frame);
    for (const index of wanted) release(slots[index]);
    loadingTask.destroy();
  }, {once:true});
  layout();
}
