/** 班级事件视图：时间线 + 增删改 */
import { api } from '../api';
import { getData } from '../state';
import type { ClassEvent } from '../types';
import { confirmDialog, h, showForm, toast } from '../ui';

export function eventForm(event: ClassEvent | null, after: () => Promise<void>): void {
  const data = getData();
  showForm({
    title: event ? '编辑事件' : '记录班级事件',
    fields: [
      {
        name: 'date',
        label: '日期',
        type: 'date',
        required: true,
        value: event?.date ?? new Date().toISOString().slice(0, 10),
      },
      {
        name: 'title',
        label: '发生了什么',
        required: true,
        value: event?.title ?? '',
        placeholder: '如：秋季运动会',
      },
      {
        name: 'detail',
        label: '细节',
        type: 'textarea',
        value: event?.detail ?? '',
        placeholder: '写点经过、结果、谁表现突出…',
      },
      {
        name: 'participants',
        label: '参与的人',
        type: 'multiselect',
        options: data.people.map((p) => ({ value: p.id, label: p.name })),
        value: event?.participants ?? [],
      },
    ],
    onSubmit: async (values) => {
      const payload = {
        date: values.date,
        title: values.title,
        detail: values.detail,
        participants: values.participants,
      };
      if (event) await api.updateEvent(event.id, payload);
      else await api.createEvent(payload);
      toast(event ? '已保存' : '已记录', 'ok');
      await after();
    },
  });
}

export function renderEvents(root: HTMLElement, refresh: () => Promise<void>): () => void {
  const data = getData();
  const byId = new Map(data.people.map((p) => [p.id, p]));
  let keyword = '';

  const listEl = h('div', { class: 'card' });

  function draw() {
    listEl.innerHTML = '';
    const events = [...data.events]
      .filter((e) => {
        if (!keyword) return true;
        const names = e.participants.map((id) => byId.get(id)?.name ?? '').join(' ');
        return `${e.title}${e.detail}${names}`.includes(keyword);
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    if (!events.length) {
      listEl.append(
        h('div', {
          class: 'empty',
          text: data.events.length ? '没有匹配的事件' : '还没有记录任何事件，点右上角「＋ 记录事件」开始',
        }),
      );
      return;
    }

    const timeline = h('div', { class: 'timeline' });
    for (const event of events) {
      const names = event.participants.map((id) => byId.get(id)?.name).filter(Boolean) as string[];
      timeline.append(
        h(
          'div',
          { class: 'tl-item' },
          h(
            'div',
            { class: 'tl-head' },
            h('span', { class: 'tl-date', text: event.date }),
            h('span', { class: 'tl-title', text: event.title }),
          ),
          event.detail ? h('div', { class: 'tl-detail', text: event.detail }) : null,
          h(
            'div',
            { class: 'tag-row' },
            h('span', { class: 'tag', text: `记录人：${event.createdBy}` }),
            ...names.map((name) => h('span', { class: 'tag', text: name })),
          ),
          data.canEdit
            ? h(
                'div',
                { class: 'tl-actions' },
                h('button', { class: 'btn btn-sm', onclick: () => eventForm(event, refresh) }, '编辑'),
                h(
                  'button',
                  {
                    class: 'btn btn-sm btn-danger',
                    onclick: async () => {
                      const ok = await confirmDialog('删除事件', `确定删除「${event.title}」？`);
                      if (!ok) return;
                      await api.deleteEvent(event.id);
                      toast('已删除', 'ok');
                      await refresh();
                    },
                  },
                  '删除',
                ),
              )
            : null,
        ),
      );
    }
    listEl.append(timeline);
  }

  const toolbar = h(
    'div',
    { class: 'page-toolbar' },
    h('h2', { class: 'page-title', text: '班级事件' }),
    h('input', {
      class: 'input',
      placeholder: '搜索事件或人名…',
      style: 'max-width:220px',
      oninput: (ev: Event) => {
        keyword = (ev.target as HTMLInputElement).value.trim();
        draw();
      },
    }),
    h('div', { class: 'spacer' }),
    h('span', { class: 'muted', text: `共 ${data.events.length} 条` }),
    data.canEdit
      ? h('button', { class: 'btn btn-primary', onclick: () => eventForm(null, refresh) }, '＋ 记录事件')
      : null,
  );

  root.append(toolbar, listEl);
  draw();
  return () => {};
}