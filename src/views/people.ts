/** 人物列表视图：按身份分组的卡片墙 */
import { api } from '../api';
import { getData } from '../state';
import { colorOf } from '../types';
import type { Person } from '../types';
import { confirmDialog, h, toast } from '../ui';
import { personForm } from './graph';

function personCard(person: Person, relationCount: number, refresh: () => Promise<void>): HTMLElement {
  const data = getData();
  return h(
    'div',
    { class: 'person-card' },
    h(
      'div',
      { class: 'name' },
      h('span', { class: 'avatar', style: `background:${colorOf(person.name)}`, text: person.name.slice(0, 1) }),
      person.name,
    ),
    h(
      'div',
      { class: 'tag-row' },
      h('span', { class: 'tag', text: person.role === 'teacher' ? '老师' : '学生' }),
      ...(person.groupIds ?? []).map((gid) => {
      const g = data.groups.find((x) => x.id === gid);
      return g ? h('span', { class: 'tag', text: g.name }) : null;
    }),
      ...person.tags.map((t) => h('span', { class: 'tag', text: t })),
    ),
    person.note ? h('div', { class: 'muted', text: person.note, style: 'white-space:pre-wrap' }) : null,
    h('div', { class: 'muted', text: `${relationCount} 条关系` }),
    data.canEdit
      ? h(
          'div',
          { class: 'card-actions' },
          h('button', { class: 'btn btn-sm', onclick: () => personForm(person, refresh) }, '编辑'),
          h(
            'button',
            {
              class: 'btn btn-sm btn-danger',
              onclick: async () => {
                const ok = await confirmDialog('删除人物', `确定删除「${person.name}」？相关关系也会删除。`);
                if (!ok) return;
                await api.deletePerson(person.id);
                toast('已删除', 'ok');
                await refresh();
              },
            },
            '删除',
          ),
        )
      : null,
  );
}

export function renderPeople(root: HTMLElement, refresh: () => Promise<void>): () => void {
  const data = getData();
  let keyword = '';

  const body = h('div');

  function draw() {
    body.innerHTML = '';
    const relationCount = (id: string) =>
      data.links.filter((l) => l.source === id || l.target === id).length;

    const filtered = data.people.filter((p) => {
      if (!keyword) return true;
      const groupNames = (p.groupIds ?? [])
        .map((gid) => data.groups.find((g) => g.id === gid)?.name ?? '')
        .join('');
      return `${p.name}${groupNames}${p.tags.join('')}${p.note}`.includes(keyword);
    });

    if (!filtered.length) {
      body.append(h('div', { class: 'empty', text: '没有匹配的人' }));
      return;
    }

    for (const [role, title] of [
      ['teacher', '老师'],
      ['student', '学生'],
    ] as const) {
      const group = filtered.filter((p) => p.role === role);
      if (!group.length) continue;
      body.append(
        h('h3', { class: 'page-title', style: 'margin:18px 0 10px', text: `${title}（${group.length}）` }),
        h(
          'div',
          { class: 'grid-cards' },
          ...group.map((p) => personCard(p, relationCount(p.id), refresh)),
        ),
      );
    }
  }

  const toolbar = h(
    'div',
    { class: 'page-toolbar' },
    h('h2', { class: 'page-title', text: '班级人物' }),
    h('input', {
      class: 'input',
      placeholder: '搜索名字 / 标签…',
      style: 'max-width:220px',
      oninput: (ev: Event) => {
        keyword = (ev.target as HTMLInputElement).value.trim();
        draw();
      },
    }),
    h('div', { class: 'spacer' }),
    h('span', { class: 'muted', text: `共 ${data.people.length} 人` }),
    data.canEdit
      ? h('button', { class: 'btn btn-primary', onclick: () => personForm(null, refresh) }, '＋ 添加人物')
      : null,
  );

  root.append(toolbar, body);
  draw();
  return () => {};
}