/* DOM 冒烟测试:用 jsdom 加载单文件应用 index.html,验证渲染与交互
 * 覆盖:初始渲染 / 六条规则的界面呈现 / 景点勾选 / 小区级地点 / 同城方案 / 方式切换重算
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
const doc = window.document;

const errors = [];
window.addEventListener('error', e => errors.push('window error: ' + e.message));
window.console.error = (...a) => { errors.push('console.error: ' + a.join(' ')); };

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) pass++; else fail++;
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond ? '' : '  <<< 失败'));
};
const $ = s => doc.querySelector(s);
const $$ = s => Array.from(doc.querySelectorAll(s));
const txt = s => ($(s) ? $(s).textContent.trim() : '');

function planTo(from, to) {
  doc.getElementById('from').value = from;
  doc.getElementById('to').value = to;
  doc.getElementById('goBtn').click();
}
function chipsOf(group) { return $$('#' + group + ' .chip'); }
function clickChip(group, label) {
  const c = chipsOf(group).filter(x => x.textContent.trim() === label)[0];
  if (c) c.click();
  return !!c;
}
function ruleTags() { return $$('#cards .rule-tag').map(e => e.textContent.trim()); }
function hasRule(n) { return ruleTags().some(t => t.indexOf(n) === 0); }
function firstModeOf(c) { return c.querySelector('.seg .pick .mode-name').textContent.trim(); }

setTimeout(() => {
  /* ---------------- 1. 初始渲染 ---------------- */
  console.log('\n【1. 初始渲染】北京·天通苑 → 上海·张江');
  const cards = $$('#cards .card');
  ok(cards.length >= 3, '生成路线卡片 ' + cards.length + ' 张');
  ok($$('#cards .card.champ').length === 1, '恰有 1 张冠军卡片');
  const champ = $('#cards .card.champ');
  ok(!!champ && !!champ.querySelector('.ribbon'), '冠军卡片带「最经济之选」角标');
  if (champ) {
    ok(/¥[\d,]+/.test(champ.querySelector('.metrics b').textContent), '冠军卡片显示费用 ' + champ.querySelector('.metrics b').textContent);
    ok(champ.querySelectorAll('.metrics .m').length >= 6, '指标区含费用/时间/换乘/里程/绕行/游玩 6 项');
    ok(/最经济|多城方案/.test(champ.querySelector('.saving').textContent), '有省钱说明:' + champ.querySelector('.saving').textContent.trim().slice(0, 34));
    ok(champ.querySelectorAll('.node .pin').length === champ.querySelectorAll('.node').length, '每个节点都有起/停/终标记');
    ok(champ.querySelectorAll('.seg').length >= 1, '每段交通都有独立区块 ' + champ.querySelectorAll('.seg').length + ' 段');
  }
  const seg0 = $('#cards .card.champ .seg');
  ok(!!seg0, '存在分段交通区块');
  if (seg0) {
    ok(/km/.test(seg0.querySelector('.seg-head .km').textContent), '分段标注了里程:' + seg0.querySelector('.seg-head .km').textContent.trim());
    ok(seg0.querySelector('.pick .reason').textContent.length > 12, '有推荐理由:' + seg0.querySelector('.pick .reason').textContent.trim().slice(0, 28) + '…');
    ok(seg0.querySelectorAll('.d2d .piece').length >= 3, '门到门明细含接驳/候车/在途等 ' + seg0.querySelectorAll('.d2d .piece').length + ' 项');
    ok(/🎫/.test(seg0.querySelector('.tickets').textContent), '有购票建议:' + seg0.querySelector('.tickets').textContent.trim().slice(0, 30) + '…');
    ok(seg0.querySelectorAll('.alts .mode').length >= 2, '该段可切换交通方式 ' + seg0.querySelectorAll('.alts .mode').length + ' 种');
    ok(seg0.querySelectorAll('.alts .mode.cheap').length >= 1, '标出了该段最便宜的方式(浅金色)');
    ok(seg0.querySelectorAll('.alts .mode.sel').length === 1, '标出了当前选中的方式');
    ok(seg0.querySelectorAll('.d2d .piece.sum').length === 1, '门到门小计只有一条');
  }
  ok(ruleTags().length >= 1, '命中并展示决策规则标签:' + ruleTags().join(' / ').slice(0, 60));
  ok($$('#chart .chart-row').length === cards.length, '对比图行数与卡片数一致(' + $$('#chart .chart-row').length + ')');
  ok($$('#chart .bar.gold').length === 1, '对比图中恰有 1 条金色最省条');
  ok(txt('#chart .chart-foot').indexOf('参考') === 0, '对比图给出「完全不停留」的参考价');
  ok($('#mapLegend').innerHTML.length > 20, '图例已渲染');
  ok($('#axisFallback').classList.contains('on') && $('#axisSvg').innerHTML.length > 100, '无地图 SDK 时自动切到离线里程示意图');
  ok($('#axisSvg').innerHTML.indexOf('起点') >= 0 || /km/.test($('#axisSvg').innerHTML), '里程示意图画出了节点');
  ok($$('#placeList option').length > 100, '输入联想候选 ' + $$('#placeList option').length + ' 条');
  ok($$('#spotList .spot-item').length > 20, '景点库加载 ' + $$('#spotList .spot-item').length + ' 个可勾选景点');
  ok(txt('#listHint').indexOf('门到门') >= 0, '列表提示:' + txt('#listHint').slice(0, 40));
  ok(/到火车站约 \d+ km/.test($('#fromInfo').textContent) && /到客运站约 \d+ km/.test($('#fromInfo').textContent),
    '出发地卡片给出接驳距离:' + $('#fromInfo').textContent.replace(/\s+/g, ' ').trim().slice(0, 46));

  /* ---------------- 2. 六条规则的界面呈现 ---------------- */
  console.log('\n【2. 交通决策规则的界面呈现】');
  planTo('北京·天通苑', '天津·五大道');
  let tags = ruleTags();
  const firstMode = txt('#cards .card .seg .pick .mode-name');
  ok(hasRule('①'), '短途(<300km)命中规则1:' + tags.join(' / '));
  ok(/大巴|定制客运|城际|公交/.test(firstMode), '短途推荐的是大巴类而非火车:' + firstMode);
  ok(!/普速|高铁|动车/.test(firstMode), '没有把短途默认推成火车硬座');
  ok(/站外|上门接|直接开进市区|直插市区/.test(txt('#cards .card .seg .pick .reason')), '理由提到了大巴的优势:' + txt('#cards .card .seg .pick .reason').slice(0, 40) + '…');
  ok(/巴士管家|定制客运|汽车站|站外上车点/.test(txt('#cards .card .seg .tickets')), '购票建议指向大巴渠道');

  planTo('北京', '上海');
  tags = ruleTags();
  const directCard = $$('#cards .card').filter(c => c.querySelector('h3').textContent.indexOf('极速直达') >= 0)[0];
  const longMode = directCard ? firstModeOf(directCard) : '';
  ok(!!directCard, '存在「极速直达」的对照方案');
  ok(hasRule('⑥'), '长距离(>400km、两端有高铁站)命中规则6:' + tags.slice(0, 8).join(' / ') + ' …');
  ok(/高铁|动车/.test(longMode), '长途直达推荐高铁/动车:' + longMode);

  planTo('北京', '天津');
  const sel = doc.getElementById('departHour');
  sel.value = '1';
  sel.dispatchEvent(new window.Event('change'));
  ok(hasRule('③'), '凌晨出发命中规则3:' + ruleTags().join(' / '));
  sel.value = '';
  sel.dispatchEvent(new window.Event('change'));

  planTo('北京', '上海');
  ok(clickChip('tagChips', '带小孩'), '勾选「带小孩」');
  ok(hasRule('④'), '带小孩命中规则4:' + ruleTags().join(' / '));
  clickChip('tagChips', '带小孩');
  planTo('北京', '上海');
  ok(clickChip('tagChips', '春运'), '勾选「春运」');
  ok(hasRule('⑤'), '春运命中规则5:' + ruleTags().join(' / '));
  clickChip('tagChips', '春运');

  planTo('北京', '九寨沟');
  ok(hasRule('②') || hasRule('①'), '景区端点命中规则2/1:' + ruleTags().join(' / '));
  ok($('#toInfo').textContent.indexOf('火车站') >= 0, '景区目的地卡片说明了到火车站的距离');

  /* ---------------- 3. 交互 ---------------- */
  console.log('\n【3. 交互】');
  planTo('北京·天通苑', '南京·夫子庙');
  const card = $('#cards .card.champ');
  const before = card.querySelector('.metrics b').textContent;
  const alt = Array.from(card.querySelectorAll('.alts .mode')).filter(m => !m.classList.contains('sel'))[0];
  const altLabel = alt.textContent.trim();
  alt.click();
  const after = doc.querySelector('#cards .card[data-id="' + card.dataset.id + '"] .metrics b').textContent;
  ok(before !== after, '切换交通方式后总价重算:' + before + ' → ' + after + '(' + altLabel + ')');
  ok($('#toast').classList.contains('on') && $('#toast').textContent.indexOf('已换成') >= 0, '切换后有提示:' + $('#toast').textContent.trim().slice(0, 30));
  ok($$('#cards .card.champ').length === 1, '重算后仍恰有 1 张冠军卡片');
  ok($$('#cards .seg .alts .mode.sel').length === $$('#cards .seg').length, '每段都恰好选中一种方式');

  const p0 = $('#cards .card.champ .metrics b').textContent;
  ok(clickChip('prefChips', '时间最短'), '切到「时间最短」偏好');
  ok($$('#cards .card').length >= 1, '偏好切换后仍有结果,冠军 ' + $('#cards .card.champ .metrics b').textContent + '(原 ' + p0 + ')');
  ok(clickChip('prefChips', '综合推荐'), '切回「综合推荐」');

  const search = doc.getElementById('spotSearch');
  search.value = '兵马俑';
  search.dispatchEvent(new window.Event('input'));
  const hit = $$('#spotList .spot-item').filter(b => b.textContent.trim() === '兵马俑')[0];
  ok(!!hit, '景点搜索「兵马俑」有结果');
  if (hit) {
    hit.click();
    ok($('#pickedSpots').textContent.indexOf('兵马俑') >= 0, '已选景点区显示「西安·兵马俑」');
    ok($('#cards').textContent.indexOf('兵马俑') >= 0, '路线已把兵马俑串进去');
    ok($('#routeNote').textContent.indexOf('已强制途经') >= 0, '顶部说明标注了强制途经:' + $('#routeNote').textContent.slice(0, 40) + '…');
    $$('#pickedSpots .pk')[0].click();
    ok($('#pickedSpots').textContent.indexOf('兵马俑') < 0, '再点一次可取消该景点');
  }

  planTo('上海·五角场', '杭州·滨江');
  ok($$('#cards .card').length >= 1, '小区 → 小区仍能规划(' + $$('#cards .card').length + ' 条方案)');

  console.log('\n【4. 未收录的精确地址】');
  planTo('北京·火星小区', '天津·五大道');
  ok($$('#fromInfo .area-btns button').length === 5, '未收录地址给出 5 档位置类型供选择');
  const areaBtns = $$('#fromInfo .area-btns button');
  const beforeKm = $('#fromInfo').textContent.match(/到火车站约 (\d+) km/);
  const scenicBtn = areaBtns.filter(b => b.textContent.trim() === '景区')[0];
  if (scenicBtn) scenicBtn.click();
  const afterKm = $('#fromInfo').textContent.match(/到火车站约 (\d+) km/);
  ok(beforeKm && afterKm && beforeKm[1] !== afterKm[1], '改位置类型后接驳距离随之变化:' + (beforeKm ? beforeKm[1] : '?') + 'km → ' + (afterKm ? afterKm[1] : '?') + 'km');
  ok($$('#cards .card').length >= 1, '选完类型仍能出结果');
  ok($('#cards').textContent.indexOf('¥') >= 0, '结果里有有效报价');

  console.log('\n【5. 同城方案】');
  planTo('北京·天通苑', '北京·望京');
  const localCard = $('#cards .card');
  ok(!!localCard, '同城也能给方案');
  if (localCard) {
    ok(/同城点对点 · (\d+(\.\d+)?) km/.test(localCard.querySelector('h3').textContent), '同城标题带市内里程:' + localCard.querySelector('h3').textContent.trim());
    const kmNum = parseFloat((localCard.querySelector('h3').textContent.match(/· ([\d.]+) km/) || [0, 0])[1]);
    ok(kmNum > 1, '市内里程不是 0 km(实际 ' + kmNum + ' km)');
    ok(/地铁|打车|拼车|步行/.test(firstModeOf(localCard)), '给出的是市内交通方式:' + firstModeOf(localCard));
    ok(localCard.querySelectorAll('.seg .alts .mode').length >= 2, '市内也有地铁/打车/拼车可选');
  }

  planTo('北京·天通苑', '北京·天通苑');
  ok($('#cards').textContent.indexOf('同一个地点') >= 0, '起终点相同时给出友好提示');

  console.log('\n【6. 交换与文案】');
  planTo('广州', '北京');
  doc.getElementById('swapBtn').click();
  ok($('#routeTitle').textContent.indexOf('北京') === 0, '交换起终点后标题反转:' + $('#routeTitle').textContent.trim().slice(0, 24));
  const brief = $('#cards').textContent;
  ok(!/\bNaN\b|undefined|Infinity|¥0\b/.test(brief) ||
    /同城/.test(brief), '渲染结果里没有 NaN / undefined / Infinity / 零元费用');

  /* ---------------- 7. 地图看门狗(3 秒后仍无底图 → 自动降级) ---------------- */
  setTimeout(() => {
    console.log('\n【7. 地图看门狗(3 秒后复查)】');
    ok($('#map').style.display === 'none', '拿不到地图底图时已隐藏地图容器');
    ok($('#axisFallback').classList.contains('on'), '降级为里程示意图');
    ok($('#axisSvg').innerHTML.length > 100, '里程示意图在降级后仍有内容');
    ok($$('#cards .card').length >= 1, '降级不影响路线卡片渲染');

    console.log('\n【运行期错误】' + (errors.length ? '' : ' 无'));
    errors.slice(0, 6).forEach(e => console.log('  ⚠️ ' + e));
    if (errors.length) fail += errors.length;

    console.log('\n结果:' + pass + ' 项通过,' + fail + ' 项失败');
    console.log(fail ? '❌ 存在失败项' : '✅ 全部 DOM 检查通过');
    if (fail) process.exitCode = 1;
  }, 3600);
}, 600);
