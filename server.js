#!/usr/bin/env node
/**
 * agent-switch — 多 Agent 对话管理工具（类 ccswitch）
 * 扫描 Codex / Claude Code / Gemini / Qoder / OpenCode / OpenClaw 的本地会话记录，
 * 提供浏览、标签管理、层级导航与全文搜索能力。
 * 零依赖，Node.js >= 16
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || (process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support') : path.join(HOME, 'AppData', 'Roaming'));
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const PORT = process.env.PORT ? Number(process.env.PORT) : 4777;
// 数据目录固定在用户主目录，保证 npx 运行（代码位于临时缓存目录）时标签/配置/总结不丢失
const DATA_DIR = path.join(HOME, '.agent-switch');
const LEGACY_DATA_DIR = path.join(__dirname, 'data');
const TAGS_FILE = path.join(DATA_DIR, 'tags.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SUMMARY_FILE = path.join(DATA_DIR, 'summaries.json');
const FLAGS_FILE = path.join(DATA_DIR, 'flags.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function safeReadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
// 一次性迁移：把旧版仓库内 data/ 下的数据搬到 ~/.agent-switch（已存在的文件不覆盖）
function migrateLegacyData() {
  if (!fs.existsSync(LEGACY_DATA_DIR)) return;
  ensureDataDir();
  for (const name of ['tags.json', 'config.json', 'summaries.json', 'flags.json']) {
    const src = path.join(LEGACY_DATA_DIR, name);
    const dst = path.join(DATA_DIR, name);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    } catch {}
  }
}
function loadTagStore() {
  // 结构: { tags: [{id,name,color}], assignments: { sessionKey: [tagId,...] } }
  return safeReadJSON(TAGS_FILE, { tags: [], assignments: {} });
}
function saveTagStore(store) {
  ensureDataDir();
  fs.writeFileSync(TAGS_FILE, JSON.stringify(store, null, 2));
}
function loadConfig() {
  // 结构: { baseUrl, apiKey, model, autoSummary, autoAnalyze }
  const cfg = safeReadJSON(CONFIG_FILE, {});
  return { baseUrl: '', apiKey: '', model: '', autoSummary: true, autoAnalyze: true, ...cfg };
}
function saveConfig(cfg) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function loadSummaries() {
  // 结构: { overview: {...}, sessions: { key: { mtime, summary, segments } } }
  return safeReadJSON(SUMMARY_FILE, { overview: null, sessions: {} });
}
function saveSummaries(s) {
  ensureDataDir();
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(s, null, 2));
}
function loadFlagStore() {
  // 结构: { rules: [{id,name,color,desc}], analyses: { sessionKey: { mtime, rulesVersion, flags: {ruleId:[msgIdx...]}, at } } }
  return safeReadJSON(FLAGS_FILE, { rules: [], analyses: {} });
}
function saveFlagStore(s) {
  ensureDataDir();
  fs.writeFileSync(FLAGS_FILE, JSON.stringify(s, null, 2));
}
function walk(dir, filterFn, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, filterFn, out);
    else if (filterFn(p)) out.push(p);
  }
  return out;
}
function firstLine(text, max = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
// 提取任意 content 结构中的纯文本
function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(extractText).filter(Boolean).join('\n');
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.thinking === 'string') return '[思考] ' + content.thinking;
    if (content.type === 'tool_use') return `[工具调用: ${content.name || ''}] ` + firstLine(JSON.stringify(content.input || {}), 200);
    if (content.type === 'tool_result') return '[工具结果] ' + firstLine(extractText(content.content), 300);
    if (typeof content.content === 'string' || Array.isArray(content.content)) return extractText(content.content);
  }
  return '';
}
// ---------------------------------------------------------------------------
// 标记检测:失败执行 / 自我纠错 / 结论转折
// ---------------------------------------------------------------------------
const FLAG_DEFS = {
  fail: {
    name: '失败执行', color: '#e5484d',
    desc: '命令/工具执行失败：报错、异常、超时、崩溃、权限拒绝、找不到文件或命令等真正失败的执行结果（不含仅仅提到"错误"一词的正常讨论）',
    re: /失败|报错|出错|无法(?:找到|连接|访问|执行|打开|读取|完成)|错误[:：]|异常|\bError\b|\bERROR\b|error[:：]|\bfailed\b|\bfailure\b|exception|Traceback|ENOENT|EACCES|Permission denied|not found|command not found|超时|timed? ?out|崩溃|crash/i,
    roles: ['assistant', 'tool'],
  },
  fix: {
    name: '自我纠错', color: '#b58a00',
    desc: 'AI 发现并承认自己之前的错误、误解或遗漏，做出更正（如"我之前理解错了""更正一下"）',
    re: /我(?:搞|弄|说|写|想|理解|判断)错了?|抱歉|对不起|更正|纠正|修正(?:了)?(?:之前|刚才|上面)|之前.{0,12}(?:错误|有误|不对|遗漏)|刚才.{0,10}(?:有误|不对|错了)|my mistake|I was wrong|apologi[zs]e|误解了|理解错了?/i,
    roles: ['assistant'],
  },
  turn: {
    name: '结论转折', color: '#8e4ec6',
    desc: '结论或方案发生转折：推翻此前判断、发现真实原因与预想不同、更换方案/思路/工具（如"结果发现原来是…""改用另一种方案"）',
    re: /但实际上|然而|结果发现|原来(?:是|并|这)|事实(?:上|证明)|没想到|出乎意料|转而|改用|改为(?:使用)?|换(?:用|成)了?|放弃了?(?:这个|该|原|之前)?(?:方案|方法|思路|做法)|重新考虑|调整(?:方案|策略|思路)|turns? out|instead of|on second thought|另一种(?:方案|方法|思路)/i,
    roles: ['assistant'],
  },
};
// 内置 + 自定义规则的统一视图
function allRules(store) {
  const builtin = Object.entries(FLAG_DEFS).map(([id, d]) => ({ id, name: d.name, color: d.color, desc: d.desc, builtin: true }));
  return [...builtin, ...(store.rules || [])];
}
// 规则集指纹:规则增删改后旧的 AI 分析缓存自动失效
function rulesVersion(store) {
  const s = allRules(store).map(r => `${r.id}:${r.name}:${r.desc}`).join('|');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}
// 命中 mtime + 规则版本 才算有效的 AI 分析缓存
function validAnalysis(store, session, version) {
  const a = store.analyses[session.key];
  if (!a || a.rulesVersion !== version) return null;
  try { if (fs.statSync(session.file).mtimeMs !== a.mtime) return null; } catch { return null; }
  return a;
}
function countsFromAnalysis(a, rules) {
  const c = {};
  for (const r of rules) c[r.id] = (a.flags[r.id] || []).length;
  return c;
}
function msgFlagsFromAnalysis(a, idx) {
  const out = [];
  for (const [rid, arr] of Object.entries(a.flags)) if (arr.includes(idx)) out.push(rid);
  return out;
}
function detectFlags(m) {
  const out = [];
  for (const [k, def] of Object.entries(FLAG_DEFS)) {
    if (!def.roles.includes(m.role)) continue;
    if (def.re.test(m.text)) out.push(k);
  }
  return out;
}
function countFlags(msgs) {
  const c = { fail: 0, fix: 0, turn: 0 };
  for (const m of msgs) for (const f of detectFlags(m)) c[f]++;
  return c;
}
// 前端可用的标记定义（内置 + 自定义，去掉正则）
function FLAG_DEFS_PUB() {
  const out = {};
  for (const r of allRules(loadFlagStore())) out[r.id] = { name: r.name, color: r.color, desc: r.desc, builtin: !!r.builtin };
  return out;
}

// 过滤掉注入的系统提醒等噪音，判断是否是"真实"的用户输入
function isNoiseUserText(t) {
  if (!t) return true;
  const s = t.trim();
  return s.startsWith('<system-reminder>') || s.startsWith('<permissions instructions>') ||
    s.startsWith('# AGENTS.md') || s.startsWith('<INSTRUCTIONS>') ||
    s.startsWith('Caveat:') || s.startsWith('<command-name>') || s.startsWith('<local-command');
}

// ---------------------------------------------------------------------------
// 三个 Agent 的会话解析器
// 统一模型:
//   session:  { key, agent, id, title, project, cwd, startTime, endTime,
//               messageCount, preview, file }
//   messages: [{ index, role: user|assistant|tool|system, text, timestamp }]
// ---------------------------------------------------------------------------

// ---- Claude Code: ~/.claude/projects/<flat>/<uuid>.jsonl ----
function parseClaudeMessages(file) {
  const msgs = [];
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return msgs; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    if (d.isSidechain) continue;
    const m = d.message || {};
    const text = extractText(m.content);
    if (!text.trim()) continue;
    let role = d.type;
    if (role === 'user' && Array.isArray(m.content) && m.content.some(c => c && c.type === 'tool_result')) role = 'tool';
    msgs.push({ role, text, timestamp: d.timestamp || null });
  }
  return msgs;
}
function scanClaude() {
  const root = path.join(HOME, '.claude', 'projects');
  const files = walk(root, p => p.endsWith('.jsonl'));
  const sessions = [];
  for (const file of files) {
    const base = path.basename(file, '.jsonl');
    if (base.startsWith('agent-')) continue; // 子 agent 记录不作为独立会话
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    if (stat.size === 0) continue;
    const msgs = parseClaudeMessages(file);
    if (!msgs.length) continue;
    const firstUser = msgs.find(m => m.role === 'user' && !isNoiseUserText(m.text));
    let cwd = '';
    // 从首条记录里取 cwd
    try {
      const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 30);
      for (const l of head) {
        try { const d = JSON.parse(l); if (d.cwd) { cwd = d.cwd; break; } } catch {}
      }
    } catch {}
    sessions.push({
      key: 'claude:' + base,
      agent: 'claude',
      id: base,
      title: firstLine(firstUser ? firstUser.text : msgs[0].text),
      project: cwd ? path.basename(cwd) : path.basename(path.dirname(file)),
      cwd,
      startTime: msgs[0].timestamp || stat.birthtime.toISOString(),
      endTime: msgs[msgs.length - 1].timestamp || stat.mtime.toISOString(),
      messageCount: msgs.length,
      preview: firstLine(msgs[msgs.length - 1].text),
      flags: countFlags(msgs),
      file,
    });
  }
  return sessions;
}

// ---- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ----
function parseCodexMessages(file) {
  const msgs = [];
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return msgs; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (d.type === 'event_msg') {
      if (p.type === 'user_message' && p.message && !isNoiseUserText(p.message)) {
        msgs.push({ role: 'user', text: p.message, timestamp: d.timestamp || null });
      } else if (p.type === 'agent_message' && p.message) {
        msgs.push({ role: 'assistant', text: p.message, timestamp: d.timestamp || null });
      }
    } else if (d.type === 'response_item' && p.type === 'function_call') {
      msgs.push({ role: 'tool', text: `[工具调用: ${p.name || ''}] ` + firstLine(p.arguments || '', 200), timestamp: d.timestamp || null });
    }
  }
  return msgs;
}
function scanCodex() {
  const root = path.join(HOME, '.codex', 'sessions');
  const files = walk(root, p => p.endsWith('.jsonl'));
  const sessions = [];
  for (const file of files) {
    let meta = null;
    try {
      const head = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
      const d = JSON.parse(head);
      if (d.type === 'session_meta') meta = d.payload;
    } catch {}
    const msgs = parseCodexMessages(file);
    if (!msgs.length) continue;
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    const id = meta && meta.id ? meta.id : path.basename(file, '.jsonl');
    const cwd = meta ? meta.cwd || '' : '';
    const firstUser = msgs.find(m => m.role === 'user');
    sessions.push({
      key: 'codex:' + id,
      agent: 'codex',
      id,
      title: firstLine(firstUser ? firstUser.text : msgs[0].text),
      project: cwd ? path.basename(cwd) : '',
      cwd,
      startTime: (meta && meta.timestamp) || msgs[0].timestamp || stat.birthtime.toISOString(),
      endTime: msgs[msgs.length - 1].timestamp || stat.mtime.toISOString(),
      messageCount: msgs.length,
      preview: firstLine(msgs[msgs.length - 1].text),
      flags: countFlags(msgs),
      file,
    });
  }
  return sessions;
}

// ---- Gemini: ~/.gemini/tmp/<hash>/chats/session-*.json ----
function parseGeminiMessages(file) {
  const d = safeReadJSON(file, null);
  if (!d || !Array.isArray(d.messages)) return [];
  const msgs = [];
  for (const m of d.messages) {
    const text = extractText(m.content);
    if (!text.trim()) continue;
    const role = m.type === 'user' ? 'user' : m.type === 'gemini' ? 'assistant' : 'tool';
    msgs.push({ role, text, timestamp: m.timestamp || null });
  }
  return msgs;
}
function scanGemini() {
  const root = path.join(HOME, '.gemini', 'tmp');
  const files = walk(root, p => /[\\/]chats[\\/]session-.*\.json$/.test(p));
  const sessions = [];
  for (const file of files) {
    const d = safeReadJSON(file, null);
    if (!d) continue;
    const msgs = parseGeminiMessages(file);
    if (!msgs.length) continue;
    const id = d.sessionId || path.basename(file, '.json');
    const firstUser = msgs.find(m => m.role === 'user' && !isNoiseUserText(m.text)) || msgs.find(m => m.role === 'user');
    // 目录名 <hash> 无法还原项目路径，用 tmp 下的目录名作为项目标识
    const projDir = path.basename(path.dirname(path.dirname(file)));
    sessions.push({
      key: 'gemini:' + id,
      agent: 'gemini',
      id,
      title: firstLine(firstUser ? firstUser.text : msgs[0].text),
      project: projDir,
      cwd: '',
      startTime: d.startTime || msgs[0].timestamp,
      endTime: d.lastUpdated || msgs[msgs.length - 1].timestamp,
      messageCount: msgs.length,
      preview: firstLine(msgs[msgs.length - 1].text),
      flags: countFlags(msgs),
      file,
    });
  }
  return sessions;
}

// ---- 通用 Agent 格式解析器与扫描器 ----
function extractGenericMsg(item) {
  if (!item || typeof item !== 'object') return null;
  const rawRole = String(item.role || item.type || item.sender || item.author || '');
  const text = extractText(item.content || item.message || item.text || item.payload);
  if (!text.trim()) return null;
  let role = 'assistant';
  if (/user|human/i.test(rawRole)) role = 'user';
  else if (/assistant|bot|ai|agent|qoder|opencode|openclaw/i.test(rawRole)) role = 'assistant';
  else if (/tool|function|call|result/i.test(rawRole)) role = 'tool';
  else if (/system/i.test(rawRole)) role = 'system';
  return { role, text, timestamp: item.timestamp || item.createdAt || item.time || null };
}

function parseGenericMessages(file) {
  const msgs = [];
  try {
    const content = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.jsonl')) {
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          const msg = extractGenericMsg(d.message || d.payload || d);
          if (msg) msgs.push(msg);
        } catch {}
      }
    } else {
      const d = JSON.parse(content);
      const items = Array.isArray(d) ? d : (d.messages || d.chats || d.history || d.conversation || []);
      for (const item of items) {
        const msg = extractGenericMsg(item);
        if (msg) msgs.push(msg);
      }
    }
  } catch {}
  return msgs;
}

// ---- OpenClaw 专属扫描器 (扫描 ~/.openclaw 内所有的 .jsonl 轨迹与会话) ----
function parseOpenClawMessages(file) {
  const msgs = [];
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return msgs; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'message' && d.message) {
      const m = d.message;
      const text = extractText(m.content);
      if (!text.trim()) continue;
      const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'tool';
      msgs.push({ role, text: text.trim(), timestamp: d.timestamp || m.timestamp || null });
    }
  }
  return msgs;
}

function scanOpenClaw() {
  const root = path.join(HOME, '.openclaw');
  if (!fs.existsSync(root)) return [];
  const files = walk(root, p => (p.endsWith('.jsonl') || p.endsWith('.json')) && !p.includes('/node_modules/') && !p.includes('/browser/'));
  const sessions = [];
  for (const file of files) {
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    if (stat.size === 0) continue;
    const msgs = parseOpenClawMessages(file);
    if (!msgs.length) continue;
    const base = path.basename(file, path.extname(file));
    const firstUser = msgs.find(m => m.role === 'user' && !isNoiseUserText(m.text)) || msgs.find(m => m.role === 'user');
    const proj = path.basename(path.dirname(file));
    sessions.push({
      key: 'openclaw:' + base,
      agent: 'openclaw',
      id: base,
      title: firstLine(firstUser ? firstUser.text : msgs[0].text),
      project: proj,
      cwd: '',
      startTime: msgs[0].timestamp || stat.birthtime.toISOString(),
      endTime: msgs[msgs.length - 1].timestamp || stat.mtime.toISOString(),
      messageCount: msgs.length,
      preview: firstLine(msgs[msgs.length - 1].text),
      flags: countFlags(msgs),
      file,
    });
  }
  return sessions;
}

// 跨平台目录获取支持
function getQoderVSCDBPath() {
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'Qoder', 'User', 'globalStorage', 'state.vscdb');
  } else if (process.platform === 'win32') {
    return path.join(APPDATA, 'Qoder', 'User', 'globalStorage', 'state.vscdb');
  } else {
    return path.join(HOME, '.config', 'Qoder', 'User', 'globalStorage', 'state.vscdb');
  }
}

function parseQoderVSCDB(dbPath) {
  if (!fs.existsSync(dbPath)) return [];
  // 方式一：尝试使用 sqlite3 命令行工具解析
  try {
    const raw = require('child_process').execSync(`sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key LIKE 'lingma.chat.localHistory.%';"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    if (raw && raw.trim()) {
      const entries = JSON.parse(raw.trim());
      return Array.isArray(entries) ? entries : [entries];
    }
  } catch {}

  // 方式二：跨平台/无 sqlite3 时的零依赖正则抓取解析备选逻辑
  try {
    const buf = fs.readFileSync(dbPath);
    const content = buf.toString('binary');
    const matches = content.match(/\{"id":"[^"]+","sessionId":"[^"]+".+?\}/g);
    if (matches) {
      const items = [];
      for (const m of matches) {
        try {
          const parsed = JSON.parse(m);
          if (parsed && (parsed.sessionId || parsed.id)) items.push(parsed);
        } catch {}
      }
      return items;
    }
  } catch {}
  return [];
}

function scanQoderVSCDB() {
  const dbPath = getQoderVSCDBPath();
  if (!fs.existsSync(dbPath)) return [];
  const entries = parseQoderVSCDB(dbPath);
  if (!entries.length) return [];

  const sessions = [];
  const grouped = {};
  for (const e of entries) {
    const sid = e.sessionId || e.id;
    if (!grouped[sid]) grouped[sid] = [];
    grouped[sid].push(e);
  }
  for (const [sid, msgs] of Object.entries(grouped)) {
    msgs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const parsedMsgs = msgs.map(m => ({
      role: 'user',
      text: m.title || '',
      timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : null,
    }));
    if (!parsedMsgs.length) continue;
    sessions.push({
      key: 'qoder:vscdb:' + sid,
      agent: 'qoder',
      id: sid,
      title: firstLine(parsedMsgs[0].text),
      project: 'Qoder IDE',
      cwd: '',
      startTime: parsedMsgs[0].timestamp || new Date().toISOString(),
      endTime: parsedMsgs[parsedMsgs.length - 1].timestamp || new Date().toISOString(),
      messageCount: parsedMsgs.length,
      preview: firstLine(parsedMsgs[parsedMsgs.length - 1].text),
      flags: countFlags(parsedMsgs),
      file: dbPath,
    });
  }
  return sessions;
}

function scanQoderCLI() {
  const root = path.join(HOME, '.qoder-cli', 'ai-stats');
  if (!fs.existsSync(root)) return [];
  const files = walk(root, p => p.endsWith('.jsonl'));
  const sessions = [];
  for (const file of files) {
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    if (stat.size === 0) continue;
    let content; try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = content.split('\n').filter(Boolean);
    const msgs = [];
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        const detail = (d.lineDetails && d.lineDetails[0]) || {};
        const text = d.aiModifiedContent || d.userQuery || (detail.lines ? `[修改 ${detail.brand || 'qoder'}] ${detail.scenario || ''}` : '');
        if (text) {
          msgs.push({
            role: 'assistant',
            text: text.trim(),
            timestamp: stat.mtime.toISOString(),
          });
        }
      } catch {}
    }
    if (!msgs.length) continue;
    const base = path.basename(file, '.jsonl');
    sessions.push({
      key: 'qoder:cli:' + base,
      agent: 'qoder',
      id: base,
      title: firstLine(msgs[0].text),
      project: 'Qoder CLI',
      cwd: '',
      startTime: stat.birthtime.toISOString(),
      endTime: stat.mtime.toISOString(),
      messageCount: msgs.length,
      preview: firstLine(msgs[msgs.length - 1].text),
      flags: countFlags(msgs),
      file,
    });
  }
  return sessions;
}

function scanQoder() {
  return [...scanQoderVSCDB(), ...scanQoderCLI()];
}

function scanGenericAgent(agentName, roots) {
  const sessions = [];
  const files = [];
  for (const root of roots) {
    if (fs.existsSync(root)) {
      walk(root, p => (p.endsWith('.json') || p.endsWith('.jsonl')) && !p.includes('/node_modules/'), files);
    }
  }
  for (const file of files) {
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    if (stat.size === 0) continue;
    const msgs = parseGenericMessages(file);
    if (!msgs.length) continue;
    const base = path.basename(file).replace(/\.(json|jsonl)$/, '');
    const firstUser = msgs.find(m => m.role === 'user' && !isNoiseUserText(m.text)) || msgs.find(m => m.role === 'user');
    const proj = path.basename(path.dirname(file));
    sessions.push({
      key: agentName + ':' + base,
      agent: agentName,
      id: base,
      title: firstLine(firstUser ? firstUser.text : msgs[0].text),
      project: proj,
      cwd: '',
      startTime: msgs[0].timestamp || stat.birthtime.toISOString(),
      endTime: msgs[msgs.length - 1].timestamp || stat.mtime.toISOString(),
      messageCount: msgs.length,
      preview: firstLine(msgs[msgs.length - 1].text),
      flags: countFlags(msgs),
      file,
    });
  }
  return sessions;
}

function scanOpenCode() {
  return scanGenericAgent('opencode', [
    path.join(HOME, '.opencode', 'sessions'),
    path.join(HOME, '.opencode', 'history'),
    path.join(HOME, '.config', 'opencode', 'sessions'),
    path.join(HOME, '.local', 'share', 'opencode', 'sessions'),
    path.join(APPDATA, 'opencode', 'sessions'),
    path.join(LOCALAPPDATA, 'opencode', 'sessions'),
  ]);
}

// ---------------------------------------------------------------------------
// 会话缓存（带 mtime 校验，避免每次全量重扫）
// ---------------------------------------------------------------------------
let cache = { sessions: [], builtAt: 0 };
function buildIndex(force) {
  const now = Date.now();
  if (!force && cache.sessions.length && now - cache.builtAt < 30_000) return cache.sessions;
  const sessions = [
    ...scanClaude(),
    ...scanCodex(),
    ...scanGemini(),
    ...scanQoder(),
    ...scanOpenCode(),
    ...scanOpenClaw(),
  ];
  sessions.sort((a, b) => String(b.endTime).localeCompare(String(a.endTime)));
  cache = { sessions, builtAt: now };
  return sessions;
}
function getMessages(session) {
  if (session.agent === 'claude') return parseClaudeMessages(session.file);
  if (session.agent === 'codex') return parseCodexMessages(session.file);
  if (session.agent === 'gemini') return parseGeminiMessages(session.file);
  if (session.agent === 'openclaw') return parseOpenClawMessages(session.file);
  if (session.key.startsWith('qoder:vscdb:')) {
    const vscdbSessions = scanQoderVSCDB();
    const found = vscdbSessions.find(s => s.id === session.id);
    if (found) {
      try {
        const raw = require('child_process').execSync(`sqlite3 "${session.file}" "SELECT value FROM ItemTable WHERE key LIKE 'lingma.chat.localHistory.%';"`, { encoding: 'utf8' });
        if (raw.trim()) {
          const entries = JSON.parse(raw.trim()).filter(e => (e.sessionId || e.id) === session.id);
          entries.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          return entries.map(m => ({
            role: 'user',
            text: m.title || '',
            timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : null,
          }));
        }
      } catch {}
    }
  }
  return parseGenericMessages(session.file);
}

// ---------------------------------------------------------------------------
// 自定义 API 总结（OpenAI 兼容 chat/completions）
// ---------------------------------------------------------------------------
async function llmChat(cfg, prompt) {
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) throw new Error('请先在设置中配置 API（Base URL / Key / 模型）');
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`API ${resp.status}: ` + t.slice(0, 300));
  }
  const d = await resp.json();
  const text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!text) throw new Error('API 返回为空');
  return text;
}
// 从模型回复中尽力提取 JSON
 function parseModelJSON(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = m ? m[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('模型未返回 JSON: ' + text.slice(0, 120));
  return JSON.parse(raw.slice(start, end + 1));
}
// 把会话拼成限长 transcript
function buildTranscript(msgs, perMsg = 400, total = 22000) {
  const lines = [];
  let used = 0;
  for (let i = 0; i < msgs.length; i++) {
    const t = msgs[i].text.replace(/\s+/g, ' ').slice(0, perMsg);
    const line = `#${i} [${msgs[i].role}] ${t}`;
    used += line.length;
    if (used > total) { lines.push(`（内容过长，已截断，共 ${msgs.length} 条消息）`); break; }
    lines.push(line);
  }
  return lines.join('\n');
}
// 单会话递进式三层总结（带缓存，按文件 mtime 失效）
// 结构: 意图层(用户问哪方面) → 环节层(用户提问/用户操作/AI操作/执行测试…) → 细节层(具体问题点,锚定到消息)
async function summarizeSession(session, force) {
  const store = loadSummaries();
  const mtime = fs.statSync(session.file).mtimeMs;
  const cached = store.sessions[session.key];
  // 旧版扁平 segments 缓存视为失效，重新生成树形结构
  if (!force && cached && cached.mtime === mtime && Array.isArray(cached.tree)) return cached;
  const msgs = getMessages(session);
  const prompt = `你是对话分析助手。以下是一段 AI 编程助手（${session.agent}）的对话记录，每行格式为“#序号 [角色] 内容”。
请生成“递进式总结树”，从宏观到微观逐层钻取：
- 第1层（意图）：用户这次对话在问/要做哪几个方面的事，1~4 个节点
- 第2层（环节）：每个意图下的推进环节，kind 取值：用户提问/用户操作/AI操作/执行测试/结果结论
- 第3层（细节）：每个环节里的具体细节点（用户到底问了什么具体问题/具体改了什么/具体测了什么），每条必须用 msg 锚定到最相关的消息序号
层数由你根据对话内容自行判断：内容足够丰富就展开到 3 层，简单对话可只给 1 层或 2 层，不必强凑；无法细分时 children 留空数组即可。
请输出严格的 JSON（不要任何其他文字）：
{"summary":"不超过 80 字的会话总结","topics":["关键词1","关键词2"],"tree":[{"title":"意图主题(12字内)","summary":"1句概括","from":起始序号,"to":结束序号,"children":[{"title":"环节名(12字内)","kind":"用户提问","summary":"1句概括","from":起始序号,"to":结束序号,"children":[{"title":"具体细节点(20字内)","msg":消息序号}]}]}]}
要求：序号必须来自对话记录中真实存在的 #序号；用中文。

对话记录：
${buildTranscript(msgs)}`;
  const text = await llmChat(loadConfig(), prompt);
  const j = parseModelJSON(text);
  const clampIdx = n => Math.max(0, Math.min(msgs.length - 1, Number(n) || 0));
  const entry = {
    mtime,
    summary: String(j.summary || ''),
    topics: Array.isArray(j.topics) ? j.topics.map(String).slice(0, 8) : [],
    tree: (Array.isArray(j.tree) ? j.tree : []).map(l1 => ({
      title: String(l1.title || ''),
      summary: String(l1.summary || ''),
      from: clampIdx(l1.from), to: clampIdx(l1.to),
      children: (Array.isArray(l1.children) ? l1.children : []).map(l2 => ({
        title: String(l2.title || ''),
        kind: String(l2.kind || ''),
        summary: String(l2.summary || ''),
        from: clampIdx(l2.from), to: clampIdx(l2.to),
        children: (Array.isArray(l2.children) ? l2.children : []).map(l3 => ({
          title: String(l3.title || ''),
          msg: clampIdx(l3.msg),
        })),
      })),
    })),
    at: new Date().toISOString(),
  };
  const fresh = loadSummaries();
  fresh.sessions[session.key] = entry;
  saveSummaries(fresh);
  return entry;
}

// 用 AI 按规则（内置 + 自定义）对消息归类，结果持久化；无效时才重新分析
async function analyzeFlags(session, force) {
  const store = loadFlagStore();
  const ver = rulesVersion(store);
  const cached = validAnalysis(store, session, ver);
  if (!force && cached) return cached;
  const msgs = getMessages(session);
  const rules = allRules(store);
  const ruleLines = rules.map(r => `- ${r.id}（${r.name}）：${r.desc || r.name}`).join('\n');
  const prompt = `你是对话质检助手。以下是一段 AI 编程助手（${session.agent}）的对话记录，每行格式为“#序号 [角色] 内容”。
请逐条判断消息是否命中以下规则（一条消息可命中多条规则，也可都不命中；宁缺毋滥，只标记确实符合描述的消息）：
${ruleLines}
请输出严格的 JSON（不要任何其他文字），每个规则 id 对应命中的消息序号数组：
{"flags":{${rules.map(r => `"${r.id}":[序号...]`).join(',')}}}
要求：序号必须来自对话记录中真实存在的 #序号；无命中给空数组。

对话记录：
${buildTranscript(msgs)}`;
  const text = await llmChat(loadConfig(), prompt);
  const j = parseModelJSON(text);
  const flags = {};
  for (const r of rules) {
    const arr = Array.isArray(j.flags && j.flags[r.id]) ? j.flags[r.id] : [];
    flags[r.id] = [...new Set(arr.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < msgs.length))].sort((a, b) => a - b);
  }
  const entry = { mtime: fs.statSync(session.file).mtimeMs, rulesVersion: ver, flags, at: new Date().toISOString() };
  const freshF = loadFlagStore();
  freshF.analyses[session.key] = entry;
  saveFlagStore(freshF);
  return entry;
}
// L1: 全局总览（基于已有 L2 摘要/标题）
async function summarizeOverview() {
  const sessions = buildIndex(false);
  const store = loadSummaries();
  const lines = sessions.map(s => {
    const c = store.sessions[s.key];
    return `- key=${s.key} | agent=${s.agent} | 项目=${s.project || '-'} | 时间=${String(s.endTime).slice(0, 10)} | ${c ? c.summary : '标题: ' + s.title}`;
  }).join('\n');
  const prompt = `以下是本机多个 AI 编程助手（claude/codex/gemini）的历史会话清单。请输出严格 JSON（无其他文字）：
{"overview":"不超过 120 字的全局总览，概括用户近期在忙什么","themes":[{"title":"主题名(10字内)","summary":"该主题 1-2 句概括","sessionKeys":["归属该主题的 key 列表"]}]}
要求：themes 3~8 个，每个会话 key 只归入最相关的一个主题；用中文。

会话清单：
${lines}`;
  const text = await llmChat(loadConfig(), prompt);
  const j = parseModelJSON(text);
  const entry = {
    overview: String(j.overview || ''),
    themes: (Array.isArray(j.themes) ? j.themes : []).map(t => ({
      title: String(t.title || ''),
      summary: String(t.summary || ''),
      sessionKeys: (Array.isArray(t.sessionKeys) ? t.sessionKeys : []).filter(k => sessions.some(s => s.key === k)),
    })),
    at: new Date().toISOString(),
  };
  const fresh = loadSummaries();
  fresh.overview = entry;
  saveSummaries(fresh);
  return entry;
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    // ---- API ----
    if (p === '/api/sessions') {
      const sessions = buildIndex(url.searchParams.get('refresh') === '1');
      const store = loadTagStore();
      const sums = loadSummaries();
      const fstore = loadFlagStore();
      const ver = rulesVersion(fstore);
      const rules = allRules(fstore);
      const list = sessions.map(s => {
        const a = validAnalysis(fstore, s, ver);
        return {
          ...s,
          flags: a ? countsFromAnalysis(a, rules) : s.flags, // 有 AI 分析用 AI 结果，否则用正则兼容
          analyzed: !!a,
          tags: store.assignments[s.key] || [],
          hasSummary: !!sums.sessions[s.key],
        };
      });
      return sendJSON(res, 200, { sessions: list, tags: store.tags, flagDefs: FLAG_DEFS_PUB() });
    }
    if (p === '/api/session') {
      const key = url.searchParams.get('key');
      const s = buildIndex(false).find(x => x.key === key);
      if (!s) return sendJSON(res, 404, { error: 'session not found' });
      const fstore = loadFlagStore();
      const a = validAnalysis(fstore, s, rulesVersion(fstore));
      const msgs = getMessages(s).map((m, i) => ({ index: i, ...m, flags: a ? msgFlagsFromAnalysis(a, i) : detectFlags(m) }));
      const sums = loadSummaries();
      return sendJSON(res, 200, {
        session: s, messages: msgs,
        summary: sums.sessions[key] || null,
        flagInfo: a ? { source: 'ai', at: a.at } : { source: 'regex' }, // 标记来源:AI 分析 or 关键词兜底
      });
    }
    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (!q) return sendJSON(res, 200, { results: [] });
      const agentFilter = url.searchParams.get('agent') || '';
      const results = [];
      for (const s of buildIndex(false)) {
        if (agentFilter && s.agent !== agentFilter) continue;
        const msgs = getMessages(s);
        for (let i = 0; i < msgs.length; i++) {
          const lower = msgs[i].text.toLowerCase();
          const pos = lower.indexOf(q);
          if (pos === -1) continue;
          const start = Math.max(0, pos - 40);
          results.push({
            sessionKey: s.key, agent: s.agent, title: s.title, project: s.project,
            messageIndex: i, role: msgs[i].role, timestamp: msgs[i].timestamp,
            snippet: (start > 0 ? '…' : '') + msgs[i].text.slice(start, pos + q.length + 80).replace(/\s+/g, ' ') + '…',
          });
          if (results.length >= 200) break;
        }
        if (results.length >= 200) break;
      }
      return sendJSON(res, 200, { results });
    }
    if (p === '/api/tags' && req.method === 'GET') {
      return sendJSON(res, 200, loadTagStore());
    }
    if (p === '/api/tags' && req.method === 'POST') {
      const body = await readBody(req);
      const store = loadTagStore();
      const tag = { id: 't' + Date.now().toString(36), name: String(body.name || '').trim(), color: body.color || '#4f8cff' };
      if (!tag.name) return sendJSON(res, 400, { error: 'name required' });
      store.tags.push(tag);
      saveTagStore(store);
      return sendJSON(res, 200, { tag });
    }
    if (p === '/api/tags' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      const store = loadTagStore();
      store.tags = store.tags.filter(t => t.id !== id);
      for (const k of Object.keys(store.assignments)) {
        store.assignments[k] = store.assignments[k].filter(t => t !== id);
        if (!store.assignments[k].length) delete store.assignments[k];
      }
      saveTagStore(store);
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/assign' && req.method === 'POST') {
      const body = await readBody(req); // { sessionKey, tagId, on }
      const store = loadTagStore();
      const cur = new Set(store.assignments[body.sessionKey] || []);
      if (body.on) cur.add(body.tagId); else cur.delete(body.tagId);
      if (cur.size) store.assignments[body.sessionKey] = [...cur];
      else delete store.assignments[body.sessionKey];
      saveTagStore(store);
      return sendJSON(res, 200, { tags: [...cur] });
    }
    // ---- 总结 API 配置 ----
    if (p === '/api/config' && req.method === 'GET') {
      const cfg = loadConfig();
      // 不回传完整 key，仅回传掩码供展示
      return sendJSON(res, 200, {
        baseUrl: cfg.baseUrl, model: cfg.model,
        apiKeyMasked: cfg.apiKey ? cfg.apiKey.slice(0, 6) + '****' + cfg.apiKey.slice(-4) : '',
        autoSummary: cfg.autoSummary !== false,
        autoAnalyze: cfg.autoAnalyze !== false,
        configured: !!(cfg.baseUrl && cfg.apiKey && cfg.model),
      });
    }
    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = loadConfig();
      if (body.baseUrl != null) cfg.baseUrl = String(body.baseUrl).trim();
      if (body.model != null) cfg.model = String(body.model).trim();
      if (body.apiKey) cfg.apiKey = String(body.apiKey).trim(); // 留空则不覆盖旧 key
      if (body.autoSummary != null) cfg.autoSummary = !!body.autoSummary;
      if (body.autoAnalyze != null) cfg.autoAnalyze = !!body.autoAnalyze;
      saveConfig(cfg);
      return sendJSON(res, 200, { ok: true, autoSummary: cfg.autoSummary, autoAnalyze: cfg.autoAnalyze, configured: !!(cfg.baseUrl && cfg.apiKey && cfg.model) });
    }
    // ---- 标记规则管理（内置规则不可删） ----
    if (p === '/api/rules' && req.method === 'GET') {
      return sendJSON(res, 200, { rules: allRules(loadFlagStore()) });
    }
    if (p === '/api/rules' && req.method === 'POST') {
      const body = await readBody(req); // { name, color, desc }
      const name = String(body.name || '').trim();
      const desc = String(body.desc || '').trim();
      if (!name || !desc) return sendJSON(res, 400, { error: '规则名称和判定描述都需填写' });
      const fstore = loadFlagStore();
      const rule = { id: 'r' + Date.now().toString(36), name, color: body.color || '#4f8cff', desc };
      fstore.rules.push(rule);
      saveFlagStore(fstore); // rulesVersion 变化 → 所有会话的 AI 分析缓存自动失效
      return sendJSON(res, 200, { rule, rules: allRules(fstore) });
    }
    if (p === '/api/rules' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (FLAG_DEFS[id]) return sendJSON(res, 400, { error: '内置规则不可删除' });
      const fstore = loadFlagStore();
      fstore.rules = fstore.rules.filter(r => r.id !== id);
      saveFlagStore(fstore);
      return sendJSON(res, 200, { rules: allRules(fstore) });
    }
    // ---- AI 标记分析（结果持久化，命中缓存直接返回） ----
    if (p === '/api/analyze' && req.method === 'POST') {
      const body = await readBody(req); // { key, force }
      const s = buildIndex(false).find(x => x.key === body.key);
      if (!s) return sendJSON(res, 404, { error: 'session not found' });
      const entry = await analyzeFlags(s, !!body.force);
      const counts = countsFromAnalysis(entry, allRules(loadFlagStore()));
      return sendJSON(res, 200, { analysis: { flags: entry.flags, at: entry.at }, counts });
    }
    // ---- 三层总结 ----
    if (p === '/api/summarize' && req.method === 'POST') {
      const body = await readBody(req); // { key, force }
      const s = buildIndex(false).find(x => x.key === body.key);
      if (!s) return sendJSON(res, 404, { error: 'session not found' });
      const entry = await summarizeSession(s, !!body.force);
      return sendJSON(res, 200, { summary: entry });
    }
    if (p === '/api/overview' && req.method === 'POST') {
      const entry = await summarizeOverview();
      return sendJSON(res, 200, { overview: entry });
    }
    if (p === '/api/overview' && req.method === 'GET') {
      return sendJSON(res, 200, { overview: loadSummaries().overview });
    }
    // ---- 静态 GitHub Pages 导出 API ----
    if (p === '/api/export-static' && req.method === 'POST') {
      const distDir = path.join(__dirname, 'dist');
      if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
      
      const sessions = buildIndex(true);
      const tagStore = loadTagStore();
      const flagDefs = FLAG_DEFS_PUB();
      
      // 提取全量消息列表
      const sessionMessagesMap = {};
      for (const s of sessions) {
        sessionMessagesMap[s.key] = getMessages(s);
      }

      // 复制静态资源 (index.html, style.css, app.js) 到 dist 目录
      fs.copyFileSync(path.join(PUBLIC_DIR, 'style.css'), path.join(distDir, 'style.css'));
      
      // 注入数据到 HTML
      const exportData = {
        sessions,
        tags: tagStore.tags,
        assignments: tagStore.assignments,
        flagDefs,
        sessionMessagesMap,
      };
      
      const rawHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      const staticHtml = rawHtml.replace('</head>', `<script>window.STATIC_EXPORT_DATA = ${JSON.stringify(exportData)};</script></head>`);
      fs.writeFileSync(path.join(distDir, 'index.html'), staticHtml, 'utf8');
      fs.copyFileSync(path.join(PUBLIC_DIR, 'app.js'), path.join(distDir, 'app.js'));

      return sendJSON(res, 200, { ok: true, distDir, sessionCount: sessions.length });
    }
    // ---- 静态文件 ----
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC_DIR, path.normalize(file));
    if (full.startsWith(PUBLIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, {
        'Content-Type': (MIME[path.extname(full)] || 'application/octet-stream') + '; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate', // 避免浏览器缓存旧版页面
      });
      return res.end(fs.readFileSync(full));
    }
    sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    sendJSON(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  migrateLegacyData();
  console.log(`agent-switch running at http://localhost:${PORT}`);
});
