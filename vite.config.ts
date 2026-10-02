import { copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * 版本号只在 package.json 里写一次，构建时注入。
 * 用 fs 读而不是 `import pkg from './package.json'`，省得为配置文件单独开 resolveJsonModule。
 */
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

/**
 * 把版本号与构建时刻写进 index.html 的 meta。
 * Vite 的 dev 模式有时不会替换 define 的常量，transformIndexHtml 在 dev / build 都会执行，最稳。
 */
function versionMetaPlugin(): Plugin {
  const stamp = new Date().toISOString();
  return {
    name: 'app-version-meta',
    transformIndexHtml(html: string): string {
      return html.replace(
        '    <title>',
        `    <meta name="app-version" content="${pkg.version}" />\n` +
          `    <meta name="app-build" content="${stamp}" />\n` +
          '    <title>',
      );
    },
  };
}

/**
 * 构建结束后把 app.html 复制一份为 index.html。
 * 用插件而不是 `vite build && cp ...`：平台解析启动命令时会认错链式命令里的 cp。
 */
function copyAppHtmlPlugin(): Plugin {
  return {
    name: 'copy-app-html-to-index',
    apply: 'build',
    closeBundle() {
      copyFileSync(
        fileURLToPath(new URL('./dist/app.html', import.meta.url)),
        fileURLToPath(new URL('./dist/index.html', import.meta.url)),
      );
    },
  };
}

/**
 * base 用相对路径，构建产物可丢进任意子目录托管。
 * 开发期把 /api 代理到本地 Node 服务（127.0.0.1:8787），前后端同源。
 */
export default defineConfig({
  base: './',
  plugins: [versionMetaPlugin(), copyAppHtmlPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
    /**
     * 入口 HTML 故意不叫 index.html、也不放在仓库根目录 —— PocketBay 的
     * framework 识别里「根目录 index.html」会被判成纯静态站点（只起 nginx、不跑接口）。
     * 改叫 app.html 之后平台才会按 package.json 的 start 脚本识别成 node 服务。
     * 构建产物里再复制一份 index.html，方便静态托管和本地直接访问。
     */
    rollupOptions: {
      input: fileURLToPath(new URL('./app.html', import.meta.url)),
    },
  },
});
