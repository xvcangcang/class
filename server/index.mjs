/**
 * 班级图谱 · HTTP 服务
 *
 * 零依赖 Node 服务，一个进程同时提供：
 *   1. 静态页面（dist/ 里的构建产物）
 *   2. /api/* 接口：登录、权限、人物 / 关系 / 事件 / 账号的读写
 *
 * 启动：node server/index.mjs
 * 环境变量：
 *   PORT               默认 8787（PocketBay 会注入自己的 PORT）
 *   POCKETBAY_DATA_DIR 数据目录（线上为 /data 持久卷）
 *   DIST_DIR           静态目录，默认 ../dist
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  ROLE_DESC,
  ROLE_LABELS,
  ROLES,
  canEdit,
  createSession,
  destroySession,
  ensureSeed,
  getEvents,
  getLinks,
  getPeople,
  getSessionUser,
  getUsers,
  hashPassword,
  isAdmin,
  publicUser,
  saveEvents,
  saveLinks,
  savePeople,
  saveUsers,
  DATA_DIR,
  verifyPassword,
} from './db.mjs';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ROOT = resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const DIST_DIR = resolve(ROOT, process.env.DIST_DIR || 'dist');
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectPromise(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch (err) {
        rejectPromise(new Error(`请求体不是合法 JSON：${String(err)}`));
      }
    });
    req.on('error', rejectPromise);
  });
}

const bearer = (req) => {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

const currentUser = (req) => getSessionUser(bearer(req));

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const asArray = (value) => (Array.isArray(value) ? value : []);

/** 关系 / 人物的简要校验 */
function findPerson(id) {
  return getPeople().find((p) => p.id === id) ?? null;
}

/* ------------------------------------------------------------------ *
 * 静态文件
 * ------------------------------------------------------------------ */
async function serveStatic(req, res, urlPath) {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('还没有构建产物。请先运行：npm run build\n');
    return;
  }
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  let target = resolve(DIST_DIR, rel);
  if (target !== DIST_DIR && !target.startsWith(DIST_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, 'index.html');
  } catch {
    // 单页应用：找不到的路径回退到 index.html
    target = join(DIST_DIR, 'index.html');
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not Found');
  }
}

/* ------------------------------------------------------------------ *
 * API 路由
 * ------------------------------------------------------------------ */

/** 组装前端一次拉取所需的全部数据（按当前用户权限裁剪） */
function buildBootstrap(user) {
  const data = {
    me: publicUser(user),
    roles: ROLES.map((id) => ({ id, label: ROLE_LABELS[id], desc: ROLE_DESC[id] })),
    people: getPeople(),
    links: getLinks(),
    events: getEvents(),
    users: [],
    version: APP_VERSION,
    canEdit: canEdit(user),
    isAdmin: isAdmin(user),
  };
  if (isAdmin(user)) {
    data.users = getUsers().map(publicUser);
  }
  return data;
}

async function handleApi(req, res, url) {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const user = currentUser(req);

  /* ---------- 健康检查（PocketBay 会调用） ---------- */
  if (path === '/api/health') {
    json(res, 200, {
      ok: true,
      version: APP_VERSION,
      dataDir: DATA_DIR,
      distReady: existsSync(DIST_DIR),
      users: getUsers().length,
      people: getPeople().length,
    });
    return true;
  }

  /* ---------- 登录 ---------- */
  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const username = str(body.username);
    const password = String(body.password ?? '');
    const found = getUsers().find((u) => u.username === username);
    if (!found || !verifyPassword(password, found.password)) {
      json(res, 401, { error: '用户名或密码不对' });
      return true;
    }
    const token = createSession(found.id);
    json(res, 200, { token, user: publicUser(found) });
    return true;
  }

  /* ---------- 以下接口都需要登录 ---------- */
  if (!user) {
    json(res, 401, { error: '请先登录' });
    return true;
  }

  if (path === '/api/auth/me' && method === 'GET') {
    json(res, 200, { user: publicUser(user) });
    return true;
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    destroySession(bearer(req));
    json(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/auth/password' && method === 'POST') {
    const body = await readBody(req);
    const oldPassword = String(body.oldPassword ?? '');
    const newPassword = String(body.newPassword ?? '');
    if (newPassword.length < 4) {
      json(res, 400, { error: '新密码至少 4 位' });
      return true;
    }
    if (!verifyPassword(oldPassword, user.password)) {
      json(res, 400, { error: '原密码不对' });
      return true;
    }
    const users = getUsers();
    const target = users.find((u) => u.id === user.id);
    target.password = hashPassword(newPassword);
    saveUsers(users);
    json(res, 200, { ok: true });
    return true;
  }

  /* ---------- 全量数据 ---------- */
  if (path === '/api/bootstrap' && method === 'GET') {
    json(res, 200, buildBootstrap(user));
    return true;
  }

  const needEdit = () => {
    if (!canEdit(user)) {
      json(res, 403, { error: '你没有编辑权限' });
      return false;
    }
    return true;
  };
  const needAdmin = () => {
    if (!isAdmin(user)) {
      json(res, 403, { error: '只有管理员能做这个操作' });
      return false;
    }
    return true;
  };

  /* ---------- 人物 ---------- */
  if (path === '/api/people' && method === 'POST') {
    if (!needEdit()) return true;
    const body = await readBody(req);
    const name = str(body.name);
    if (!name) {
      json(res, 400, { error: '名字不能空着' });
      return true;
    }
    const role = body.role === 'teacher' ? 'teacher' : 'student';
    const people = getPeople();
    const person = {
      id: randomUUID(),
      name,
      role,
      group: str(body.group),
      tags: asArray(body.tags).map(str).filter(Boolean),
      note: str(body.note),
      createdAt: Date.now(),
    };
    people.push(person);
    savePeople(people);
    json(res, 200, { person });
    return true;
  }

  const peopleMatch = path.match(/^\/api\/people\/([^/]+)$/);
  if (peopleMatch) {
    if (!needEdit()) return true;
    const id = peopleMatch[1];
    const people = getPeople();
    const index = people.findIndex((p) => p.id === id);
    if (index < 0) {
      json(res, 404, { error: '找不到这个人' });
      return true;
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readBody(req);
      const person = people[index];
      if ('name' in body && str(body.name)) person.name = str(body.name);
      if ('role' in body) person.role = body.role === 'teacher' ? 'teacher' : 'student';
      if ('group' in body) person.group = str(body.group);
      if ('tags' in body) person.tags = asArray(body.tags).map(str).filter(Boolean);
      if ('note' in body) person.note = str(body.note);
      savePeople(people);
      json(res, 200, { person });
      return true;
    }
    if (method === 'DELETE') {
      people.splice(index, 1);
      savePeople(people);
      // 连带清掉这个人参与的关系
      saveLinks(getLinks().filter((l) => l.source !== id && l.target !== id));
      // 事件里的参与者引用也清掉
      saveEvents(
        getEvents().map((e) => ({
          ...e,
          participants: asArray(e.participants).filter((p) => p !== id),
        })),
      );
      json(res, 200, { ok: true });
      return true;
    }
  }

  /* ---------- 关系 ---------- */
  if (path === '/api/links' && method === 'POST') {
    if (!needEdit()) return true;
    const body = await readBody(req);
    const source = str(body.source);
    const target = str(body.target);
    if (!source || !target || source === target) {
      json(res, 400, { error: '关系的两端必须是两个不同的人' });
      return true;
    }
    if (!findPerson(source) || !findPerson(target)) {
      json(res, 400, { error: '关系里的人不存在' });
      return true;
    }
    const weight = Math.min(5, Math.max(1, Number(body.weight) || 1));
    const links = getLinks();
    const link = { id: randomUUID(), source, target, type: str(body.type) || '其他', weight };
    links.push(link);
    saveLinks(links);
    json(res, 200, { link });
    return true;
  }

  const linkMatch = path.match(/^\/api\/links\/([^/]+)$/);
  if (linkMatch) {
    if (!needEdit()) return true;
    const id = linkMatch[1];
    const links = getLinks();
    const index = links.findIndex((l) => l.id === id);
    if (index < 0) {
      json(res, 404, { error: '找不到这条关系' });
      return true;
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readBody(req);
      const link = links[index];
      if ('type' in body) link.type = str(body.type) || link.type;
      if ('weight' in body) link.weight = Math.min(5, Math.max(1, Number(body.weight) || link.weight));
      if ('source' in body && findPerson(str(body.source))) link.source = str(body.source);
      if ('target' in body && findPerson(str(body.target))) link.target = str(body.target);
      saveLinks(links);
      json(res, 200, { link });
      return true;
    }
    if (method === 'DELETE') {
      links.splice(index, 1);
      saveLinks(links);
      json(res, 200, { ok: true });
      return true;
    }
  }

  /* ---------- 事件 ---------- */
  if (path === '/api/events' && method === 'POST') {
    if (!needEdit()) return true;
    const body = await readBody(req);
    const title = str(body.title);
    if (!title) {
      json(res, 400, { error: '事件标题不能空着' });
      return true;
    }
    const event = {
      id: randomUUID(),
      date: str(body.date) || new Date().toISOString().slice(0, 10),
      title,
      detail: str(body.detail),
      participants: asArray(body.participants).map(str).filter((p) => findPerson(p)),
      createdBy: user.displayName || user.username,
      updatedAt: Date.now(),
    };
    const events = getEvents();
    events.push(event);
    saveEvents(events);
    json(res, 200, { event });
    return true;
  }

  const eventMatch = path.match(/^\/api\/events\/([^/]+)$/);
  if (eventMatch) {
    if (!needEdit()) return true;
    const id = eventMatch[1];
    const events = getEvents();
    const index = events.findIndex((e) => e.id === id);
    if (index < 0) {
      json(res, 404, { error: '找不到这个事件' });
      return true;
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readBody(req);
      const event = events[index];
      if ('date' in body) event.date = str(body.date) || event.date;
      if ('title' in body && str(body.title)) event.title = str(body.title);
      if ('detail' in body) event.detail = str(body.detail);
      if ('participants' in body) {
        event.participants = asArray(body.participants).map(str).filter((p) => findPerson(p));
      }
      event.updatedAt = Date.now();
      saveEvents(events);
      json(res, 200, { event });
      return true;
    }
    if (method === 'DELETE') {
      events.splice(index, 1);
      saveEvents(events);
      json(res, 200, { ok: true });
      return true;
    }
  }

  /* ---------- 账号管理（仅管理员） ---------- */
  if (path === '/api/users' && method === 'POST') {
    if (!needAdmin()) return true;
    const body = await readBody(req);
    const username = str(body.username);
    const password = String(body.password ?? '');
    const role = ROLES.includes(body.role) ? body.role : 'viewer';
    if (!/^[A-Za-z0-9_.-]{3,20}$/.test(username)) {
      json(res, 400, { error: '用户名 3~20 位，只能字母数字和 _ . -' });
      return true;
    }
    if (password.length < 4) {
      json(res, 400, { error: '密码至少 4 位' });
      return true;
    }
    const users = getUsers();
    if (users.some((u) => u.username === username)) {
      json(res, 400, { error: '这个用户名已经有人用了' });
      return true;
    }
    const created = {
      id: randomUUID(),
      username,
      password: hashPassword(password),
      role,
      displayName: str(body.displayName) || username,
      personId: str(body.personId) || null,
      createdAt: Date.now(),
    };
    users.push(created);
    saveUsers(users);
    json(res, 200, { user: publicUser(created) });
    return true;
  }

  const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch) {
    if (!needAdmin()) return true;
    const id = userMatch[1];
    const users = getUsers();
    const index = users.findIndex((u) => u.id === id);
    if (index < 0) {
      json(res, 404, { error: '找不到这个账号' });
      return true;
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readBody(req);
      const target = users[index];
      if ('role' in body && ROLES.includes(body.role)) {
        if (target.id === user.id && body.role !== 'admin') {
          json(res, 400, { error: '不能把自己降级，免得没人能管了' });
          return true;
        }
        target.role = body.role;
      }
      if ('displayName' in body) target.displayName = str(body.displayName) || target.username;
      if ('personId' in body) target.personId = str(body.personId) || null;
      if ('password' in body && String(body.password)) {
        if (String(body.password).length < 4) {
          json(res, 400, { error: '密码至少 4 位' });
          return true;
        }
        target.password = hashPassword(String(body.password));
      }
      saveUsers(users);
      json(res, 200, { user: publicUser(target) });
      return true;
    }
    if (method === 'DELETE') {
      if (id === user.id) {
        json(res, 400, { error: '不能删掉自己' });
        return true;
      }
      users.splice(index, 1);
      saveUsers(users);
      json(res, 200, { ok: true });
      return true;
    }
  }

  json(res, 404, { error: '没有这个接口' });
  return true;
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
ensureSeed();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type, authorization',
          'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        });
        res.end();
        return;
      }
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: '只支持 GET' });
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    json(res, 500, { error: `服务器出错：${String(err?.message ?? err)}` });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('班级图谱服务已启动');
  console.log(`  地址：http://0.0.0.0:${PORT}`);
  console.log(`  数据目录：${DATA_DIR}`);
  console.log(`  静态目录：${DIST_DIR}${existsSync(DIST_DIR) ? '' : ' （不存在，请先 npm run build）'}`);
});