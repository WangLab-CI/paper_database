// Small UI building blocks: modal dialogs and tag inputs.
import { esc, parseTags } from './util.js';

export function modal(title, bodyHtml, { wide = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="ghost close" aria-label="Close">✕</button></div>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  wrap.querySelector('.close').onclick = close;
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  wrap.querySelector('input,textarea,select')?.focus();
  return { el: wrap.querySelector('.modal-body'), close };
}

export function confirmDialog(message) {
  return new Promise((resolve) => {
    const m = modal('Please confirm', `<p>${esc(message)}</p>
      <div class="row end"><button class="ghost" data-a="no">Cancel</button><button class="danger" data-a="yes">Confirm</button></div>`);
    m.el.querySelector('[data-a=no]').onclick = () => { m.close(); resolve(false); };
    m.el.querySelector('[data-a=yes]').onclick = () => { m.close(); resolve(true); };
  });
}

// Comma-separated tag input with autocomplete from a datalist.
export function tagInputHtml(name, tags = [], allTags = []) {
  const id = `dl-${name}-${Math.random().toString(36).slice(2, 7)}`;
  return `<input name="${name}" class="tag-input" list="${id}" value="${esc((tags || []).join(', '))}"
            placeholder="e.g. tp53, organoids, spatial transcriptomics" autocomplete="off">
          <datalist id="${id}">${allTags.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
          <small class="muted">Comma-separated. Tags become concept nodes in the graph.</small>`;
}

export const readTags = (form, name = 'tags') => parseTags(form.elements[name]?.value);

export function formData(form) {
  const o = {};
  for (const el of form.elements) if (el.name) o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  return o;
}
