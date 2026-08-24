// 内置 B站专属音源脚本(手机版)
// 由 lx_music_source_mobile.js 自动生成, 勿手动编辑
// eslint-disable-next-line
export const biliSourceScript = String.raw`/**
 * @name B站专属音源(手机版)
 * @version 6.4.0
 * @description 仅从B站获取音频(适配手机版lx-music-mobile): 多关键词多页搜索找全候选, 信任频道/官方优先, 质量阶梯(高质>标准>普通), 干净完整为硬性要求; 返回B站直链(手机版无本地缓存代理)。
 * @author Charke Lee
 * @homepage https://github.com/lyswhut/lx-music-mobile
 */

// ============ 基础请求封装 ============
const REQUEST_TIMEOUT = 20000;

const request = (url, options = {}) => new Promise((resolve, reject) => {
  lx.request(url, Object.assign({ method: 'get', timeout: REQUEST_TIMEOUT }, options), (err, resp) => {
    if (err) return reject(new Error((err && err.message) || '网络请求失败'));
    if (!resp || resp.statusCode < 200 || resp.statusCode >= 300) {
      return reject(new Error('请求失败: HTTP ' + (resp ? resp.statusCode : '?')));
    }
    resolve(resp);
  });
});

// 简单重试封装(应对B站接口偶发限流 412), 延迟逐次递增
const withRetry = (fn, delayMs, times) => {
  const attempt = (i) => fn().catch(err => {
    if (i < times) return new Promise(res => setTimeout(res, delayMs * (i + 1))).then(() => attempt(i + 1));
    throw err;
  });
  return attempt(0);
};

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// 解析歌曲时长: 兼容整数秒 / "MM:SS" / "MM:SS.mmm" / "H:MM:SS" 等字符串格式
const parseInterval = (v) => {
  if (typeof v === 'number' && isFinite(v)) return Math.floor(v);
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d+):(\d{1,2})(?:\.\d+)?$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  m = s.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/);
  if (m) return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return Math.floor(parseFloat(m[1]));
  m = s.match(/(\d+):(\d{1,2})/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return parseInt(s, 10) || 0;
};
// 合理性守卫: 时长异常(过短/过长)视为未知, 不启用时长门(避免误杀全部候选)
// 特别地: <60秒的条目通常是铃声/试听版本, 此时放开时长门以匹配完整版
const safeInterval = (v) => (v >= 60 && v <= 7200) ? v : 0;

// ============ 文本规范化 ============
const norm = (s) => String(s || '').toLowerCase()
  .replace(/[\s·、,，.。!！?？'’"“”\-—–～~（）()【】\[\]《》<>:：;；&\/\\|*＋+×]/g, '');
// B站搜索接口标题含HTML实体(&amp;等), 需先解码再匹配
const decodeEntities = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
const coreName = (s) => String(s || '')
  .replace(/[（(][^（()）]*[)）]/g, '').replace(/[【\[][^【\[\]】]*[】\]]/g, '').trim();
const artistTokens = (s) => String(s || '').split(/[、,，/&;；\s]+/).map(norm).filter(t => t.length >= 2);
// 连写分词: "DNFU地下城与勇士" → ["dnfu地下城与勇士", "dnfu", "地下城与勇士"]
// 手机版 QuickJS 环境不保证支持 lookbehind 正则, 用 match 分段实现
const expandTokens = (toks) => {
  const out = [];
  for (const t of toks) {
    out.push(t);
    const segs = String(t).match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || [];
    if (segs.length > 1) for (const s of segs) if (s.length >= 2) out.push(s);
  }
  return out;
};
// 通用/无效歌手名: 出现在歌手字段但实际无意义(合辑等), 不参与匹配
const GENERIC_ARTISTS = ['日本群星', '群星', '网络歌手', '未知歌手', '未知', 'unknown', 'variousartists', 'va', '影视原声', '游戏原声', '影视配乐', '游戏配乐', '原声带', 'ost'];
const isGenericArtist = (artist) => {
  const toks = artistTokens(artist);
  return !toks.length || toks.every(t => GENERIC_ARTISTS.includes(t));
};
// 提取括号别称: "边缘、粘了咕叽（遗憾总是贯穿人生始终）" → ["遗憾总是贯穿人生始终"]
const extractParen = (s) => {
  const out = [];
  const re = /[（(]([^（()）]{2,})[)）]/g;
  let m;
  while ((m = re.exec(String(s || '')))) out.push(m[1]);
  return out;
};

// ============ 质量策略 ============
// 标准质量目标码率(非硬门槛): 优先找到 >= 100kbps(128k档), 找不到则接受最佳可用(普通音质也可)
const STD_BANDWIDTH = 100000;

// 信任频道/UP主: 官方厂牌与知名干净音源频道(排序优先)
const TRUSTED_CHANNELS = [
  // 官方厂牌/艺人官方账号
  '太合音乐', '华纳音乐', '索尼音乐', '环球音乐', '环球唱片', '相信音乐', 'bin-music',
  '杰威尔音乐', '摩登天空', '滚石唱片', '福茂唱片', '种子音乐', '华研国际音乐', '海蝶音乐',
  '风华秋实', '少城时代', '天浩盛世', '乐华娱乐', '时代峰峻', '哇唧唧哇', 'tf家族',
  '上海彩虹室内合唱团', '丝芭传媒', '好妹妹', '水木年华',
  // 知名干净音源频道
  'jLRS-LeoFM', '索性自挂东南枝', '知己音乐', '南京现场Live', '4K音乐馆', '小墨Music', '八音盒音乐',
  // 艺人官方频道
  'AlanWalker官方频道', '开心星星之球_Official',
];

// 干净度过滤: 含以下词视为非干净/非正版(伴奏/曲谱/教学/翻唱/串烧/合成/变速/DJ等); 歌名自含则放行
const REJECT_WORDS = ['伴奏', '鼓谱', '简谱', '琴谱', '曲谱', '乐谱', '教学', '教程', '教你', '翻唱', '串烧', '合集', '连播', '循环', '一小时', '车载', '混剪', '剪辑', '混音', '变速', '升调', '降调', '慢速', '低音', '重低音', '夜店', '蹦迪', '3d环绕', '左右声道', '试听', '预告', '片段', '纯音乐', '演奏', '吉他', '钢琴', '二胡', '小提琴', '古筝', '琵琶', '独奏', '改编', 'cover', 'remix', 'cut', 'dj版', 'dj阿', 'ktv版'];

// 官方/正版信号加分
const BONUS_WORDS = ['mv', '官方', 'official', '4k', '修复', '完整版', '正式版', '原版', '无损', '高音质', 'hi-res', 'hires'];

// ============ B站 ============
const parseBiliDuration = (s) => {
  if (!s) return 0;
  const p = String(s).split(':').map(x => parseInt(x, 10) || 0);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] || 0;
};

const BILIBILI = {
  buvid: '',
  headers() {
    return Object.assign({ Referer: 'https://www.bilibili.com/', Cookie: 'buvid3=' + (BILIBILI.buvid || '') }, COMMON_HEADERS);
  },
  ensureBuvid() {
    if (BILIBILI.buvid) return Promise.resolve(BILIBILI.buvid);
    return request('https://api.bilibili.com/x/frontend/finger/spi').then(resp => {
      const b3 = resp.body && resp.body.data && resp.body.data.b_3;
      BILIBILI.buvid = b3 || ('buvid3_' + Math.random().toString(36).substring(2) + '_infoc');
      return BILIBILI.buvid;
    });
  },
  // 单页搜索(带缓存)
  search(keyword, page) {
    const cacheKey = keyword + '|' + page;
    const now = Date.now();
    const c = BILIBILI.__searchCache && BILIBILI.__searchCache[cacheKey];
    if (c && now - c.ts < 600000) return Promise.resolve(c.list);
    return BILIBILI.ensureBuvid().then(() =>
      withRetry(() => request('https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + encodeURIComponent(keyword) + '&page=' + page, { headers: BILIBILI.headers() }), 3000, 3)
    ).then(resp => {
      const list = resp.body && resp.body.data && resp.body.data.result;
      if (!Array.isArray(list) || !list.length) {
        return Promise.reject(new Error('B站: 无搜索结果'));
      }
      const mapped = list.filter(v => v && v.bvid).map(v => ({
        bvid: v.bvid,
        title: decodeEntities(String(v.title || '').replace(/<[^>]+>/g, '')),
        author: decodeEntities(String(v.author || '').replace(/<[^>]+>/g, '')),
        duration: parseBiliDuration(v.duration),
        play: parseInt(v.play, 10) || 0,
      }));
      try {
        BILIBILI.__searchCache = BILIBILI.__searchCache || {};
        BILIBILI.__searchCache[cacheKey] = { list: mapped, ts: Date.now() };
      } catch (e) {}
      return mapped;
    });
  },
  // 多关键词×多页搜索, 找全候选(例: 4K音乐馆的"向云端"在搜索结果第2页也能找到)
  searchAll(songName, artist, interval) {
    const variants = [];
    const add = k => { k = (k || '').trim(); if (k && !variants.includes(k)) variants.push(k); };
    add(songName + ' ' + artist);
    add(songName);
    const core = coreName(songName);
    if (core && core !== songName) { add(core + ' ' + artist); add(core); }
    // 括号别称(较长的, 如"遗憾总是贯穿人生始终")作为补充关键词
    for (const p of extractParen(songName)) {
      if (p.trim().length >= 6) { add(p.trim() + ' ' + artist); add(p.trim()); }
    }
    const trustedSet = TRUSTED_CHANNELS.map(norm);
    const pool = [];
    const seen = new Set();
    const pages = [1, 2, 3];
    let strongFound = false;
    const chain = variants.reduce((p, kw) => p.then(() => {
      if (strongFound || pool.length >= 60) return Promise.resolve();
      const pagesChain = pages.reduce((p2, page) => p2.then(() => {
        if (strongFound || pool.length >= 60) return Promise.resolve();
        return BILIBILI.search(kw, page).then(list => {
          for (const v of list) {
            if (!seen.has(v.bvid)) { seen.add(v.bvid); pool.push(v); }
          }
          // 提前停止条件: 已有强候选(信任频道且标题含完整歌名)
          const nameFull = norm(songName);
          strongFound = pool.some(v => trustedSet.includes(norm(v.author)) && norm(v.title).includes(nameFull));
        }).catch(() => null); // 单页失败继续
      }), Promise.resolve());
      return pagesChain;
    }), Promise.resolve());
    return chain.then(() => pool);
  },
  // 硬性质量检查(干净完整): 歌名/歌手/时长/内容过滤
  // requireArtist=false 时放宽歌手匹配; looseDuration=true 时放宽时长(±45%)
  pickCandidates(pool, songName, artist, interval, requireArtist, looseDuration) {
    const effInterval = safeInterval(interval);
    const nameFull = norm(songName);
    const nameCore = norm(coreName(songName));
    const nameAlts = extractParen(songName).map(norm).filter(n => n.length >= 6);
    const toks = expandTokens(artistTokens(artist));
    const trustedSet = TRUSTED_CHANNELS.map(norm);
    const stats = { total: pool.length, nameMatch: 0, artistMatch: 0, durMatch: 0, contentReject: 0 };
    const pass = [];
    for (const v of pool) {
      const t = norm(v.title);
      const au = norm(v.author);
      let nameScore = 0;
      if (nameFull && t.includes(nameFull)) nameScore = 2;
      else if (nameCore && nameCore.length >= 2 && t.includes(nameCore)) nameScore = 1.5;
      else if (nameAlts.some(a => t.includes(a))) nameScore = 1;
      if (!nameScore) continue;
      stats.nameMatch++;
      if (requireArtist && toks.length && !toks.some(tk => t.includes(tk) || au.includes(tk))) continue;
      stats.artistMatch++;
      const d = v.duration;
      if (d < 30) continue;
      if (effInterval > 0) {
        const lo = Math.floor(effInterval * (looseDuration ? 0.55 : 0.8)) - 15;
        const hi = Math.ceil(effInterval * (looseDuration ? 1.45 : 1.3)) + 15;
        if (d < lo || d > hi) continue;
      }
      stats.durMatch++;
      let rejected = false;
      for (const w of REJECT_WORDS) {
        if (t.includes(norm(w)) && !(nameFull && nameFull.includes(norm(w))) && !(nameCore && nameCore.includes(norm(w)))) {
          rejected = true;
          break;
        }
      }
      if (rejected) { stats.contentReject++; continue; }
      // UP主名含教学/伴奏等同样视为非干净内容
      let authorRejected = false;
      for (const w of ['教学', '教程', '教你', '鼓谱', '琴谱', '简谱', '伴奏']) {
        if (au.includes(norm(w))) { authorRejected = true; break; }
      }
      if (authorRejected) { stats.contentReject++; continue; }
      let bonus = 0;
      for (const w of BONUS_WORDS) {
        if (t.includes(norm(w)) || au.includes(norm(w))) { bonus++; break; }
      }
      pass.push(Object.assign({}, v, { nameScore, bonus, trusted: trustedSet.includes(au) }));
    }
    // 排序阶梯: 完整歌名 > 信任频道 > 官方信号 > 时长吻合 > 播放量
    pass.sort((x, y) => {
      if (x.nameScore !== y.nameScore) return y.nameScore - x.nameScore;
      if (x.trusted !== y.trusted) return x.trusted ? -1 : 1;
      if (x.bonus !== y.bonus) return y.bonus - x.bonus;
      if (effInterval > 0) {
        const dx = Math.abs(x.duration - effInterval), dy = Math.abs(y.duration - effInterval);
        if (dx !== dy) return dx - dy;
      }
      return y.play - x.play;
    });
    return { pass, stats };
  },
  getCid(bvid) {
    const now = Date.now();
    const c = BILIBILI.__vidCache && BILIBILI.__vidCache[bvid];
    if (c && c.cid && now - c.ts < 600000) return Promise.resolve(c.cid);
    return withRetry(() => request('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, { headers: BILIBILI.headers() }), 2000, 3).then(resp => {
      const cid = resp.body && resp.body.data && resp.body.data.cid;
      if (!cid) return Promise.reject(new Error('B站: 获取视频信息失败'));
      try {
        BILIBILI.__vidCache = BILIBILI.__vidCache || {};
        BILIBILI.__vidCache[bvid] = { cid: cid, ts: Date.now() };
      } catch (e) {}
      return cid;
    });
  },
  getAudioUrl(bvid, cid) {
    const now = Date.now();
    const c = BILIBILI.__vidCache && BILIBILI.__vidCache[bvid];
    if (c && c.audio && now - c.ts < 600000) return Promise.resolve(c.audio);
    return withRetry(() => request('https://api.bilibili.com/x/player/playurl?bvid=' + bvid + '&cid=' + cid + '&fnval=16&fourk=1', { headers: BILIBILI.headers() }), 2000, 3).then(resp => {
      const audio = resp.body && resp.body.data && resp.body.data.dash && resp.body.data.dash.audio;
      if (!Array.isArray(audio) || !audio.length) return Promise.reject(new Error('B站: 获取音频流失败'));
      let best = audio[0];
      for (const a of audio) if (a.bandwidth > best.bandwidth) best = a;
      if (!best || !/^https?:/.test(best.baseUrl || '')) return Promise.reject(new Error('B站: 音频流不可用'));
      const result = { url: best.baseUrl, bandwidth: best.bandwidth || 0 };
      try {
        BILIBILI.__vidCache = BILIBILI.__vidCache || {};
        BILIBILI.__vidCache[bvid] = Object.assign(BILIBILI.__vidCache[bvid] || { cid: cid }, { audio: result, ts: Date.now() });
      } catch (e) {}
      return result;
    });
  },
  // 主入口: 全量搜索 → 硬性校验(三级阶梯) → 质量阶梯选取(优先>=100k, 否则最佳可用)
  getMusicUrl(keyword, interval, songName, artist) {
    const start = Date.now();
    return BILIBILI.searchAll(songName, artist, interval).then(pool => {
      // 阶梯1: 严格(歌手必须匹配); 阶梯2: 放宽歌手; 阶梯3: 再放宽时长
      const requireArtist = !isGenericArtist(artist);
      let l1 = BILIBILI.pickCandidates(pool, songName, artist, interval, requireArtist, false);
      let level = 1;
      if (!l1.pass.length) {
        l1 = BILIBILI.pickCandidates(pool, songName, artist, interval, false, false);
        level = 2;
      }
      if (!l1.pass.length) {
        l1 = BILIBILI.pickCandidates(pool, songName, artist, interval, false, true);
        level = 3;
      }
      const { pass, stats } = l1;
      if (!pass.length) {
        try {
          BILIBILI.__lastPick = {
            ok: false, song: songName, reason: 'B站: 无干净完整候选', stats: stats,
            diag: { interval: interval, effInterval: safeInterval(interval), samples: pool.slice(0, 5).map(v => ({ t: v.title.slice(0, 30), d: v.duration })) },
          };
        } catch (e) {}
        return Promise.reject(new Error('B站: 未找到干净完整的视频'));
      }
      let best = null;
      const failedTries = [];
      const finish = () => {
        if (best) {
          try { BILIBILI.__lastPick = Object.assign({ ok: true, song: songName, level: level, costMs: Date.now() - start }, best); } catch (e) {}
          return Promise.resolve(best.url);
        }
        try { BILIBILI.__lastPick = { ok: false, song: songName, reason: 'B站: 候选音频流均不可用', stats: stats }; } catch (e) {}
        return Promise.reject(new Error('B站: 候选音频流均不可用'));
      };
      const attempt = (i) => {
        if (i >= Math.min(pass.length, 6)) {
          // 高排名/信任频道候选曾因临时限流失败 → 等一会重试一次再决定
          if (failedTries.length && (best.__bw < STD_BANDWIDTH || failedTries.some(v => v.trusted))) {
            const retryList = failedTries.slice(0, 3);
            failedTries.length = 0;
            const retry = (j) => {
              if (j >= retryList.length) return finish();
              const v = retryList[j];
              return BILIBILI.getCid(v.bvid)
                .then(cid => BILIBILI.getAudioUrl(v.bvid, cid))
                .then(r => {
                  const info = { bvid: v.bvid, title: v.title.slice(0, 40), author: v.author, trusted: v.trusted, duration: v.duration, bw: Math.round(r.bandwidth / 1000) };
                  if (r.bandwidth >= STD_BANDWIDTH) {
                    best = Object.assign({}, info, { url: r.url, __bw: r.bandwidth });
                    try { BILIBILI.__lastPick = Object.assign({ ok: true, song: songName, level: level, costMs: Date.now() - start }, info); } catch (e) {}
                    return r.url;
                  }
                  if (r.bandwidth > best.__bw) best = Object.assign({}, info, { url: r.url, __bw: r.bandwidth });
                  return retry(j + 1);
                })
                .catch(() => retry(j + 1));
            };
            return new Promise(res => setTimeout(res, 6000)).then(() => retry(0));
          }
          return finish();
        }
        const v = pass[i];
        return BILIBILI.getCid(v.bvid)
          .then(cid => BILIBILI.getAudioUrl(v.bvid, cid))
          .then(r => {
            const info = { bvid: v.bvid, title: v.title.slice(0, 40), author: v.author, trusted: v.trusted, duration: v.duration, bw: Math.round(r.bandwidth / 1000) };
            if (!best || r.bandwidth > best.__bw) {
              best = Object.assign({}, info, { url: r.url, __bw: r.bandwidth });
            }
            if (r.bandwidth >= STD_BANDWIDTH) {
              try { BILIBILI.__lastPick = Object.assign({ ok: true, song: songName, level: level, costMs: Date.now() - start }, info); } catch (e) {}
              return r.url; // 达到标准质量, 立即采用
            }
            return attempt(i + 1); // 低码率, 继续找更好的
          })
          .catch(() => { failedTries.push(v); return attempt(i + 1); });
      };
      return attempt(0);
    }).catch(err => {
      try { BILIBILI.__lastPick = Object.assign({}, BILIBILI.__lastPick || {}, { ok: false, song: songName, reason: String(err && err.message) }); } catch (e) {}
      throw err;
    });
  },
};

// ============ 注册(B站专属, 手机版) ============
// 手机版无本地缓存代理(QuickJS 沙箱无文件系统), 直接返回B站音频直链;
// 搜索与播放地址均有 10 分钟内存缓存, 接口限流自动阶梯重试。
lx.on('request', ({ source, action, info }) => {
  return new Promise((resolve, reject) => {
    try {
      if (action !== 'musicUrl') return reject(new Error('不支持的请求类型: ' + action));
      const musicInfo = info && info.musicInfo;
      if (!musicInfo) return reject(new Error('缺少歌曲信息'));
      const songName = musicInfo.name || '';
      const singer = musicInfo.singer || '';
      const keyword = (songName + ' ' + singer).trim();
      const interval = parseInterval(musicInfo.interval);
      if (!keyword) return reject(new Error('缺少歌曲信息'));
      BILIBILI.getMusicUrl(keyword, interval, songName, singer).then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
});

lx.send('inited', {
  sources: {
    kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] },
    wy: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac', 'flac24bit'] },
    tx: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac', 'flac24bit'] },
    kg: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac', 'flac24bit'] },
    mg: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
  },
});
`
