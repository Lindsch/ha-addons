/* Wiezer – freezer inventory UI. Plain JavaScript, no libraries.
 * Amounts are handled in tenths (15 = 1.5), the same as on the server. */
(() => {
  'use strict';

  const API = 'api/';
  const POLL_MS = 4000;
  const ERROR_CODES = ['invalid', 'not_found', 'drawer_not_empty', 'unit_in_use', 'last_drawer', 'last_unit', 'undo_expired', 'server'];

  const S = {
    strings: { en: {}, de: {} },
    lang: 'en',
    locale: 'en-US',
    state: null,
    units: new Map(),
    drawers: new Map(),
    groups: new Map(),
    items: new Map(),
    view: 'list',
    search: '',
    changelog: null,
    overlays: [],
    snackTimer: null,
    dragging: false,
    pendingState: null,
  };

  // ------------------------------------------------------------------ small helpers

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = value;
      else if (key === 'value') el.value = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // Own simple line icons (no icon font or licensed icon set)
  const ICONS = {
    add: '<path d="M12 5v14M5 12h14"/>',
    remove: '<path d="M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    delete: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    grip: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="3.2"/>',
    move: '<path d="M4 12h11M11 7l5 5-5 5"/><path d="M20 5v14"/>',
    keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
    drawer: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 12h4"/>',
  };

  function icon(name) {
    const tpl = document.createElement('template');
    tpl.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
    return tpl.content.firstChild;
  }

  function t(key, params) {
    let text = S.strings[S.lang][key];
    if (text === undefined) text = S.strings.en[key];
    if (text === undefined) text = key;
    if (params) {
      for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (e) { /* not available */ }
  }

  function normalize(text) {
    return text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  }

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ------------------------------------------------------------------ formatting

  function fmtNum(tenths) {
    return new Intl.NumberFormat(S.locale, { maximumFractionDigits: 1 }).format(tenths / 10);
  }

  function plainNum(tenths) {
    return new Intl.NumberFormat(S.locale, { maximumFractionDigits: 1, useGrouping: false }).format(tenths / 10);
  }

  function decimalSep() {
    return new Intl.NumberFormat(S.locale).format(1.5).charAt(1);
  }

  function unitName(unit, tenths) {
    const one = tenths === 10;
    if (unit.builtin && !unit.singular) return t(`unit.${unit.builtin}.${one ? 'one' : 'other'}`);
    return one ? unit.singular : (unit.plural || unit.singular);
  }

  function unitTitle(unit) {
    const one = unitName(unit, 10);
    const other = unitName(unit, 20);
    return one === other ? one : `${one} / ${other}`;
  }

  function fmtAmount(tenths, unit) {
    return `${fmtNum(tenths)} ${unit ? unitName(unit, tenths) : ''}`.trim();
  }

  function fmtDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Intl.DateTimeFormat(S.locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
      .format(new Date(y, m - 1, d));
  }

  // Parse "1,5" / "1.5" / "250" into tenths; returns null if invalid
  function parseAmount(text) {
    const cleaned = String(text).trim().replace(/\s/g, '').replace(',', '.');
    if (!/^\d+(\.\d+)?$|^\.\d+$/.test(cleaned)) return null;
    const value = Math.round(parseFloat(cleaned) * 10);
    return Number.isFinite(value) ? value : null;
  }

  function locationText(item) {
    const drawer = S.drawers.get(item.drawer_id);
    if (!drawer) return '';
    const group = drawer.group_id ? S.groups.get(drawer.group_id) : null;
    return group
      ? t('item.location_group', { group: group.name, drawer: drawer.name })
      : t('item.location', { drawer: drawer.name });
  }

  function labelText(item) {
    const unit = S.units.get(item.unit_id);
    return `${item.name}\n${fmtAmount(item.amount, unit)} · ${fmtDate(item.added)}`;
  }

  // ------------------------------------------------------------------ preferences

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function applyPrefs(settings) {
    const systemLang = (navigator.language || 'en').toLowerCase();
    const lang = settings.language === 'system' ? (systemLang.startsWith('de') ? 'de' : 'en') : settings.language;
    S.lang = lang;
    S.locale = systemLang.startsWith(lang) ? navigator.language : (lang === 'de' ? 'de-DE' : 'en-US');
    document.documentElement.lang = lang;
    const dark = settings.theme === 'dark' || (settings.theme === 'system' && darkQuery.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  darkQuery.addEventListener('change', () => {
    if (S.state) applyPrefs(S.state.settings);
  });

  // ------------------------------------------------------------------ server communication

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      snack(t('error.network'));
      throw e;
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const code = data && ERROR_CODES.includes(data.error) ? data.error : 'server';
      snack(t(`error.${code}`));
      const err = new Error(code);
      err.code = code;
      throw err;
    }
    if (data && data.items) applyState(data);
    return data;
  }

  function applyState(data) {
    if (S.dragging) { S.pendingState = data; return; } // don't redraw under the user's finger
    const prev = S.state;
    S.state = data;
    S.units = new Map(data.units.map((u) => [u.id, u]));
    S.drawers = new Map(data.drawers.map((d) => [d.id, d]));
    S.groups = new Map(data.groups.map((g) => [g.id, g]));
    S.items = new Map(data.items.map((i) => [i.id, i]));
    const prefsChanged = !prev
      || prev.settings.language !== data.settings.language
      || prev.settings.theme !== data.settings.theme;
    applyPrefs(data.settings);
    if (prefsChanged) render();
    else renderContent();
    for (const overlay of [...S.overlays]) if (overlay.onState) overlay.onState();
  }

  async function poll() {
    if (document.hidden || !S.state) return;
    try {
      const { rev } = await fetchJson(API + 'rev');
      if (rev !== S.state.rev) applyState(await fetchJson(API + 'state'));
    } catch (e) { /* try again next time */ }
  }

  // ------------------------------------------------------------------ overlays (sheets, dialogs, snackbar)

  function openOverlay(build, { dialog = false } = {}) {
    document.querySelectorAll('.snackbar').forEach((el) => el.remove());
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
    const scrim = h('div', { class: dialog ? 'scrim dialog' : 'scrim' }, sheet);
    const overlay = { scrim, sheet, onState: null, onClose: null };
    overlay.close = () => {
      const i = S.overlays.indexOf(overlay);
      if (i >= 0) S.overlays.splice(i, 1);
      scrim.remove();
      if (overlay.onClose) overlay.onClose();
    };
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) overlay.close();
    });
    S.overlays.push(overlay);
    document.body.append(scrim);
    build(overlay);
    return overlay;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.overlays.length) S.overlays[S.overlays.length - 1].close();
  });

  function sheetHead(overlay, title, subtitle) {
    return h('div', { class: 'sheet-head' },
      h('div', {},
        h('div', { class: 'title-large' }, title),
        subtitle ? h('div', { class: 'body-medium muted' }, subtitle) : null),
      h('button', { class: 'icon-btn', 'aria-label': t('action.close'), onclick: () => overlay.close() }, icon('close')));
  }

  function snack(text, action) {
    document.querySelectorAll('.snackbar').forEach((el) => el.remove());
    clearTimeout(S.snackTimer);
    const bar = h('div', { class: 'snackbar', role: 'status' },
      h('span', { class: 'body-medium' }, text),
      action ? h('button', {
        class: 'btn text',
        onclick: () => { bar.remove(); action.run(); },
      }, action.label) : null);
    document.body.append(bar);
    S.snackTimer = setTimeout(() => bar.remove(), action ? 6000 : 3500);
  }

  function confirmDialog(text, confirmLabel) {
    return new Promise((resolve) => {
      let answered = false;
      openOverlay((o) => {
        o.onClose = () => { if (!answered) resolve(false); };
        o.sheet.append(
          h('div', { class: 'title-medium' }, text),
          h('div', { class: 'sheet-actions' },
            h('button', { class: 'btn text', onclick: () => o.close() }, t('action.cancel')),
            h('button', {
              class: 'btn filled danger',
              onclick: () => { answered = true; resolve(true); o.close(); },
            }, confirmLabel)));
      }, { dialog: true });
    });
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through to the older method */ }
    try {
      const area = h('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0' });
      area.value = text;
      document.body.append(area);
      area.select();
      area.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      area.remove();
      if (ok) return true;
    } catch (e) { /* show the manual dialog */ }
    return false;
  }

  async function copyLabel(item) {
    const text = labelText(item);
    if (await copyText(text)) {
      snack(t('snack.copied'));
      return;
    }
    openOverlay((o) => {
      const box = h('pre', { class: 'copy-text title-medium' }, text);
      o.sheet.append(
        h('div', { class: 'title-medium' }, t('copy.manual_title')),
        h('p', { class: 'body-medium muted' }, t('copy.manual_hint')),
        box,
        h('div', { class: 'sheet-actions' }, h('button', { class: 'btn text', onclick: () => o.close() }, t('action.close'))));
      const range = document.createRange();
      range.selectNodeContents(box);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }, { dialog: true });
  }

  // ------------------------------------------------------------------ choice controls

  // Filter chips; above six options a dropdown instead (unless forceChips)
  function choice(options, selected, onSelect, { forceChips = false, label = '' } = {}) {
    if (options.length > 6 && !forceChips) {
      const select = h('select', { class: 'select', 'aria-label': label, onchange: () => onSelect(parseValue(select.value)) },
        options.map((o) => h('option', { value: o.value === null ? '' : String(o.value), selected: o.value === selected }, o.label)));
      return select;
    }
    return h('div', { class: 'chips', role: 'radiogroup', 'aria-label': label },
      options.map((o) => h('button', {
        class: o.value === selected ? 'chip selected' : 'chip',
        role: 'radio',
        'aria-checked': o.value === selected ? 'true' : 'false',
        onclick: () => onSelect(o.value),
      }, o.value === selected ? icon('check') : null, o.label)));
  }

  function parseValue(raw) {
    if (raw === '') return null;
    return /^\d+$/.test(raw) ? Number(raw) : raw;
  }

  function switchControl(checked, onChange, label) {
    const sw = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(checked), 'aria-label': label });
    sw.addEventListener('click', () => {
      const now = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(now));
      onChange(now);
    });
    return sw;
  }

  // Drawer picker: always chips (agreed exception), one row per group
  function drawerChips(selected, onSelect, exclude = null) {
    const wrap = h('div', {});
    const draw = () => {
      wrap.replaceChildren();
      const all = S.state.drawers.filter((d) => d.id !== exclude);
      const ungrouped = all.filter((d) => !d.group_id || !S.groups.has(d.group_id));
      const row = (drawers) => choice(drawers.map((d) => ({ value: d.id, label: d.name })), selected,
        (v) => { selected = v; onSelect(v); draw(); }, { forceChips: true, label: t('field.drawer') });
      if (ungrouped.length) wrap.append(row(ungrouped));
      for (const group of S.state.groups) {
        const drawers = all.filter((d) => d.group_id === group.id);
        if (!drawers.length) continue;
        wrap.append(h('div', { class: 'chip-group-label body-medium muted' }, group.name), row(drawers));
      }
    };
    draw();
    return wrap;
  }

  // ------------------------------------------------------------------ amount picker (digit wheels)

  const ROW = 40; // px per wheel row, must match .wheel-item height

  function makeWheel(initial, label, onPick) {
    const wheel = h('div', { class: 'wheel', tabindex: '-1', 'aria-hidden': 'true' },
      h('div', { class: 'wheel-pad' }),
      Array.from({ length: 10 }, (_, d) => h('div', { class: 'wheel-item' }, String(d))),
      h('div', { class: 'wheel-pad' }));
    let quietUntil = 0;
    let timer = null;
    wheel.addEventListener('scroll', () => {
      if (Date.now() < quietUntil) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const digit = Math.max(0, Math.min(9, Math.round(wheel.scrollTop / ROW)));
        if (Math.abs(wheel.scrollTop - digit * ROW) > 1) wheel.scrollTo({ top: digit * ROW });
        onPick(digit);
      }, 120);
    });
    const show = (digit, smooth) => {
      quietUntil = Date.now() + (smooth ? 400 : 80);
      wheel.scrollTo({ top: digit * ROW, behavior: smooth ? 'smooth' : 'auto' });
    };
    const init = () => (wheel.isConnected ? show(initial, false) : requestAnimationFrame(init));
    requestAnimationFrame(init);
    return { el: wheel, show };
  }

  /* value/max in tenths. max = null means no upper limit (adding).
   * extraActions: buttons shown next to "Type amount". */
  function createPicker({ value, max = null, decimals, unit, onChange, extraActions = [] }) {
    const root = h('div', {});
    let current = value;
    let typing = false;
    let allowDecimals = decimals;
    let currentUnit = unit;
    let digitCount = 1;
    let digits = [];
    let tenth = 0;
    let wheels = [];

    const countDigits = () => {
      const whole = String(Math.floor(current / 10)).length;
      if (max !== null) return Math.max(whole, String(Math.floor(max / 10)).length, 1);
      return Math.min(7, Math.max(2, whole + 1));
    };

    const fromValue = () => {
      digitCount = countDigits();
      digits = String(Math.floor(current / 10)).padStart(digitCount, '0').split('').map(Number);
      tenth = allowDecimals ? current % 10 : 0;
    };

    const toValue = () => Number(digits.join('')) * 10 + (allowDecimals ? tenth : 0);

    const markLeading = () => {
      let leading = true;
      wheels.forEach((w, i) => {
        if (i >= digitCount) return;
        if (digits[i] !== 0 || i === digitCount - 1) leading = false;
        w.col.classList.toggle('leading', leading);
      });
    };

    const updateLabel = () => {
      const label = root.querySelector('.picker .picker-unit');
      if (label && currentUnit) label.textContent = unitName(currentUnit, current);
    };

    const changed = () => {
      current = toValue();
      markLeading();
      updateLabel();
      onChange(current);
    };

    const column = (getDigit, setDigit, label) => {
      const col = h('div', { class: 'picker-col' });
      const wheel = makeWheel(getDigit(), label, (d) => {
        if (d !== getDigit()) { setDigit(d); changed(); }
      });
      const step = (delta) => {
        const d = (getDigit() + delta + 10) % 10;
        setDigit(d);
        wheel.show(d, true);
        changed();
      };
      col.append(
        h('button', { class: 'icon-btn', 'aria-label': `${t('action.increase')} (${label})`, onclick: () => step(1) }, icon('up')),
        h('div', { class: 'picker-window' }, wheel.el),
        h('button', { class: 'icon-btn', 'aria-label': `${t('action.decrease')} (${label})`, onclick: () => step(-1) }, icon('down')));
      return { col, wheel };
    };

    const render = () => {
      root.replaceChildren();
      wheels = [];
      if (typing) {
        const input = h('input', {
          class: 'text-input',
          type: 'text',
          inputmode: 'decimal',
          autocomplete: 'off',
          'aria-label': t('field.amount'),
          value: plainNum(current),
        });
        const error = h('div', { class: 'field-error body-medium hidden' });
        const apply = () => {
          let parsed = parseAmount(input.value);
          if (parsed === null) {
            error.textContent = t('field.invalid_number');
            error.classList.remove('hidden');
            return;
          }
          if (!allowDecimals) parsed = Math.round(parsed / 10) * 10;
          if (max !== null && parsed > max) parsed = max;
          current = parsed;
          typing = false;
          render();
          onChange(current);
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        root.append(
          h('div', { class: 'picker-typing' }, input,
            h('span', { class: 'picker-unit' }, currentUnit ? unitName(currentUnit, 20) : ''),
            h('button', { class: 'btn tonal', onclick: apply }, t('action.ok'))),
          error);
        requestAnimationFrame(() => { input.focus(); input.select(); });
        return;
      }
      fromValue();
      const row = h('div', { class: 'picker' });
      for (let i = 0; i < digitCount; i += 1) {
        const position = 10 ** (digitCount - 1 - i);
        const c = column(() => digits[i], (d) => { digits[i] = d; }, fmtNum(position * 10));
        wheels.push(c);
        row.append(c.col);
      }
      if (allowDecimals) {
        row.append(h('div', { class: 'picker-sep' }, decimalSep()));
        const c = column(() => tenth, (d) => { tenth = d; }, fmtNum(1));
        wheels.push(c);
        row.append(c.col);
      }
      row.append(h('span', { class: 'picker-unit title-medium' }, currentUnit ? unitName(currentUnit, current) : ''));
      markLeading();
      root.append(row,
        h('div', { class: 'picker-actions' },
          h('button', {
            class: 'btn text',
            onclick: () => { typing = true; render(); },
          }, icon('keyboard'), t('action.type_amount')),
          extraActions));
    };

    render();
    return {
      el: root,
      get value() { return current; },
      set(v) { current = v; typing = false; render(); onChange(current); },
      setUnit(u) {
        currentUnit = u;
        allowDecimals = u.decimals || (current % 10 !== 0 && max !== null);
        if (!allowDecimals) current = Math.max(10, Math.round(current / 10) * 10);
        typing = false;
        render();
        onChange(current);
      },
    };
  }

  // ------------------------------------------------------------------ add / edit sheet

  function openForm(item) {
    const editing = Boolean(item);
    const catalog = S.state.catalog;
    const lastDrawer = Number(storageGet('wiezer.lastDrawer'));
    const lastUnit = Number(storageGet('wiezer.lastUnit'));
    const firstUnit = S.state.units.find((u) => u.builtin === 'portion') || S.state.units[0];
    const form = {
      name: editing ? item.name : '',
      drawer_id: editing ? item.drawer_id : (S.drawers.has(lastDrawer) ? lastDrawer : S.state.drawers[0].id),
      unit_id: editing ? item.unit_id : (S.units.has(lastUnit) ? lastUnit : firstUnit.id),
      added: editing ? item.added : todayIso(),
      note: editing ? item.note : '',
    };
    form.amount = editing ? item.amount : S.units.get(form.unit_id).step;
    const touched = { drawer: editing, unit: editing, amount: editing };

    openOverlay((o) => {
      const nameInput = h('input', {
        class: 'text-input', type: 'text', autocomplete: 'off', maxlength: '100', value: form.name, 'aria-label': t('field.name'),
      });
      const nameError = h('div', { class: 'field-error body-medium hidden' }, t('field.required'));
      const suggestions = h('div', { class: 'suggestions hidden', role: 'listbox' });
      const drawerSlot = h('div', {});
      const unitSlot = h('div', {});
      const amountError = h('div', { class: 'field-error body-medium hidden' }, t('field.invalid_number'));
      const dateInput = h('input', { class: 'text-input', type: 'date', value: form.added, 'aria-label': t('field.date') });
      const noteInput = h('textarea', { class: 'text-input', maxlength: '500', 'aria-label': t('field.note') });
      noteInput.value = form.note;

      const picker = createPicker({
        value: form.amount,
        decimals: S.units.get(form.unit_id).decimals || form.amount % 10 !== 0,
        unit: S.units.get(form.unit_id),
        onChange: (v) => { form.amount = v; touched.amount = true; amountError.classList.add('hidden'); },
      });

      const drawDrawers = () => drawerSlot.replaceChildren(drawerChips(form.drawer_id, (v) => {
        form.drawer_id = v; touched.drawer = true;
      }));

      const drawUnits = () => unitSlot.replaceChildren(choice(
        S.state.units.map((u) => ({ value: u.id, label: unitName(u, 20) })), form.unit_id,
        (v) => {
          form.unit_id = v;
          touched.unit = true;
          const unit = S.units.get(v);
          const wasTouched = touched.amount;
          if (!wasTouched) picker.set(unit.step);
          picker.setUnit(unit);
          form.amount = picker.value;
          touched.amount = wasTouched;
          drawUnits();
        }, { label: t('field.unit') }));

      const applySuggestion = (entry, setName) => {
        if (setName) { form.name = entry.name; nameInput.value = entry.name; }
        if (entry.drawer_id && S.drawers.has(entry.drawer_id)) { form.drawer_id = entry.drawer_id; drawDrawers(); }
        if (entry.unit_id && S.units.has(entry.unit_id)) {
          form.unit_id = entry.unit_id;
          const unit = S.units.get(entry.unit_id);
          picker.setUnit(unit);
          drawUnits();
        }
        if (entry.amount) picker.set(entry.amount);
        form.amount = picker.value;
        touched.amount = false;
        suggestions.classList.add('hidden');
      };

      const showSuggestions = () => {
        const q = normalize(nameInput.value);
        suggestions.replaceChildren();
        if (!q) { suggestions.classList.add('hidden'); return; }
        const starts = [];
        const contains = [];
        for (const entry of catalog) {
          const n = normalize(entry.name);
          if (n === q) continue;
          if (n.startsWith(q)) starts.push(entry);
          else if (n.includes(q)) contains.push(entry);
        }
        const list = starts.concat(contains).slice(0, 6);
        if (!list.length) { suggestions.classList.add('hidden'); return; }
        for (const entry of list) {
          const unit = S.units.get(entry.unit_id);
          suggestions.append(h('button', {
            class: 'suggestion',
            role: 'option',
            onpointerdown: (e) => e.preventDefault(), // keep focus in the name field
            onclick: () => applySuggestion(entry, true),
          },
          h('div', {}, entry.name),
          unit && entry.amount ? h('div', { class: 'body-medium muted' }, fmtAmount(entry.amount, unit)) : null));
        }
        suggestions.classList.remove('hidden');
      };

      nameInput.addEventListener('input', () => {
        form.name = nameInput.value;
        nameError.classList.add('hidden');
        showSuggestions();
        if (!editing && !touched.drawer && !touched.unit) {
          const exact = catalog.find((c) => normalize(c.name) === normalize(nameInput.value));
          if (exact) applySuggestion(exact, false);
        }
      });
      nameInput.addEventListener('blur', () => suggestions.classList.add('hidden'));

      const save = async () => {
        const name = nameInput.value.trim();
        if (!name) { nameError.classList.remove('hidden'); nameInput.focus(); return; }
        if (!(form.amount > 0)) { amountError.classList.remove('hidden'); return; }
        const body = {
          name,
          drawer_id: form.drawer_id,
          unit_id: form.unit_id,
          amount: form.amount,
          added: dateInput.value || todayIso(),
          note: noteInput.value,
        };
        try {
          if (editing) {
            await api('PATCH', `items/${item.id}`, body);
            o.close();
            snack(t('snack.saved'));
          } else {
            const result = await api('POST', 'items', body);
            storageSet('wiezer.lastDrawer', form.drawer_id);
            storageSet('wiezer.lastUnit', form.unit_id);
            o.close();
            const created = S.items.get(result.created_id);
            snack(t('snack.saved'), created ? { label: t('action.copy_label'), run: () => copyLabel(created) } : null);
          }
        } catch (e) { /* error already shown */ }
      };

      drawDrawers();
      drawUnits();
      o.sheet.append(
        h('div', { class: 'sheet-handle' }),
        sheetHead(o, editing ? t('sheet.edit_title') : t('sheet.add_title')),
        h('label', { class: 'field' }, h('span', { class: 'field-label body-medium' }, t('field.name')), nameInput, nameError, suggestions),
        h('div', { class: 'field' }, h('span', { class: 'field-label body-medium' }, t('field.drawer')), drawerSlot),
        h('div', { class: 'field' }, h('span', { class: 'field-label body-medium' }, t('field.unit')), unitSlot),
        h('div', { class: 'field' }, h('span', { class: 'field-label body-medium' }, t('field.amount')), picker.el, amountError),
        h('label', { class: 'field' }, h('span', { class: 'field-label body-medium' }, t('field.date')), dateInput),
        h('label', { class: 'field' }, h('span', { class: 'field-label body-medium' }, t('field.note')), noteInput),
        h('div', { class: editing ? 'sheet-actions spread' : 'sheet-actions' },
          editing ? h('button', { class: 'btn text danger', onclick: () => deleteItem(item, o) }, icon('delete'), t('action.delete')) : null,
          h('div', { class: 'sheet-actions', style: 'margin-top:0' },
            h('button', { class: 'btn text', onclick: () => o.close() }, t('action.cancel')),
            h('button', { class: 'btn filled', onclick: save }, t('action.save')))));

      o.onState = () => {
        if (editing && !S.items.has(item.id)) { o.close(); snack(t('snack.item_gone')); }
      };
      if (!editing) requestAnimationFrame(() => nameInput.focus());
    });
  }

  async function deleteItem(item, overlay) {
    if (!(await confirmDialog(t('confirm.delete', { name: item.name }), t('action.delete')))) return;
    try {
      await api('DELETE', `items/${item.id}`);
      if (overlay) overlay.close();
      snack(t('snack.deleted'));
    } catch (e) { /* shown */ }
  }

  // ------------------------------------------------------------------ moving between drawers

  async function moveItem(item, drawerId, amount) {
    const result = await api('POST', `items/${item.id}/move`, { drawer_id: drawerId, amount });
    const location = locationText({ drawer_id: drawerId });
    snack(t(result.merged ? 'snack.moved_merged' : 'snack.moved', { location }), {
      label: t('action.undo'),
      run: async () => {
        try {
          await api('POST', 'items/undo', { token: result.undo });
          snack(t('snack.undone'));
        } catch (e) { /* shown */ }
      },
    });
    return result;
  }

  // Drag an entry by its grip handle onto another drawer card (pointer events: touch, pen and mouse)
  function startDrag(e, item) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const row = handle.closest('.item');
    const rect = row.getBoundingClientRect();
    const ghost = row.cloneNode(true);
    ghost.classList.add('drag-ghost');
    Object.assign(ghost.style, { width: `${rect.width}px`, left: `${rect.left}px`, top: `${rect.top}px` });
    document.body.append(ghost);
    row.classList.add('dragging');
    document.body.classList.add('is-dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) { /* not allowed */ }
    S.dragging = true;
    const offsetY = e.clientY - rect.top;
    let x = e.clientX;
    let y = e.clientY;
    let target = null;
    let frame = null;

    const findTarget = () => {
      const el = document.elementFromPoint(x, y);
      const card = el ? el.closest('.drawer[data-drawer]') : null;
      const next = card && Number(card.dataset.drawer) !== item.drawer_id ? card : null;
      if (next !== target) {
        if (target) target.classList.remove('drop-target');
        target = next;
        if (target) target.classList.add('drop-target');
      }
    };
    // Scroll the list while the finger is near the top or bottom edge
    const autoScroll = () => {
      const edge = 80;
      let dy = 0;
      if (y < edge) dy = -Math.ceil((edge - y) / 5);
      else if (y > window.innerHeight - edge) dy = Math.ceil((y - (window.innerHeight - edge)) / 5);
      if (dy) { window.scrollBy(0, dy); findTarget(); }
      frame = requestAnimationFrame(autoScroll);
    };
    frame = requestAnimationFrame(autoScroll);

    const onMove = (ev) => {
      x = ev.clientX;
      y = ev.clientY;
      ghost.style.top = `${y - offsetY}px`;
      findTarget();
    };
    const finish = async (cancelled) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      cancelAnimationFrame(frame);
      ghost.remove();
      row.classList.remove('dragging');
      document.body.classList.remove('is-dragging');
      const dest = !cancelled && target ? Number(target.dataset.drawer) : null;
      if (target) target.classList.remove('drop-target');
      S.dragging = false;
      const pending = S.pendingState;
      S.pendingState = null;
      if (dest) {
        try { await moveItem(item, dest, item.amount); } catch (err) { if (pending) applyState(pending); }
      } else if (pending) {
        applyState(pending);
      }
    };
    const onUp = () => finish(false);
    const onCancel = () => finish(true);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
  }

  // ------------------------------------------------------------------ entry sheet (take out, move, copy, edit)

  function openItem(id) {
    openOverlay((o) => {
      let shown = null;
      const draw = () => {
        const item = S.items.get(id);
        shown = item;
        const unit = S.units.get(item.unit_id);
        const start = Math.min(unit.step, item.amount);
        const status = h('div', { class: 'take-status body-medium muted' });
        const takeBtn = h('button', { class: 'btn filled' }, icon('remove'), t('action.take'));
        const canMove = S.state.drawers.length > 1;
        const moveBtn = h('button', { class: 'btn tonal' }, icon('move'), t('action.move'));
        const moveLabel = h('div', { class: 'title-medium' });
        const movePanel = h('div', { class: 'move-panel hidden' }, moveLabel,
          drawerChips(null, async (drawerId) => {
            try {
              await moveItem(item, drawerId, Math.min(picker.value, item.amount));
              o.close();
            } catch (e) { /* shown */ }
          }, item.drawer_id));
        let moving = false;
        const update = (v) => {
          const amount = Math.min(v, item.amount);
          if (v >= item.amount) {
            const whole = moving ? t('move.whole') : t('take.removes');
            status.textContent = v > item.amount
              ? `${t('take.capped', { amount: fmtAmount(item.amount, unit) })} – ${whole}`
              : whole;
          } else {
            status.textContent = t('take.remaining', { amount: fmtAmount(item.amount - v, unit) });
          }
          moveLabel.textContent = t('move.where', { amount: fmtAmount(amount, unit) });
          takeBtn.disabled = v <= 0;
          moveBtn.disabled = v <= 0;
          movePanel.classList.toggle('disabled', v <= 0);
        };
        moveBtn.addEventListener('click', () => {
          moving = !moving;
          movePanel.classList.toggle('hidden', !moving);
          moveBtn.classList.toggle('selected', moving);
          update(picker.value);
          if (moving) requestAnimationFrame(() => movePanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
        });
        let picker = null;
        picker = createPicker({
          value: start,
          max: item.amount,
          decimals: unit.decimals || item.amount % 10 !== 0,
          unit,
          onChange: update,
          extraActions: [h('button', { class: 'btn outlined', onclick: () => picker.set(item.amount) }, t('action.all'))],
        });
        update(start);
        takeBtn.addEventListener('click', async () => {
          const amount = Math.min(picker.value, item.amount);
          try {
            const result = await api('POST', `items/${item.id}/take`, { amount });
            o.close();
            if (result.removed) snack(t('snack.removed'));
            else snack(t('snack.taken_rest', { amount: fmtAmount(item.amount - amount, unit) }));
          } catch (e) { /* shown */ }
        });

        o.sheet.replaceChildren(...[
          h('div', { class: 'sheet-handle' }),
          sheetHead(o, item.name, `${fmtAmount(item.amount, unit)} · ${fmtDate(item.added)} · ${locationText(item)}`),
          item.note ? h('p', { class: 'body-medium', style: 'white-space:pre-wrap' }, item.note) : null,
          item.created_by ? h('div', { class: 'body-medium muted' }, t('item.added_by', { name: item.created_by })) : null,
          h('hr', { class: 'divider' }),
          h('div', { class: 'title-medium' }, t('field.amount')),
          picker.el,
          status,
          h('div', { class: 'sheet-actions', style: 'justify-content:center;margin-top:0' }, takeBtn, canMove ? moveBtn : null),
          canMove ? movePanel : null,
          h('hr', { class: 'divider' }),
          h('div', { class: 'sheet-actions', style: 'justify-content:center;margin-top:0' },
            h('button', { class: 'btn tonal', onclick: () => copyLabel(item) }, icon('copy'), t('action.copy_label')),
            h('button', { class: 'btn outlined', onclick: () => { o.close(); openForm(item); } }, icon('edit'), t('action.edit')),
            h('button', { class: 'btn text danger', onclick: () => deleteItem(item, o) }, icon('delete'), t('action.delete'))),
        ].filter(Boolean));
      };
      o.onState = () => {
        const item = S.items.get(id);
        if (!item) { o.close(); snack(t('snack.item_gone')); return; }
        if (JSON.stringify(item) !== JSON.stringify(shown)) draw();
      };
      draw();
    });
  }

  // ------------------------------------------------------------------ main list view

  function renderList() {
    const app = document.getElementById('app');
    const content = h('div', { id: 'content' });
    const searchInput = h('input', {
      type: 'search', value: S.search, placeholder: t('app.search_placeholder'), 'aria-label': t('app.search_placeholder'),
      oninput: () => { S.search = searchInput.value; renderContent(); },
    });
    app.replaceChildren(
      h('header', { class: 'top-bar' },
        h('div', { class: 'title-large' }, 'Wiezer'),
        h('button', { class: 'icon-btn', 'aria-label': t('action.settings'), onclick: () => navigate('settings') }, icon('settings'))),
      h('div', { class: 'search' }, icon('search'), searchInput),
      content,
      h('button', { class: 'fab', onclick: () => openForm(null) }, icon('add'), t('action.add')));
    renderContent();
  }

  function drawerCard(drawer, items) {
    const count = items.length;
    return h('section', { class: 'drawer', 'data-drawer': String(drawer.id) },
      h('div', { class: 'drawer-head' },
        h('span', { class: 'drawer-badge' }, drawer.name),
        h('span', { class: 'body-medium' }, count
          ? t(count === 1 ? 'list.entries_one' : 'list.entries_other', { n: count })
          : t('list.empty_drawer'))),
      items.map((item) => {
        const unit = S.units.get(item.unit_id);
        return h('div', { class: 'item' },
          h('button', { class: 'item-main', onclick: () => openItem(item.id) },
            h('div', { class: 'item-text' },
              h('div', { class: 'item-name title-medium' }, item.name),
              h('div', { class: 'body-medium muted' }, `${fmtAmount(item.amount, unit)} · ${fmtDate(item.added)}`))),
          S.state.drawers.length > 1
            ? h('div', {
              class: 'drag-handle',
              title: t('action.drag'),
              'aria-label': t('action.drag'),
              onpointerdown: (e) => startDrag(e, item),
            }, icon('grip'))
            : null);
      }));
  }

  function renderContent() {
    if (S.view !== 'list') { if (S.view === 'settings') renderSettings(); return; }
    const content = document.getElementById('content');
    if (!content || !S.state) return;
    const q = normalize(S.search);
    const searching = q.length > 0;
    const byDrawer = new Map();
    for (const item of S.state.items) {
      if (searching && !normalize(item.name).includes(q) && !normalize(item.note || '').includes(q)) continue;
      if (!byDrawer.has(item.drawer_id)) byDrawer.set(item.drawer_id, []);
      byDrawer.get(item.drawer_id).push(item);
    }
    const nodes = [];
    const addDrawers = (drawers) => {
      for (const d of drawers) {
        const items = byDrawer.get(d.id) || [];
        if (searching && !items.length) continue;
        nodes.push(drawerCard(d, items));
      }
    };
    addDrawers(S.state.drawers.filter((d) => !d.group_id || !S.groups.has(d.group_id)));
    for (const group of S.state.groups) {
      const drawers = S.state.drawers.filter((d) => d.group_id === group.id);
      const before = nodes.length;
      addDrawers(drawers);
      if (nodes.length > before) nodes.splice(before, 0, h('h2', { class: 'group-heading title-small' }, group.name));
    }
    if (searching && !nodes.length) nodes.push(h('div', { class: 'empty-state muted' }, t('list.no_results')));
    content.replaceChildren(...nodes);
  }

  // ------------------------------------------------------------------ settings view

  function settingBlock(title, desc, control) {
    return h('div', { class: 'setting' },
      h('div', { class: 'title-medium' }, title),
      desc ? h('div', { class: 'body-medium muted' }, desc) : null,
      control);
  }

  function moveButtons(kind, row, index, total) {
    const move = (direction) => api('POST', `${kind}/${row.id}/move`, { direction }).catch(() => {});
    return [
      h('button', { class: 'icon-btn', 'aria-label': t('action.move_up'), disabled: index === 0, onclick: () => move(-1) }, icon('up')),
      h('button', { class: 'icon-btn', 'aria-label': t('action.move_down'), disabled: index === total - 1, onclick: () => move(1) }, icon('down')),
    ];
  }

  function listRow(main, secondary, onOpen, extra) {
    return h('div', { class: 'list-row' },
      h('button', { class: 'list-row-main', onclick: onOpen },
        h('div', { class: 'title-medium' }, main),
        secondary ? h('div', { class: 'body-medium muted' }, secondary) : null),
      extra);
  }

  function renderSettings() {
    const app = document.getElementById('app');
    const st = S.state;
    const savePrefs = (patch) => api('PUT', 'settings', { ...st.settings, ...patch }).catch(() => {});

    const general = h('section', { class: 'section' },
      h('h2', { class: 'section-title title-small' }, t('settings.general')),
      settingBlock(t('settings.language'), t('settings.language_desc'),
        choice([{ value: 'system', label: t('option.system') }, { value: 'de', label: t('lang.de') }, { value: 'en', label: t('lang.en') }],
          st.settings.language, (v) => savePrefs({ language: v }), { label: t('settings.language') })),
      settingBlock(t('settings.theme'), t('settings.theme_desc'),
        choice([{ value: 'system', label: t('option.system') }, { value: 'light', label: t('option.light') }, { value: 'dark', label: t('option.dark') }],
          st.settings.theme, (v) => savePrefs({ theme: v }), { label: t('settings.theme') })));

    const drawers = h('section', { class: 'section' },
      h('h2', { class: 'section-title title-small' }, t('settings.drawers')),
      h('div', { class: 'body-medium muted' }, t('settings.drawers_desc')),
      st.drawers.map((d, i) => listRow(d.name,
        d.group_id && S.groups.has(d.group_id) ? S.groups.get(d.group_id).name : t('field.no_group'),
        () => drawerDialog(d), moveButtons('drawers', d, i, st.drawers.length))),
      h('button', { class: 'btn tonal', style: 'margin:8px 0', onclick: () => drawerDialog(null) }, icon('add'), t('settings.add_drawer')));

    const groups = h('section', { class: 'section' },
      h('h2', { class: 'section-title title-small' }, t('settings.groups')),
      h('div', { class: 'body-medium muted' }, t('settings.groups_desc')),
      st.groups.length
        ? st.groups.map((g, i) => listRow(g.name, null, () => groupDialog(g), moveButtons('groups', g, i, st.groups.length)))
        : h('div', { class: 'body-medium muted', style: 'padding:12px 0' }, t('settings.no_groups')),
      h('button', { class: 'btn tonal', style: 'margin:8px 0', onclick: () => groupDialog(null) }, icon('add'), t('settings.add_group')));

    const units = h('section', { class: 'section' },
      h('h2', { class: 'section-title title-small' }, t('settings.units')),
      h('div', { class: 'body-medium muted' }, t('settings.units_desc')),
      st.units.map((u, i) => listRow(unitTitle(u),
        [t('settings.unit_step', { step: fmtAmount(u.step, u) }), u.decimals ? t('settings.unit_decimals') : null].filter(Boolean).join(' · '),
        () => unitDialog(u), moveButtons('units', u, i, st.units.length))),
      h('button', { class: 'btn tonal', style: 'margin:8px 0', onclick: () => unitDialog(null) }, icon('add'), t('settings.add_unit')));

    const about = h('section', { class: 'section' },
      h('h2', { class: 'section-title title-small' }, t('settings.about')),
      settingBlock(t('settings.version'), st.version, h('div', { class: 'body-medium muted' }, t('settings.about_desc'))),
      listRow(t('settings.changelog'), t('settings.changelog_desc'), () => navigate('changelog'),
        h('span', { class: 'chev muted', style: 'padding:0 12px' }, icon('chevron'))));

    const scrollY = window.scrollY;
    app.replaceChildren(
      topBarBack(t('settings.title'), () => goBack('list')),
      general, h('hr', { class: 'divider full' }),
      drawers, h('hr', { class: 'divider full' }),
      groups, h('hr', { class: 'divider full' }),
      units, h('hr', { class: 'divider full' }),
      about);
    window.scrollTo(0, scrollY);
  }

  function topBarBack(title, onBack) {
    return h('header', { class: 'top-bar with-back' },
      h('button', { class: 'icon-btn', 'aria-label': t('action.back'), onclick: onBack }, icon('back')),
      h('div', { class: 'title-large' }, title));
  }

  function dialogActions(o, onDelete, onSave) {
    return h('div', { class: onDelete ? 'sheet-actions spread' : 'sheet-actions' },
      onDelete ? h('button', { class: 'btn text danger', onclick: onDelete }, t('action.delete')) : null,
      h('div', { class: 'sheet-actions', style: 'margin-top:0' },
        h('button', { class: 'btn text', onclick: () => o.close() }, t('action.cancel')),
        h('button', { class: 'btn filled', onclick: onSave }, t('action.save'))));
  }

  function textField(label, value, attrs) {
    const input = h('input', { class: 'text-input', type: 'text', autocomplete: 'off', maxlength: '100', value, 'aria-label': label, ...attrs });
    const error = h('div', { class: 'field-error body-medium hidden' });
    const wrap = h('label', { class: 'field' }, h('span', { class: 'field-label body-medium' }, label), input, error);
    return {
      wrap,
      input,
      fail(msg) { error.textContent = msg; error.classList.remove('hidden'); input.focus(); },
      clear() { error.classList.add('hidden'); },
    };
  }

  function drawerDialog(drawer) {
    openOverlay((o) => {
      const name = textField(t('field.drawer_name'), drawer ? drawer.name : '');
      let groupId = drawer ? (S.groups.has(drawer.group_id) ? drawer.group_id : null) : null;
      const groupSlot = h('div', {});
      const drawGroups = () => groupSlot.replaceChildren(choice(
        [{ value: null, label: t('field.no_group') }, ...S.state.groups.map((g) => ({ value: g.id, label: g.name }))],
        groupId, (v) => { groupId = v; drawGroups(); }, { label: t('field.group') }));
      drawGroups();
      const save = async () => {
        const value = name.input.value.trim();
        if (!value) { name.fail(t('field.required')); return; }
        try {
          if (drawer) await api('PATCH', `drawers/${drawer.id}`, { name: value, group_id: groupId });
          else await api('POST', 'drawers', { name: value, group_id: groupId });
          o.close();
        } catch (e) { /* shown */ }
      };
      const remove = drawer ? async () => {
        if (!(await confirmDialog(t('confirm.delete', { name: drawer.name }), t('action.delete')))) return;
        try { await api('DELETE', `drawers/${drawer.id}`); o.close(); } catch (e) { /* shown */ }
      } : null;
      o.sheet.append(
        h('div', { class: 'title-large' }, t('settings.drawer_title')),
        name.wrap,
        h('div', { class: 'field' }, h('span', { class: 'field-label body-medium' }, t('field.group')), groupSlot),
        dialogActions(o, remove, save));
      name.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      requestAnimationFrame(() => name.input.focus());
    }, { dialog: true });
  }

  function groupDialog(group) {
    openOverlay((o) => {
      const name = textField(t('field.group_name'), group ? group.name : '');
      const save = async () => {
        const value = name.input.value.trim();
        if (!value) { name.fail(t('field.required')); return; }
        try {
          if (group) await api('PATCH', `groups/${group.id}`, { name: value });
          else await api('POST', 'groups', { name: value });
          o.close();
        } catch (e) { /* shown */ }
      };
      const remove = group ? async () => {
        if (!(await confirmDialog(t('confirm.delete_group', { name: group.name }), t('action.delete')))) return;
        try { await api('DELETE', `groups/${group.id}`); o.close(); } catch (e) { /* shown */ }
      } : null;
      o.sheet.append(h('div', { class: 'title-large' }, t('settings.group_title')), name.wrap, dialogActions(o, remove, save));
      name.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      requestAnimationFrame(() => name.input.focus());
    }, { dialog: true });
  }

  function unitDialog(unit) {
    openOverlay((o) => {
      const shownOne = unit ? unitName(unit, 10) : '';
      const shownOther = unit ? unitName(unit, 20) : '';
      const singular = textField(t('field.singular'), shownOne);
      const plural = textField(t('field.plural'), shownOther === shownOne ? '' : shownOther);
      plural.wrap.append(h('div', { class: 'body-medium muted' }, t('field.plural_hint')));
      let decimals = unit ? unit.decimals : false;
      const step = textField(t('field.step'), unit ? plainNum(unit.step) : '1', { inputmode: 'decimal', maxlength: '12' });
      step.wrap.append(h('div', { class: 'body-medium muted' }, t('field.step_hint')));
      const save = async () => {
        const one = singular.input.value.trim();
        if (!one) { singular.fail(t('field.required')); return; }
        const stepValue = parseAmount(step.input.value);
        if (!stepValue) { step.fail(t('field.invalid_number')); return; }
        if (!decimals && stepValue % 10) { step.fail(t('field.whole_number')); return; }
        const other = plural.input.value.trim();
        const body = { step: stepValue, decimals };
        const namesUnchanged = unit && one === shownOne && (other || one) === shownOther;
        if (!namesUnchanged) { body.singular = one; body.plural = other; }
        try {
          if (unit) await api('PATCH', `units/${unit.id}`, body);
          else await api('POST', 'units', { ...body, singular: one, plural: other });
          o.close();
        } catch (e) { /* shown */ }
      };
      const remove = unit ? async () => {
        if (!(await confirmDialog(t('confirm.delete', { name: unitTitle(unit) }), t('action.delete')))) return;
        try { await api('DELETE', `units/${unit.id}`); o.close(); } catch (e) { /* shown */ }
      } : null;
      o.sheet.append(
        h('div', { class: 'title-large' }, t('settings.unit_title')),
        singular.wrap,
        plural.wrap,
        step.wrap,
        h('div', { class: 'setting-row', style: 'margin:16px 0' },
          h('div', {},
            h('div', { class: 'title-medium' }, t('field.decimals')),
            h('div', { class: 'body-medium muted' }, t('field.decimals_hint'))),
          switchControl(decimals, (v) => { decimals = v; }, t('field.decimals'))),
        dialogActions(o, remove, save));
      requestAnimationFrame(() => singular.input.focus());
    }, { dialog: true });
  }

  // ------------------------------------------------------------------ changelog view

  async function renderChangelog() {
    const app = document.getElementById('app');
    const list = h('div', {});
    app.replaceChildren(topBarBack(t('changelog.title'), () => goBack('settings')), list);
    try {
      if (!S.changelog) S.changelog = await fetchJson('changelog.json');
    } catch (e) {
      list.append(h('div', { class: 'empty-state muted' }, t('error.network')));
      return;
    }
    for (const entry of S.changelog) {
      list.append(h('section', { class: 'changelog-entry' },
        h('div', { class: 'title-medium' }, `${entry.version} · ${fmtDate(entry.date)}`),
        h('ul', { class: 'body-medium' }, (entry[S.lang] || entry.en).map((line) => h('li', {}, line)))));
    }
  }

  // ------------------------------------------------------------------ navigation & startup

  function viewFromHash() {
    const hash = location.hash.replace('#', '');
    return ['settings', 'changelog'].includes(hash) ? hash : 'list';
  }

  function navigate(view) {
    if (view === S.view) return;
    history.pushState({ wiezer: view }, '', `#${view}`);
    S.view = view;
    window.scrollTo(0, 0);
    render();
  }

  // Go back one level; uses the browser history when we created the entry ourselves
  function goBack(fallback) {
    if (history.state && history.state.wiezer) { history.back(); return; }
    history.replaceState(null, '', fallback === 'list' ? location.pathname + location.search : `#${fallback}`);
    S.view = fallback;
    render();
  }

  window.addEventListener('popstate', () => {
    S.view = viewFromHash();
    while (S.overlays.length) S.overlays[S.overlays.length - 1].close();
    render();
  });

  function render() {
    if (!S.state) return;
    if (S.view === 'settings') renderSettings();
    else if (S.view === 'changelog') renderChangelog();
    else renderList();
  }

  async function start() {
    const app = document.getElementById('app');
    try {
      const [en, de] = await Promise.all([fetchJson('i18n/en.json'), fetchJson('i18n/de.json')]);
      S.strings = { en, de };
    } catch (e) { /* keys are shown as a last resort */ }
    applyPrefs({ language: 'system', theme: 'system' });
    app.replaceChildren(h('div', { class: 'empty-state muted' }, t('app.loading')));
    S.view = viewFromHash();
    try {
      applyState(await fetchJson(API + 'state'));
      render();
    } catch (e) {
      app.replaceChildren(h('div', { class: 'empty-state' },
        h('p', { class: 'muted' }, t('error.network')),
        h('button', { class: 'btn tonal', onclick: start }, t('action.retry'))));
      return;
    }
    if (!S.pollTimer) {
      S.pollTimer = setInterval(poll, POLL_MS);
      document.addEventListener('visibilitychange', poll);
    }
  }

  start();
})();
