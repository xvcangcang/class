/**
 * 班级图谱 · HTTP 服务（Express）
 *
 * 一个进程同时提供：
 *   1. 静态页面（dist/ 构建产物，单页应用回退到 index.html）
 *   2. /api/* 接口：登录、权限、人物 / 关系 / 事件 / 账号的读写
 *
 * 为什么用 Express：PocketBay 的平台识别按依赖判断后端类型，纯 node:http 的
 * 零依赖服务会被当成静态站点（只起 nginx，接口全 404）。Express 是平台明确
 * 支持的 node 运行时标志。
 *
 * 启动：node server/index.mjs
 * 环境变量：
 *   PORT               默认 8787（平台会注入自己的 PORT）
 *   POCKETBAY_DATA_DIR 数据目录（线上为 /data 持久卷）
 *   DIST_DIR           静态目录，默认 ../dist
 */
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  DATA_DIR,
  ROLE_DESC,
  ROLE_LABELS,
  ROLES,
  canEdit,
  createSession,
  destroySession,
  ensureSeed,
  getEvents,
  getLinkTypes,
  getLinks,
  getPeople,
  getSessionUser,
  getUsers,
  hashPassword,
  isAdmin,
  publicUser,
  saveEvents,
  saveLinkTypes,
  saveLinks,
  savePeople,
  saveUsers,
  verifyPassword,
} from './db.mjs';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ROOT = resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const DIST_DIR = resolve(ROOT, process.env.DIST_DIR || 'dist');
const INDEX_HTML = join(DIST_DIR, 'index.html');
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

ensureSeed();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
const str = (value) => (typeof value === 'string' ? value.trim() : '');
const asArray = (value) => (Array.isArray(value) ? value : []);
const findPerson = (id) => getPeople().find((p) => p.id === id) ?? null;
const bearer = (req) => {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};
const currentUser = (req) => getSessionUser(bearer(req));

/** 组装前端一次拉取所需的全部数据（按当前用户权限裁剪） */
function buildBootstrap(user) {
  const data = {
    me: publicUser(user),
    roles: ROLES.map((id) => ({ id, label: ROLE_LABELS[id], desc: ROLE_DESC[id] })),
    people: getPeople(),
    links: getLinks(),
    events: getEvents(),
    linkTypes: getLinkTypes(),
    users: [],
    version: APP_VERSION,
    canEdit: canEdit(user),
    isAdmin: isAdmin(user),
  };
  if (isAdmin(user)) data.users = getUsers().map(publicUser);
  return data;
}

/* ------------------------------------------------------------------ *
 * 中间件
 * ------------------------------------------------------------------ */
const auth = (req, res, next) => {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ error: '请先登录' });
    return;
  }
  req.user = user;
  next();
};

const editorOnly = (req, res, next) => {
  if (!canEdit(req.user)) {
    res.status(403).json({ error: '你没有编辑权限' });
    return;
  }
  next();
};

const adminOnly = (req, res, next) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: '只有管理员能做这个操作' });
    return;
  }
  next();
};

/* ------------------------------------------------------------------ *
 * 公开接口
 * ------------------------------------------------------------------ */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    dataDir: DATA_DIR,
    distReady: existsSync(INDEX_HTML),
    users: getUsers().length,
    people: getPeople().length,
  });
});

app.post('/api/auth/login', (req, res) => {
  const username = str(req.body?.username);
  const password = String(req.body?.password ?? '');
  const found = getUsers().find((u) => u.username === username);
  if (!found || !verifyPassword(password, found.password)) {
    res.status(401).json({ error: '用户名或密码不对' });
    return;
  }
  res.json({ token: createSession(found.id), user: publicUser(found) });
});

/* ------------------------------------------------------------------ *
 * 需要登录
 * ------------------------------------------------------------------ */
app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/auth/logout', auth, (req, res) => {
  destroySession(bearer(req));
  res.json({ ok: true });
});

app.post('/api/auth/password', auth, (req, res) => {
  const oldPassword = String(req.body?.oldPassword ?? '');
  const newPassword = String(req.body?.newPassword ?? '');
  if (newPassword.length < 4) {
    res.status(400).json({ error: '新密码至少 4 位' });
    return;
  }
  if (!verifyPassword(oldPassword, req.user.password)) {
    res.status(400).json({ error: '原密码不对' });
    return;
  }
  const users = getUsers();
  const target = users.find((u) => u.id === req.user.id);
  target.password = hashPassword(newPassword);
  saveUsers(users);
  res.json({ ok: true });
});

app.get('/api/bootstrap', auth, (req, res) => res.json(buildBootstrap(req.user)));

/* ------------------------------------------------------------------ *
 * 人物
 * ------------------------------------------------------------------ */
app.post('/api/people', auth, editorOnly, (req, res) => {
  const name = str(req.body?.name);
  if (!name) {
    res.status(400).json({ error: '名字不能空着' });
    return;
  }
  const people = getPeople();
  const person = {
    id: randomUUID(),
    name,
    role: req.body?.role === 'teacher' ? 'teacher' : 'student',
    group: str(req.body?.group),
    tags: asArray(req.body?.tags).map(str).filter(Boolean),
    note: str(req.body?.note),
    createdAt: Date.now(),
  };
  people.push(person);
  savePeople(people);
  res.json({ person });
});

app.patch('/api/people/:id', auth, editorOnly, (req, res) => {
  const people = getPeople();
  const person = people.find((p) => p.id === req.params.id);
  if (!person) {
    res.status(404).json({ error: '找不到这个人' });
    return;
  }
  const body = req.body ?? {};
  if ('name' in body && str(body.name)) person.name = str(body.name);
  if ('role' in body) person.role = body.role === 'teacher' ? 'teacher' : 'student';
  if ('group' in body) person.group = str(body.group);
  if ('tags' in body) person.tags = asArray(body.tags).map(str).filter(Boolean);
  if ('note' in body) person.note = str(body.note);
  savePeople(people);
  res.json({ person });
});

app.delete('/api/people/:id', auth, editorOnly, (req, res) => {
  const id = req.params.id;
  const people = getPeople();
  const index = people.findIndex((p) => p.id === id);
  if (index < 0) {
    res.status(404).json({ error: '找不到这个人' });
    return;
  }
  people.splice(index, 1);
  savePeople(people);
  // 连带清掉这个人参与的关系与事件引用
  saveLinks(getLinks().filter((l) => l.source !== id && l.target !== id));
  saveEvents(
    getEvents().map((event) => ({
      ...event,
      participants: asArray(event.participants).filter((p) => p !== id),
    })),
  );
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * 关系类型（使用者可自己增删改）
 * ------------------------------------------------------------------ */
const MAX_TYPE_LENGTH = 12;

app.post('/api/link-types', auth, editorOnly, (req, res) => {
  const name = str(req.body?.name);
  if (!name) {
    res.status(400).json({ error: '类型名称不能空着' });
    return;
  }
  if (name.length > MAX_TYPE_LENGTH) {
    res.status(400).json({ error: `类型名称最多 ${MAX_TYPE_LENGTH} 个字` });
    return;
  }
  if (/[/\\]/.test(name)) {
    res.status(400).json({ error: '名称里不能有斜杠' });
    return;
  }
  const types = getLinkTypes();
  if (types.includes(name)) {
    res.status(400).json({ error: '已经有这个类型了' });
    return;
  }
  types.push(name);
  saveLinkTypes(types);
  res.json({ linkTypes: types });
});

app.patch('/api/link-types/:name', auth, editorOnly, (req, res) => {
  const from = req.params.name;
  const to = str(req.body?.name);
  if (!to) {
    res.status(400).json({ error: '新名称不能空着' });
    return;
  }
  if (to.length > MAX_TYPE_LENGTH) {
    res.status(400).json({ error: `类型名称最多 ${MAX_TYPE_LENGTH} 个字` });
    return;
  }
  const types = getLinkTypes();
  const index = types.indexOf(from);
  if (index < 0) {
    res.status(404).json({ error: '找不到这个类型' });
    return;
  }
  if (to !== from && types.includes(to)) {
    res.status(400).json({ error: '已经有这个类型了' });
    return;
  }
  types[index] = to;
  saveLinkTypes(types);

  // 已有关系跟着一起改名
  const links = getLinks();
  let changed = 0;
  for (const link of links) {
    if (link.type === from) {
      link.type = to;
      changed += 1;
    }
  }
  if (changed) saveLinks(links);

  res.json({ linkTypes: types, updatedLinks: changed });
});

app.delete('/api/link-types/:name', auth, editorOnly, (req, res) => {
  const name = req.params.name;
  const types = getLinkTypes();
  if (types.length <= 1) {
    res.status(400).json({ error: '至少要留一个关系类型' });
    return;
  }
  const index = types.indexOf(name);
  if (index < 0) {
    res.status(404).json({ error: '找不到这个类型' });
    return;
  }
  types.splice(index, 1);
  saveLinkTypes(types);

  // 用到这个类型的关系改成「其他」（没有「其他」就用剩下的第一个）
  const fallback = types.includes('其他') ? '其他' : types[0];
  const links = getLinks();
  let changed = 0;
  for (const link of links) {
    if (link.type === name) {
      link.type = fallback;
      changed += 1;
    }
  }
  if (changed) saveLinks(links);

  res.json({ linkTypes: types, updatedLinks: changed, fallback });
});

/* ------------------------------------------------------------------ *
 * 关系
 * ------------------------------------------------------------------ */
app.post('/api/links', auth, editorOnly, (req, res) => {
  const source = str(req.body?.source);
  const target = str(req.body?.target);
  if (!source || !target || source === target) {
    res.status(400).json({ error: '关系的两端必须是两个不同的人' });
    return;
  }
  if (!findPerson(source) || !findPerson(target)) {
    res.status(400).json({ error: '关系里的人不存在' });
    return;
  }
  const links = getLinks();
  const link = {
    id: randomUUID(),
    source,
    target,
    type: str(req.body?.type) || '其他',
    weight: Math.min(5, Math.max(1, Number(req.body?.weight) || 1)),
  };
  links.push(link);
  saveLinks(links);
  res.json({ link });
});

app.patch('/api/links/:id', auth, editorOnly, (req, res) => {
  const links = getLinks();
  const link = links.find((l) => l.id === req.params.id);
  if (!link) {
    res.status(404).json({ error: '找不到这条关系' });
    return;
  }
  const body = req.body ?? {};
  if ('type' in body) link.type = str(body.type) || link.type;
  if ('weight' in body) link.weight = Math.min(5, Math.max(1, Number(body.weight) || link.weight));
  if ('source' in body && findPerson(str(body.source))) link.source = str(body.source);
  if ('target' in body && findPerson(str(body.target))) link.target = str(body.target);
  saveLinks(links);
  res.json({ link });
});

app.delete('/api/links/:id', auth, editorOnly, (req, res) => {
  const links = getLinks();
  const index = links.findIndex((l) => l.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ error: '找不到这条关系' });
    return;
  }
  links.splice(index, 1);
  saveLinks(links);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */
app.post('/api/events', auth, editorOnly, (req, res) => {
  const title = str(req.body?.title);
  if (!title) {
    res.status(400).json({ error: '事件标题不能空着' });
    return;
  }
  const events = getEvents();
  const event = {
    id: randomUUID(),
    date: str(req.body?.date) || new Date().toISOString().slice(0, 10),
    title,
    detail: str(req.body?.detail),
    participants: asArray(req.body?.participants).map(str).filter((p) => findPerson(p)),
    createdBy: req.user.displayName || req.user.username,
    updatedAt: Date.now(),
  };
  events.push(event);
  saveEvents(events);
  res.json({ event });
});

app.patch('/api/events/:id', auth, editorOnly, (req, res) => {
  const events = getEvents();
  const event = events.find((e) => e.id === req.params.id);
  if (!event) {
    res.status(404).json({ error: '找不到这个事件' });
    return;
  }
  const body = req.body ?? {};
  if ('date' in body) event.date = str(body.date) || event.date;
  if ('title' in body && str(body.title)) event.title = str(body.title);
  if ('detail' in body) event.detail = str(body.detail);
  if ('participants' in body) {
    event.participants = asArray(body.participants).map(str).filter((p) => findPerson(p));
  }
  event.updatedAt = Date.now();
  saveEvents(events);
  res.json({ event });
});

app.delete('/api/events/:id', auth, editorOnly, (req, res) => {
  const events = getEvents();
  const index = events.findIndex((e) => e.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ error: '找不到这个事件' });
    return;
  }
  events.splice(index, 1);
  saveEvents(events);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * 账号（仅管理员）
 * ------------------------------------------------------------------ */
app.post('/api/users', auth, adminOnly, (req, res) => {
  const username = str(req.body?.username);
  const password = String(req.body?.password ?? '');
  const role = ROLES.includes(req.body?.role) ? req.body.role : 'viewer';
  if (!/^[A-Za-z0-9_.-]{3,20}$/.test(username)) {
    res.status(400).json({ error: '用户名 3~20 位，只能字母数字和 _ . -' });
    return;
  }
  if (password.length < 4) {
    res.status(400).json({ error: '密码至少 4 位' });
    return;
  }
  const users = getUsers();
  if (users.some((u) => u.username === username)) {
    res.status(400).json({ error: '这个用户名已经有人用了' });
    return;
  }
  const created = {
    id: randomUUID(),
    username,
    password: hashPassword(password),
    role,
    displayName: str(req.body?.displayName) || username,
    personId: str(req.body?.personId) || null,
    createdAt: Date.now(),
  };
  users.push(created);
  saveUsers(users);
  res.json({ user: publicUser(created) });
});

app.patch('/api/users/:id', auth, adminOnly, (req, res) => {
  const users = getUsers();
  const target = users.find((u) => u.id === req.params.id);
  if (!target) {
    res.status(404).json({ error: '找不到这个账号' });
    return;
  }
  const body = req.body ?? {};
  if ('role' in body && ROLES.includes(body.role)) {
    if (target.id === req.user.id && body.role !== 'admin') {
      res.status(400).json({ error: '不能把自己降级，免得没人能管了' });
      return;
    }
    target.role = body.role;
  }
  if ('displayName' in body) target.displayName = str(body.displayName) || target.username;
  if ('personId' in body) target.personId = str(body.personId) || null;
  if ('password' in body && String(body.password)) {
    if (String(body.password).length < 4) {
      res.status(400).json({ error: '密码至少 4 位' });
      return;
    }
    target.password = hashPassword(String(body.password));
  }
  saveUsers(users);
  res.json({ user: publicUser(target) });
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  const users = getUsers();
  const index = users.findIndex((u) => u.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ error: '找不到这个账号' });
    return;
  }
  if (users[index].id === req.user.id) {
    res.status(400).json({ error: '不能删掉自己' });
    return;
  }
  users.splice(index, 1);
  saveUsers(users);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * 静态文件 + 单页应用回退
 * ------------------------------------------------------------------ */
app.use(express.static(DIST_DIR, { index: 'index.html' }));

app.use('/api', (req, res) => res.status(404).json({ error: '没有这个接口' }));

app.get('*', (req, res) => {
  if (!existsSync(INDEX_HTML)) {
    res.status(503).type('text/plain').send('还没有构建产物。请先运行：npm run build\n');
    return;
  }
  res.sendFile(INDEX_HTML);
});

/* 错误兜底 */
app.use((err, req, res, next) => {
  const isParseError = err?.type === 'entity.parse.failed';
  res.status(isParseError ? 400 : 500).json({
    error: isParseError ? '请求体不是合法 JSON' : `服务器出错：${String(err?.message ?? err)}`,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Class Analysis Platform server started');
  console.log(`  地址：http://0.0.0.0:${PORT}`);
  console.log(`  数据目录：${DATA_DIR}`);
  console.log(`  静态目录：${DIST_DIR}${existsSync(INDEX_HTML) ? '' : ' （还没有构建产物）'}`);
});