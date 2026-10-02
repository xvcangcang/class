# =============================================================================
# 班级图谱 —— 单容器 Web 应用
#
# 为什么需要它：本项目后端是「零依赖 Node 服务」（只用 node:http），
# PocketBay 的自动识别会因为没有使用 Express/Koa 等框架而把它当成纯静态站点，
# 于是只起了 nginx、不跑接口。用一个显式 Dockerfile 让平台按 node 方式启动，
# 前后端在同一个进程、同一个域名下。
# =============================================================================

# ---------- 构建阶段：装依赖 + 打包前端 ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---------- 运行阶段：只带构建产物 + 服务端代码 ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# 数据落在持久卷里，跨更新保留
ENV POCKETBAY_DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./package.json

EXPOSE 3000
CMD ["node", "server/index.mjs"]