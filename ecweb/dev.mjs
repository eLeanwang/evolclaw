/**
 * ecweb 开发监听：初次全量 build，之后监听 src/ 变化自动重建。
 * 跨平台、无额外依赖。Ctrl+C 退出。
 *
 * 注意：本脚本只负责把 src/ 编译/拷贝到 dist/。
 * 网页服务仍需另开终端运行 `ec watch web`（它从 ecweb/dist/static 读页面）。
 * 改完文件本脚本会自动重建 dist，浏览器刷新即可看到最新页面。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'src');

function build() {
  const t = new Date().toLocaleTimeString();
  try {
    const tscBin = path.join(here, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [tscBin], { cwd: here, stdio: 'inherit' });
    fs.cpSync(path.join(here, 'src', 'static'), path.join(here, 'dist', 'static'), { recursive: true });
    // 自动更新 dist/static/index.html 里的构建时间戳
    const htmlPath = path.join(here, 'dist', 'static', 'index.html');
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, 'utf8').replace(/(\<span class="build-ts"[^>]*\>)[^<]+(\<\/span\>)/, `$1${ts}$2`));
    console.log(`[${t}] ✓ build 完成 → dist/`);
  } catch {
    console.log(`[${t}] ✗ build 失败（见上方 tsc 报错）`);
  }
}

console.log('ecweb dev：初次构建…');
build();

let timer = null;
fs.watch(srcDir, { recursive: true }, (_evt, filename) => {
  if (!filename) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`↻ 检测到变化：${filename}`);
    build();
  }, 200);
});

console.log('正在监听 src/ … 修改后自动重建。Ctrl+C 退出。');
