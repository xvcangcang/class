/** 应用入口：登录态 → 顶栏 → 各视图路由 */
import { ApiError, api, getToken, setToken } from './api';
import { clearData, getData, hasData, setData } from './state';
import { h, showForm, toast } from './ui';
import { renderAccounts } from './views/accounts';
import { renderEvents } from './views/events';
import { renderGraph } from './views/graph';
import { renderLogin } from './views/login';
import { renderPeople } from './views/people';
import './styles/main.css';

const app = document.getElementById('app') as HTMLElement;

const TABS = [
  { id: 'graph', label: '关系图' },
  { id: 'events', label: '班级事件' },
  { id: 'people', label: '人物' },
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
    h('div', { class: 'brand' }, h('span', { class: 'dot' }), '班级图谱'),
    tabsEl,
    h(
      'div',
      { class: 'userbox' },
      h('span', { text: data.me.displayName }),
      h('span', { class: `role-badge role-${data.me.role}`, text: roleInfo?.label ?? data.me.role }),
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

  app.append(
    topbar,
    page,
    h('div', { class: 'footer-note', text: `班级图谱 v${data.version} · 数据只保存在你自己部署的服务器上` }),
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
  else if (currentTab === 'accounts') cleanup = renderAccounts(page, refresh);
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