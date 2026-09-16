/* ============================================================
 * engine.js —— 顺路旅行路线规划引擎(精确地点版)
 * 依赖 data.js(城市/车站/走廊/精确地点)
 *   浏览器:  window.TRP_DATA ; Node: require('./data.js')
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./data.js'));
  } else {
    root.TRP = factory(root.TRP_DATA);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DATA) {
  'use strict';

  const CITIES = DATA.CITIES;
  const BY_NAME = DATA.BY_NAME;
  const HUBS = DATA.HUBS;
  const AREA_TYPES = DATA.AREA_TYPES;
  const INTERESTS = DATA.INTERESTS;

  /* ---------------------------------------------------------
   * 1. 基础几何
   * --------------------------------------------------------- */
  const EARTH_R = 6371;
  const rad = function (d) { return d * Math.PI / 180; };

  function haversine(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const la1 = rad(a.lat), la2 = rad(b.lat);
    const h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(la1) * Math.cos(la2) * Math.pow(Math.sin(dLng / 2), 2);
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function axisMetrics(a, b, c) {
    const cosL = Math.cos(rad((a.lat + b.lat) / 2));
    const ax = a.lng * cosL, ay = a.lat, bx = b.lng * cosL, by = b.lat;
    const cx = c.lng * cosL, cy = c.lat;
    const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
    if (len2 === 0) return { t: 0, off: 0 };
    const t = ((cx - ax) * vx + (cy - ay) * vy) / len2;
    const px = ax + t * vx, py = ay + t * vy;
    return { t: t, off: Math.sqrt(Math.pow(cx - px, 2) + Math.pow(cy - py, 2)) * 111.19 };
  }

  /* ---------------------------------------------------------
   * 2. 地点解析:支持「北京·天通苑」「上海 张江」「兵马俑」等写法
   * --------------------------------------------------------- */
  const CITY_NAMES = CITIES.map(function (c) { return c.n; }).sort(function (a, b) { return b.length - a.length; });

  function norm(s) {
    return String(s).replace(/[\s·・、,，\-—/]/g, '').replace(/[（(].*?[)）]/g, '');
  }

  function cityLevelLocation(city) {
    return {
      city: city.n, place: null, label: city.n + '(市区)',
      lat: city.lat, lng: city.lng, km: 0, type: '市中心', areaKind: 'core',
      hubKm: city.hsr ? Math.max(3, city.hsrStationKm)
        : (city.rail ? Math.max(2, city.railStationKm || 3) : 150),
      busKm: 2, railDirect: true, note: city.busStation ? ('客运站:' + city.busStation) : '',
      isCity: true, c: city
    };
  }

  function spotLocation(city, p) {
    return {
      city: city.n, place: p.n, label: city.n + '·' + p.n,
      lat: city.lat, lng: city.lng, km: p.km, type: p.type,
      areaKind: (AREA_TYPES[p.type] || { kind: 'area' }).kind,
      hubKm: p.hubKm, busKm: p.busKm, railDirect: p.railDirect, note: p.note,
      isCity: false, c: city
    };
  }

  function parsePlace(text, areaKind) {
    if (!text) return null;
    const raw = String(text).trim();
    const t = norm(raw);
    if (!t) return null;

    // 1) 城市名开头 + 具体地点
    for (let i = 0; i < CITY_NAMES.length; i++) {
      const cn = CITY_NAMES[i];
      if (t.indexOf(cn) === 0) {
        const city = BY_NAME[cn];
        const rest = t.slice(cn.length);
        if (!rest) return cityLevelLocation(city);
        let hit = null;
        for (let j = 0; j < city.places.length; j++) {
          const p = city.places[j];
          const pn = norm(p.n);
          if (pn === rest || pn.indexOf(rest) === 0 || rest.indexOf(pn) === 0) { hit = p; break; }
        }
        if (!hit) {
          for (let j = 0; j < city.places.length; j++) {
            const p = city.places[j];
            const pn = norm(p.n);
            if (pn.indexOf(rest) >= 0 || rest.indexOf(pn) >= 0) { hit = p; break; }
          }
        }
        if (hit) return spotLocation(city, hit);
        // 城市存在但这个具体地名没收录 → 按位置类型估算,并标记出来提醒用户
        return locationFromUnknown(cn, rest, areaKind || 'area');
      }
    }

    // 2) 全局按地点名匹配(取推荐度最高的城市)
    const matches = [];
    CITIES.forEach(function (city) {
      city.places.forEach(function (p) {
        const pn = norm(p.n);
        if (pn === t || (t.length >= 2 && (pn.indexOf(t) >= 0 || t.indexOf(pn) >= 0))) matches.push({ city: city, p: p });
      });
    });
    if (matches.length) {
      matches.sort(function (x, y) { return y.city.s - x.city.s; });
      return spotLocation(matches[0].city, matches[0].p);
    }

    // 3) 只写了城市名
    for (let i = 0; i < CITY_NAMES.length; i++) {
      const cn = CITY_NAMES[i];
      if (t === cn || t.indexOf(cn) >= 0) {
        const city = BY_NAME[cn];
        const rest = t.replace(cn, '');
        if (!rest) return cityLevelLocation(city);
        return locationFromUnknown(cn, rest, areaKind || 'area');
      }
    }
    return null;
  }

  // 未收录的具体地址:按位置类型估算接驳
  const RELAY_ASSUME = {
    core: { hubKm: 6, busKm: 3, label: '市中心' },
    area: { hubKm: 10, busKm: 8, label: '城区/居住区' },
    suburb: { hubKm: 20, busKm: 18, label: '近郊/新区' },
    county: { hubKm: 35, busKm: 25, label: '县城/乡镇' },
    scenic: { hubKm: 60, busKm: 0, label: '景区' }
  };

  function locationFromUnknown(cityName, placeName, areaKind) {
    const city = BY_NAME[cityName];
    if (!city) return null;
    const a = RELAY_ASSUME[areaKind] || RELAY_ASSUME.area;
    return {
      city: city.n, place: placeName || a.label, label: city.n + '·' + (placeName || a.label),
      lat: city.lat, lng: city.lng, km: a.hubKm, type: a.label, areaKind: areaKind || 'area',
      hubKm: a.hubKm, busKm: a.busKm, railDirect: false,
      note: '未收录的具体地址,按「' + a.label + '」估算接驳距离',
      isCity: false, c: city, assumed: true
    };
  }

  /* ---------------------------------------------------------
   * 3. 交通方式与里程费率(不含接驳与调度)
   * --------------------------------------------------------- */
  const MODES = {
    citybus: { key: 'citybus', label: '城际公交/地铁', icon: '🚇', group: '公共交通', rate: 0.20, min: 3, speed: 45, factor: 1.15, wait: 10, maxKm: 200 },
    bus: { key: 'bus', label: '城际大巴', icon: '🚌', group: '大巴', rate: 0.42, min: 15, speed: 72, factor: 1.22, wait: 20, maxKm: 950 },
    charter: { key: 'charter', label: '定制客运/城际拼车', icon: '🚐', group: '大巴', rate: 0.75, min: 60, speed: 80, factor: 1.15, wait: 15, maxKm: 350 },
    d: { key: 'd', label: '动车 D 二等座', icon: '🚈', group: '高铁/火车', rate: 0.31, min: 18, speed: 200, factor: 1.28, wait: 35, maxKm: 2400 },
    g: { key: 'g', label: '高铁 G 二等座', icon: '🚄', group: '高铁/火车', rate: 0.44, min: 25, speed: 255, factor: 1.28, wait: 40, maxKm: 2800 },
    k: { key: 'k', label: '普速列车 硬座', icon: '🚂', group: '高铁/火车', rate: 0.12, min: 8, speed: 75, factor: 1.30, wait: 45, maxKm: 4200 },
    kw: { key: 'kw', label: '普速列车 硬卧(夜车)', icon: '🛏️', group: '高铁/火车', rate: 0.22, min: 90, speed: 80, factor: 1.30, wait: 40, maxKm: 4200 },
    air: { key: 'air', label: '飞机 经济舱', icon: '✈️', group: '民航', rate: 0.62, min: 350, speed: 720, factor: 1.06, wait: 110, extra: 90, maxKm: 5000 }
  };
  const MODE_ORDER = ['metro', 'taxi', 'ride', 'citybus', 'bus', 'charter', 'd', 'g', 'k', 'kw', 'air'];
  const RAIL_MODES = ['d', 'g', 'k', 'kw'];
  const HSR_MODES = ['g', 'd'];
  const BUS_MODES = ['bus', 'charter'];

  /* ---------------------------------------------------------
   * 3.1 市内短途(起终点同城:家 ↔ 车站/机场/景点)
   * --------------------------------------------------------- */
  function buildLocalOptions(a, b, ctx) {
    const straight = localStraight(a, b);
    const road = straight * 1.3;
    const out = [];
    const mk = function (mode, label, icon, group, rate, min, speed, wait, walkKm) {
      const dist = Math.max(road, walkKm || 0);
      const cost = Math.max(min, dist * rate);
      const minutes = Math.round(dist / speed * 60) + wait;
      out.push({
        mode: mode, label: label, icon: icon, group: group,
        intercityCost: Math.round(cost), intercityMinutes: minutes,
        wait: 0, dist: Math.round(dist), straight: Math.round(straight),
        relayA: { mode: '无需接驳', km: 0, minutes: 0, cost: 0, alt: null },
        relayB: { mode: '无需接驳', km: 0, minutes: 0, cost: 0, alt: null },
        transfers: 0, hub: null, scenicTransfer: false, doorPickup: true,
        cost: Math.round(cost), minutes: minutes, stationLabel: '', direct: true
      });
    };
    if (straight <= 3) {
      mk('metro', '步行/骑行', '🚶', '市内短途', 0, 0, 5, 0, straight * 1.25);
    }
    mk('metro', '地铁/公交', '🚇', '市内公共交通', 0.25, 2, 22, 8);
    mk('taxi', '打车/网约车', '🚕', '市内打车', 2.6, 14, 28, 5);
    if (straight >= 8) mk('ride', '顺风车/拼车', '🚗', '市内拼车', 1.2, 12, 26, 12);
    out.sort(function (x, y) { return MODE_ORDER.indexOf(x.mode) - MODE_ORDER.indexOf(y.mode); });
    return out;
  }

  function decideLocalLeg(a, b, ctx) {
    const options = buildLocalOptions(a, b, ctx);
    const heavy = ctx.rp === 'taxi';
    options.forEach(function (o) {
      let s = 60;
      if (o.mode === 'metro') s += heavy ? -10 : 14;
      if (o.mode === 'taxi') s += heavy ? 16 : 4;
      if (o.mode === 'ride') s += heavy ? 2 : 0;
      if (ctx.preference === 'speed') s += (30 - o.minutes) / 10;
      if (ctx.preference === 'cheap') s -= o.cost / 5;
      if (ctx.preference === 'comfort') s += o.mode === 'taxi' ? 12 : (o.mode === 'metro' ? -6 : 2);
      if (ctx.preference === 'direct') s += o.mode === 'taxi' ? 8 : 0;
      o.score = s;
      o.ruleTags = [];
      o.reason = o.mode === 'taxi' ? '点对点直接送到门口,赶时间或者带行李时最省事。'
        : o.mode === 'ride' ? '拼车价格介于地铁和打车之间,提前几分钟叫车就有。'
          : '地铁/公交班次密、不怕堵车,最省钱的一段。';
      o.tickets = o.mode === 'taxi' ? '用高德/滴滴叫车,起步价 + 里程计费。'
        : o.mode === 'ride' ? '在滴滴/哈啰的顺风车入口提前 30 分钟发布行程。'
          : '手机刷码进站,或用「车来了」看实时到站。';
    });
    options.sort(function (x, y) { return y.score - x.score || x.minutes - y.minutes; });
    options.forEach(function (o, i) { o.recommended = i === 0; });
    return {
      from: a, to: b, straight: Math.round(localStraight(a, b)), local: true,
      options: options, chosen: options[0].mode, rules: [], ruleIds: []
    };
  }
  function straight0(a, b) { return haversine(a.c, b.c); }

  /* 同城两点:地点数据只记录「距市中心 km」,并没有精确坐标。
   * 直接按城市中心算会恒等于 0,所以用「两点各自距市中心 + 约 60° 夹角」的几何关系估算市内里程。*/
  function intraCityKm(a, b) {
    const k1 = a.km || 0, k2 = b.km || 0;
    if (!k1 && !k2) return 2.5;                       // 两个市中心地点,给一个保守的市内距离
    return Math.max(Math.sqrt(k1 * k1 + k2 * k2 - k1 * k2), 1.2);
  }
  function localStraight(a, b) {
    if (a.city && a.city === b.city) return intraCityKm(a, b);
    return Math.max(haversine(a.c, b.c), 0.4);
  }

  /* ---------------------------------------------------------
   * 4. 接驳(门到门的关键):小区/酒店/景区 → 车站
   * --------------------------------------------------------- */
  function relayLeg(km, ctx) {
    if (!km || km <= 0.35) return { mode: '门口上车', km: 0, minutes: 6, cost: 0, alt: null };
    if (km <= 1.2) return { mode: '步行', km: km, minutes: Math.round(km * 13), cost: 0, alt: null };

    const transit = { mode: '地铁/公交', km: km, minutes: Math.round(km / 22 * 60) + 10, cost: Math.round(Math.max(2, km * 0.25)) };
    const taxi = { mode: '打车/网约车', km: km, minutes: Math.round(km / 30 * 60) + 6, cost: Math.round(Math.max(13, 4 + 2.6 * km)) };
    let pick;
    if (km > 60) {
      pick = { mode: '打车/网约车/包车', km: km, minutes: Math.round(km / 55 * 60) + 8, cost: Math.round(Math.max(60, km * 2.1)), alt: transit };
    } else if (ctx.rp === 'taxi') {
      pick = taxi; pick.alt = transit;
    } else {
      pick = transit; pick.alt = taxi;
    }
    return pick;
  }

  /* ---------------------------------------------------------
   * 5. 换乘判定:用铁路走廊 + 枢纽近似真实路网
   * --------------------------------------------------------- */
  function sharedCorridor(A, B) {
    return A.corridors.some(function (c) { return B.corridors.indexOf(c) >= 0; });
  }
  function nearestHub(A, B) {
    let best = null, bestD = Infinity;
    HUBS.forEach(function (h) {
      if (h === A.n || h === B.n) return;
      const c = BY_NAME[h];
      if (!c) return;
      const d = haversine(A, c) + haversine(c, B);
      if (d < bestD) { bestD = d; best = c; }
    });
    return best;
  }
  function transferInfo(A, B, mode, straight, a, b) {
    if (mode === 'air' || mode === 'citybus' || mode === 'charter') return { transfers: 0, hub: null, extraMin: 0, extraCost: 0 };
    const scenic = (a && a.areaKind === 'scenic') || (b && b.areaKind === 'scenic') ||
      (a && a.areaKind === 'county') || (b && b.areaKind === 'county');
    if (mode === 'bus') {
      if (scenic && straight > 250) {
        // 景区/乡镇没有长途直达车,得先到市区客运站集散再换专线
        return { transfers: 1, hub: null, extraMin: 65, extraCost: 25, scenic: true };
      }
      if (straight <= 900) return { transfers: 0, hub: null, extraMin: 0, extraCost: 0 };
      return { transfers: 1, hub: nearestHub(A, B), extraMin: 90, extraCost: 30 };
    }
    if (sharedCorridor(A, B)) return { transfers: 0, hub: null, extraMin: 0, extraCost: 0 };
    const hub = nearestHub(A, B);
    const long = straight > 1800;
    return { transfers: 1, hub: hub, extraMin: long ? 100 : 70, extraCost: Math.round(straight * 0.03) };
  }

  // 大巴的接驳:景区/乡镇的「门口上车」只在短途(专线集散)时才成立,
  // 长途需先回市区客运站,否则会低估接驳成本
  function busRelayKm(loc, straight) {
    if (straight <= 150) return loc.busKm;
    if (loc.busKm > 0) return loc.busKm;
    return Math.max(6, loc.km * 0.85);
  }

  /* ---------------------------------------------------------
   * 6. 生成一段的全部候选交通方案(门到门 时间 + 费用)
   * --------------------------------------------------------- */
  function buildOptions(a, b, ctx) {
    const A = a.c, B = b.c;
    const straight = haversine(A, B);
    const crossBorder = !!(A.island || B.island);
    const crossStrait = (A.strait !== B.strait);
    const out = [];
    const filter = ctx.only;

    function add(key, opts) {
      const m = MODES[key];
      if (filter === 'rail' && RAIL_MODES.indexOf(key) < 0) return;
      if (filter === 'bus' && BUS_MODES.indexOf(key) < 0 && key !== 'citybus') return;
      opts = opts || {};
      if (straight > m.maxKm && !opts.force) return;

      const dist = straight * m.factor;
      let intercityCost = Math.max(m.min, dist * m.rate) + (m.extra || 0);
      let intercityMin = Math.round(dist / m.speed * 60);
      const ti = transferInfo(A, B, key, straight, a, b);
      intercityMin += ti.extraMin;
      intercityCost += ti.extraCost;

      let fromKm, toKm, stationLabel;
      if (key === 'bus') {
        fromKm = busRelayKm(a, straight); toKm = busRelayKm(b, straight);
        stationLabel = A.busStation || '汽车站';
      }
      else if (key === 'charter') { fromKm = Math.max(0, a.busKm * 0.15); toKm = Math.max(0, b.busKm * 0.15); stationLabel = '定制客运上门接送点'; }
      else if (key === 'citybus') { fromKm = Math.max(1, a.hubKm * 0.5); toKm = Math.max(1, b.hubKm * 0.5); stationLabel = '城际公交站'; }
      else if (key === 'air') { fromKm = A.airportKm; toKm = B.airportKm; stationLabel = A.airport || '机场'; }
      else {
        const useHsr = HSR_MODES.indexOf(key) >= 0;
        fromKm = useHsr ? Math.max(a.hubKm, a.c.hsrStationKm || 0) : a.hubKm;
        toKm = useHsr ? Math.max(b.hubKm, b.c.hsrStationKm || 0) : b.hubKm;
        stationLabel = (useHsr ? (A.hsrStation || A.railStation) : (A.railStation || '')) || '火车站';
      }

      const relayA = relayLeg(fromKm, ctx);
      const relayB = relayLeg(toKm, ctx);
      let relayCost = relayA.cost + relayB.cost;
      let relayMin = relayA.minutes + relayB.minutes;
      if (ti.transfers) { relayMin += 25; relayCost += 20; }

      out.push({
        mode: key, label: m.label, icon: m.icon, group: m.group,
        intercityCost: Math.round(intercityCost), intercityMinutes: intercityMin,
        wait: m.wait, dist: Math.round(dist), straight: Math.round(straight),
        relayA: relayA, relayB: relayB,
        transfers: ti.transfers, hub: ti.hub ? ti.hub.n : null,
        scenicTransfer: !!ti.scenic,
        doorPickup: (key === 'bus' && fromKm <= 0.4) || key === 'charter',
        cost: Math.round(intercityCost + relayCost),
        minutes: Math.round(intercityMin + m.wait + relayMin),
        stationLabel: stationLabel, direct: ti.transfers === 0
      });
    }

    if (crossBorder) {
      if (straight <= 650 && !A.noBus && !B.noBus) add('bus', { force: true });
      if (A.rail && B.rail && A.hsr && B.hsr && straight <= 600) add('g');
      if (A.air && B.air) add('air', { force: true });
      if (straight <= 300 && !A.noBus && !B.noBus) add('charter', { force: true });
    } else {
      if (straight <= 200 && !crossStrait) add('citybus', { force: true });
      if (!crossStrait || straight <= 300) add('bus');
      if (straight <= 700 && !crossStrait) add('charter');
      if (A.rail && B.rail) {
        if (A.hsr && B.hsr && !crossStrait) {
          add('g');
          if (straight >= 180) add('d');
        }
        add('k', { force: crossStrait });
        if (straight >= 600) add('kw', { force: crossStrait });
      }
      if (straight >= 700 && A.air && B.air) add('air');
    }
    if (!out.length) add('bus', { force: true });
    out.sort(function (x, y) { return MODE_ORDER.indexOf(x.mode) - MODE_ORDER.indexOf(y.mode); });
    return out;
  }

  /* ---------------------------------------------------------
   * 7. 交通方式决策规则(严格按 6 条顺序判断)
   * --------------------------------------------------------- */
  const RULE_TEXT = {
    R1: '① 短途(<300km)→ 优先城际大巴/定制客运',
    R2: '② 端点在县城/景区或离火车站太远 → 大巴/专线直达',
    R3: '③ 该时段火车没班次 → 夜班大巴/定制客运',
    R4: '④ 带小孩/行李多/老人 → 大巴更省事',
    R5: '⑤ 节假日/春运 → 大巴兜底',
    R6: '⑥ 长途(>400km)且两端通高铁 → 高铁最稳妥'
  };

  function placeKindLabel(loc) {
    if (loc.areaKind === 'scenic') return '景区';
    if (loc.areaKind === 'county') return '县城/乡镇';
    return null;
  }

  function evaluateRules(a, b, ctx, straight) {
    const A = a.c, B = b.c;
    const hits = [];
    const specialTags = ctx.userTags.filter(function (t) {
      return ['带小孩', '行李多', '老年人', '价格敏感', '扶老携幼'].indexOf(t) >= 0;
    });
    const night = ctx.departHour != null && (ctx.departHour >= 23 || ctx.departHour < 5);
    const holiday = ctx.dateTags.some(function (t) { return ['节假日', '春运', '黄金周'].indexOf(t) >= 0; });

    if (straight < 300) hits.push({ id: 'R1', target: 'bus', weight: 24 });

    const badRail = [];
    [a, b].forEach(function (loc) {
      const c = loc.c;
      if (!c.rail) badRail.push(loc.city + '没有火车站');
      else if (loc.hubKm > 10 && loc.areaKind !== 'core' && loc.areaKind !== 'hub') {
        badRail.push(loc.place ? (loc.label + '离火车站约 ' + Math.round(loc.hubKm) + ' 公里') : (loc.city + '火车站离市区约 ' + Math.round(loc.hubKm) + ' 公里'));
      }
      const pk = placeKindLabel(loc);
      if (pk && badRail.indexOf(loc.label + '在' + pk) < 0) badRail.push(loc.label + '在' + pk);
    });
    if (badRail.length) hits.push({ id: 'R2', target: 'bus', weight: 26, detail: badRail });

    if (night) hits.push({ id: 'R3', target: 'night', weight: 20 });
    if (specialTags.length) hits.push({ id: 'R4', target: 'bus', weight: 18, detail: specialTags });
    if (holiday) hits.push({ id: 'R5', target: 'bus', weight: 14, detail: ctx.dateTags });

    const bothHsr = A.hsr && B.hsr && a.hubKm <= 30 && b.hubKm <= 30;
    const r6 = straight > 400 && bothHsr && !specialTags.length;
    if (r6) hits.push({ id: 'R6', target: 'rail', weight: 24 });

    return { hits: hits, specialTags: specialTags, night: night, holiday: holiday, r6: r6, bothHsr: bothHsr, badRail: badRail };
  }

  function scoreOptions(options, a, b, ctx, ev) {
    const straight = options.length ? options[0].straight : haversine(a.c, b.c);
    const maxMin = Math.max.apply(null, options.map(function (o) { return o.minutes; }));
    const maxCost = Math.max.apply(null, options.map(function (o) { return o.cost; }));

    options.forEach(function (o) {
      let s = 60;
      const why = [];
      const isBus = BUS_MODES.indexOf(o.mode) >= 0 || o.mode === 'citybus';
      const isHsr = HSR_MODES.indexOf(o.mode) >= 0;

      ev.hits.forEach(function (h) {
        if (h.target === 'bus' && isBus) { s += h.weight; if (why.indexOf(h.id) < 0) why.push(h.id); }
        if (h.target === 'rail' && isHsr) { s += h.weight; if (why.indexOf(h.id) < 0) why.push(h.id); }
        if (h.target === 'night') {
          if (o.mode === 'kw') { s += 22; why.push('R3'); }
          else if (o.mode === 'charter') { s += 20; why.push('R3'); }
          else if (o.mode === 'bus') { s += 16; why.push('R3'); }
          else s -= 30;
        }
      });

      if (o.mode === 'bus') {
        if (straight > 900) s -= 70;
        else if (straight > 650) s -= 22;
        if (o.transfers) s -= 16;
        if (o.scenicTransfer) s -= 14;          // 景区/乡镇没有直达车,要先进市区集散
      }
      // 规则1/2/4/5 的理由都是「门到门时间不输火车」。真输了就不该硬推大巴,
      // 但既然这几条规则本身就是结构性理由(短途/没火车站/带娃/节假日),
      // 命中时就把容忍度放大,只有差距大到不合理才回头压分。
      if (BUS_MODES.indexOf(o.mode) >= 0) {
        const rail = options.filter(function (x) { return RAIL_MODES.indexOf(x.mode) >= 0; });
        if (rail.length) {
          const bestRail = Math.min.apply(null, rail.map(function (x) { return x.minutes; }));
          const keep = ev.hits.some(function (h) { return h.target === 'bus'; });
          const limit = keep ? bestRail * 1.8 + 100 : bestRail * 1.35 + 30;
          if (o.minutes > limit) { s -= 28; o.slowerThanRail = true; }
        }
      }
      if (o.mode === 'citybus' && straight > 60) s -= 14;
      if (o.mode === 'citybus' && straight > 200) s -= 40;
      if (isHsr) {
        if (straight <= 300) s -= 26;
        else if (straight <= 400) s -= 10;
        if (ev.badRail.length) s -= 18;
        if (o.transfers) s -= 14;
        if (ev.holiday) s -= 8;
        if (ev.specialTags.length) s -= 6;
      }
      if (o.mode === 'k') {
        if (straight > 1500) s -= 26;
        if (straight > 350) s -= 10;      // 超过 5 小时车程的硬座,得真的便宜不少才推
        if (ev.specialTags.indexOf('价格敏感') >= 0) s += 12;
      }
      // 带小孩/扶老携幼长途坐硬座基本不可行;这种情况下硬卧、高铁、飞机才是现实选项
      const family = ev.specialTags.indexOf('带小孩') >= 0 ||
        ev.specialTags.indexOf('老年人') >= 0 || ev.specialTags.indexOf('扶老携幼') >= 0;
      if (o.mode === 'k' && family) s -= straight > 400 ? 34 : 14;
      if (o.mode === 'k' && !family && ev.specialTags.indexOf('行李多') >= 0 && straight > 400) s -= 12;
      if (o.mode === 'kw' && family && straight > 500) s += 10;
      if (o.mode === 'air' && family && straight > 1200) s += 12;
      if (o.mode === 'kw') {
        if (o.transfers) s -= 10;
        if (ev.specialTags.indexOf('老年人') >= 0) s -= 4;
      }
      if (o.mode === 'charter') {
        if (straight > 250) s -= 26;
        else if (straight > 150) s -= 8;
      }
      if (o.mode === 'air') {
        if (straight < 600) s -= 80;
        else if (straight < 900) s -= 10;
        if (straight >= 1500) s += 16;
        if (ev.specialTags.indexOf('老年人') >= 0) s -= 6;
        if (ev.specialTags.indexOf('价格敏感') >= 0) s -= 10;
      }

      const p = ctx.preference;
      if (p === 'speed') s += (maxMin - o.minutes) / Math.max(maxMin, 1) * 34;
      else if (p === 'direct') s += o.transfers === 0 ? 14 : -16;
      else if (p === 'cheap') s += (maxCost - o.cost) / Math.max(maxCost, 1) * 30;
      else if (p === 'comfort') {
        if (o.mode === 'charter') s += 12;
        else if (o.mode === 'bus') s += 9;
        else if (o.mode === 'kw') s += 8;
        else if (isHsr) s += 14;
        else if (o.mode === 'k') s -= 16;
        else if (o.mode === 'air') s += 2;
        s += o.relayA.mode.indexOf('打车') >= 0 ? 6 : 0;
        s -= o.minutes / 60 * 1.6;             // 舒适也要考虑别在路上耗太久
      }

      o.score = s;
      o.ruleTags = why;
    });

    // 同分时定序:
    //  · 默认用「广义花费」= 票价 + 时间 × 1.2 元/分钟(约 72 元/小时的机会成本),
    //    既不会为了省几十块让人坐 20 小时硬座,也不会为省 1 小时多花几百块;
    //  · 「最经济」那条路线改成直接比价格,帮用户把每一段都压到最低。
    options.sort(function (x, y) {
      const d = y.score - x.score;
      if (d) return d;
      if (ctx.tieBreak === 'cost') return (x.cost - y.cost) || (x.minutes - y.minutes);
      return (x.cost + x.minutes * 1.2) - (y.cost + y.minutes * 1.2);
    });
    options.forEach(function (o, i) { o.recommended = i === 0; });
    return options;
  }

  /* ---------------- 推荐理由 / 购票建议(旅行助手语气) ---------------- */
  function buildReason(o, a, b, ctx, ev, options) {
    const km = Math.round(o.straight);
    const dest = b.place || b.city;
    const sadv = ev.specialTags;
    const opts = options || [];

    if (BUS_MODES.indexOf(o.mode) >= 0) {
      if (o.mode === 'charter') {
        return '这段叫一辆定制客运最合适——能上门接、直接送到' + dest + ',不用拎着箱子先跑去汽车站,门到门常常比坐火车还快。';
      }
      if (o.scenicTransfer) {
        return '这段建议坐大巴:' + dest + '在市区之外,大巴先到市区客运站,再换景区专线或接驳车,不用像火车那样从火车站再倒一趟车。';
      }
      if (ev.hits.some(function (h) { return h.id === 'R2'; })) {
        return '这段建议坐大巴:' + ev.badRail[0] + ',' + (o.doorPickup ? '而大巴可以站外/门口上车,' : '大巴不用往市区火车站绕,') + '直接到' + dest + ',不用像火车那样先回市区再换乘。';
      }
      if (ev.hits.some(function (h) { return h.id === 'R1'; })) {
        const hsr = opts.filter(function (x) { return HSR_MODES.indexOf(x.mode) >= 0; })
          .sort(function (x, y) { return x.cost - y.cost; })[0];
        let txt = '只有 ' + km + ' 公里,这段建议坐大巴:站外就能上车、直接开进市区,' +
          '不用像火车那样先绕到火车站再倒一趟,综合门到门时间不输火车';
        if (hsr && hsr.cost > o.cost) txt += ',还比高铁便宜 ' + (hsr.cost - o.cost) + ' 元';
        if (sadv.length) txt += ',行李舱大、上下车也方便';
        if (o.slowerThanRail) txt += '(时间会比高铁多花一些,但省掉了提前赶去车站安检的功夫)';
        return txt + '。';
      }
      if (sadv.length) {
        return '你们' + sadv.join('、') + ',大巴行李舱空间大、上下车方便,也不用拖着箱子在火车站里换乘,综合成本更低。';
      }
      if (ev.holiday) {
        return '节假日火车票不好抢,大巴班次密、能现场买票,是可靠的兜底方案,服务区还能下车透口气。';
      }
      return '这段大巴班次密,上下车都在市区,不用提前很久到站安检,整体更省心。';
    }
    if (o.mode === 'citybus') return '两地挨得很近,城际公交/地铁随到随走,不用提前买票,比专门跑一趟火车站划算。';
    if (o.mode === 'air') {
      return km > 1500 ? '这个距离只有飞机能把当天时间省下来,直飞 ' + km + ' 公里,落地再打车进城。' : '坐飞机能把时间压到最短,但要预留值机安检和往返机场的时间。';
    }
    if (o.mode === 'kw') return '安排夜车硬卧最划算:睡一觉就到,省下一晚住宿,白天还能直接开始玩。';
    if (o.mode === 'k') return '普速列车票价最低' + (o.straight > 600 ? ',而且常有直达车,适合不赶时间的玩法' : '') + ',就是路上要多花些时间。';
    if (HSR_MODES.indexOf(o.mode) >= 0) {
      if (o.transfers) return '这段得坐火车:' + (o.hub ? '需要在 ' + o.hub + ' 换乘一次' : '中途要换乘一次') + ',不过高铁准点、坐着舒服,总时间还算可控。';
      if (ev.r6) return km + ' 公里这个距离,高铁是最优解:两端都有高铁站、能直达,准点率高,路上还能踏实休息。';
      return '两地有直达火车,不用中途换乘,按点发车最稳妥' + (ev.night ? ',不过夜间班次很少,记得先确认车次' : '') + '。';
    }
    return '综合时间与花费比较均衡的一个选择。';
  }

  function buildTickets(o, a, b, ctx) {
    const A = a.c, B = b.c;
    if (o.mode === 'bus') {
      const from = o.doorPickup ? (a.place || a.city) + '(站外上车点)' : (A.busStation || A.n + '汽车站');
      return '在「巴士管家」或携程汽车票搜「' + A.n + '·' + from + ' → ' + B.n + '」的班次' +
        (o.doorPickup ? ',顺口问一下民宿/景区客服怎么在门口上车' : '') +
        (o.scenicTransfer ? ';到市区客运站后再买景区专线或接驳车的票' : '') + ';节假日建议提前 1 天订。';
    }
    if (o.mode === 'charter') return '在「巴士管家」的定制客运/城际拼车入口,或在高德/滴滴的「城际」里下单,上门地址填「' + a.label + '」,一般提前 2-4 小时都还有位。';
    if (o.mode === 'citybus') return '到当地公交枢纽直接刷码上车,或用「车来了」查班次,不需要提前买票。';
    if (RAIL_MODES.indexOf(o.mode) >= 0) {
      const st = HSR_MODES.indexOf(o.mode) >= 0 ? (A.hsrStation || A.railStation) : (A.railStation || '');
      return '12306 查「' + A.n + ' → ' + B.n + '」' + (st ? ',从' + st + '上车' : '') +
        (o.transfers && o.hub ? ';需要中途在 ' + o.hub + ' 换乘,买票时选「' + o.hub + '换乘」方案更省事' : '') +
        (ctx.dateTags.length ? ';旺季放票后尽快抢,记得勾选候补。' : ';热门区段建议提前 1-2 天买。');
    }
    if (o.mode === 'air') return '在航司官网或携程/飞猪比价,注意' + (A.airport || '机场') + '离市区约 ' + Math.round(A.airportKm) + ' 公里,预留 2 小时安检;行李多可以先买托运额度。';
    return '';
  }

  function decideLeg(a, b, ctx) {
    const options = buildOptions(a, b, ctx);
    const straight = haversine(a.c, b.c);
    const ev = evaluateRules(a, b, ctx, straight);
    scoreOptions(options, a, b, ctx, ev);
    options.forEach(function (o) {
      o.reason = buildReason(o, a, b, ctx, ev, options);
      o.tickets = buildTickets(o, a, b, ctx);
    });
    return {
      from: a, to: b, straight: Math.round(straight),
      options: options, chosen: options[0].mode,
      rules: ev.hits.map(function (h) { return { id: h.id, text: RULE_TEXT[h.id], target: h.target, detail: h.detail }; }),
      ruleIds: ev.hits.map(function (h) { return h.id; })
    };
  }

  /* ---------------------------------------------------------
   * 8. 顺路候选城市筛选
   * --------------------------------------------------------- */
  function findCandidates(A, B, D, prefs, exclude) {
    const maxRatio = prefs.maxRatio, interestTags = prefs.interestTags || [];
    const pool = [];
    CITIES.forEach(function (c) {
      if (c.n === A.n || c.n === B.n) return;
      if (exclude && exclude.indexOf(c.n) >= 0) return;
      const d1 = haversine(A, c), d2 = haversine(c, B);
      const ratio = (d1 + d2) / D;
      const m = axisMetrics(A, B, c);
      const add = d1 + d2 - D;
      if (m.t <= 0.05 || m.t >= 0.95) return;
      if (ratio > maxRatio) return;
      if (add > Math.max(D * 0.85, 300)) return;
      if (m.off > Math.max(D * 0.32, 260)) return;
      const match = c.tags.some(function (t) { return interestTags.indexOf(t) >= 0; }) ? 1 : 0;
      pool.push({
        c: c, ratio: ratio, t: m.t, off: m.off, add: add, match: match,
        weight: c.s - 55 * (ratio - 1) - m.off / Math.max(D, 1) * 30 + match * 9
      });
    });
    pool.sort(function (x, y) { return y.weight - x.weight; });
    return pool;
  }

  function combinations(arr, k) {
    const res = [];
    (function walk(start, cur) {
      if (cur.length === k) { res.push(cur.slice()); return; }
      for (let i = start; i < arr.length; i++) { cur.push(arr[i]); walk(i + 1, cur); cur.pop(); }
    })(0, []);
    return res;
  }

  function geoLength(nodes) {
    let sum = 0;
    for (let i = 0; i < nodes.length - 1; i++) sum += haversine(nodes[i], nodes[i + 1]);
    return sum;
  }

  function toNode(n, isStop) {
    return {
      n: n.city, label: n.label, place: n.place, lat: n.lat, lng: n.lng,
      type: n.type, prov: n.c.prov, s: n.c.s,
      spots: n.place ? (n.note || n.place) : n.c.spotsSummary, isStop: !!isStop
    };
  }

  /* ---------------------------------------------------------
   * 9. 组装路线
   * --------------------------------------------------------- */
  function copyCtx(ctx, tieBreak) {
    return {
      preference: ctx.preference, departHour: ctx.departHour, dateTags: ctx.dateTags,
      userTags: ctx.userTags, only: ctx.only, rp: ctx.rp, tieBreak: tieBreak
    };
  }

  function buildRoute(a, b, chain, ctx, meta) {
    const nodes = [a].concat(chain.map(function (x) {
      return x.place ? spotLocation(x.c, x.place) : cityLevelLocation(x.c);
    })).concat([b]);

    // 「最经济」那条路线:同分时按价格定序,把每一段都压到最低
    const legCtx = meta.family === 'eco' ? copyCtx(ctx, 'cost') : ctx;

    const segments = [];
    let cost = 0, minutes = 0, km = 0, transfers = 0;
    for (let i = 0; i < nodes.length - 1; i++) {
      const leg = decideLeg(nodes[i], nodes[i + 1], legCtx);
      if (meta.railOnly) {
        // 「全程高铁」:强制从铁路方式里挑最快的
        const rail = leg.options.filter(function (o) { return RAIL_MODES.indexOf(o.mode) >= 0; });
        if (rail.length) {
          const hsrOnly = rail.filter(function (o) { return HSR_MODES.indexOf(o.mode) >= 0; });
          const src = (hsrOnly.length ? hsrOnly : rail).slice().sort(function (x, y) { return x.minutes - y.minutes; });
          leg.chosen = src[0].mode;
        }
      }
      const picked = leg.options.filter(function (o) { return o.mode === leg.chosen; })[0] || leg.options[0];
      cost += picked.cost; minutes += picked.minutes; km += picked.dist; transfers += picked.transfers;
      segments.push(leg);
    }

    const geo = geoLength(nodes), direct = Math.max(haversine(a.c, b.c), 1);
    const stops = chain.map(function (x) {
      return {
        n: x.c.n, place: x.place ? x.place.n : null, forced: !!x.forced,
        days: x.place ? 1 : (x.c.s >= 85 ? 2 : 1),
        spots: x.place ? x.place.n : x.c.spotsSummary,
        score: x.c.s, tip: x.place ? (x.place.note || x.c.tip) : x.c.tip, tags: x.c.tags
      };
    });

    return {
      id: meta.id, title: meta.title, desc: meta.desc, color: meta.color, family: meta.family,
      fromLabel: a.label, toLabel: b.label,
      nodes: nodes.map(function (n, i) { return toNode(n, i > 0 && i < nodes.length - 1); }),
      chain: chain, stops: stops, segments: segments,
      cost: cost, minutes: minutes, km: km, transfers: transfers,
      geoKm: Math.round(geo), directKm: Math.round(direct),
      ratio: geo / direct,
      score: chain.reduce(function (s, x) { return s + x.c.s; }, 0),
      stayDays: stops.reduce(function (s, x) { return s + x.days; }, 0)
    };
  }

  function recompute(route) {
    let cost = 0, minutes = 0, km = 0, transfers = 0;
    route.segments.forEach(function (seg) {
      const o = seg.options.filter(function (x) { return x.mode === seg.chosen; })[0] || seg.options[0];
      seg.chosen = o.mode;
      cost += o.cost; minutes += o.minutes; km += o.dist; transfers += o.transfers;
    });
    route.cost = cost; route.minutes = minutes; route.km = km; route.transfers = transfers;
    return route;
  }

  function fmtDuration(min) {
    const h = Math.floor(min / 60), m = min % 60;
    if (h <= 0) return m + ' 分钟';
    if (m === 0) return h + ' 小时';
    return h + ' 小时 ' + m + ' 分';
  }

  /* ---------------------------------------------------------
   * 10. 主规划函数
   * --------------------------------------------------------- */
  const COLORS = ['#2f6fed', '#0ea5a4', '#b45309', '#7c3aed', '#dc2626', '#0f766e'];

  function plan(opts) {
    const a = opts.fromLoc || parsePlace(opts.from);
    const b = opts.toLoc || parsePlace(opts.to);
    if (!a || !b) throw new Error('地点未识别:' + (!a ? opts.from : opts.to));

    const specialTags = ['带小孩', '行李多', '老年人', '价格敏感', '扶老携幼'];
    const ctx = {
      preference: opts.preference || 'balanced',
      departHour: (opts.departHour === '' || opts.departHour == null) ? null : Number(opts.departHour),
      dateTags: opts.dateTags || [],
      userTags: opts.userTags || [],
      only: opts.only || null,
      rp: (opts.preference === 'comfort' || (opts.userTags || []).some(function (t) { return specialTags.indexOf(t) >= 0; })) ? 'taxi' : 'transit'
    };
    const A = a.c, B = b.c;
    const D = Math.max(haversine(A, B), 1);
    const prefs = { maxRatio: opts.maxRatio || 1.4, interestTags: opts.interestTags || [] };

    const mustLocs = (opts.mustVisit || []).map(function (t) { return parsePlace(t, opts.mustAreaKind); }).filter(function (x) { return x && !x.isCity; });
    const mustCityNames = mustLocs.map(function (x) { return x.city; });

    // 同城:起终点在同一个城市 → 给出市内点对点 / 一日动线
    if (A.n === B.n) {
      if (a.label === b.label) {
        return { from: a, to: b, distance: 0, routes: [], note: '起点和终点是同一个地点(' + a.label + '),换个目的地试试吧。', ctx: ctx };
      }
      if (!mustLocs.length) {
        const leg = decideLocalLeg(a, b, ctx);
        const picked = leg.options[0];
        const ickm = Math.round(intraCityKm(a, b));
        const route = {
          id: 'local', title: '同城点对点 · ' + ickm + ' km',
          desc: '起终点都在' + A.n + ',这里给的是市内从「' + (a.place || '市区') + '」到「' + (b.place || '市区') + '」怎么走最合适',
          color: COLORS[0], family: 'local',
          fromLabel: a.label, toLabel: b.label,
          nodes: [toNode(a, false), toNode(b, false)],
          chain: [], stops: [], segments: [leg],
          cost: picked.cost, minutes: picked.minutes, km: picked.dist, transfers: 0,
          geoKm: ickm, directKm: ickm, ratio: 1,
          score: 0, stayDays: 0
        };
        return {
          from: a, to: b, distance: ickm, routes: [route],
          note: '起终点同城,按市内交通给出方案;市内里程按两地「距市中心距离」估算。', ctx: ctx
        };
      }
      const chain = mustLocs.map(function (l) {
        return { c: l.c, place: l.c.places.filter(function (p) { return p.n === l.place; })[0], forced: true, t: 0.5, add: 0 };
      });
      const route = buildRoute(a, b, chain, ctx, { id: 'city', title: '同城一日动线 · ' + chain.length + ' 站', desc: '起终点都在' + A.n + ',已按你勾选的景点排出市内动线', color: COLORS[0], family: 'city' });
      return { from: a, to: b, distance: 0, routes: [route], note: '起终点同城,已按必去景点串联。', ctx: ctx };
    }

    const pool = findCandidates(A, B, D, prefs, mustCityNames);
    const anchors = mustLocs.map(function (l) {
      const m = axisMetrics(A, B, l.c);
      const sameEnd = A.n === l.city ? 0.02 : (B.n === l.city ? 0.98 : m.t);
      return {
        c: l.c, place: l.c.places.filter(function (p) { return p.n === l.place; })[0], forced: true,
        t: sameEnd, add: haversine(A, l.c) + haversine(l.c, B) - D
      };
    }).sort(function (x, y) { return x.t - y.t; });

    const kClassic = D < 600 ? 1 : (D < 1600 ? 2 : 3);
    const kDeep = D < 600 ? 2 : (D < 1600 ? 3 : 4);
    const top = pool.slice(0, 18);
    const maxExtraBase = Math.max(D * 0.5, 420);

    function estimate(nodes) {
      let cost = 0, minutes = 0, transfers = 0;
      for (let i = 0; i < nodes.length - 1; i++) {
        const leg = decideLeg(nodes[i], nodes[i + 1], ctx);
        const o = leg.options[0];
        cost += o.cost; minutes += o.minutes; transfers += o.transfers;
      }
      return { cost: cost, minutes: minutes, transfers: transfers };
    }
    function chainToNodes(part) {
      return [a].concat(part.map(function (x) { return x.place ? spotLocation(x.c, x.place) : cityLevelLocation(x.c); })).concat([b]);
    }

    function pickBest(k, objective) {
      const avail = Math.max(0, k - anchors.length);
      if (avail <= 0) return anchors;
      const src = top.slice(0, k >= 3 ? 13 : 17);
      const combos = combinations(src, avail);
      let best = null, bestVal = -Infinity;
      combos.forEach(function (combo) {
        const merged = anchors.concat(combo.map(function (x) { return { c: x.c, place: null, forced: false, t: x.t, add: x.add }; }))
          .sort(function (x, y) { return x.t - y.t; });
        const nodes = chainToNodes(merged);
        const geo = geoLength(nodes), ratio = geo / D;
        if (objective.maxRatio && ratio > objective.maxRatio) return;
        if (objective.maxExtra && geo - D > objective.maxExtra) return;
        const est = estimate(nodes);
        const val = objective.score(merged, ratio, est.cost, est.minutes, { transfers: est.transfers });
        if (val > bestVal) { bestVal = val; best = merged; }
      });
      if (best) return best;
      return anchors.concat(top.slice(0, avail).map(function (x) { return { c: x.c, place: null, forced: false, t: x.t, add: x.add }; }));
    }

    const scoreSum = function (arr) { return arr.reduce(function (s, x) { return s + x.c.s; }, 0); };
    const routes = [];

    // ① 直达 / 只走必去点
    routes.push(buildRoute(a, b, anchors, ctx, {
      id: 'direct',
      title: anchors.length ? '只走必去点 · ' + anchors.length + ' 站' : '极速直达',
      desc: anchors.length ? '只停你勾选的必去景点,不再加别的城市,路上最省时间' : '途中不停留,按你的偏好选最快的一套交通方案',
      color: COLORS[0], family: 'direct'
    }));

    // ② 顺路精选
    const cClassic = pickBest(Math.max(kClassic, anchors.length + 1), {
      maxRatio: Math.min(prefs.maxRatio, 1.32), maxExtra: maxExtraBase,
      score: function (arr, ratio) { return scoreSum(arr) - 190 * (ratio - 1); }
    });
    if (cClassic.length > anchors.length) routes.push(buildRoute(a, b, cClassic, ctx, {
      id: 'classic', title: '顺路精选 · ' + (cClassic.length - anchors.length) + ' 城顺路',
      desc: '偏离直线不到三成,顺路加停口碑最好的城市', color: COLORS[1], family: 'classic'
    }));

    // ③ 全程高铁/动车
    const cHsr = pickBest(Math.max(kClassic + 1, anchors.length + 1), {
      maxRatio: Math.min(prefs.maxRatio + 0.08, 1.45), maxExtra: maxExtraBase * 1.1,
      score: function (arr, ratio, cost, time, info) { return scoreSum(arr) * 0.5 - time / 60 * 6 - ratio * 25 - info.transfers * 40; }
    });
    if (cHsr.length > anchors.length) routes.push(buildRoute(a, b, cHsr, ctx, {
      id: 'hsr', title: '全程高铁 · ' + (cHsr.length - anchors.length) + ' 城顺路',
      desc: '城市之间尽量用高铁/动车衔接,班次密、准点率高', color: COLORS[3], family: 'hsr', railOnly: true
    }));

    // ④ 深度环游
    const cDeep = pickBest(Math.max(kDeep, anchors.length + 1), {
      maxRatio: Math.min(prefs.maxRatio + 0.3, 1.8), maxExtra: Math.max(D * 0.95, 800),
      score: function (arr, ratio, cost) { return scoreSum(arr) * 0.75 - cost / 100 * 3 - ratio * 12; }
    });
    if (cDeep.length > cClassic.length) routes.push(buildRoute(a, b, cDeep, ctx, {
      id: 'deep', title: '深度环游 · ' + (cDeep.length - anchors.length) + ' 城顺路',
      desc: '多停几站慢慢玩,交通按省心省钱的思路安排', color: COLORS[4], family: 'deep'
    }));

    // ⑤ 最经济:门到门总价最低的多城组合
    const cEco = pickBest(Math.max(2, anchors.length + 1), {
      maxRatio: Math.min(prefs.maxRatio, 1.35), maxExtra: Math.max(D * 0.35, 300),
      score: function (arr, ratio, cost) { return -cost - ratio * 3 + arr.length * 2; }
    });
    const ecoChain = cEco.length ? cEco : cClassic;
    if (ecoChain.length > anchors.length) routes.push(buildRoute(a, b, ecoChain, ctx, {
      id: 'eco', title: '最经济之选 · ' + (ecoChain.length - anchors.length) + ' 城顺路',
      desc: '门到门总花费最低的一套组合(已含接驳与换乘)', color: '#b45309', family: 'eco'
    }));

    const seen = {}, uniq = [];
    routes.forEach(function (r) {
      const sig = r.chain.map(function (x) { return x.c.n + (x.place ? '·' + x.place.n : ''); }).join('>') + '|' +
        r.segments.map(function (s) { return s.chosen; }).join('>');
      if (seen[sig]) return;
      seen[sig] = 1; uniq.push(r);
    });
    const chainSeen = {};
    uniq.forEach(function (r) {
      const cs = r.chain.map(function (x) { return x.c.n + (x.place ? '·' + x.place.n : ''); }).join('>') || '∅';
      if (chainSeen[cs]) r.sameChainAs = chainSeen[cs]; else chainSeen[cs] = r.title;
    });
    uniq.forEach(function (r, i) { r.color = COLORS[i % COLORS.length]; });
    uniq.sort(function (x, y) { return x.cost - y.cost; });
    uniq.forEach(recompute);

    const placeCount = CITIES.reduce(function (s, c) { return s + c.places.length; }, 0);
    const note = '已收录 ' + CITIES.length + ' 座城市、' + placeCount + ' 个精确地点/景点;' +
      '费用与耗时均为门到门(含接驳),起终点之间找到 ' + pool.length + ' 座顺路城市,绕行上限 ' + prefs.maxRatio.toFixed(2) + '。' +
      (mustLocs.length ? ' 已强制途经:' + mustLocs.map(function (l) { return l.label; }).join('、') + '。' : '');
    return { from: a, to: b, distance: Math.round(haversine(A, B)), routes: uniq, poolSize: pool.length, note: note, ctx: ctx };
  }

  /* ---------------------------------------------------------
   * 11. 排序与称号
   * --------------------------------------------------------- */
  function rank(routes) {
    const list = routes.slice();
    if (!list.length) return { routes: list, championId: null, titles: {} };
    const titles = {};
    const cheap = list.slice().sort(function (x, y) { return x.cost - y.cost || y.chain.length - x.chain.length; });
    const multi = cheap.filter(function (r) { return r.chain.length >= 1; });
    const champion = multi.length ? multi[0] : cheap[0];
    titles[champion.id] = '🏆';

    const fast = list.slice().sort(function (x, y) { return x.minutes - y.minutes; })[0];
    titles[fast.id] = (titles[fast.id] || '') + '⚡';
    const smooth = list.slice().sort(function (x, y) { return (x.transfers - y.transfers) || (x.minutes - y.minutes); })[0];
    titles[smooth.id] = (titles[smooth.id] || '') + '🔁';
    const many = list.slice().sort(function (x, y) { return (y.chain.length - x.chain.length) || (y.score - x.score); })[0];
    titles[many.id] = (titles[many.id] || '') + '🎒';

    const rival = cheap.filter(function (r) { return r.id !== champion.id && r.chain.length >= 1; })[0] ||
      cheap.filter(function (r) { return r.id !== champion.id; })[0];
    // 「全程不停靠」的直达方案有可能比最经济之选还便宜。
    // 这不算错(最经济是「多玩几座城」里最省的),但不告诉用户就容易让人误以为选贵了。
    const cheaperDirect = list.filter(function (r) {
      return r.id !== champion.id && r.chain.length === 0 && r.cost < champion.cost;
    }).sort(function (x, y) { return x.cost - y.cost; })[0] || null;

    return {
      routes: list, championId: champion.id, titles: titles,
      championSave: rival ? Math.max(0, rival.cost - champion.cost) : 0,
      rivalId: rival ? rival.id : null,
      budgetId: cheaperDirect ? cheaperDirect.id : null,
      budgetSave: cheaperDirect ? champion.cost - cheaperDirect.cost : 0,
      fastestId: fast.id, smoothestId: smooth.id, mostCitiesId: many.id
    };
  }

  return {
    CITIES: CITIES, BY_NAME: BY_NAME, MODES: MODES, INTERESTS: INTERESTS,
    AREA_TYPES: AREA_TYPES, RELAY_ASSUME: RELAY_ASSUME, RULE_TEXT: RULE_TEXT,
    haversine: haversine, parsePlace: parsePlace,
    cityLevelLocation: cityLevelLocation, locationFromUnknown: locationFromUnknown,
    buildOptions: buildOptions, decideLeg: decideLeg, relayLeg: relayLeg,
    decideLocalLeg: decideLocalLeg, buildLocalOptions: buildLocalOptions,
    plan: plan, recompute: recompute, rank: rank, fmtDuration: fmtDuration, axisMetrics: axisMetrics
  };
});
