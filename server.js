const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const BiliAPI = require('./bili-api');

const PORT = 8899;
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
};

const logs = [];
let extracting = false;

function addLog(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logs.push(line);
    console.log(line);
}

// ── HTTP 服务 ──

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // API: 开始提取
    if (pathname === '/api/extract' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(await handleExtract(data)));
            } catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // API: 进度日志
    if (pathname === '/api/progress') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ logs: logs.slice(-200), running: extracting }));
        return;
    }

    // API: 打开输出目录 (仅Windows)
    if (pathname === '/api/open') {
        const dir = path.join(__dirname, 'subtitles');
        if (fs.existsSync(dir)) {
            try { require('child_process').execSync(`start "" "${dir}"`); } catch(e) {}
        }
        res.writeHead(200);
        res.end('ok');
        return;
    }

    // 静态文件
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain' });
        res.end(content);
    });
});

// ── 核心处理逻辑 ──

async function handleExtract(data) {
    if (extracting) return { success: false, error: '已有任务在运行，请等待完成' };
    extracting = true;
    logs.length = 0;

    try {
        const { input, cookie, maxVideos = 0 } = data;
        if (!input.trim()) throw new Error('请输入 UID 或视频链接');
        if (!cookie.trim()) throw new Error('请填写 Cookie');

        const api = new BiliAPI(cookie);
        let videos = [];

        // 判断输入类型: 链接 or UID
        if (input.startsWith('http://') || input.startsWith('https://')) {
            const match = input.match(/\/video\/(BV[a-zA-Z0-9]+)/);
            if (!match) throw new Error('无法解析视频链接，请确认是 B站 视频地址');
            const bvid = match[1];
            addLog(`📺 正在获取视频信息: ${bvid}`);
            const info = await api.getVideoInfo(bvid);
            videos = [{ bvid: info.bvid, title: info.title, cid: info.cid }];
            addLog(`📺 目标视频: ${info.title}`);
        } else {
            const uid = parseInt(input.trim());
            if (isNaN(uid)) throw new Error('UID 必须是数字');
            addLog(`📺 正在获取 UP 主视频列表 (UID: ${uid})...`);
            videos = await api.getUpVideos(uid, maxVideos);
            if (!videos.length) throw new Error('未找到该 UP 主的视频（或 Cookie 无效）');
            addLog(`🎯 共获取到 ${videos.length} 个视频`);
        }

        // 创建输出目录
        const outputDir = path.join(__dirname, 'subtitles');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

        let success = 0, noSub = 0, fail = 0, cidFail = 0;

        for (let i = 0; i < videos.length; i++) {
            const v = videos[i];
            addLog(`[${i+1}/${videos.length}] ${v.title.substring(0, 60)}`);

            try {
                // 获取 cid (分P取第一个)
                let cid = v.cid;
                if (!cid) {
                    cid = await api.getCid(v.bvid);
                    await api.sleep(300);
                }
                if (!cid) {
                    addLog(`   ❌ 无法获取视频 CID`);
                    cidFail++;
                    continue;
                }

                addLog(`   🔍 正在获取字幕...`);
                const subs = await api.getSubtitleContent(v.bvid, cid);

                if (!subs.length) {
                    addLog(`   ⏭️ 无字幕（视频没有上传或生成字幕）`);
                    noSub++;
                    continue;
                }

                // 生成字幕文本
                const text = subs.map(s => s.content).join('\n');
                const safeTitle = v.title.replace(/[<>:"/\\|?*\n\r]/g, '_').trim().slice(0, 120);
                const filePath = path.join(outputDir, `${safeTitle}.txt`);

                // 文件头包含元信息
                const header = [
                    `标题: ${v.title}`,
                    `BVID: ${v.bvid}`,
                    `字幕语言: 中文`,
                    `字幕条数: ${subs.length}`,
                    `---`,
                    ``
                ].join('\n');

                fs.writeFileSync(filePath, header + text, 'utf-8');
                addLog(`   ✅ 已保存 ${subs.length} 条字幕 → ${safeTitle}.txt`);
                success++;
            } catch (e) {
                addLog(`   ❌ 错误: ${e.message}`);
                fail++;
            }
        }

        // 最终统计
        const total = videos.length;
        addLog(`\n📊 提取完成`);
        addLog(`   总计: ${total} 个视频`);
        addLog(`   ✅ 成功保存字幕: ${success}`);
        addLog(`   ⏭️ 无字幕跳过: ${noSub}`);
        addLog(`   ❌ CID获取失败: ${cidFail}`);
        addLog(`   ❌ 其他错误: ${fail}`);

        if (success === 0) {
            addLog(`\n💡 可能的原因:`);
            addLog(`   1. Cookie 过期或无效 — 重新从浏览器复制`);
            addLog(`   2. 该 UP 主的视频本身没有字幕（示例视频是否有字幕？）`);
            addLog(`   3. B站 API 限制 — 可稍后重试`);
        }

        return { success: true, stats: { total, success, noSub, cidFail, fail }, outputDir };
    } catch (e) {
        addLog(`❌ ${e.message}`);
        return { success: false, error: e.message };
    } finally {
        extracting = false;
    }
}

// ── 启动 ──

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║      🎬 B站字幕批量提取器（AI字幕版）    ║
║                                        ║
║   http://localhost:${PORT}              ║
║                                        ║
║   Ctrl+C 关闭                          ║
╚════════════════════════════════════════╝
    `);
});
