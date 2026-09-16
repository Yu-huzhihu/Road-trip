const TRP = require('./engine.js');

let fails = 0;
function ok(cond, label) {
  if (!cond) fails++;
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + label);
}

console.log('\n=== 1. 地点解析 ===');
[['北京·天通苑'], ['天通苑'], ['北京 望京'], ['兵马俑'], ['西安兵马俑'], ['杭州·西湖'],
 ['上海张江'], ['九寨沟'], ['厦门'], ['西湖'], ['北京·火星小区']].forEach(p => {
  const l = TRP.parsePlace(p[0]);
  console.log('  ' + p[0].padEnd(12) + '→  ' + (l ? (l.label + ' | ' + l.type + ' | 到火车站 ' + l.hubKm + 'km | 到客运站 ' + l.busKm + 'km') : 'null'));
});
ok(TRP.parsePlace('北京·天通苑').place === '天通苑', '精确到小区:北京·天通苑');
ok(TRP.parsePlace('天通苑').city === '北京', '只有小区名也能识别出城市');
ok(TRP.parsePlace('兵马俑').place === '兵马俑', '景区名可全局识别');
ok(TRP.parsePlace('杭州').isCity === true, '只写城市名 → 城市级地点');
ok(TRP.parsePlace('火星基地') === null, '不存在的名字返回 null');
ok(TRP.parsePlace('北京·火星小区').assumed === true, '城市存在但小区未收录 → 标记为估算(assumed)');
const unk = TRP.locationFromUnknown('北京', '火星小区', 'suburb');
ok(unk.hubKm === 20 && unk.busKm === 18, '未收录小区按位置类型估算接驳(近郊 20km)');

function leg(a, b, ctx) {
  return TRP.decideLeg(TRP.parsePlace(a), TRP.parsePlace(b), Object.assign({
    preference: 'balanced', departHour: 9, dateTags: [], userTags: [], rp: 'transit'
  }, ctx || {}));
}

console.log('\n=== 2. 六条决策规则 ===');
let L = leg('北京·天通苑', '天津·五大道');
console.log('  [短途+小区] 命中 ' + L.ruleIds.join(',') + ' → 推荐 ' + L.options[0].label +
  ' ¥' + L.options[0].cost + ' 门到门 ' + TRP.fmtDuration(L.options[0].minutes));
console.log('    理由: ' + L.options[0].reason);
console.log('    购票: ' + L.options[0].tickets);
ok(L.ruleIds.indexOf('R1') >= 0, '规则1 命中(108km < 300km)');
ok(L.ruleIds.indexOf('R2') >= 0, '规则2 命中(天通苑离火车站 16km)');
ok(['bus', 'charter'].indexOf(L.options[0].mode) >= 0, '推荐大巴/定制客运,而不是火车');

L = leg('北京', '上海');
console.log('  [长途] 命中 ' + L.ruleIds.join(',') + ' → 推荐 ' + L.options[0].label + ' ¥' + L.options[0].cost + ' 门到门 ' + TRP.fmtDuration(L.options[0].minutes));
console.log('    理由: ' + L.options[0].reason);
console.log('    购票: ' + L.options[0].tickets);
ok(L.ruleIds.indexOf('R6') >= 0, '规则6 命中(1067km 且两端有高铁站)');
ok(['g', 'd'].indexOf(L.options[0].mode) >= 0, '推荐高铁/动车');

L = leg('北京·天通苑', '天津·五大道', { departHour: 1 });
ok(L.ruleIds.indexOf('R3') >= 0, '规则3 命中(凌晨 1 点)');
console.log('  [凌晨1点] 推荐 ' + L.options[0].label + ' · ' + L.options[0].reason);

L = leg('北京·天通苑', '天津·五大道', { userTags: ['行李多', '带小孩'] });
ok(L.ruleIds.indexOf('R4') >= 0, '规则4 命中(行李多/带小孩)');
console.log('  [带娃+行李多] 推荐 ' + L.options[0].label + ' · ' + L.options[0].reason);
console.log('    接驳方式: ' + L.options[0].relayA.mode + ' ' + TRP.fmtDuration(L.options[0].relayA.minutes) + ' ¥' + L.options[0].relayA.cost);

L = leg('北京·天通苑', '天津·五大道', { dateTags: ['春运'] });
ok(L.ruleIds.indexOf('R5') >= 0, '规则5 命中(春运)');
console.log('  [春运] ' + L.options[0].reason);

L = leg('西安', '西安·兵马俑');
console.log('  [景区端点] 命中 ' + L.ruleIds.join(',') + ' → 推荐 ' + L.options[0].label + ' ¥' + L.options[0].cost);
console.log('    理由: ' + L.options[0].reason);
ok(L.ruleIds.indexOf('R2') >= 0, '规则2 命中(兵马俑在景区、离火车站 43km)');

L = leg('成都', '九寨沟·九寨沟景区');
console.log('  [无铁路] 推荐 ' + L.options[0].label + ' ¥' + L.options[0].cost + ' · ' + L.options[0].reason);

console.log('\n=== 3. 偏好切换对每段推荐的影响(北京·天通苑 → 南京·夫子庙) ===');
['balanced', 'speed', 'direct', 'cheap', 'comfort'].forEach(p => {
  const l = leg('北京·天通苑', '南京·夫子庙', { preference: p });
  console.log('  偏好=' + p.padEnd(9) + ' → ' + l.options[0].label.padEnd(20) +
    ' ¥' + String(l.options[0].cost).padStart(4) + ' 门到门 ' + TRP.fmtDuration(l.options[0].minutes).padEnd(12) +
    ' 换乘 ' + l.options[0].transfers + ' | 备选 ' + l.options.length + ' 种');
});

console.log('\n=== 4. 门到门明细 ===');
L = leg('北京·天通苑', '南京·夫子庙');
L.options.forEach(o => {
  console.log('  ' + (o.recommended ? '*' : ' ') + o.label.padEnd(20) + ' ¥' + String(o.cost).padStart(4) +
    ' 门到门 ' + TRP.fmtDuration(o.minutes).padEnd(12) + '[接驳 ' + o.relayA.mode + '/' + o.relayB.mode +
    ' + 候车 ' + o.wait + '分 + 在途 ' + TRP.fmtDuration(o.intercityMinutes) + ']' + (o.transfers ? ' 需在' + o.hub + '换乘' : ' 直达'));
});

console.log('\n=== 5. 必去景点 + 完整规划(北京·天通苑 → 成都·天府三街) ===');
const res = TRP.plan({
  from: '北京·天通苑', to: '成都·天府三街',
  mustVisit: ['西安·兵马俑', '九寨沟·九寨沟景区'],
  preference: 'speed', departHour: 8, userTags: [], dateTags: [], maxRatio: 1.5
});
console.log('  ' + res.note);
res.routes.forEach(r => {
  const names = [r.fromLabel].concat(r.chain.map(c => c.c.n + (c.place ? '·' + c.place.n : ''))).concat([r.toLabel]);
  console.log('  · ' + r.title + ' | ¥' + r.cost + ' | ' + TRP.fmtDuration(r.minutes) + ' | ' + r.km + 'km | 换乘 ' + r.transfers);
  console.log('      ' + names.join(' → '));
  r.segments.forEach(s => {
    const o = s.options.find(x => x.mode === s.chosen);
    console.log('      ' + s.from.label.padEnd(18) + '→ ' + s.to.label.padEnd(18) + o.label + ' ¥' + o.cost + ' ' + TRP.fmtDuration(o.minutes));
  });
});
ok(res.routes.some(r => r.chain.some(c => c.place && c.place.n === '兵马俑')), '必去景点「西安·兵马俑」已进入路线');
ok(res.routes.some(r => r.chain.some(c => c.place && c.place.n === '九寨沟景区')), '必去景点「九寨沟景区」已进入路线');

console.log('\n=== 5.1 同城:精确到小区的市内方案 ===');
const same = TRP.plan({ from: '北京·天通苑', to: '北京·望京', preference: 'balanced' });
same.routes.forEach(r => {
  console.log('  · ' + r.title + ' | ¥' + r.cost + ' | ' + TRP.fmtDuration(r.minutes));
  r.segments.forEach(s => {
    s.options.forEach(o => console.log('      ' + (o.recommended ? '*' : ' ') + o.label.padEnd(14) + ' ¥' + String(o.cost).padStart(3) + ' ' + TRP.fmtDuration(o.minutes) + ' · ' + o.reason));
  });
});
ok(same.routes.length === 1 && same.routes[0].family === 'local', '同城两个地点 → 给出市内点对点方案');
ok(same.routes[0].segments[0].options.length >= 3, '市内方案含地铁/打车/拼车等选择');
const sameCity = TRP.plan({ from: '北京·天通苑', to: '北京', preference: 'comfort', userTags: ['行李多'] });
console.log('  [带行李·舒适] ' + sameCity.routes[0].segments[0].options[0].label +
  ' ¥' + sameCity.routes[0].segments[0].options[0].cost);
ok(sameCity.routes[0].segments[0].options[0].mode === 'taxi', '带行李+舒适偏好 → 推荐打车');
const sameCity2 = TRP.plan({ from: '北京·天通苑', to: '北京·望京', preference: 'cheap' });
ok(sameCity2.routes[0].segments[0].options[0].mode === 'metro', '省钱偏好 → 推荐地铁/公交');

console.log('\n=== 6. 边界与回归 ===');
const cases = [
  ['北京', '上海'], ['成都', '西安'], ['广州', '北京'], ['拉萨', '上海'],
  ['杭州', '黄山'], ['苏州', '无锡'], ['三亚', '哈尔滨'], ['深圳', '中国香港'],
  ['厦门', '中国台北'], ['北京', '北京'], ['拉萨', '喀什'],   ['北京·天通苑', '北京·望京'], ['北京', '北京'],
  ['上海·五角场', '杭州·滨江'], ['重庆·大学城', '成都·犀浦'], ['北京·天通苑', '天津·五大道']
];
const t0 = Date.now();
cases.forEach(c => {
  try {
    const r = TRP.plan({ from: c[0], to: c[1], maxRatio: 1.4 });
    const rk = TRP.rank(r.routes);
    const ch = r.routes.find(x => x.id === rk.championId);
    console.log('  ' + (c[0] + ' → ' + c[1]).padEnd(26) + ' 方案 ' + r.routes.length +
      ' | 冠军 ' + (ch ? ch.title + ' ¥' + ch.cost : '无') +
      ' | 最省时 ' + (r.routes.length ? Math.min.apply(null, r.routes.map(x => x.minutes)) + '分' : '-'));
    r.routes.forEach(x => {
      if (!isFinite(x.cost) || (!(x.cost >= 0))) { fails++; console.log('    [WARN] 费用异常 ' + x.title); }
      if (x.family !== 'local' && x.cost <= 0) { fails++; console.log('    [WARN] 费用应大于 0 ' + x.title); }
      x.segments.forEach(s => {
        if (!s.options.length) { fails++; console.log('    [WARN] 空段'); }
        if (!s.options.some(o => o.mode === s.chosen)) { fails++; console.log('    [WARN] chosen 不在选项中'); }
        s.options.forEach(o => { if (!isFinite(o.cost) || !isFinite(o.minutes)) { fails++; console.log('    [WARN] 选项数值异常 ' + o.label); } });
      });
    });
  } catch (e) { fails++; console.log('  [FAIL] ' + c[0] + '→' + c[1] + ' 报错: ' + e.message); }
});
console.log('  ' + cases.length + ' 组用例总耗时 ' + (Date.now() - t0) + 'ms');

console.log('\n=== 7. 交互等价:改交通方式后重算 ===');
const r2 = TRP.plan({ from: '北京·回龙观', to: '上海·张江' });
const rt = r2.routes[1];
const seg = rt.segments[0];
const before = rt.cost;
const alt = seg.options.find(o => o.mode !== seg.chosen);
seg.chosen = alt.mode;
TRP.recompute(rt);
console.log('  把「' + rt.title + '」首段改成 ' + alt.label + ':¥' + before + ' → ¥' + rt.cost + '(门到门 ' + TRP.fmtDuration(rt.minutes) + ')');
const rk2 = TRP.rank(r2.routes);
console.log('  重新排名后冠军 = ' + rk2.championId + ',领先次优 ¥' + rk2.championSave);
ok(isFinite(rt.cost) && rt.cost > 0, '切换后费用仍然有效');

console.log('\n' + (fails === 0 ? '全部检查通过' : '失败 ' + fails + ' 项'));
process.exit(fails === 0 ? 0 : 1);
