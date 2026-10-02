/** 关系图视图：ECharts 力导向网络图 + 侧边详情面板 */
import * as echarts from 'echarts';
import { api } from '../api';
import { getData } from '../state';
import { GROUP_KINDS, GROUP_LINK_TYPE } from '../types';
import type { Group, GroupKind, Person, PersonLink } from '../types';
import { confirmDialog, h, openDialog, showForm, toast } from '../ui';

/** 视图状态放在模块级，刷新后不会丢 */
const viewState = {
  colorBy: 'role' as 'role' | 'group',
  hiddenTypes: new Set<string>(),
  keyword: '',
  selected: null as string | null,
};

function personOptions(people: Person[]) {
  return [...people]
    .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name))
    .map((p) => ({ value: p.id, label: `${p.role === 'teacher' ? '师' : '生'}·${p.name}` }));
}

/** 人物表单（新增 / 编辑共用） */
export function personForm(person: Person | null, after: () => Promise<void>): void {
  const data = getData();
  showForm({
    title: person ? `编辑「${person.name}」` : '添加人物',
    fields: [
      { name: 'name', label: '名字', required: true, value: person?.name ?? '', placeholder: '建议用昵称或代号' },
      {
        name: 'role',
        label: '身份',
        type: 'select',
        options: [
          { value: 'student', label: '学生' },
          { value: 'teacher', label: '老师' },
        ],
        value: person?.role ?? 'student',
      },
      {
        name: 'groupIds',
        label: '所属群组',
        type: 'multiselect',
        options: data.groups.map((g) => ({ value: g.id, label: `${g.name}（${g.kind}）` })),
        value: person?.groupIds ?? [],
        help: data.groups.length
          ? '可以同时属于多个，比如既是第三组、又住 302 宿舍'
          : '还没有群组，先点工具栏的「🔲 群组」建一个',
      },
      {
        name: 'tags',
        label: '标签',
        value: (person?.tags ?? []).join('、'),
        placeholder: '用「、」或逗号分隔，如：班长、组长',
      },
      { name: 'note', label: '备注', type: 'textarea', value: person?.note ?? '' },
    ],
    onSubmit: async (values) => {
      const payload = {
        name: values.name,
        role: values.role,
        groupIds: values.groupIds,
        tags: String(values.tags ?? '')
          .split(/[、,，\s]+/)
          .filter(Boolean),
        note: values.note,
      };
      if (person) await api.updatePerson(person.id, payload);
      else await api.createPerson(payload);
      toast(person ? '已保存' : '已添加', 'ok');
      await after();
    },
  });
}

/** 关系表单 */
export function linkForm(after: () => Promise<void>, preset?: Person): void {
  const data = getData();
  if (data.people.length < 2) {
    toast('至少要两个人才能建立关系', 'err');
    return;
  }
  const options = personOptions(data.people);
  const presetId = preset?.id ?? '';
  const other = preset?.id ?? options[0].value;
  showForm({
    title: '添加关系',
    fields: [
      { name: 'source', label: '甲', type: 'select', options, value: presetId || options[0].value, required: true },
      {
        name: 'target',
        label: '乙',
        type: 'select',
        options,
        value: other,
        required: true,
        help: '两端必须是两个不同的人',
      },
      {
        name: 'types',
        label: '关系类型',
        type: 'multiselect',
        options: data.linkTypes.map((t) => ({ value: t, label: t })),
        value: ['好友'],
        required: true,
        help: '可以一次勾多个：比如既是好友、又是同桌、还是小学同学',
      },
      {
        name: 'weight',
        label: '亲密度（1~5）',
        type: 'number',
        value: 2,
        help: '越小线越细，用来区分好朋友和普通同学',
      },
    ],
    onSubmit: async (values) => {
      if (values.source === values.target) return '两端不能是同一个人';
      const types: string[] = values.types ?? [];
      if (!types.length) return '至少勾一个关系类型';

      // 这两个人之间已有的关系（不分方向）
      const existing = getData().links.filter(
        (l) =>
          (l.source === values.source && l.target === values.target) ||
          (l.source === values.target && l.target === values.source),
      );

      let created = 0;
      let skipped = 0;
      for (const type of types) {
        if (existing.some((l) => l.type === type)) {
          skipped += 1;
          continue;
        }
        await api.createLink({
          source: values.source,
          target: values.target,
          type,
          weight: Number(values.weight) || 1,
        });
        created += 1;
      }

      if (!created) return '勾选的关系都已经存在了';
      toast(skipped ? `已添加 ${created} 条，跳过 ${skipped} 条（已存在）` : `已添加 ${created} 条关系`, 'ok');
      await after();
    },
  });
}

/** 编辑已有一条关系的类型 / 亲密度 */
export function linkEditForm(link: PersonLink, after: () => Promise<void>): void {
  const data = getData();
  const byId = new Map(data.people.map((p) => [p.id, p]));
  const from = byId.get(link.source)?.name ?? '?';
  const to = byId.get(link.target)?.name ?? '?';
  showForm({
    title: `编辑「${from} — ${to}」`,
    fields: [
      {
        name: 'type',
        label: '关系类型',
        type: 'select',
        options: data.linkTypes.map((t) => ({ value: t, label: t })),
        value: link.type,
        required: true,
      },
      { name: 'weight', label: '亲密度（1~5）', type: 'number', value: link.weight },
    ],
    onSubmit: async (values) => {
      await api.updateLink(link.id, { type: values.type, weight: Number(values.weight) || link.weight });
      toast('已保存', 'ok');
      await after();
    },
  });
}

/** 关系类型管理：可改名、删除、新增 */
export function typeManager(after: () => Promise<void>): void {
  const listEl = h('div');
  const errorEl = h('div', { class: 'muted', style: 'color:var(--danger);min-height:18px;margin:8px 0' });
  const nameInput = h('input', {
    class: 'input',
    placeholder: '新类型名称，如：竞赛队友',
    maxlength: '12',
  }) as HTMLInputElement;

  function drawList(): void {
    const data = getData();
    listEl.innerHTML = '';
    if (!data.linkTypes.length) {
      listEl.append(h('div', { class: 'empty', text: '还没有任何关系类型' }));
      return;
    }
    for (const type of data.linkTypes) {
      const used = data.links.filter((l) => l.type === type).length;
      const input = h('input', { class: 'input', value: type, maxlength: '12' }) as HTMLInputElement;
      listEl.append(
        h(
          'div',
          { class: 'rel-item', style: 'display:flex;gap:8px;align-items:center' },
          input,
          h('span', { class: 'who', style: 'flex:none;white-space:nowrap', text: `${used} 条` }),
          h(
            'button',
            {
              class: 'btn btn-sm',
              onclick: async () => {
                const next = input.value.trim();
                if (!next || next === type) return;
                errorEl.textContent = '';
                try {
                  const res = await api.renameLinkType(type, next);
                  toast(res.updatedLinks ? `已改名，${res.updatedLinks} 条关系跟着更新` : '已改名', 'ok');
                  await after();
                  drawList();
                } catch (err) {
                  errorEl.textContent = (err as Error).message;
                }
              },
            },
            '保存',
          ),
          h(
            'button',
            {
              class: 'btn btn-sm btn-danger',
              onclick: async () => {
                const ok = await confirmDialog(
                  '删除关系类型',
                  used
                    ? `「${type}」还有 ${used} 条关系在用，删除后它们会变成「其他」。确定删除吗？`
                    : `确定删除「${type}」？`,
                );
                if (!ok) return;
                errorEl.textContent = '';
                try {
                  const res = await api.deleteLinkType(type);
                  toast(
                    res.updatedLinks ? `已删除，${res.updatedLinks} 条关系改为「${res.fallback}」` : '已删除',
                    'ok',
                  );
                  await after();
                  drawList();
                } catch (err) {
                  errorEl.textContent = (err as Error).message;
                }
              },
            },
            '删除',
          ),
        ),
      );
    }
  }

  const addBtn = h(
    'button',
    {
      class: 'btn btn-primary',
      onclick: async () => {
        const name = nameInput.value.trim();
        if (!name) {
          errorEl.textContent = '先写个名称';
          return;
        }
        errorEl.textContent = '';
        try {
          await api.createLinkType(name);
          nameInput.value = '';
          toast('已添加', 'ok');
          await after();
          drawList();
        } catch (err) {
          errorEl.textContent = (err as Error).message;
        }
      },
    },
    '添加',
  );

  openDialog((close) =>
    h(
      'div',
      { class: 'modal' },
      h('h2', { text: '关系类型' }),
      h('div', {
        class: 'muted',
        style: 'margin-bottom:10px;line-height:1.6',
        text: '改名字会同步更新已有的关系；删除时，用到它的关系会自动变成「其他」。',
      }),
      listEl,
      errorEl,
      h('div', { style: 'display:flex;gap:8px' }, nameInput, addBtn),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: () => close() }, '完成')),
    ),
  );

  drawList();
}

/** 群组管理：增删改（小组 / 宿舍 / 社团） */
export function groupManager(after: () => Promise<void>): void {
  const listEl = h('div');
  const errorEl = h('div', { class: 'muted', style: 'color:var(--danger);min-height:18px;margin:8px 0' });
  const nameInput = h('input', {
    class: 'input',
    placeholder: '新群组名称，如：302 宿舍',
    maxlength: '16',
  }) as HTMLInputElement;
  const kindSelect = h(
    'select',
    { class: 'select', style: 'width:auto;flex:none' },
    ...GROUP_KINDS.map((k) => h('option', { value: k }, k)),
  ) as HTMLSelectElement;

  function drawList(): void {
    const data = getData();
    listEl.innerHTML = '';
    if (!data.groups.length) {
      listEl.append(
        h('div', {
          class: 'empty',
          text: '还没有群组。建一个「第一组」或「302 宿舍」，再把同学放进去。',
        }),
      );
      return;
    }
    for (const group of data.groups) {
      const members = data.people.filter((p) => (p.groupIds ?? []).includes(group.id));
      const typeName = GROUP_LINK_TYPE[group.kind] ?? '同组';
      const pairCount = (members.length * (members.length - 1)) / 2;
      const input = h('input', { class: 'input', value: group.name, maxlength: '16' }) as HTMLInputElement;
      const kind = h(
        'select',
        { class: 'select', style: 'width:auto;flex:none' },
        ...GROUP_KINDS.map((k) => h('option', { value: k, selected: k === group.kind }, k)),
      ) as HTMLSelectElement;
      listEl.append(
        h(
          'div',
          { class: 'rel-item' },
          h('div', { style: 'display:flex;gap:8px;align-items:center' }, input, kind,
            h('span', { class: 'who', style: 'flex:none;white-space:nowrap', text: `${members.length} 人` }),
          ),
          h('div', {
            class: 'who',
            style: 'margin-top:6px',
            text: members.length ? members.map((m) => m.name).join('、') : '还没有成员',
          }),
          h(
            'div',
            { class: 'tl-actions' },
            h(
              'button',
              {
                class: 'btn btn-sm',
                onclick: async () => {
                  const name = input.value.trim();
                  if (!name) {
                    errorEl.textContent = '名称不能空着';
                    return;
                  }
                  errorEl.textContent = '';
                  try {
                    await api.updateGroup(group.id, { name, kind: kind.value as GroupKind });
                    toast('已保存', 'ok');
                    await after();
                    drawList();
                  } catch (err) {
                    errorEl.textContent = (err as Error).message;
                  }
                },
              },
              '保存',
            ),
            h('button', { class: 'btn btn-sm', onclick: () => memberPicker(group.id, after, drawList) }, '编辑成员'),
            h(
              'button',
              {
                class: 'btn btn-sm',
                title: `把成员两两连起来，自动生成「${typeName}」关系`,
                onclick: async () => {
                  if (pairCount < 1) {
                    toast('这个群组还没有足够成员', 'err');
                    return;
                  }
                  const ok = await confirmDialog(
                    '生成成员关系',
                    `把「${group.name}」的 ${members.length} 个成员两两连起来，会生成 ${pairCount} 条「${typeName}」关系。确定吗？`,
                    false,
                  );
                  if (!ok) return;
                  errorEl.textContent = '';
                  try {
                    const res = await api.generateGroupLinks(group.id, 'add');
                    toast(
                      res.created
                        ? `已生成 ${res.created} 条「${res.type}」关系${
                            res.created < res.pairs ? `（另有 ${res.pairs - res.created} 条已存在）` : ''
                          }`
                        : `「${res.type}」关系都已经有了`,
                      'ok',
                    );
                    await after();
                    drawList();
                  } catch (err) {
                    errorEl.textContent = (err as Error).message;
                  }
                },
              },
              `生成关系${pairCount ? `（${pairCount}）` : ''}`,
            ),
            h(
              'button',
              {
                class: 'btn btn-sm btn-danger',
                onclick: async () => {
                  const ok = await confirmDialog(
                    '清除成员关系',
                    `删除「${group.name}」成员之间的全部「${typeName}」关系？`,
                  );
                  if (!ok) return;
                  errorEl.textContent = '';
                  try {
                    const res = await api.generateGroupLinks(group.id, 'remove');
                    toast(res.removed ? `已删除 ${res.removed} 条关系` : '没有需要删除的关系', 'ok');
                    await after();
                    drawList();
                  } catch (err) {
                    errorEl.textContent = (err as Error).message;
                  }
                },
              },
              '清除关系',
            ),
            h(
              'button',
              {
                class: 'btn btn-sm btn-danger',
                onclick: async () => {
                  const ok = await confirmDialog(
                    '删除群组',
                    `确定删除「${group.name}」？${members.length ? `${members.length} 人会退出这个群组。` : ''}`,
                  );
                  if (!ok) return;
                  try {
                    await api.deleteGroup(group.id);
                    toast('已删除', 'ok');
                    await after();
                    drawList();
                  } catch (err) {
                    errorEl.textContent = (err as Error).message;
                  }
                },
              },
              '删除',
            ),
          ),
        ),
      );
    }
  }

  const addBtn = h(
    'button',
    {
      class: 'btn btn-primary',
      onclick: async () => {
        const name = nameInput.value.trim();
        if (!name) {
          errorEl.textContent = '先写个名称';
          return;
        }
        errorEl.textContent = '';
        try {
          await api.createGroup({ name, kind: kindSelect.value as GroupKind });
          nameInput.value = '';
          toast('已创建', 'ok');
          await after();
          drawList();
        } catch (err) {
          errorEl.textContent = (err as Error).message;
        }
      },
    },
    '创建',
  );

  openDialog((close) =>
    h(
      'div',
      { class: 'modal' },
      h('h2', { text: '群组' }),
      h('div', {
        class: 'muted',
        style: 'margin-bottom:10px;line-height:1.6',
        text: '群组会显示成图上的长方形节点，人连到群组就表示「同组 / 同宿舍」。一个人可以同时在好几个群里。',
      }),
      listEl,
      errorEl,
      h('div', { style: 'display:flex;gap:8px' }, nameInput, kindSelect, addBtn),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: () => close() }, '完成')),
    ),
  );

  drawList();
}

/** 勾选谁在这个群里 */
function memberPicker(groupId: string, after: () => Promise<void>, onDone: () => void): void {
  const data = getData();
  const group = data.groups.find((g) => g.id === groupId);
  if (!group) return;

  const boxes = new Map<string, HTMLInputElement>();
  const grid = h('div', { class: 'checkbox-grid' });
  const sorted = [...data.people].sort((a, b) => a.name.localeCompare(b.name));
  for (const person of sorted) {
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = (person.groupIds ?? []).includes(groupId);
    boxes.set(person.id, box);
    grid.append(h('label', null, box, `${person.role === 'teacher' ? '师·' : ''}${person.name}`));
  }
  if (!sorted.length) grid.append(h('span', { class: 'muted', text: '还没有人物' }));

  const errorEl = h('div', { class: 'muted', style: 'color:var(--danger);min-height:18px' });

  const save = h(
    'button',
    {
      class: 'btn btn-primary',
      onclick: async () => {
        try {
          const join: string[] = [];
          const leave: string[] = [];
          for (const [personId, box] of boxes) (box.checked ? join : leave).push(personId);
          let changed = 0;
          if (join.length) changed += (await api.setGroupMembers(groupId, join, 'add')).changed;
          if (leave.length) changed += (await api.setGroupMembers(groupId, leave, 'remove')).changed;
          toast(changed ? `已更新 ${changed} 人` : '没有变化', 'ok');
          await after();
          onDone();
          close();
        } catch (err) {
          errorEl.textContent = (err as Error).message;
        }
      },
    },
    '保存',
  );

  const close = openDialog((cl) =>
    h(
      'div',
      { class: 'modal' },
      h('h2', { text: `「${group.name}」的成员` }),
      h('div', { class: 'muted', style: 'margin-bottom:10px', text: '勾上 = 加入，取消勾选 = 移出。' }),
      grid,
      errorEl,
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => cl() }, '取消'),
        save,
      ),
    ),
  );
}

export function renderGraph(root: HTMLElement, refresh: () => Promise<void>): () => void {
  const data = getData();
  const byId = new Map(data.people.map((p) => [p.id, p]));

  /* ---------- 每个人的关系数量（决定点的大小） ---------- */
  const degree = new Map<string, number>();
  for (const link of data.links) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }

  /* ---------- 群组节点 ---------- */
  const groupById = new Map(data.groups.map((g) => [g.id, g]));
  const GROUP_PREFIX = 'group:';
  const groupNodeId = (id: string) => `${GROUP_PREFIX}${id}`;
  const isGroupNode = (id: string) => id.startsWith(GROUP_PREFIX);

  /* ---------- 分类（配色依据） ---------- */
  const categoryOf = (p: Person): string => {
    if (viewState.colorBy === 'role') return p.role === 'teacher' ? '老师' : '学生';
    const first = (p.groupIds ?? [])[0];
    const group = first ? groupById.get(first) : null;
    return group ? group.name : '未分组';
  };
  const categoryList =
    viewState.colorBy === 'role' ? ['学生', '老师'] : Array.from(new Set(data.people.map(categoryOf)));

  /* ---------- DOM ---------- */
  const chartEl = h('div', { id: 'chart' });
  const sideEl = h('div', { class: 'side' });

  /* ---------- 缩放控件（滚轮 / 双指缩放不好用，给几个明确的按钮） ---------- */
  const zoomLabel = h('div', { class: 'zoom-level', text: '100%' });
  const zoomBtn = (label: string, title: string, onClick: () => void) =>
    h('button', { class: 'zoom-btn', type: 'button', title, onclick: onClick }, label);
  const zoomBox = h(
    'div',
    { class: 'zoom-controls' },
    zoomBtn('＋', '放大', () => applyZoom(currentZoom() * 1.25)),
    zoomBtn('－', '缩小', () => applyZoom(currentZoom() / 1.25)),
    zoomBtn('⟲', '复位视图（重新布局并回到 100%）', () => resetZoom()),
    zoomLabel,
  );

  const keywordInput = h('input', {
    class: 'input',
    placeholder: '搜索名字…',
    value: viewState.keyword,
    style: 'max-width:170px',
    oninput: (event: Event) => {
      viewState.keyword = (event.target as HTMLInputElement).value.trim();
      applyOption();
    },
  }) as HTMLInputElement;

  const colorToggle = h(
    'button',
    {
      class: 'btn btn-sm',
      onclick: () => {
        viewState.colorBy = viewState.colorBy === 'role' ? 'group' : 'role';
        colorToggle.textContent = viewState.colorBy === 'role' ? '按角色着色' : '按群组着色';
        render();
      },
    },
    viewState.colorBy === 'role' ? '按角色着色' : '按群组着色',
  );

  const allTypes = Array.from(
    new Set([...data.linkTypes, ...data.links.map((l) => l.type), '成员']),
  );
  const chips = allTypes.map((type) =>
    h(
      'button',
      {
        class: `chip ${viewState.hiddenTypes.has(type) ? '' : 'active'}`,
        onclick: (event: Event) => {
          const btn = event.currentTarget as HTMLElement;
          if (viewState.hiddenTypes.has(type)) viewState.hiddenTypes.delete(type);
          else viewState.hiddenTypes.add(type);
          btn.classList.toggle('active');
          applyOption();
        },
      },
      type,
    ),
  );

  const toolbar = h(
    'div',
    { class: 'graph-toolbar' },
    colorToggle,
    keywordInput,
    h(
      'button',
      {
        class: 'btn btn-sm',
        onclick: () => {
          viewState.hiddenTypes.clear();
          viewState.keyword = '';
          viewState.selected = null;
          keywordInput.value = '';
          chips.forEach((c) => c.classList.add('active'));
          render();
        },
      },
      '重置视图',
    ),
    data.canEdit
      ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => personForm(null, refresh) }, '＋ 人物')
      : null,
    data.canEdit ? h('button', { class: 'btn btn-sm', onclick: () => linkForm(refresh) }, '＋ 关系') : null,
    data.canEdit ? h('button', { class: 'btn btn-sm', onclick: () => groupManager(refresh) }, '🔲 群组') : null,
    data.canEdit
      ? h('button', { class: 'btn btn-sm', onclick: () => typeManager(refresh) }, '⚙ 关系类型')
      : null,
    h('div', { class: 'spacer' }),
    h('div', { class: 'muted', text: `${data.people.length} 人 · ${data.links.length} 条关系` }),
    h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;width:100%;padding-top:4px' }, ...chips),
  );

  root.append(
    h(
      'div',
      { class: 'graph-layout' },
      h('div', { class: 'card graph-card' }, toolbar, chartEl, zoomBox),
      sideEl,
    ),
  );

  const chart = echarts.init(chartEl, 'dark', { renderer: 'canvas' });
  chart.getDom().style.background = 'transparent';

  /* ---------- 缩放 ---------- */
  function currentZoom(): number {
    const option = chart.getOption() as any;
    const zoom = option?.series?.[0]?.zoom;
    return typeof zoom === 'number' && zoom > 0 ? zoom : 1;
  }

  function setZoomLabel(zoom: number): void {
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  function applyZoom(next: number): void {
    const zoom = Math.min(8, Math.max(0.25, next));
    chart.setOption({ series: [{ zoom }] } as any);
    setZoomLabel(zoom);
  }

  /** 复位：回到 100% 并重新跑一次布局（节点散在画布外时也能收回来） */
  function resetZoom(): void {
    chart.setOption({ series: [{ zoom: 1 }] } as any);
    setZoomLabel(1);
    applyOption();
  }

  // 用户自己滚轮 / 双指缩放时，同步一下百分比
  chart.on('graphroam', () => {
    window.setTimeout(() => setZoomLabel(currentZoom()), 0);
  });

  /* ---------- ECharts option ---------- */
  function applyOption() {
    // 保留当前缩放级别，避免筛选 / 搜索之后整张图跳回原样
    const prevOption = chart.getOption() as any;
    const prevZoom = typeof prevOption?.series?.[0]?.zoom === 'number' ? prevOption.series[0].zoom : 1;

    const showMembers = !viewState.hiddenTypes.has('成员');
    const links = data.links.filter(
      (l) => !viewState.hiddenTypes.has(l.type) && byId.has(l.source) && byId.has(l.target),
    );
    const linkedIds = new Set<string>();
    for (const link of links) {
      linkedIds.add(link.source);
      linkedIds.add(link.target);
    }
    // 人 → 群组 的归属边（虚线）
    const memberEdges: { id: string; source: string; target: string }[] = [];
    if (showMembers) {
      for (const person of data.people) {
        for (const gid of person.groupIds ?? []) {
          if (!groupById.has(gid)) continue;
          memberEdges.push({ id: `m:${person.id}:${gid}`, source: person.id, target: groupNodeId(gid) });
        }
      }
    }
    const keyword = viewState.keyword;
    const matched = keyword ? data.people.filter((p) => p.name.includes(keyword)).map((p) => p.id) : [];

    const categoryColors: Record<string, string> = {};
    for (const name of categoryList) categoryColors[name] = colorOfStatic(name);

    const personNodes = data.people.map((p) => {
      const deg = degree.get(p.id) ?? 0;
      let opacity = 1;
      if (keyword) opacity = matched.includes(p.id) ? 1 : 0.15;
      else if (viewState.hiddenTypes.size > 0 && !linkedIds.has(p.id)) opacity = 0.15;
      if (viewState.selected && p.id !== viewState.selected && !linkedIds.has(p.id)) opacity = Math.min(opacity, 0.3);
      return {
        id: p.id,
        name: p.name,
        category: Math.max(0, categoryList.indexOf(categoryOf(p))),
        symbolSize: Math.min(62, 20 + deg * 5),
        itemStyle: {
          color: categoryColors[categoryOf(p)],
          borderColor: p.role === 'teacher' ? '#f59e0b' : '#0b1220',
          borderWidth: p.role === 'teacher' ? 2 : 1,
          opacity,
        },
        label: { show: opacity > 0.2, color: '#dbe7f7' },
      };
    });

    /* 群组长方形节点 */
    const groupNodes = data.groups.map((group) => {
      const members = data.people.filter((p) => (p.groupIds ?? []).includes(group.id));
      const dim = keyword ? !group.name.includes(keyword) : !showMembers;
      return {
        id: groupNodeId(group.id),
        name: group.name,
        symbol: 'rect',
        symbolSize: [Math.max(64, group.name.length * 15 + 30), 36],
        itemStyle: {
          color: GROUP_KIND_COLORS[group.kind] ?? '#94a3b8',
          borderColor: '#0b1220',
          borderWidth: 1,
          opacity: dim ? 0.22 : 1,
        },
        label: { show: !dim, position: 'inside', color: '#08202f', fontWeight: 'bold', fontSize: 12 },
        _group: group,
        _memberCount: members.length,
      };
    });

    const nodes = [...personNodes, ...groupNodes];

    /* 人—人关系：同一对人有多条时，用不同弧度错开 */
    const pairSeq = new Map<string, number>();
    const personEdges = links.map((l) => {
      const key = [l.source, l.target].sort().join('|');
      const index = pairSeq.get(key) ?? 0;
      pairSeq.set(key, index + 1);
      const curveness = [0.08, 0.3, -0.24, 0.44, -0.4][Math.min(index, 4)];
      return {
        source: l.source,
        target: l.target,
        id: l.id,
        type: l.type,
        weight: l.weight,
        value: l.type,
        lineStyle: { width: 1 + l.weight * 1.2, opacity: 0.55, curveness },
      };
    });

    const option = {
      backgroundColor: 'transparent',
      tooltip: {
        confine: true,
        formatter: (params: any) => {
          if (params.dataType === 'edge') {
            const d = params.data;
            if (d.value === '成员') {
              const owner = byId.get(d.source);
              const group = groupById.get(String(d.target).slice(GROUP_PREFIX.length));
              return `${owner?.name ?? '?'} 属于 <b>${group?.name ?? '?'}</b>`;
            }
            const s = byId.get(d.source)?.name ?? '?';
            const t = byId.get(d.target)?.name ?? '?';
            return `${s} — ${t}<br/>关系：${d.type}（亲密度 ${d.weight}）`;
          }
          const raw = params.data;
          if (raw._group) {
            return `<b>${raw._group.name}</b><br/>${raw._group.kind} · ${raw._memberCount} 人`;
          }
          const p = byId.get(raw.id);
          if (!p) return params.name;
          const relCount = degree.get(p.id) ?? 0;
          const groupNames = (p.groupIds ?? [])
            .map((gid) => groupById.get(gid)?.name)
            .filter(Boolean)
            .join('、');
          return `<b>${p.name}</b><br/>${p.role === 'teacher' ? '老师' : '学生'}${
            groupNames ? ` · ${groupNames}` : ''
          }<br/>关系数：${relCount}`;
        },
      },
      legend: [
        {
          data: categoryList,
          bottom: 0,
          textStyle: { color: '#8ea0bd' },
          itemWidth: 12,
          itemHeight: 12,
        },
      ],
      series: [
        {
          type: 'graph',
          layout: 'force',
          roam: true,
          draggable: true,
          selectedMode: 'single',
          zoom: prevZoom,
          categories: categoryList.map((name) => ({ name, itemStyle: { color: categoryColors[name] } })),
          data: nodes,
          links: [
            ...personEdges,
            ...memberEdges.map((e) => ({
              ...e,
              value: '成员',
              lineStyle: { width: 1.2, opacity: 0.35, type: 'dashed', curveness: 0 },
            })),
          ],
          force: {
            repulsion: Math.max(220, 420 - data.people.length * 6),
            edgeLength: [60, 160],
            gravity: 0.08,
          },
          emphasis: { focus: 'adjacency', lineStyle: { width: 4, opacity: 0.9 } },
          label: { show: true, position: 'right', color: '#dbe7f7', fontSize: 12 },
          lineStyle: { color: 'source' },
        },
      ],
    };
    chart.setOption(option as any, true);
  }

  /* ---------- 侧栏 ---------- */
  function renderGroupSide(target: Group) {
    const members = data.people.filter((p) => (p.groupIds ?? []).includes(target.id));
    sideEl.append(
      h(
        'div',
        { class: 'card' },
        h('h3', { text: target.name }),
        h(
          'div',
          { class: 'tag-row' },
          h('span', { class: 'tag', text: target.kind }),
          h('span', { class: 'tag', text: `${members.length} 人` }),
        ),
        target.note ? h('div', { class: 'muted', text: target.note }) : null,
        h(
          'div',
          { class: 'tl-actions', style: 'margin-top:12px' },
          h('button', { class: 'btn btn-sm', onclick: () => select(null) }, '返回概览'),
          data.canEdit
            ? h('button', { class: 'btn btn-sm', onclick: () => groupManager(refresh) }, '管理群组')
            : null,
        ),
      ),
    );

    sideEl.append(
      h(
        'div',
        { class: 'card' },
        h('h3', { text: '成员' }),
        ...(members.length
          ? members.map((m) =>
              h(
                'div',
                { class: 'rel-item', style: 'cursor:pointer', onclick: () => select(m.id) },
                h('b', { text: m.name }),
                h('div', { class: 'who', text: m.role === 'teacher' ? '老师' : '学生' }),
              ),
            )
          : [h('div', { class: 'empty', text: '这个群组还没有成员' })]),
      ),
    );
  }

  function renderSide() {
    sideEl.innerHTML = '';
    const selectedId = viewState.selected;
    const group =
      selectedId && isGroupNode(selectedId)
        ? groupById.get(selectedId.slice(GROUP_PREFIX.length)) ?? null
        : null;
    const person = selectedId && !isGroupNode(selectedId) ? byId.get(selectedId) ?? null : null;

    if (group) {
      renderGroupSide(group);
      return;
    }

    if (!person) {
      /* 概览 */
      const teachers = data.people.filter((p) => p.role === 'teacher').length;
      const ranked = [...data.people]
        .map((p) => ({ p, deg: degree.get(p.id) ?? 0 }))
        .sort((a, b) => b.deg - a.deg)
        .slice(0, 5);
      const typeCount = new Map<string, number>();
      for (const l of data.links) typeCount.set(l.type, (typeCount.get(l.type) ?? 0) + 1);

      sideEl.append(
        h(
          'div',
          { class: 'card' },
          h('h3', { text: '班级概览' }),
          h('div', { class: 'tag-row' },
            h('span', { class: 'tag', text: `学生 ${data.people.length - teachers}` }),
            h('span', { class: 'tag', text: `老师 ${teachers}` }),
            h('span', { class: 'tag', text: `关系 ${data.links.length}` }),
            h('span', { class: 'tag', text: `事件 ${data.events.length}` }),
            h('span', { class: 'tag', text: `群组 ${data.groups.length}` }),
          ),
          h('div', { class: 'muted', style: 'margin-top:10px', text: '点一个圆点，看这个人的详细关系' }),
        ),
      );

      sideEl.append(
        h(
          'div',
          { class: 'card' },
          h('h3', { text: '关系最多的人' }),
          ...(ranked.length
            ? ranked.map((r) =>
                h(
                  'div',
                  { class: 'rel-item', style: 'cursor:pointer', onclick: () => select(r.p.id) },
                  h('b', { text: r.p.name }),
                  h('div', { class: 'who', text: `${r.deg} 条关系` }),
                ),
              )
            : [h('div', { class: 'empty', text: '还没有数据' })]),
        ),
      );

      sideEl.append(
        h(
          'div',
          { class: 'card' },
          h('h3', { text: '关系类型分布' }),
          ...(typeCount.size
            ? [...typeCount.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => h('div', { class: 'rel-item' }, h('b', { text: type }), h('div', { class: 'who', text: `${count} 条` })))
            : [h('div', { class: 'empty', text: '还没有关系' })]),
        ),
      );
      return;
    }

    /* 个人详情 */
    const rels = data.links.filter((l) => l.source === person.id || l.target === person.id);
    const evs = [...data.events].filter((e) => e.participants.includes(person.id)).sort((a, b) => (a.date < b.date ? 1 : -1));

    sideEl.append(
      h(
        'div',
        { class: 'card' },
        h('h3', { text: person.name }),
        h(
          'div',
          { class: 'tag-row' },
          h('span', { class: 'tag', text: person.role === 'teacher' ? '老师' : '学生' }),
          ...(person.groupIds ?? []).map((gid) => {
            const g = groupById.get(gid);
            return g
              ? h(
                  'span',
                  { class: 'tag', style: 'cursor:pointer', onclick: () => select(groupNodeId(gid)) },
                  g.name,
                )
              : null;
          }),
          ...person.tags.map((t) => h('span', { class: 'tag', text: t })),
          h('span', { class: 'tag', text: `关系 ${rels.length}` }),
        ),
        person.note ? h('div', { class: 'muted', text: person.note }) : null,
        h(
          'div',
          { class: 'tl-actions', style: 'margin-top:12px' },
          h('button', { class: 'btn btn-sm', onclick: () => select(null) }, '返回概览'),
          data.canEdit
            ? h('button', { class: 'btn btn-sm', onclick: () => personForm(person, refresh) }, '编辑')
            : null,
          data.canEdit
            ? h(
                'button',
                {
                  class: 'btn btn-sm btn-danger',
                  onclick: async () => {
                    const ok = await confirmDialog('删除人物', `确定删除「${person.name}」？他/她的关系也会一起删除。`);
                    if (!ok) return;
                    await api.deletePerson(person.id);
                    toast('已删除', 'ok');
                    viewState.selected = null;
                    await refresh();
                  },
                },
                '删除',
              )
            : null,
        ),
      ),
    );

    sideEl.append(
      h(
        'div',
        { class: 'card' },
        h('h3', { text: '关系' }),
        ...(rels.length
          ? rels.map((l) => {
              const other = byId.get(l.source === person.id ? l.target : l.source);
              return h(
                'div',
                { class: 'rel-item' },
                h('b', { text: other?.name ?? '（已删除）' }),
                h('div', { class: 'who', text: `${l.type} · 亲密度 ${l.weight}` }),
                data.canEdit
                  ? h(
                      'div',
                      { class: 'tl-actions' },
                      h('button', { class: 'btn btn-sm', onclick: () => linkEditForm(l, refresh) }, '编辑'),
                      h(
                        'button',
                        {
                          class: 'btn btn-sm btn-danger',
                          onclick: async () => {
                            await api.deleteLink(l.id);
                            toast('已删除关系', 'ok');
                            await refresh();
                          },
                        },
                        '删除',
                      ),
                    )
                  : null,
              );
            })
          : [h('div', { class: 'empty', text: '还没有关系' })]),
      ),
    );

    sideEl.append(
      h(
        'div',
        { class: 'card' },
        h('h3', { text: '参与的事件' }),
        ...(evs.length
          ? evs.map((e) =>
              h('div', { class: 'rel-item' }, h('b', { text: e.title }), h('div', { class: 'who', text: e.date })),
            )
          : [h('div', { class: 'empty', text: '还没记录相关事件' })]),
      ),
    );
  }

  function select(id: string | null) {
    viewState.selected = id;
    applyOption();
    renderSide();
    if (id) {
      chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: data.people.findIndex((p) => p.id === id) });
    }
  }

  function render() {
    applyOption();
    renderSide();
    setZoomLabel(currentZoom());
  }

  chart.on('click', (params: any) => {
    if (params.dataType === 'node') select(params.data.id);
    else if (params.dataType === 'edge') select(null);
  });
  chart.on('dblclick', () => select(null));

  const onResize = () => chart.resize();
  window.addEventListener('resize', onResize);
  requestAnimationFrame(() => chart.resize());

  render();

  return () => {
    window.removeEventListener('resize', onResize);
    chart.dispose();
  };
}

/** 分类配色：学生/老师用固定色，其他按名字散列 */
const ROLE_COLORS: Record<string, string> = { 学生: '#38bdf8', 老师: '#f59e0b' };

/** 群组节点按类型配色 */
const GROUP_KIND_COLORS: Record<string, string> = {
  小组: '#34d399',
  宿舍: '#a78bfa',
  社团: '#f472b6',
  其他: '#94a3b8',
};
function colorOfStatic(key: string): string {
  if (ROLE_COLORS[key]) return ROLE_COLORS[key];
  const palette = ['#22d3ee', '#34d399', '#a78bfa', '#f472b6', '#fbbf24', '#fb923c', '#4ade80', '#60a5fa', '#f87171'];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  return palette[Math.abs(hash) % palette.length];
}