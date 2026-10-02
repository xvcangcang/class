import { readFileSync } from 'node:fs';
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
 * base 用相对路径，构建产物可丢进任意子目录托管。
 * 开发期把 /api 代理到本地 Node 服务（127.0.0.1:8787），前后端同源。
 */
export default defineConfig({
  base: './',
  plugins: [versionMetaPlugin()],
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
  },
});
