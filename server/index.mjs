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
  appendLog,
  canEdit,
  createSession,
  destroySession,
  ensureSeed,
  getEvents,
  getGroups,
  getLinkTypes,
  getLinks,
  getLogs,
  getPeople,
  getSessionUser,
  getUsers,
  hashPassword,
  isAdmin,
  publicUser,
  saveEvents,
  saveGroups,
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
/** 只保留真实存在的群组 id，避免脏数据 */
const cleanGroupIds = (value) => {
  const known = new Set(getGroups().map((g) => g.id));
  return asArray(value)
    .map(str)
    .filter((id) => id && known.has(id));
};
const bearer = (req) => {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};
const currentUser = (req) => getSessionUser(bearer(req));

/* ------------------------------------------------------------------ *
 * 操作日志
 *
 * 每一次「改动数据」的操作都会追加一条日志：谁 / 什么时候 / 对什么 / 做了什么。
 * 日志只增不删，界面里也没有删除入口 —— 这样才谈得上留痕、可溯源。
 * 参数的含义：
 *   action  做了什么（短词，用于筛选与配色），如「新增人物」
 *   target  对什么做的（人名 / 群组名 / 关系两端 / 账号名）
 *   detail  补充说明（改动了哪些字段、连带影响了多少条数据）
 *   ok      成功还是失败
 * ------------------------------------------------------------------ */
function logAction(req, { action, target = '', detail = '', ok = true }) {
  try {
    const user = req.user ?? null;
    const ip =
      String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      '';
    appendLog({
      id: randomUUID(),
      ts: Date.now(),
      action,
      target,
      detail,
      ok,
      actor: user ? user.displayName || user.username : '未登录用户',
      actorUsername: user?.username ?? '',
      actorId: user?.id ?? null,
      ip,
    });
  } catch (err) {
    // 记日志失败绝不能影响正常业务
    console.error('写操作日志失败：', err);
  }
}

/** 把 id 列表换成「张三、李四」这种看得懂的名字 */
const namesOf = (ids) =>
  asArray(ids)
    .map((id) => findPerson(id)?.name ?? '（已删除）')
    .join('、');

/** 对比前后对象，列出被改动的字段（用于日志的「改了什么」） */
function changedFields(before, after, labels) {
  const changed = [];
  for (const [key, label] of Object.entries(labels)) {
    const a = JSON.stringify(before?.[key] ?? null);
    const b = JSON.stringify(after?.[key] ?? null);
    if (a !== b) changed.push(label);
  }
  return changed;
}

/** 组装前端一次拉取所需的全部数据（按当前用户权限裁剪） */
function buildBootstrap(user) {
  const data = {
    me: publicUser(user),
    roles: ROLES.map((id) => ({ id, label: ROLE_LABELS[id], desc: ROLE_DESC[id] })),
    people: getPeople(),
    groups: getGroups(),
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
    logAction(req, {
      action: '登录失败',
      target: username || '（没填用户名）',
      detail: found ? '密码不对' : '没有这个账号',
      ok: false,
    });
    res.status(401).json({ error: '用户名或密码不对' });
    return;
  }
  req.user = found;
  logAction(req, { action: '登录', target: found.username, detail: `以「${ROLE_LABELS[found.role] ?? found.role}」身份登录` });
  res.json({ token: createSession(found.id), user: publicUser(found) });
});

/* ------------------------------------------------------------------ *
 * 需要登录
 * ------------------------------------------------------------------ */
app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/auth/logout', auth, (req, res) => {
  logAction(req, { action: '退出登录', target: req.user.username });
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
  logAction(req, { action: '修改密码', target: req.user.username, detail: '修改了自己的登录密码' });
  res.json({ ok: true });
});

app.get('/api/bootstrap', auth, (req, res) => res.json(buildBootstrap(req.user)));

/* ------------------------------------------------------------------ *
 * 群组（小组 / 宿舍 / 社团…）：图上的长方形节点
 * ------------------------------------------------------------------ */
const GROUP_KINDS = ['小组', '宿舍', '社团', '其他'];
const MAX_GROUP_NAME = 16;

/** 群组类型 → 自动生成的人—人关系类型 */
const GROUP_LINK_TYPE = {
  小组: '同组',
  宿舍: '同宿舍',
  社团: '同社团',
  其他: '同组',
};

const pairKey = (a, b) => [a, b].sort().join('|');

/**
 * 把群组成员两两之间的关系补齐（只针对这个群组对应的那一种关系类型）。
 *
 * 注意：默认情况下只有当这个群组**已经用「人—人连线」表达过**同组关系时才会自动动手，
 * 否则什么都不做 —— 免得把本来用群组节点表达的图一下子连成一张密密麻麻的网。
 * 用户手动点「生成成员关系」时传 force = true。
 */
function syncGroupMemberLinks(groupId, force = false) {
  const group = getGroups().find((g) => g.id === groupId);
  if (!group) return { created: 0, removed: 0, skipped: true };

  const typeName = GROUP_LINK_TYPE[group.kind] ?? '同组';
  const members = getPeople().filter((p) => (p.groupIds ?? []).includes(group.id));
  const memberIds = new Set(members.map((m) => m.id));
  const links = getLinks();

  const alreadyUsed = links.some(
    (l) => l.type === typeName && memberIds.has(l.source) && memberIds.has(l.target),
  );
  if (!force && !alreadyUsed) return { created: 0, removed: 0, skipped: true };

  const existing = new Set(
    links.filter((l) => l.type === typeName).map((l) => pairKey(l.source, l.target)),
  );

  let created = 0;
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const key = pairKey(members[i].id, members[j].id);
      if (existing.has(key)) continue;
      links.push({
        id: randomUUID(),
        source: members[i].id,
        target: members[j].id,
        type: typeName,
        weight: 3,
      });
      existing.add(key);
      created += 1;
    }
  }

  // 已经退出群组的人，与组内成员之间的残留关系一起清掉
  let removed = 0;
  const kept = links.filter((l) => {
    if (l.type !== typeName) return true;
    const inA = memberIds.has(l.source);
    const inB = memberIds.has(l.target);
    if (inA === inB) return true; // 都在组内（保留）或都不在（别动别人加的）
    removed += 1;
    return false;
  });

  if (created || removed) saveLinks(kept);

  return { created, removed, skipped: false };
}

app.post('/api/groups', auth, editorOnly, (req, res) => {
  const name = str(req.body?.name);
  if (!name) {
    res.status(400).json({ error: '群组名称不能空着' });
    return;
  }
  if (name.length > MAX_GROUP_NAME) {
    res.status(400).json({ error: `名称最多 ${MAX_GROUP_NAME} 个字` });
    return;
  }
  const groups = getGroups();
  if (groups.some((g) => g.name === name)) {
    res.status(400).json({ error: '已经有这个群组了' });
    return;
  }
  const group = {
    id: randomUUID(),
    name,
    kind: GROUP_KINDS.includes(req.body?.kind) ? req.body.kind : '其他',
    note: str(req.body?.note),
    createdAt: Date.now(),
  };
  groups.push(group);
  saveGroups(groups);
  logAction(req, { action: '新建群组', target: group.name, detail: `类型：${group.kind}` });
  res.json({ group });
});

app.patch('/api/groups/:id', auth, editorOnly, (req, res) => {
  const groups = getGroups();
  const group = groups.find((g) => g.id === req.params.id);
  if (!group) {
    res.status(404).json({ error: '找不到这个群组' });
    return;
  }
  const body = req.body ?? {};
  const before = { ...group };
  if ('name' in body && str(body.name)) {
    const name = str(body.name);
    if (groups.some((g) => g.name === name && g.id !== group.id)) {
      res.status(400).json({ error: '已经有这个群组了' });
      return;
    }
    group.name = name;
  }
  if ('kind' in body && GROUP_KINDS.includes(body.kind)) group.kind = body.kind;
  if ('note' in body) group.note = str(body.note);
  saveGroups(groups);
  const fields = changedFields(before, group, { name: '名称', kind: '类型', note: '备注' });
  logAction(req, {
    action: '修改群组',
    target: group.name,
    detail: fields.length ? `改动：${fields.join('、')}` : '没有实际改动',
  });
  res.json({ group });
});

app.delete('/api/groups/:id', auth, editorOnly, (req, res) => {
  const groups = getGroups();
  const index = groups.findIndex((g) => g.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ error: '找不到这个群组' });
    return;
  }
  const [removed] = groups.splice(index, 1);
  saveGroups(groups);

  // 把成员的归属一并摘掉
  const people = getPeople();
  let changed = 0;
  for (const person of people) {
    if (Array.isArray(person.groupIds) && person.groupIds.includes(removed.id)) {
      person.groupIds = person.groupIds.filter((id) => id !== removed.id);
      changed += 1;
    }
  }
  if (changed) savePeople(people);

  logAction(req, {
    action: '删除群组',
    target: removed.name,
    detail: changed ? `连带把 ${changed} 个人的归属移除了` : '组里当时没有人',
  });

  res.json({ ok: true, removedMembers: changed });
});

/** 批量加入 / 移出成员：{ personIds: [...], mode: 'add' | 'remove' } */
app.post('/api/groups/:id/members', auth, editorOnly, (req, res) => {
  const group = getGroups().find((g) => g.id === req.params.id);
  if (!group) {
    res.status(404).json({ error: '找不到这个群组' });
    return;
  }
  const personIds = asArray(req.body?.personIds).map(str).filter(Boolean);
  const remove = req.body?.mode === 'remove';
  const people = getPeople();
  let changed = 0;
  for (const person of people) {
    if (!Array.isArray(person.groupIds)) person.groupIds = [];
    const has = person.groupIds.includes(group.id);
    if (!personIds.includes(person.id)) continue;
    if (!remove && !has) {
      person.groupIds.push(group.id);
      changed += 1;
    } else if (remove && has) {
      person.groupIds = person.groupIds.filter((id) => id !== group.id);
      changed += 1;
    }
  }
  if (changed) {
    savePeople(people);
    syncGroupMemberLinks(group.id);
  }
  logAction(req, {
    action: remove ? '移出群组成员' : '加入群组成员',
    target: group.name,
    detail: changed ? `${changed} 人：${namesOf(personIds)}` : '没有变化（这些人本来就在/不在组里）',
  });
  res.json({ ok: true, changed });
});

/**
 * 一键：按群组成员自动生成（或清除）人—人之间的同组类关系。
 * 例如「302 宿舍」8 个人 → 28 条「同宿舍」。
 */
app.post('/api/groups/:id/generate-links', auth, editorOnly, (req, res) => {
  const group = getGroups().find((g) => g.id === req.params.id);
  if (!group) {
    res.status(404).json({ error: '找不到这个群组' });
    return;
  }
  const typeName = GROUP_LINK_TYPE[group.kind] ?? '同组';
  const members = getPeople().filter((p) => (p.groupIds ?? []).includes(group.id));
  const memberIds = new Set(members.map((m) => m.id));

  if (req.body?.mode === 'remove') {
    const links = getLinks();
    let removed = 0;
    for (let i = links.length - 1; i >= 0; i -= 1) {
      const l = links[i];
      if (l.type === typeName && memberIds.has(l.source) && memberIds.has(l.target)) {
        links.splice(i, 1);
        removed += 1;
      }
    }
    if (removed) saveLinks(links);
    logAction(req, {
      action: '清除同组关系',
      target: group.name,
      detail: `清掉 ${removed} 条「${typeName}」关系`,
    });
    res.json({ ok: true, type: typeName, pairs: 0, created: 0, removed });
    return;
  }

  // 把类型补进关系类型列表，免得图上图例找不到它
  const types = getLinkTypes();
  if (!types.includes(typeName)) saveLinkTypes([...types, typeName]);

  const result = syncGroupMemberLinks(group.id, true);
  logAction(req, {
    action: '生成同组关系',
    target: group.name,
    detail: `${members.length} 名成员之间新增 ${result.created} 条「${typeName}」${result.removed ? `，清理 ${result.removed} 条残留` : ''}`,
  });
  res.json({
    ok: true,
    type: typeName,
    pairs: (members.length * (members.length - 1)) / 2,
    created: result.created,
    removed: result.removed,
  });
});

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
    groupIds: cleanGroupIds(req.body?.groupIds),
    tags: asArray(req.body?.tags).map(str).filter(Boolean),
    note: str(req.body?.note),
    createdAt: Date.now(),
  };
  people.push(person);
  savePeople(people);
  logAction(req, {
    action: '新增人物',
    target: person.name,
    detail: `${person.role === 'teacher' ? '老师' : '学生'}${person.groupIds.length ? `，加入 ${person.groupIds.length} 个群组` : ''}`,
  });
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
  const beforeGroups = [...(person.groupIds ?? [])];
  const before = { ...person, groupIds: [...beforeGroups], tags: [...(person.tags ?? [])] };
  if ('name' in body && str(body.name)) person.name = str(body.name);
  if ('role' in body) person.role = body.role === 'teacher' ? 'teacher' : 'student';
  if ('groupIds' in body) person.groupIds = cleanGroupIds(body.groupIds);
  if ('tags' in body) person.tags = asArray(body.tags).map(str).filter(Boolean);
  if ('note' in body) person.note = str(body.note);
  savePeople(people);

  // 归属发生过变化的群组，把人—人关系同步一下
  for (const gid of new Set([...beforeGroups, ...(person.groupIds ?? [])])) {
    syncGroupMemberLinks(gid);
  }

  const fields = changedFields(before, person, {
    name: '姓名',
    role: '身份',
    groupIds: '所属群组',
    tags: '标签',
    note: '备注',
  });
  logAction(req, {
    action: '修改人物',
    target: person.name,
    detail: fields.length ? `改动：${fields.join('、')}` : '没有实际改动',
  });

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
  const [removed] = people.splice(index, 1);
  savePeople(people);
  // 连带清掉这个人参与的关系与事件引用
  const links = getLinks();
  const keptLinks = links.filter((l) => l.source !== id && l.target !== id);
  saveLinks(keptLinks);
  saveEvents(
    getEvents().map((event) => ({
      ...event,
      participants: asArray(event.participants).filter((p) => p !== id),
    })),
  );
  logAction(req, {
    action: '删除人物',
    target: removed?.name ?? '（未知）',
    detail: `同时清掉 ${links.length - keptLinks.length} 条相关关系`,
  });
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
  logAction(req, { action: '新增关系类型', target: name });
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

  logAction(req, {
    action: '重命名关系类型',
    target: `${from} → ${to}`,
    detail: changed ? `同步更新了 ${changed} 条关系` : '当时没有关系用到它',
  });

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

  logAction(req, {
    action: '删除关系类型',
    target: name,
    detail: changed ? `${changed} 条关系改为「${fallback}」` : `没有关系用到它（回落类型：${fallback}）`,
  });

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
  logAction(req, {
    action: '新增关系',
    target: `${findPerson(source)?.name ?? '？'} ↔ ${findPerson(target)?.name ?? '？'}`,
    detail: `类型：${link.type}，亲密度 ${link.weight}`,
  });
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
  const before = { ...link };
  if ('type' in body) link.type = str(body.type) || link.type;
  if ('weight' in body) link.weight = Math.min(5, Math.max(1, Number(body.weight) || link.weight));
  if ('source' in body && findPerson(str(body.source))) link.source = str(body.source);
  if ('target' in body && findPerson(str(body.target))) link.target = str(body.target);
  saveLinks(links);
  const fields = changedFields(before, link, { type: '类型', weight: '亲密度', source: '起点', target: '终点' });
  logAction(req, {
    action: '修改关系',
    target: `${findPerson(link.source)?.name ?? '？'} ↔ ${findPerson(link.target)?.name ?? '？'}`,
    detail: fields.length ? `改动：${fields.join('、')}` : '没有实际改动',
  });
  res.json({ link });
});

app.delete('/api/links/:id', auth, editorOnly, (req, res) => {
  const links = getLinks();
  const index = links.findIndex((l) => l.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ error: '找不到这条关系' });
    return;
  }
  const [removed] = links.splice(index, 1);
  saveLinks(links);
  logAction(req, {
    action: '删除关系',
    target: `${findPerson(removed?.source)?.name ?? '？'} ↔ ${findPerson(removed?.target)?.name ?? '？'}`,
    detail: removed ? `类型：${removed.type}` : '',
  });
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
  logAction(req, {
    action: '新增事件',
    target: event.title,
    detail: `${event.date}${event.participants.length ? `，涉及 ${namesOf(event.participants)}` : ''}`,
  });
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
  const before = { ...event };
  if ('date' in body) event.date = str(body.date) || event.date;
  if ('title' in body && str(body.title)) event.title = str(body.title);
  if ('detail' in body) event.detail = str(body.detail);
  if ('participants' in body) {
    event.participants = asArray(body.participants).map(str).filter((p) => findPerson(p));
  }
  event.updatedAt = Date.now();
  saveEvents(events);
  const fields = changedFields(before, event, { date: '日期', title: '标题', detail: '细节', participants: '参与人' });
  logAction(req, {
    action: '修改事件',
    target: event.title,
    detail: fields.length ? `改动：${fields.join('、')}` : '没有实际改动',
  });
  res.json({ event });
});

app.delete('/api/events/:id', auth, editorOnly, (req, res) => {
  const events = getEvents();
  const index = events.findIndex((e) => e.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ error: '找不到这个事件' });
    return;
  }
  const [removed] = events.splice(index, 1);
  saveEvents(events);
  logAction(req, {
    action: '删除事件',
    target: removed?.title ?? '（未知）',
    detail: removed ? `日期：${removed.date}` : '',
  });
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
  logAction(req, {
    action: '新建账号',
    target: created.username,
    detail: `权限：${ROLE_LABELS[created.role] ?? created.role}，显示名：${created.displayName}`,
  });
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
  const before = { ...target };
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
  const fields = changedFields(before, target, {
    role: '权限等级',
    displayName: '显示名',
    personId: '关联人物',
    password: '密码',
  });
  logAction(req, {
    action: '修改账号',
    target: target.username,
    detail: fields.length ? `改动：${fields.join('、')}` : '没有实际改动',
  });
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
  const [removed] = users.splice(index, 1);
  saveUsers(users);
  logAction(req, {
    action: '删除账号',
    target: removed.username,
    detail: `原权限：${ROLE_LABELS[removed.role] ?? removed.role}`,
  });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * 操作日志查询（仅管理员可看，因为里面会涉及账号操作）
 * ------------------------------------------------------------------ */
app.get('/api/logs', auth, adminOnly, (req, res) => {
  const all = getLogs();
  const q = str(req.query?.q).toLowerCase();
  const action = str(req.query?.action);
  const result = str(req.query?.result); // '' | 'ok' | 'fail'
  const from = Number(req.query?.from) || 0;
  const to = Number(req.query?.to) || 0;
  const limit = Math.min(1000, Math.max(1, Number(req.query?.limit) || 200));

  const filtered = all
    .filter((entry) => {
      if (action && entry.action !== action) return false;
      if (result === 'ok' && entry.ok === false) return false;
      if (result === 'fail' && entry.ok !== false) return false;
      if (from && entry.ts < from) return false;
      if (to && entry.ts > to) return false;
      if (q) {
        const haystack = `${entry.actor} ${entry.actorUsername} ${entry.action} ${entry.target} ${entry.detail}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => b.ts - a.ts);

  res.json({
    logs: filtered.slice(0, limit),
    total: filtered.length,
    stored: all.length,
    actions: [...new Set(all.map((entry) => entry.action))].sort(),
  });
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