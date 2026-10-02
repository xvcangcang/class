/** 应用入口：登录态 → 顶栏 → 各视图路由 */
import { ApiError, api, getToken, setToken } from './api';
import { clearData, getData, hasData, setData } from './state';
import { h, showForm, toast } from './ui';
import { renderAccounts } from './views/accounts';
import { renderEvents } from './views/events';
import { renderGraph } from './views/graph';
import { renderLogin } from './views/login';
import { renderLogs } from './views/logs';
import { renderPeople } from './views/people';
import './styles/main.css';

const app = document.getElementById('app') as HTMLElement;

const TABS = [
  { id: 'graph', label: '关系图' },
  { id: 'events', label: '班级事件' },
  { id: 'people', label: '人物' },
  { id: 'logs', label: '操作日志' },
  { id: 'accounts', label: '账号', adminOnly: true },
] as const;

type TabId = (typeof TABS)[number]['id'];

let currentTab: TabId = 'graph';
let cleanup: (() => void) | null = null;

function tabFromHash(): TabId {
  const hash = location.hash.replace('#', '') as TabId;
  return TABS.some((t) => t.id === hash) ? hash : 'graph';
}

function clearView() {
  cleanup?.();
  cleanup = null;
  app.innerHTML = '';
}

/* ---------------- 登录页 ---------------- */
function showLogin() {
  clearView();
  renderLogin(app, boot);
}

/* ---------------- 启动 ---------------- */
async function boot() {
  clearView();
  if (!getToken()) {
    showLogin();
    return;
  }
  try {
    const data = await api.bootstrap();
    setData(data);
    renderShell();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setToken(null);
      clearData();
      showLogin();
      return;
    }
    clearView();
    app.append(
      h('div', { class: 'loading' }, `加载失败：${(err as Error).message}`),
      h('div', { class: 'loading' }, h('button', { class: 'btn', onclick: () => boot() }, '重试')),
    );
  }
}

/* ---------------- 主界面 ---------------- */
function renderShell() {
  clearView();
  const data = getData();
  currentTab = tabFromHash();

  const page = h('div', { class: 'page' });

  const tabsEl = h('div', { class: 'tabs' });
  for (const tab of TABS) {
    if ('adminOnly' in tab && tab.adminOnly && !data.isAdmin) continue;
    tabsEl.append(
      h(
        'button',
        {
          class: `tab ${currentTab === tab.id ? 'active' : ''}`,
          onclick: () => {
            location.hash = tab.id;
          },
        },
        tab.label,
      ),
    );
  }

  const roleInfo = data.roles.find((r) => r.id === data.me.role);

  const topbar = h(
    'div',
    { class: 'topbar' },
    h('div', { class: 'brand' }, h('span', { class: 'dot' }), 'Class Analysis Platform'),
    tabsEl,
    h(
      'div',
      { class: 'userbox' },
      h('span', { text: data.me.displayName }),
      h('span', { class: `role-badge role-${data.me.role}`, text: roleInfo?.label ?? data.me.role }),
      data.isAdmin
        ? h(
            'button',
            {
              class: `btn btn-sm ${data.incognito ? 'btn-warn' : ''}`,
              title: '开启后，你的操作不会被写入操作日志（开关本身仍会留痕）',
              onclick: () => toggleIncognito(data.incognito),
            },
            data.incognito ? '无痕中 · 点此关闭' : '无痕模式',
          )
        : null,
      h('button', { class: 'btn btn-sm', onclick: () => openChangePassword() }, '改密码'),
      h(
        'button',
        {
          class: 'btn btn-sm',
          onclick: async () => {
            try {
              await api.logout();
            } catch {
              /* 忽略：就算失败也照常退出本地 */
            }
            setToken(null);
            clearData();
            showLogin();
          },
        },
        '退出',
      ),
    ),
  );

  const incognitoBanner = data.incognito
    ? h(
        'div',
        { class: 'incognito-banner' },
        h('span', { class: 'incognito-icon', text: '🕶️' }),
        h('span', { text: '无痕模式已开启：接下来的操作不会写入操作日志' }),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm', onclick: () => toggleIncognito(true) }, '关闭无痕'),
      )
    : null;

  app.append(topbar);
  if (incognitoBanner) app.append(incognitoBanner);
  app.append(
    page,
    h('div', { class: 'footer-note', text: `Class Analysis Platform v${data.version} · 数据只保存在你自己部署的服务器上` }),
  );

  renderCurrentTab(page);
}

function renderCurrentTab(page: HTMLElement) {
  cleanup?.();
  cleanup = null;
  page.innerHTML = '';

  const refresh = async () => {
    const data = await api.bootstrap();
    setData(data);
    renderShell();
  };

  if (currentTab === 'graph') cleanup = renderGraph(page, refresh);
  else if (currentTab === 'events') cleanup = renderEvents(page, refresh);
  else if (currentTab === 'people') cleanup = renderPeople(page, refresh);
  else if (currentTab === 'logs') cleanup = renderLogs(page);
  else if (currentTab === 'accounts') cleanup = renderAccounts(page, refresh);
}

/** 无痕模式开关（仅管理员）：打开后本次登录的操作不写日志 */
async function toggleIncognito(current: boolean) {
  // 关闭：直接恢复记录
  if (current) {
    try {
      await api.setIncognito(false);
      toast('已关闭无痕模式，恢复记录', 'ok');
    } catch (err) {
      toast((err as Error).message, 'err');
    }
    await boot();
    return;
  }

  // 开启：让管理员写一句原因，会记进日志，方便以后看懂为什么开
  showForm({
    title: '开启无痕模式',
    submitText: '开启无痕',
    fields: [
      {
        name: 'reason',
        label: '为什么开无痕？（会记进操作日志）',
        type: 'textarea',
        placeholder: '例如：整理敏感数据、给同学演示、刚才录错了想重来…',
        help: '开启后你的操作不再写入日志；「开启」与「关闭」这两步本身仍会留痕，日志里能看到这段无痕区间的起止与原因。',
      },
    ],
    onSubmit: async (values) => {
      await api.setIncognito(true, values.reason ?? '');
      toast('无痕模式已开启，操作将不再记录', 'ok');
      await boot();
    },
  });
}

function openChangePassword() {
  showForm({
    title: '修改我的密码',
    fields: [
      { name: 'oldPassword', label: '原密码', type: 'password', required: true },
      { name: 'newPassword', label: '新密码', type: 'password', required: true, help: '至少 4 位' },
    ],
    onSubmit: async (values) => {
      await api.changePassword(values.oldPassword, values.newPassword);
      toast('密码已修改', 'ok');
    },
  });
}

window.addEventListener('hashchange', () => {
  if (!hasData()) return;
  renderShell();
});

boot();