/** 轻量 UI 工具：DOM 构建、提示、弹窗、通用表单 */

type Child = Node | string | number | null | undefined | false;

/** 极简 hyperscript：h('div', { class: 'x', onclick: fn }, '文本', 子元素) */
export function h(tag: string, props?: Record<string, any> | null, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'html') node.innerHTML = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key in node && typeof (node as any)[key] !== 'function' && key !== 'style') {
        (node as any)[key] = value;
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* ---------------- 提示 ---------------- */
let toastHost: HTMLElement | null = null;

export function toast(message: string, type: 'ok' | 'err' | '' = ''): void {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = h('div', { class: 'toast-host' });
    document.body.append(toastHost);
  }
  const node = h('div', { class: `toast ${type}`, text: message });
  toastHost.append(node);
  setTimeout(() => node.remove(), 2600);
}

/* ---------------- 通用弹窗容器 ---------------- */
function openModal(mount: (close: () => void) => HTMLElement, onClose?: () => void): () => void {
  const mask = h('div', { class: 'modal-mask' });
  const close = () => {
    mask.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };
  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  document.addEventListener('keydown', onKey);
  mask.append(mount(close));
  document.body.append(mask);
  return close;
}

/* ---------------- 确认框 ---------------- */
export function confirmDialog(title: string, message: string, danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // 用户点遮罩 / ESC 关闭时，视为取消
    openModal(
      (cl) =>
        h(
          'div',
          { class: 'modal' },
          h('h2', { text: title }),
          h('p', { class: 'muted', text: message }),
          h(
            'div',
            { class: 'modal-actions' },
            h(
              'button',
              {
                class: 'btn',
                onclick: () => {
                  settle(false);
                  cl();
                },
              },
              '取消',
            ),
            h(
              'button',
              {
                class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
                onclick: () => {
                  settle(true);
                  cl();
                },
              },
              '确定',
            ),
          ),
        ),
      () => settle(false),
    );
  });
}

/* ---------------- 通用表单 ---------------- */
export interface FieldDef {
  name: string;
  label: string;
  type?: 'text' | 'password' | 'number' | 'textarea' | 'select' | 'date' | 'multiselect';
  options?: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
  value?: string | number | string[];
  help?: string;
}

export function showForm(config: {
  title: string;
  fields: FieldDef[];
  submitText?: string;
  onSubmit: (values: Record<string, any>) => Promise<string | null | void> | string | null | void;
}): void {
  const readers: { field: FieldDef; read: () => any }[] = [];
  const errorEl = h('div', { class: 'field-error', style: 'color:var(--danger);font-size:13px;min-height:18px;margin-bottom:6px' });
  const saveBtn = h(
    'button',
    { class: 'btn btn-primary', type: 'submit' },
    config.submitText ?? '保存',
  ) as HTMLButtonElement;

  const rows = config.fields.map((field) => {
    const type = field.type ?? 'text';
    const initial = field.value;
    let control: HTMLElement;

    if (type === 'textarea') {
      const area = h('textarea', {
        class: 'textarea',
        placeholder: field.placeholder ?? '',
        value: (initial as string) ?? '',
      }) as HTMLTextAreaElement;
      control = area;
      readers.push({ field, read: () => area.value.trim() });
    } else if (type === 'select') {
      const select = h(
        'select',
        { class: 'select' },
        ...(field.options ?? []).map((opt) =>
          h('option', { value: opt.value, selected: String(opt.value) === String(initial ?? '') }, opt.label),
        ),
      ) as HTMLSelectElement;
      control = select;
      readers.push({ field, read: () => select.value });
    } else if (type === 'multiselect') {
      const selected = Array.isArray(initial) ? (initial as string[]) : [];
      const boxes: HTMLInputElement[] = [];
      const grid = h('div', { class: 'checkbox-grid' });
      for (const opt of field.options ?? []) {
        const box = h('input', { type: 'checkbox', value: opt.value }) as HTMLInputElement;
        box.checked = selected.includes(String(opt.value));
        boxes.push(box);
        grid.append(h('label', null, box, opt.label));
      }
      if (!(field.options ?? []).length) grid.append(h('span', { class: 'muted', text: '还没人可选' }));
      control = grid;
      readers.push({ field, read: () => boxes.filter((b) => b.checked).map((b) => b.value) });
    } else {
      const input = h('input', {
        class: 'input',
        type,
        placeholder: field.placeholder ?? '',
        value: initial === undefined || initial === null ? '' : String(initial),
      }) as HTMLInputElement;
      control = input;
      readers.push({
        field,
        read: () => (type === 'number' ? Number(input.value) : input.value.trim()),
      });
    }

    return h(
      'div',
      { class: 'field' },
      h('label', { text: field.label + (field.required ? ' *' : '') }),
      control,
      field.help ? h('div', { class: 'muted', style: 'margin-top:6px;font-size:12px', text: field.help }) : null,
    );
  });

  const form = h(
    'form',
    {
      onsubmit: async (event: Event) => {
        event.preventDefault();
        errorEl.textContent = '';
        const values: Record<string, any> = {};
        for (const reader of readers) values[reader.field.name] = reader.read();

        for (const field of config.fields) {
          const value = values[field.name];
          const empty =
            value === '' || value == null || (Array.isArray(value) && value.length === 0) || Number.isNaN(value);
          if (field.required && empty) {
            errorEl.textContent = `「${field.label}」不能空着`;
            return;
          }
        }

        saveBtn.disabled = true;
        try {
          const result = await config.onSubmit(values);
          if (typeof result === 'string' && result) {
            errorEl.textContent = result;
            return;
          }
          close();
        } catch (err) {
          errorEl.textContent = String((err as Error)?.message ?? err);
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
    ...rows,
    errorEl,
    h(
      'div',
      { class: 'modal-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => close() }, '取消'),
      saveBtn,
    ),
  );

  const close = openModal(() => h('div', { class: 'modal' }, h('h2', { text: config.title }), form));
}
