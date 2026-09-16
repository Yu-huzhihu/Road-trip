/* 把 data.js + engine.js 依次内联进 template.html,产出单文件应用 index.html
 * 顺序要求:data.js 在前(定义 window.TRP_DATA),engine.js 在后(读取 window.TRP_DATA)
 */
const fs = require('fs');
const path = require('path');
const dir = __dirname;

const data = fs.readFileSync(path.join(dir, 'data.js'), 'utf8');
const engine = fs.readFileSync(path.join(dir, 'engine.js'), 'utf8');
let tpl = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');

const PLACEHOLDER = '/*__BUNDLE__*/';
if (tpl.indexOf(PLACEHOLDER) < 0) throw new Error('模板中缺少 ' + PLACEHOLDER + ' 占位符');

const bundle =
  '\n/* ================= 数据层 data.js ================= */\n' +
  data + '\n' +
  '/* ================= 规划引擎 engine.js ================= */\n' +
  engine + '\n';

const out = tpl.replace(PLACEHOLDER, bundle);
fs.writeFileSync(path.join(dir, 'index.html'), out, 'utf8');

/* ---------- 构建自检 ---------- */
const problems = [];

// 1) 未内联任何地图密钥
const leak = /(?:secret|apikey|api_key|access_key)\s*[:=]\s*['"][A-Za-z0-9\-_]{16,}['"]/i.test(out);
if (leak) problems.push('可能存在明文地图密钥');

// 2) 代理占位符必须保留(由宿主注入)
const portKept = out.indexOf('__WB_HTTP_PORT__') > 0;
const secretKept = out.indexOf('__WB_TMAP_SECRET__') > 0;
if (!portKept || !secretKept) problems.push('腾讯地图代理占位符 __WB_HTTP_PORT__ / __WB_TMAP_SECRET__ 丢失');

// 3) 内联代码语法必须正确(用 Function 编译,不执行)
try { new Function('window', 'document', 'navigator', 'location', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'globalThis', data + '\n' + engine); }
catch (e) { problems.push('内联脚本语法错误: ' + e.message); }

// 4) 占位符必须已被替换干净
if (out.indexOf(PLACEHOLDER) >= 0) problems.push('占位符未被替换');

console.log('✅ 已生成 index.html,大小 ' + (out.length / 1024).toFixed(1) + ' KB');
console.log('   内联: data.js ' + (data.length / 1024).toFixed(1) + ' KB + engine.js ' + (engine.length / 1024).toFixed(1) + ' KB');
console.log('   合规检查:' + (leak ? '⚠️ 发现疑似密钥' : '通过,未内联地图密钥') +
  ' | 代理占位符保留:' + (portKept && secretKept ? '是' : '否'));
if (problems.length) {
  console.log('⚠️ 构建问题:'); problems.forEach(function (p) { console.log('   - ' + p); });
  process.exit(1);
}
console.log('✅ 构建自检全部通过');
