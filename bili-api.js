const axios = require('axios');
const crypto = require('crypto');

// WBI 签名密钥打乱表 (B站官方算法)
const MIXIN_KEY_TABLE = [
    46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,
    27,43,5,49,33,9,42,19,29,28,14,37,12,52,4,54,
    16,39,40,59,43,51,6,20,7,55,34,36,22,38,13,1,
    30,44,56,11,48,25,26,41,17,57,24,21,60
];

class BiliAPI {
    constructor(cookie) {
        this.a = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.bilibili.com',
                'Cookie': cookie
            },
            timeout: 15000
        });
        this._wbiKeys = null;
        this._wbiExpire = 0;
    }

    sleep(ms = 500) { return new Promise(r => setTimeout(r, ms)); }

    // ────────── WBI 签名 ──────────

    getMixinKey(key) {
        return MIXIN_KEY_TABLE.map(i => key[i]).join('').slice(0, 32);
    }

    async getWbiKeys() {
        if (this._wbiKeys && Date.now() < this._wbiExpire) return this._wbiKeys;
        const r = await this.a.get('https://api.bilibili.com/x/web-interface/nav');
        const d = r.data;
        if (d.code !== 0) throw new Error('获取 WBI 密钥失败: ' + (d.message || d.msg));
        const { img_key, sub_key } = d.data.wbi_img;
        this._wbiKeys = { img_key, sub_key };
        this._wbiExpire = Date.now() + 3600_000; // 缓存 1 小时
        return this._wbiKeys;
    }

    async signWbi(params = {}) {
        const { img_key, sub_key } = await this.getWbiKeys();
        const mixinKey = this.getMixinKey(img_key + sub_key);
        const wts = Math.round(Date.now() / 1000);
        const chrFilter = /[!'()*]/g;

        const sorted = Object.entries(params)
            .map(([k, v]) => [k, String(v).replace(chrFilter, '')])
            .sort((a, b) => a[0].localeCompare(b[0]));

        const query = sorted.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');

        return { ...params, w_rid, wts };
    }

    // ────────── API 方法 ──────────

    /** 获取 UP 主所有视频列表 */
    async getUpVideos(uid, maxVideos = 0) {
        const all = [];
        let page = 1;
        while (true) {
            const r = await this.a.get(
                `https://api.bilibili.com/x/space/arc/search?mid=${uid}&ps=50&pn=${page}`
            );
            const d = r.data;
            if (d.code !== 0) break;
            const list = d.data?.list?.vlist || [];
            if (!list.length) break;
            all.push(...list.map(v => ({ bvid: v.bvid, title: v.title, cid: null })));
            if (maxVideos > 0 && all.length >= maxVideos) return all.slice(0, maxVideos);
            if (all.length >= (d.data?.page?.count || 0)) break;
            page++;
            await this.sleep(600);
        }
        return all;
    }

    /** 获取单个视频信息 */
    async getVideoInfo(bvid) {
        const r = await this.a.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
        const d = r.data.data;
        return { bvid: d.bvid, title: d.title, cid: d.cid };
    }

    /** 获取视频的 cid */
    async getCid(bvid) {
        const r = await this.a.get(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`);
        if (r.data.code === 0 && r.data.data?.length > 0) return r.data.data[0].cid;
        return null;
    }

    /** 获取字幕内容（含 AI 字幕） */
    async getSubtitleContent(bvid, cid) {
        // 1) 尝试 WBI 签名版接口
        try {
            const signed = await this.signWbi({ bvid, cid });
            const r = await this.a.get('https://api.bilibili.com/x/player/wbi/v2', { params: signed });
            const subs = r.data?.data?.subtitle?.subtitles;
            if (subs && subs.length) {
                const result = await this._downloadSubtitles(subs);
                if (result.length) return result;
            }
        } catch (e) {
            // fall through
        }

        // 2) 备选: 无 WBI 的 player/v2 接口 (部分视频有效)
        try {
            const r = await this.a.get('https://api.bilibili.com/x/player/v2', {
                params: { bvid, cid }
            });
            const subs = r.data?.data?.subtitle?.subtitles;
            if (subs && subs.length) {
                const result = await this._downloadSubtitles(subs);
                if (result.length) return result;
            }
        } catch (e) {
            // noop
        }

        return [];
    }

    /** 下载字幕 JSON 并解析为统一格式 */
    async _downloadSubtitles(subtitles) {
        // 优先中文（含自动生成）
        const sorted = [...subtitles].sort((a, b) => {
            const aIsZh = (a.lan_doc && a.lan_doc.includes('中文')) ? 1 : 0;
            const bIsZh = (b.lan_doc && b.lan_doc.includes('中文')) ? 1 : 0;
            const aIsAi = (a.lan_doc && a.lan_doc.includes('自动')) ? 1 : 0;
            const bIsAi = (b.lan_doc && b.lan_doc.includes('自动')) ? 1 : 0;
            // 优先中文手动 > 中文自动 > 其他
            return (bIsZh - aIsZh) || (bIsAi - aIsAi);
        });

        const allLines = [];
        for (const sub of sorted) {
            if (!sub.subtitle_url) continue;
            try {
                let url = sub.subtitle_url;
                if (url.startsWith('//')) url = 'https:' + url;
                const res = await this.a.get(url);
                if (res.data?.body?.length) {
                    const lines = res.data.body.map(b => ({
                        content: b.content,
                        from: b.from,
                        to: b.to
                    }));
                    // 如果已经取了中文手动/自动，就不再取其他语言
                    allLines.push(...lines);
                    break; // 只取最优语言的字幕
                }
            } catch (e) {
                continue;
            }
        }
        return allLines;
    }
}

module.exports = BiliAPI;
