/** 账号管理视图（仅管理员可见）：账号表 + 新建/改权限/重置密码/删除 */
import { api } from '../api';
import { getData } from '../state';
import type { User } from '../types';
import { confirmDialog, h, showForm, toast } from '../ui';

export function userForm(user: User | null, after: () => Promise<void>): void {
  const data = getData();
  const roleOptions = data.roles.map((r) => ({ value: r.id, label: `${r.label} —— ${r.desc}` }));
  const personOptions = [
    { value: '', label: '（不关联）' },
    ...data.people.map((p) => ({ value: p.id, label: `${p.role === 'teacher' ? '师' : '生'}·${p.name}` })),
  ];

  showForm({
    title: user ? `编辑账号「${user.username}」` : '新建账号',
    fields: user
      ? [
          { name: 'displayName', label: '显示名', value: user.displayName },
          { name: 'role', label: '权限等级', type: 'select', options: roleOptions, value: user.role },
          { name: 'personId', label: '关联人物', type: 'select', options: personOptions, value: user.personId ?? '' },
          {
            name: 'password',
            label: '重置密码',
            type: 'password',
            placeholder: '留空表示不改',
            help: '改完记得告诉本人新密码',
          },
        ]
      : [
          { name: 'username', label: '用户名', required: true, placeholder: '字母数字，3~20 位', help: '登录时用，建议拼音或代号' },
          { name: 'displayName', label: '显示名', placeholder: '留空就用用户名' },
          { name: 'password', label: '初始密码', type: 'password', required: true, placeholder: '至少 4 位' },
          { name: 'role', label: '权限等级', type: 'select', options: roleOptions, value: 'viewer' },
          { name: 'personId', label: '关联人物', type: 'select', options: personOptions, value: '' },
        ],
    onSubmit: async (values) => {
      if (user) {
        const payload: Record<string, unknown> = {
          displayName: values.displayName,
          role: values.role,
          personId: values.personId || null,
        };
        if (values.password) payload.password = values.password;
        await api.updateUser(user.id, payload);
      } else {
        await api.createUser({
          username: values.username,
          displayName: values.displayName || values.username,
          password: values.password,
          role: values.role,
          personId: values.personId || null,
        });
      }
      toast('已保存', 'ok');
      await after();
    },
  });
}

export function renderAccounts(root: HTMLElement, refresh: () => Promise<void>): () => void {
  const data = getData();
  if (!data.isAdmin) {
    root.append(h('div', { class: 'empty', text: '只有管理员能管理账号' }));
    return () => {};
  }

  const byId = new Map(data.people.map((p) => [p.id, p]));
  const listEl = h('div', { class: 'card' });

  function draw() {
    listEl.innerHTML = '';
    const tableWrap = h('div', { class: 'table-wrap' });
    const tbody = h('tbody');

    for (const user of data.users) {
      const roleSelect = h(
        'select',
        {
          class: 'select',
          style: 'width:auto;padding:5px 8px',
          onchange: async (event: Event) => {
            const value = (event.target as HTMLSelectElement).value;
            try {
              await api.updateUser(user.id, { role: value });
              toast('权限已更新', 'ok');
              await refresh();
            } catch (err) {
              toast((err as Error).message, 'err');
              await refresh();
            }
          },
        },
        ...data.roles.map((r) =>
          h('option', { value: r.id, selected: r.id === user.role }, r.label),
        ),
      ) as HTMLSelectElement;

      const linked = user.personId ? byId.get(user.personId)?.name ?? '（已删除）' : '—';

      tbody.append(
        h(
          'tr',
          null,
          h('td', null, h('b', { text: user.username }), user.id === data.me.id ? h('span', { class: 'tag', text: '我', style: 'margin-left:6px' }) : null),
          h('td', { text: user.displayName }),
          h('td', null, roleSelect),
          h('td', { text: linked }),
          h('td', { text: new Date(user.createdAt).toLocaleDateString('zh-CN') }),
          h(
            'td',
            null,
            h(
              'div',
              { style: 'display:flex;gap:6px' },
              h('button', { class: 'btn btn-sm', onclick: () => userForm(user, refresh) }, '编辑'),
              h(
                'button',
                {
                  class: 'btn btn-sm btn-danger',
                  onclick: async () => {
                    const ok = await confirmDialog('删除账号', `确定删除「${user.username}」？`);
                    if (!ok) return;
                    try {
                      await api.deleteUser(user.id);
                      toast('已删除', 'ok');
                    } catch (err) {
                      toast((err as Error).message, 'err');
                    }
                    await refresh();
                  },
                },
                '删除',
              ),
            ),
          ),
        ),
      );
    }

    tableWrap.append(
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { text: '用户名' }),
            h('th', { text: '显示名' }),
            h('th', { text: '权限等级' }),
            h('th', { text: '关联人物' }),
            h('th', { text: '创建时间' }),
            h('th', { text: '操作' }),
          ),
        ),
        tbody,
      ),
    );
    listEl.append(tableWrap);
  }

  const legend = h(
    'div',
    { class: 'card', style: 'margin-bottom:14px' },
    h('h3', { style: 'margin:0 0 10px;font-size:15px', text: '三个权限等级' }),
    ...data.roles.map((r) =>
      h(
        'div',
        { class: 'rel-item' },
        h('b', { text: r.label }),
        h('div', { class: 'who', text: r.desc }),
      ),
    ),
  );

  const toolbar = h(
    'div',
    { class: 'page-toolbar' },
    h('h2', { class: 'page-title', text: '账号与权限' }),
    h('div', { class: 'spacer' }),
    h('span', { class: 'muted', text: `共 ${data.users.length} 个账号` }),
    h('button', { class: 'btn btn-primary', onclick: () => userForm(null, refresh) }, '＋ 新建账号'),
  );

  root.append(toolbar, legend, listEl);
  draw();
  return () => {};
}