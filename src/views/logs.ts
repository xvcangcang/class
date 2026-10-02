/**
 * 操作日志视图（所有登录用户可见）
 *
 * 目标：一眼就能看懂「谁、什么时候、改了什么」。
 * 只展示、只导出，不提供删除入口 —— 这样日志才可信。
 */
import { api } from '../api';
import type { LogEntry } from '../types';
import { h, toast } from '../ui';

/** 动作 → 颜色：新增类偏绿、删除类偏红、修改类偏黄，其余用蓝色 */
function actionTone(action: string): string {
  if (action.includes('删除') || action.includes('清除')) return 'danger';
  if (action.includes('新增') || action.includes('新建') || action.includes('生成') || action.includes('加入')) return 'ok';
  if (
    action.includes('修改') ||
    action.includes('重命名') ||
    action.includes('移出') ||
    action.includes('失败')
  ) {
    return action.includes('失败') ? 'danger' : 'warn';
  }
  return 'info';
}

const pad = (n: number) => String(n).padStart(2, '0');

const timeText = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** 日期分组标题：今天 / 昨天 / 2026年10月2日 */
function dayText(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 导出用：把一条日志摊平成一行文字 */
const rowText = (entry: LogEntry) => [
  new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
  entry.actor + (entry.actorUsername && entry.actorUsername !== entry.actor ? `（${entry.actorUsername}）` : ''),
  entry.action,
  entry.target,
  entry.detail,
  entry.ok ? '成功' : '失败',
  entry.ip ?? '',
];

function toCsv(entries: LogEntry[]): string {
  const header = ['时间', '操作人', '动作', '对象', '说明', '结果', '来源IP'];
  const escape = (value: string) => `"${String(value).replace(/"/g, '""')}"`;
  const lines = [header.map(escape).join(',')];
  for (const entry of entries) lines.push(rowText(entry).map(escape).join(','));
  return `\ufeff${lines.join('\r\n')}`;
}

export function renderLogs(root: HTMLElement): () => void {
  let keyword = '';
  let action = '';
  let result = '';
  let loaded: LogEntry[] = [];

  const countEl = h('span', { class: 'muted', text: '加载中…' });
  const listEl = h('div', { class: 'log-list' });
  const actionSelect = h('select', { class: 'select', style: 'width:auto' }, h('option', { value: '' }, '全部动作')) as HTMLSelectElement;
  const resultSelect = h(
    'select',
    { class: 'select', style: 'width:auto' },
    h('option', { value: '' }, '全部结果'),
    h('option', { value: 'ok' }, '只看成功'),
    h('option', { value: 'fail' }, '只看失败'),
  ) as HTMLSelectElement;

  /** 按天分组渲染 */
  function draw() {
    listEl.innerHTML = '';
    if (!loaded.length) {
      listEl.append(h('div', { class: 'empty', text: keyword || action || result ? '没有匹配的记录' : '还没有任何操作记录' }));
      return;
    }
    let currentDay = '';
    for (const entry of loaded) {
      const key = dayKey(entry.ts);
      if (key !== currentDay) {
        currentDay = key;
        listEl.append(h('div', { class: 'log-day', text: dayText(entry.ts) }));
      }
      listEl.append(
        h(
          'div',
          { class: `log-row ${entry.ok ? '' : 'log-row-fail'}` },
          h('span', { class: 'log-time', text: timeText(entry.ts) }),
          h('span', { class: 'log-actor', text: entry.actor, title: entry.actorUsername }),
          h('span', { class: `pill pill-${actionTone(entry.action)}`, text: entry.action }),
          entry.target ? h('span', { class: 'log-target', text: entry.target }) : null,
          entry.detail ? h('span', { class: 'log-detail', text: entry.detail }) : null,
        ),
      );
    }
  }

  async function load() {
    try {
      const res = await api.listLogs({ q: keyword, action, result, limit: 500 });
      loaded = res.logs;
      countEl.textContent = `显示 ${res.logs.length} / 匹配 ${res.total} 条（共存有 ${res.stored} 条）`;

      // 动作下拉：保留当前选项，重建其余
      const keep = action;
      actionSelect.innerHTML = '';
      actionSelect.append(h('option', { value: '' }, '全部动作'));
      for (const name of res.actions) actionSelect.append(h('option', { value: name }, name));
      actionSelect.value = res.actions.includes(keep) ? keep : '';

      draw();
    } catch (err) {
      listEl.innerHTML = '';
      listEl.append(h('div', { class: 'empty', text: `加载失败：${(err as Error).message}` }));
      countEl.textContent = '';
    }
  }

  function exportCsv() {
    if (!loaded.length) {
      toast('当前没有可导出的记录', 'err');
      return;
    }
    const blob = new Blob([toCsv(loaded)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', {
      href: url,
      download: `操作日志_${new Date().toISOString().slice(0, 10)}.csv`,
    }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已导出 ${loaded.length} 条`, 'ok');
  }

  const toolbar = h(
    'div',
    { class: 'page-toolbar' },
    h('h2', { class: 'page-title', text: '操作日志' }),
    h('input', {
      class: 'input',
      placeholder: '搜人名 / 动作 / 说明…',
      style: 'max-width:200px',
      oninput: (ev: Event) => {
        keyword = (ev.target as HTMLInputElement).value.trim();
        void load();
      },
    }),
    actionSelect,
    resultSelect,
    h('div', { class: 'spacer' }),
    countEl,
    h('button', { class: 'btn', onclick: () => void load() }, '刷新'),
    h('button', { class: 'btn btn-primary', onclick: exportCsv }, '导出表格'),
  );

  actionSelect.addEventListener('change', () => {
    action = actionSelect.value;
    void load();
  });
  resultSelect.addEventListener('change', () => {
    result = resultSelect.value;
    void load();
  });

  const intro = h(
    'div',
    { class: 'card log-intro' },
    h('b', { text: '每一次改动都会自动留痕' }),
    h('div', {
      class: 'muted',
      text: '上面按时间倒序列出「谁、什么时候、改了什么」。日志只增加、不删除，导出表格可以用 Excel 打开。',
    }),
  );

  root.append(toolbar, intro, listEl);
  void load();
  return () => {};
}
