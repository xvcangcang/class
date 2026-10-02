/** 关系图视图：ECharts 力导向网络图 + 侧边详情面板 */
import * as echarts from 'echarts';
import { api } from '../api';
import { getData } from '../state';
import { LINK_TYPES } from '../types';
import type { Person } from '../types';
import { confirmDialog, h, showForm, toast } from '../ui';

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
      { name: 'group', label: '小组 / 部门', value: person?.group ?? '', placeholder: '如：第一组、教师办公室' },
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
        group: values.group,
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
        name: 'type',
        label: '关系类型',
        type: 'select',
        options: LINK_TYPES.map((t) => ({ value: t, label: t })),
        value: '好友',
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
      await api.createLink({
        source: values.source,
        target: values.target,
        type: values.type,
        weight: Number(values.weight) || 1,
      });
      toast('已添加关系', 'ok');
      await after();
    },
  });
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

  /* ---------- 分类（配色依据） ---------- */
  const groups = Array.from(new Set(data.people.map((p) => p.group || '未分组')));
  const categoryList = viewState.colorBy === 'role' ? ['学生', '老师'] : groups;
  const categoryOf = (p: Person): string =>
    viewState.colorBy === 'role' ? (p.role === 'teacher' ? '老师' : '学生') : p.group || '未分组';

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
        colorToggle.textContent = viewState.colorBy === 'role' ? '按角色着色' : '按小组着色';
        render();
      },
    },
    viewState.colorBy === 'role' ? '按角色着色' : '按小组着色',
  );

  const allTypes = Array.from(new Set([...LINK_TYPES, ...data.links.map((l) => l.type)]));
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

    const links = data.links.filter(
      (l) => !viewState.hiddenTypes.has(l.type) && byId.has(l.source) && byId.has(l.target),
    );
    const linkedIds = new Set<string>();
    for (const link of links) {
      linkedIds.add(link.source);
      linkedIds.add(link.target);
    }
    const keyword = viewState.keyword;
    const matched = keyword ? data.people.filter((p) => p.name.includes(keyword)).map((p) => p.id) : [];

    const categoryColors: Record<string, string> = {};
    for (const name of categoryList) categoryColors[name] = colorOfStatic(name);

    const nodes = data.people.map((p) => {
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

    const option = {
      backgroundColor: 'transparent',
      tooltip: {
        confine: true,
        formatter: (params: any) => {
          if (params.dataType === 'edge') {
            const l = params.data;
            const s = byId.get(l.source)?.name ?? '?';
            const t = byId.get(l.target)?.name ?? '?';
            return `${s} — ${t}<br/>关系：${l.type}（亲密度 ${l.weight}）`;
          }
          const p = byId.get(params.data.id);
          if (!p) return params.name;
          const relCount = degree.get(p.id) ?? 0;
          return `<b>${p.name}</b><br/>${p.role === 'teacher' ? '老师' : '学生'} · ${
            p.group || '未分组'
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
          links: links.map((l) => ({
            source: l.source,
            target: l.target,
            id: l.id,
            type: l.type,
            weight: l.weight,
            value: l.type,
            lineStyle: {
              width: 1 + l.weight * 1.2,
              opacity: 0.55,
              curveness: 0.1,
            },
          })),
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
  function renderSide() {
    sideEl.innerHTML = '';
    const person = viewState.selected ? byId.get(viewState.selected) : null;

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
          person.group ? h('span', { class: 'tag', text: person.group }) : null,
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