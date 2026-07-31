/* Agent Switch 前端逻辑 */
const $ = s => document.querySelector(s);
const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', qoder: 'Qoder / CLI', opencode: 'OpenCode', openclaw: 'OpenClaw' };
const COLORS = ['#4f8cff', '#d97757', '#10a37f', '#e5484d', '#b58a00', '#8e4ec6', '#e93d82', '#00a2c7'];

const state = {
  sessions: [], tags: [],
  config: { configured: false, autoSummary: true, autoAnalyze: true },
  flagDefs: { fail: { name: '失败执行', color: '#e5484d', builtin: true }, fix: { name: '自我纠错', color: '#b58a00', builtin: true }, turn: { name: '结论转折', color: '#8e4ec6', builtin: true } },
  agent: '', project: '', tagFilter: '',
  sort: 'time-desc',
  mode: 'list',           // list | search
  searchResults: [],
  current: null,          // { session, messages, summary, flagInfo }
  pendingJump: null,      // 搜索跳转的消息 index
  inSessionHits: [], inSessionIdx: -1,
  flagCursor: {},         // 统计条循环定位游标（规则 id -> 上次位置）
  analyzing: false,       // AI 标记分析进行中
  lang: localStorage.getItem('agent_switch_lang') || 'zh'
};

const I18N = {
  zh: {
    btnLang: '🌐 EN',
    btnLoadLocal: '📂 选择本地日志目录/文件',
    agentAll: '全部',
    sectionProject: '项目',
    sectionTag: '标签',
    sectionRules: '标记规则',
    ruleHint: '新增规则，由 AI 按描述归类',
    btnOverview: '✨ 全局总览',
    btnSettings: '⚙︎ API 设置',
    btnRefresh: '↻ 重新扫描',
    btnExportPages: '📦 导出 GitHub Pages 产物',
    searchPlaceholder: '全文搜索所有对话… (Enter)',
    sortRecent: '最近更新',
    sortOldest: '最早更新',
    sortStartDesc: '开始时间 ↓',
    sortMsgDesc: '消息数 ↓',
    sortTitle: '标题 A-Z',
    detailEmptyText: '从左侧选择一个会话，或使用全文搜索定位对话片段',
    inSessionSearchPlaceholder: '在本会话内查找… (Enter 下一个)',
    clearFilter: '清除筛选',
    sessionsCount: '个会话',
    tagPlaceholder: '标签名称',
    save: '保存',
    cancel: '取消',
    ruleNamePlaceholder: '规则名称（如：性能问题）',
    ruleDescPlaceholder: '判定描述：什么样的消息算命中',
    ruleSaveHint: '保存后旧分析自动失效，打开会话时由 AI 按新规则重新归类',
    failExec: '失败执行',
    selfFix: '自我纠错',
    conclusionTurn: '结论转折',
    summaryTitle: '递进式总结',
    reGenerate: '重新生成',
    msgCount: '条消息',
    noMessages: '对话记录为空，无法生成总结',
  },
  en: {
    btnLang: '🌐 中文',
    btnLoadLocal: '📂 Select Local Log Directory / File',
    agentAll: 'All Agents',
    sectionProject: 'PROJECTS',
    sectionTag: 'TAGS',
    sectionRules: 'MARKING RULES',
    ruleHint: 'Add rule, classified by AI based on description',
    btnOverview: '✨ Overview',
    btnSettings: '⚙︎ API Settings',
    btnRefresh: '↻ Rescan',
    btnExportPages: '📦 Export GitHub Pages',
    searchPlaceholder: 'Search all conversations… (Enter)',
    sortRecent: 'Recently Updated',
    sortOldest: 'Oldest Updated',
    sortStartDesc: 'Start Time ↓',
    sortMsgDesc: 'Message Count ↓',
    sortTitle: 'Title A-Z',
    detailEmptyText: 'Select a conversation from the left sidebar or use full-text search',
    inSessionSearchPlaceholder: 'Find in this conversation… (Enter next)',
    clearFilter: 'Clear Filter',
    sessionsCount: 'sessions',
    tagPlaceholder: 'Tag Name',
    save: 'Save',
    cancel: 'Cancel',
    ruleNamePlaceholder: 'Rule Name (e.g. Performance Issue)',
    ruleDescPlaceholder: 'Condition: what kind of message matches',
    ruleSaveHint: 'Old analysis is invalidated on save; AI will re-classify per new rules on session open',
    failExec: 'Failed Execution',
    selfFix: 'Self Correction',
    conclusionTurn: 'Conclusion Pivot',
    summaryTitle: 'Progressive Summary',
    reGenerate: 'Regenerate',
    msgCount: 'messages',
    noMessages: 'Empty conversation log, cannot generate summary',
  }
};

function t(key) {
  return (I18N[state.lang] && I18N[state.lang][key]) || (I18N.zh[key] || key);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function highlight(text, q) {
  if (!q) return esc(text);
  const parts = String(text).split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((p, i) => i % 2 ? `<mark>${esc(p)}</mark>` : esc(p)).join('');
}
async function api(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------
async function loadSessions(refresh) {
  if (window.STATIC_EXPORT_DATA) {
    const d = window.STATIC_EXPORT_DATA;
    state.sessions = d.sessions || [];
    state.tags = d.tags || [];
    state.assignments = d.assignments || {};
    if (d.flagDefs) state.flagDefs = d.flagDefs;
    renderSidebar();
    renderRules();
    renderList();
    return;
  }
  const d = await api('/api/sessions' + (refresh ? '?refresh=1' : ''));
  state.sessions = d.sessions;
  state.tags = d.tags;
  if (d.flagDefs) state.flagDefs = d.flagDefs;
  renderSidebar();
  renderRules();
  renderList();
}

function updateLanguageUI() {
  if ($('#btnLangToggle')) $('#btnLangToggle').textContent = t('btnLang');
  if ($('#btnLoadLocal')) $('#btnLoadLocal').textContent = t('btnLoadLocal');
  if ($('#navAllText')) $('#navAllText').textContent = t('agentAll');
  if ($('#titleProject')) $('#titleProject').textContent = t('sectionProject');
  if ($('#titleTag')) $('#titleTag').innerHTML = `${t('sectionTag')} <button id="btnAddTag" title="${t('tagPlaceholder')}">＋</button>`;
  if ($('#titleRules')) $('#titleRules').innerHTML = `${t('sectionRules')} <button id="btnAddRule" title="${t('ruleHint')}">＋</button>`;
  if ($('#btnOverview')) $('#btnOverview').textContent = t('btnOverview');
  if ($('#btnSettings')) $('#btnSettings').textContent = t('btnSettings');
  if ($('#btnRefresh')) $('#btnRefresh').textContent = t('btnRefresh');
  if ($('#btnExportGitPages')) $('#btnExportGitPages').textContent = t('btnExportPages');
  if ($('#searchBox')) $('#searchBox').placeholder = t('searchPlaceholder');
  if ($('#inSessionSearch')) $('#inSessionSearch').placeholder = t('inSessionSearchPlaceholder');
  if ($('#detailEmpty p')) $('#detailEmpty p').textContent = t('detailEmptyText');
  if ($('#ruleSaveHint')) $('#ruleSaveHint').textContent = t('ruleSaveHint');

  // Update builtin rule names
  if (state.flagDefs.fail) state.flagDefs.fail.name = t('failExec');
  if (state.flagDefs.fix) state.flagDefs.fix.name = t('selfFix');
  if (state.flagDefs.turn) state.flagDefs.turn.name = t('conclusionTurn');

  // Update sort dropdown options
  if ($('#sortSel')) {
    const sel = $('#sortSel');
    const val = sel.value;
    sel.innerHTML = `
      <option value="time-desc">${t('sortRecent')}</option>
      <option value="time-asc">${t('sortOldest')}</option>
      <option value="start-desc">${t('sortStartDesc')}</option>
      <option value="msg-desc">${t('sortMsgDesc')}</option>
      <option value="title">${t('sortTitle')}</option>
    `;
    sel.value = val;
  }
}

// ---------------------------------------------------------------------------
// 左栏渲染:Agent / 项目 / 标签
// ---------------------------------------------------------------------------
function renderSidebar() {
  updateLanguageUI();
  // Agent 计数
  const cnt = { '': state.sessions.length, claude: 0, codex: 0, gemini: 0, qoder: 0, opencode: 0, openclaw: 0 };
  for (const s of state.sessions) {
    if (cnt[s.agent] !== undefined) cnt[s.agent]++;
    else cnt[s.agent] = (cnt[s.agent] || 0) + 1;
  }
  if ($('#cnt-all')) $('#cnt-all').textContent = cnt[''];
  if ($('#cnt-claude')) $('#cnt-claude').textContent = cnt.claude;
  if ($('#cnt-codex')) $('#cnt-codex').textContent = cnt.codex;
  if ($('#cnt-gemini')) $('#cnt-gemini').textContent = cnt.gemini;
  if ($('#cnt-qoder')) $('#cnt-qoder').textContent = cnt.qoder;
  if ($('#cnt-opencode')) $('#cnt-opencode').textContent = cnt.opencode;
  if ($('#cnt-openclaw')) $('#cnt-openclaw').textContent = cnt.openclaw;
  document.querySelectorAll('#agentList .nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.agent === state.agent);
  });

  // 项目列表（按当前 agent 过滤统计）
  const projs = {};
  for (const s of state.sessions) {
    if (state.agent && s.agent !== state.agent) continue;
    const p = s.project || '(未知)';
    projs[p] = (projs[p] || 0) + 1;
  }
  $('#projectList').innerHTML = Object.entries(projs)
    .sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([p, n]) => `<div class="proj-item ${state.project === p ? 'active' : ''}" data-proj="${esc(p)}">${esc(p)} <span style="float:right">${n}</span></div>`)
    .join('');
  document.querySelectorAll('.proj-item').forEach(el => {
    el.onclick = () => { state.project = state.project === el.dataset.proj ? '' : el.dataset.proj; renderSidebar(); renderList(); };
  });

  // 标签列表
  $('#tagList').innerHTML = state.tags.map(t =>
    `<div class="tag-item ${state.tagFilter === t.id ? 'active' : ''}" data-tag="${t.id}">
       <span class="swatch" style="background:${esc(t.color)}"></span>${esc(t.name)}
       <button class="del" data-del="${t.id}" title="删除标签">✕</button>
     </div>`).join('') || `<div class="proj-item" style="cursor:default">${state.lang === 'en' ? 'No tags yet, click + to add' : '暂无标签，点 ＋ 新建'}</div>`;
  document.querySelectorAll('.tag-item').forEach(el => {
    el.onclick = e => {
      if (e.target.dataset.del) return;
      state.tagFilter = state.tagFilter === el.dataset.tag ? '' : el.dataset.tag;
      renderSidebar(); renderList();
    };
  });
  document.querySelectorAll('.tag-item .del').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      if (!confirm('删除该标签？（会从所有会话上移除）')) return;
      await api('/api/tags?id=' + btn.dataset.del, { method: 'DELETE' });
      if (state.tagFilter === btn.dataset.del) state.tagFilter = '';
      await loadSessions(false);
      if (state.current) renderDetailTags();
    };
  });
}

// 标记规则列表（内置不可删，自定义可删）
function renderRules() {
  $('#ruleList').innerHTML = Object.entries(state.flagDefs).map(([id, r]) =>
    `<div class="tag-item" style="cursor:default" title="${esc(r.desc || '')}">
       <span class="swatch" style="background:${esc(r.color)}"></span>${esc(r.name)}
       ${r.builtin ? '<span class="rule-builtin">内置</span>' : `<button class="del" data-rdel="${id}" title="删除规则">✕</button>`}
     </div>`).join('');
  document.querySelectorAll('[data-rdel]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('删除该规则？旧的 AI 分析会失效并在打开会话时重新归类')) return;
      const r = await api('/api/rules?id=' + btn.dataset.rdel, { method: 'DELETE' });
      if (r.error) return alert(r.error);
      await loadSessions(false);
      if (state.current) reopenCurrentFlags();
    };
  });
}
// 规则变化后刷新当前会话的标记（重新拉取，必要时自动触发 AI 分析）
async function reopenCurrentFlags() {
  const key = state.current.session.key;
  const d = await api('/api/session?key=' + encodeURIComponent(key));
  if (d.error || !state.current || state.current.session.key !== key) return;
  state.current.messages = d.messages;
  state.current.flagInfo = d.flagInfo;
  renderFlagBar();
  renderMessages('');
  if (d.flagInfo.source !== 'ai' && state.config.configured && state.config.autoAnalyze) doAnalyze(false);
}

// ---------------------------------------------------------------------------
// 中栏:会话列表 / 搜索结果
// ---------------------------------------------------------------------------
function filteredSessions() {
  let list = state.sessions.filter(s =>
    (!state.agent || s.agent === state.agent) &&
    (!state.project || (s.project || '(未知)') === state.project) &&
    (!state.tagFilter || (s.tags || []).includes(state.tagFilter))
  );
  const by = state.sort;
  list.sort((a, b) => {
    if (by === 'time-desc') return String(b.endTime).localeCompare(String(a.endTime));
    if (by === 'time-asc') return String(a.endTime).localeCompare(String(b.endTime));
    if (by === 'start-desc') return String(b.startTime).localeCompare(String(a.startTime));
    if (by === 'msg-desc') return b.messageCount - a.messageCount;
    if (by === 'title') return a.title.localeCompare(b.title, 'zh');
    return 0;
  });
  return list;
}

function renderList() {
  if (state.mode === 'search') return renderSearchResults();
  const list = filteredSessions();
  const filters = [];
  if (state.agent) filters.push(AGENT_NAME[state.agent]);
  if (state.project) filters.push('📁 ' + state.project);
  if (state.tagFilter) { const t = state.tags.find(t => t.id === state.tagFilter); if (t) filters.push('🏷 ' + t.name); }
  $('#listHeader').innerHTML = `<span>${list.length} 个会话${filters.length ? ' · ' + filters.map(esc).join(' / ') : ''}</span>` +
    (filters.length ? '<span class="clear" id="clearFilters">清除筛选</span>' : '');
  const cf = $('#clearFilters');
  if (cf) cf.onclick = () => { state.agent = ''; state.project = ''; state.tagFilter = ''; renderSidebar(); renderList(); };

  const tagMap = Object.fromEntries(state.tags.map(t => [t.id, t]));
  $('#sessionList').innerHTML = list.map(s => `
    <div class="sess ${state.current && state.current.session.key === s.key ? 'active' : ''}" data-key="${esc(s.key)}">
      <div class="sess-top">
        <span class="badge badge-${s.agent}">${AGENT_NAME[s.agent]}</span>
        <span class="sess-title">${esc(s.title)}</span>
      </div>
      <div class="sess-preview">${esc(s.preview)}</div>
      <div class="sess-meta">
        <span>🕒 ${fmtTime(s.endTime)}</span>
        <span>💬 ${s.messageCount}</span>
        ${s.project ? `<span>📁 ${esc(s.project)}</span>` : ''}
        ${s.hasSummary ? '<span title="已生成 AI 总结">✨</span>' : ''}
        <span class="sess-flags">${flagPills(s.flags)}</span>
        <span class="sess-tags">${(s.tags || []).map(id => tagMap[id] ? `<span class="mini-tag" style="background:${esc(tagMap[id].color)}">${esc(tagMap[id].name)}</span>` : '').join('')}</span>
      </div>
    </div>`).join('') || '<div style="padding:24px;color:var(--muted);text-align:center">没有匹配的会话</div>';
  document.querySelectorAll('.sess').forEach(el => {
    el.onclick = () => openSession(el.dataset.key);
  });
}

// 会话列表上的标记计数小徽章
function flagPills(flags) {
  if (!flags) return '';
  return Object.entries(flags)
    .filter(([k, n]) => n > 0 && state.flagDefs[k])
    .map(([k, n]) => `<span class="fp" style="background:${state.flagDefs[k].color}" title="${state.flagDefs[k].name}">${n}</span>`)
    .join('');
}

async function doSearch(q) {
  if (!q) { state.mode = 'list'; renderList(); return; }
  $('#listHeader').innerHTML = '<span>搜索中…</span>';
  const params = new URLSearchParams({ q });
  if (state.agent) params.set('agent', state.agent);
  const d = await api('/api/search?' + params);
  state.mode = 'search';
  state.searchResults = d.results;
  state.searchQuery = q;
  renderSearchResults();
}

function renderSearchResults() {
  const rs = state.searchResults;
  $('#listHeader').innerHTML = `<span>「${esc(state.searchQuery)}」命中 ${rs.length} 处</span><span class="clear" id="exitSearch">返回列表</span>`;
  $('#exitSearch').onclick = () => { state.mode = 'list'; $('#searchBox').value = ''; renderList(); };
  $('#sessionList').innerHTML = rs.map((r, i) => `
    <div class="sr" data-i="${i}">
      <div class="sr-top">
        <span class="badge badge-${r.agent}">${AGENT_NAME[r.agent]}</span>
        <span class="sr-title">${esc(r.title)}</span>
      </div>
      <div class="sr-top"><span>#${r.messageIndex + 1} · ${r.role}</span>${r.project ? `<span>📁 ${esc(r.project)}</span>` : ''}<span>${fmtTime(r.timestamp)}</span></div>
      <div class="sr-snippet">${highlight(r.snippet, state.searchQuery)}</div>
    </div>`).join('') || '<div style="padding:24px;color:var(--muted);text-align:center">未找到匹配内容</div>';
  document.querySelectorAll('.sr').forEach(el => {
    el.onclick = () => {
      const r = rs[Number(el.dataset.i)];
      state.pendingJump = r.messageIndex;
      openSession(r.sessionKey, state.searchQuery);
    };
  });
}

// ---------------------------------------------------------------------------
// 右栏:会话详情 + 消息内定位
// ---------------------------------------------------------------------------
const MAX_MSG_LEN = 1200;
async function openSession(key, highlightQ) {
  let d;
  if (window.STATIC_EXPORT_DATA) {
    const s = (window.STATIC_EXPORT_DATA.sessions || []).find(x => x.key === key);
    if (!s) return alert('未在离线数据中找到此会话');
    const msgs = (window.STATIC_EXPORT_DATA.sessionMessagesMap && window.STATIC_EXPORT_DATA.sessionMessagesMap[key]) || [];
    d = { session: s, messages: msgs, summary: null, flagInfo: null };
  } else {
    d = await api('/api/session?key=' + encodeURIComponent(key));
    if (d.error) return alert(d.error);
  }
  state.current = d;
  $('#detailEmpty').classList.add('hidden');
  $('#detailView').classList.remove('hidden');
  const s = d.session;
  $('#detailTitle').textContent = s.title;
  $('#detailMeta').innerHTML = [
    `<span class="badge badge-${s.agent}">${AGENT_NAME[s.agent]}</span>`,
    s.cwd ? `📁 ${esc(s.cwd)}` : (s.project ? `📁 ${esc(s.project)}` : ''),
    `🕒 ${fmtTime(s.startTime)} → ${fmtTime(s.endTime)}`,
    `💬 ${s.messageCount} 条消息`,
  ].filter(Boolean).join(' <span style="opacity:.4">|</span> ');
  renderDetailTags();
  renderFlagBar();
  renderSummaryPanel();
  renderMessages(highlightQ || '');
  document.querySelectorAll('.sess').forEach(el => el.classList.toggle('active', el.dataset.key === key));
  // 搜索跳转
  if (state.pendingJump != null) {
    jumpToMessage(state.pendingJump);
    state.pendingJump = null;
  } else {
    $('#messages').scrollTop = 0;
  }
  // 自动总结：已配置 API + 开关打开 + 尚无新版树形总结
  if (!(d.summary && Array.isArray(d.summary.tree)) && state.config.configured && state.config.autoSummary) {
    doSummarize(false);
  }
  // 自动 AI 标记分析：尚无有效 AI 分析结果时触发，结果会持久化供下次直接读取
  if (d.flagInfo && d.flagInfo.source !== 'ai' && state.config.configured && state.config.autoAnalyze) {
    doAnalyze(false);
  }
}

// ---------------------------------------------------------------------------
// 标记统计条:点击循环定位到下一处命中
// ---------------------------------------------------------------------------
function flagIndices(kind) {
  return state.current.messages.filter(m => (m.flags || []).includes(kind)).map(m => m.index);
}
function renderFlagBar() {
  state.flagCursor = {};
  const info = state.current.flagInfo || { source: 'regex' };
  const stats = Object.entries(state.flagDefs).map(([k, def]) => {
    const n = flagIndices(k).length;
    return `<button class="flag-stat ${n ? '' : 'disabled'}" data-flag="${k}" title="${esc(def.desc || '')}，点击跳到下一处">
      <span class="flag-dot" style="background:${def.color}"></span>${esc(def.name)}
      <span class="n" style="color:${def.color}">${n}</span>
      <span class="pos" data-pos="${k}"></span>
    </button>`;
  }).join('');
  // 来源标识 + AI 分析按钮
  const src = state.analyzing
    ? '<span class="flag-src">🤖 AI 分析中…</span>'
    : info.source === 'ai'
      ? `<span class="flag-src" title="分析于 ${fmtTime(info.at)}">🤖 AI 已归类</span><button class="mini-btn" id="btnReanalyze" title="忽略缓存重新分析">↻ 重新分析</button>`
      : `<span class="flag-src" title="未经 AI 分析，当前为关键词匹配结果">关键词匹配</span>` +
        (state.config.configured ? `<button class="mini-btn" id="btnReanalyze">🤖 AI 分析</button>` : '');
  $('#flagBar').innerHTML = stats + `<span class="flag-right">${src}<span class="flag-err" id="flagErr"></span></span>`;
  const rb = $('#btnReanalyze');
  if (rb) rb.onclick = () => doAnalyze(info.source === 'ai');
  document.querySelectorAll('.flag-stat').forEach(btn => {
    btn.onclick = () => {
      const k = btn.dataset.flag;
      const hits = flagIndices(k);
      if (!hits.length) return;
      state.flagCursor[k] = ((state.flagCursor[k] ?? -1) + 1) % hits.length;
      btn.querySelector('.pos').textContent = `${state.flagCursor[k] + 1}/${hits.length}`;
      jumpToMessage(hits[state.flagCursor[k]]);
    };
  });
}
// 调用 AI 对当前会话按规则归类（服务端持久化，命中缓存秒回）
async function doAnalyze(force) {
  if (!state.current || state.analyzing) return;
  const key = state.current.session.key;
  state.analyzing = true;
  renderFlagBar();
  const r = await api('/api/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, force }),
  });
  state.analyzing = false;
  if (!state.current || state.current.session.key !== key) return; // 已切走
  if (r.error) {
    renderFlagBar();
    const err = $('#flagErr');
    if (err) err.textContent = 'AI 分析失败：' + r.error.slice(0, 60);
    return;
  }
  // 把分析结果应用到消息上并刷新展示
  state.current.messages.forEach(m => {
    m.flags = Object.entries(r.analysis.flags).filter(([, arr]) => arr.includes(m.index)).map(([rid]) => rid);
  });
  state.current.flagInfo = { source: 'ai', at: r.analysis.at };
  const sess = state.sessions.find(x => x.key === key);
  if (sess) { sess.flags = r.counts; sess.analyzed = true; }
  renderFlagBar();
  renderMessages('');
  if (state.mode === 'list') renderList();
}

// ---------------------------------------------------------------------------
// AI 三层总结面板 (L2 会话摘要 + L3 阶段片段，点击跳转)
// ---------------------------------------------------------------------------
function renderSummaryPanel(loading, error) {
  const p = $('#summaryPanel');
  if (loading) { p.innerHTML = '<div class="sum-loading">✨ 正在生成递进式总结，请稍候…</div>'; return; }
  if (error) { p.innerHTML = `<div class="sum-error">总结失败：${esc(error)} <button class="mini-btn" id="sumRetry">重试</button></div>`; $('#sumRetry').onclick = () => doSummarize(false); return; }
  const sum = state.current && state.current.summary;
  if (!sum || !Array.isArray(sum.tree)) {
    // 自动模式下一般不会停留在这里；未配置 API 时给出提示
    p.innerHTML = `<div class="sum-head"><span class="sum-title">递进式总结</span><button class="mini-btn" id="btnSum">✨ 立即生成</button></div>` +
      (state.config.configured ? '' : '<div class="sum-body" style="color:var(--muted);font-size:12px">需先在左下角“API 设置”中配置接口。</div>');
    $('#btnSum').onclick = () => doSummarize(false);
    return;
  }
  // 递进式总结树：层数由 AI 判断，逐层可折叠，每个节点点击跳转
  const kindColor = { '用户提问': '#4f8cff', '用户操作': '#00a2c7', 'AI操作': '#58c98b', '执行测试': '#b58a00', '结果结论': '#8e4ec6' };
  const l3html = (nodes) => nodes.map(n =>
    `<div class="tn tn3" data-jump="${n.msg}"><span class="tn-msg">#${n.msg + 1}</span>${esc(n.title)}</div>`).join('');
  const l2html = (nodes) => nodes.map(n => `
    <details class="tn tn2" ${n.children && n.children.length ? '' : 'data-leaf="1"'} open>
      <summary><span class="kind" style="background:${kindColor[n.kind] || 'var(--bg3)'}">${esc(n.kind || '环节')}</span>
        <span class="tn-title" data-jump="${n.from}">${esc(n.title)}</span>
        <span class="tn-range" data-jump="${n.from}">#${n.from + 1}-${n.to + 1}</span></summary>
      ${n.summary ? `<div class="tn-sum">${esc(n.summary)}</div>` : ''}
      ${n.children && n.children.length ? l3html(n.children) : ''}
    </details>`).join('');
  const l1html = sum.tree.map(n => `
    <details class="tn tn1" open>
      <summary><span class="tn-title" data-jump="${n.from}">${esc(n.title)}</span>
        <span class="tn-range" data-jump="${n.from}">#${n.from + 1}-${n.to + 1}</span></summary>
      ${n.summary ? `<div class="tn-sum">${esc(n.summary)}</div>` : ''}
      ${n.children && n.children.length ? l2html(n.children) : ''}
    </details>`).join('');
  p.innerHTML = `
    <div class="sum-head"><span class="sum-title">递进式总结</span><button class="mini-btn" id="btnResum">↻ 重新生成</button></div>
    <div class="sum-body">${esc(sum.summary)}
      <div class="sum-topics">${(sum.topics || []).map(t => `<span class="sum-topic">${esc(t)}</span>`).join('')}</div>
    </div>
    <div class="sum-tree">${l1html}</div>`;
  $('#btnResum').onclick = () => doSummarize(true);
  p.querySelectorAll('[data-jump]').forEach(el => {
    el.onclick = e => { e.preventDefault(); e.stopPropagation(); jumpToMessage(Number(el.dataset.jump)); };
  });
}
async function doSummarize(force) {
  if (!state.current) return;
  const key = state.current.session.key;
  renderSummaryPanel(true);
  const r = await api('/api/summarize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, force }),
  });
  // 用户可能已切到其他会话，避免错位渲染
  if (!state.current || state.current.session.key !== key) return;
  if (r.error) return renderSummaryPanel(false, r.error);
  state.current.summary = r.summary;
  const sess = state.sessions.find(x => x.key === key);
  if (sess) sess.hasSummary = true;
  renderSummaryPanel();
}

function renderDetailTags() {
  const s = state.current.session;
  const cur = (state.sessions.find(x => x.key === s.key) || {}).tags || [];
  $('#detailTags').innerHTML = state.tags.map(t => {
    const on = cur.includes(t.id);
    return `<button class="tag-chip ${on ? 'on' : ''}" data-tag="${t.id}" style="${on ? 'background:' + esc(t.color) : ''}">${on ? '✓ ' : '＋'}${esc(t.name)}</button>`;
  }).join('') || '<span style="font-size:12px;color:var(--muted)">在左栏创建标签后可为会话打标</span>';
  document.querySelectorAll('.tag-chip').forEach(btn => {
    btn.onclick = async () => {
      const on = !btn.classList.contains('on');
      const r = await api('/api/assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: s.key, tagId: btn.dataset.tag, on }),
      });
      const sess = state.sessions.find(x => x.key === s.key);
      if (sess) sess.tags = r.tags;
      renderDetailTags();
      if (state.mode === 'list') renderList();
    };
  });
}

function renderMessages(q) {
  const msgs = state.current.messages;
  $('#messages').innerHTML = msgs.map(m => {
    const long = m.text.length > MAX_MSG_LEN;
    // 命中搜索词的消息不折叠，保证高亮可见
    const hit = q && m.text.toLowerCase().includes(q.toLowerCase());
    const shown = long && !hit ? m.text.slice(0, MAX_MSG_LEN) : m.text;
    const fl = (m.flags || []).filter(f => state.flagDefs[f]);
    const flagCls = fl.map(f => 'f-' + (state.flagDefs[f].builtin ? f : 'custom')).join(' ');
    const pills = fl.map(f => `<span class="flag-pill" style="background:${state.flagDefs[f].color}">${esc(state.flagDefs[f].name)}</span>`).join('');
    const border = fl.length ? `style="border-left:3px solid ${state.flagDefs[fl[0]].color}"` : '';
    return `<div class="msg msg-${m.role} ${flagCls}" data-idx="${m.index}">
      <div class="msg-head"><span class="msg-role">${m.role === 'user' ? '👤 用户' : m.role === 'assistant' ? '🤖 助手' : '🔧 工具'}</span><span>#${m.index + 1}</span><span>${fmtTime(m.timestamp)}</span>${pills}</div>
      <div class="msg-body" ${border}>${highlight(shown, q)}${long && !hit ? `<div class="msg-more" data-more="${m.index}">…展开全部 (${m.text.length} 字)</div>` : ''}</div>
    </div>`;
  }).join('');
  document.querySelectorAll('.msg-more').forEach(el => {
    el.onclick = () => {
      const m = msgs[Number(el.dataset.more)];
      el.parentElement.innerHTML = highlight(m.text, q);
    };
  });
  state.inSessionHits = []; state.inSessionIdx = -1;
  $('#inSessionInfo').textContent = '';
}

function jumpToMessage(idx) {
  const el = document.querySelector(`.msg[data-idx="${idx}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// 会话内查找:Enter 循环跳到下一个命中
function inSessionFind() {
  const q = $('#inSessionSearch').value.trim();
  if (!state.current) return;
  if (!q) { renderMessages(''); return; }
  if (!state.inSessionHits.length || state.inSessionQ !== q) {
    renderMessages(q);
    state.inSessionQ = q;
    state.inSessionHits = state.current.messages
      .filter(m => m.text.toLowerCase().includes(q.toLowerCase()))
      .map(m => m.index);
    state.inSessionIdx = -1;
  }
  if (!state.inSessionHits.length) { $('#inSessionInfo').textContent = '无匹配'; return; }
  state.inSessionIdx = (state.inSessionIdx + 1) % state.inSessionHits.length;
  $('#inSessionInfo').textContent = `${state.inSessionIdx + 1} / ${state.inSessionHits.length}`;
  jumpToMessage(state.inSessionHits[state.inSessionIdx]);
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
document.querySelectorAll('#agentList .nav-item').forEach(el => {
  el.onclick = () => {
    state.agent = el.dataset.agent;
    state.project = '';
    renderSidebar();
    if (state.mode === 'search') doSearch(state.searchQuery);
    else renderList();
  };
});
$('#sortSel').onchange = e => { state.sort = e.target.value; renderList(); };
$('#searchBox').onkeydown = e => { if (e.key === 'Enter') doSearch(e.target.value.trim()); };
$('#inSessionSearch').onkeydown = e => { if (e.key === 'Enter') inSessionFind(); };
$('#btnRefresh').onclick = () => loadSessions(true);

// 标签表单
let pickedColor = COLORS[0];
$('#colorPicker').innerHTML = COLORS.map((c, i) => `<div class="c ${i === 0 ? 'sel' : ''}" data-c="${c}" style="background:${c}"></div>`).join('');
document.querySelectorAll('#colorPicker .c').forEach(el => {
  el.onclick = () => {
    document.querySelectorAll('#colorPicker .c').forEach(x => x.classList.remove('sel'));
    el.classList.add('sel');
    pickedColor = el.dataset.c;
  };
});
$('#btnAddTag').onclick = () => { $('#tagForm').classList.toggle('hidden'); $('#tagName').focus(); };
$('#tagCancel').onclick = () => $('#tagForm').classList.add('hidden');
$('#tagSave').onclick = async () => {
  const name = $('#tagName').value.trim();
  if (!name) return;
  await api('/api/tags', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color: pickedColor }),
  });
  $('#tagName').value = '';
  $('#tagForm').classList.add('hidden');
  await loadSessions(false);
  if (state.current) renderDetailTags();
};
$('#tagName').onkeydown = e => { if (e.key === 'Enter') $('#tagSave').click(); };

// 标记规则表单（新增后由 AI 按描述归类）
let rulePickedColor = COLORS[7];
$('#ruleColorPicker').innerHTML = COLORS.map((c, i) => `<div class="c ${i === 7 ? 'sel' : ''}" data-c="${c}" style="background:${c}"></div>`).join('');
document.querySelectorAll('#ruleColorPicker .c').forEach(el => {
  el.onclick = () => {
    document.querySelectorAll('#ruleColorPicker .c').forEach(x => x.classList.remove('sel'));
    el.classList.add('sel');
    rulePickedColor = el.dataset.c;
  };
});
$('#btnAddRule').onclick = () => { $('#ruleForm').classList.toggle('hidden'); $('#ruleName').focus(); };
$('#ruleCancel').onclick = () => $('#ruleForm').classList.add('hidden');
$('#ruleSave').onclick = async () => {
  const name = $('#ruleName').value.trim();
  const desc = $('#ruleDesc').value.trim();
  if (!name || !desc) return alert('规则名称和判定描述都需填写');
  const r = await api('/api/rules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, desc, color: rulePickedColor }),
  });
  if (r.error) return alert(r.error);
  $('#ruleName').value = ''; $('#ruleDesc').value = '';
  $('#ruleForm').classList.add('hidden');
  await loadSessions(false); // 新规则使旧分析失效，计数回退到关键词匹配
  if (state.current) reopenCurrentFlags(); // 当前会话立即按新规则重新分析
};
$('#ruleDesc').onkeydown = e => { if (e.key === 'Enter') $('#ruleSave').click(); };

// ---------------------------------------------------------------------------
// API 设置弹窗
// ---------------------------------------------------------------------------
$('#btnSettings').onclick = async () => {
  const cfg = await api('/api/config');
  state.config = cfg;
  $('#cfgBase').value = cfg.baseUrl || '';
  $('#cfgModel').value = cfg.model || '';
  $('#cfgKey').value = '';
  $('#cfgAuto').checked = cfg.autoSummary !== false;
  $('#cfgAutoAnalyze').checked = cfg.autoAnalyze !== false;
  $('#cfgKeyHint').textContent = cfg.apiKeyMasked ? `已保存: ${cfg.apiKeyMasked}` : '未设置';
  $('#cfgStatus').textContent = '';
  $('#modalMask').classList.remove('hidden');
};
$('#cfgCancel').onclick = () => $('#modalMask').classList.add('hidden');
$('#modalMask').onclick = e => { if (e.target.id === 'modalMask') $('#modalMask').classList.add('hidden'); };
$('#cfgSave').onclick = async () => {
  const r = await api('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: $('#cfgBase').value, model: $('#cfgModel').value, apiKey: $('#cfgKey').value, autoSummary: $('#cfgAuto').checked, autoAnalyze: $('#cfgAutoAnalyze').checked }),
  });
  state.config = { ...state.config, configured: r.configured, autoSummary: r.autoSummary, autoAnalyze: r.autoAnalyze };
  $('#cfgStatus').textContent = r.configured ? '✓ 已保存，配置完整，可以开始总结' : '已保存，但配置不完整（Base URL/Key/模型都需填写）';
  if (r.configured) setTimeout(() => $('#modalMask').classList.add('hidden'), 800);
};

// ---------------------------------------------------------------------------
// 全局总览弹窗 (L1)，含批量总结
// ---------------------------------------------------------------------------
let batchRunning = false;
$('#btnOverview').onclick = async () => {
  $('#overviewMask').classList.remove('hidden');
  const d = await api('/api/overview');
  renderOverview(d.overview);
};
$('#ovClose').onclick = () => { if (!batchRunning) $('#overviewMask').classList.add('hidden'); };
$('#overviewMask').onclick = e => { if (e.target.id === 'overviewMask' && !batchRunning) $('#overviewMask').classList.add('hidden'); };
$('#ovRefresh').onclick = () => generateOverview();

function renderOverview(ov) {
  const body = $('#overviewBody');
  if (!ov) {
    const nSum = state.sessions.filter(s => s.hasSummary).length;
    body.innerHTML = `<div class="ov-text" style="color:var(--muted)">尚未生成全局总览。<br>
      当前 ${state.sessions.length} 个会话中已有 ${nSum} 个生成了会话摘要；先批量总结各会话可让总览更准确（也可直接基于标题生成）。</div>
      <div style="display:flex;gap:8px">
        <button class="mini-btn" id="ovGenNow" style="padding:6px 14px">✨ 直接生成总览</button>
        <button class="mini-btn" id="ovBatch" style="padding:6px 14px">⚡ 先批量总结全部会话，再生成总览</button>
      </div><div id="ovProg" class="hint"></div>`;
    $('#ovGenNow').onclick = () => generateOverview();
    $('#ovBatch').onclick = () => batchSummarize();
    return;
  }
  const byKey = Object.fromEntries(state.sessions.map(s => [s.key, s]));
  body.innerHTML = `<div class="ov-text">${esc(ov.overview)}</div>` +
    ov.themes.map(t => `
      <div class="theme">
        <div class="theme-head">${esc(t.title)} <span style="color:var(--muted);font-weight:400">(${t.sessionKeys.length})</span></div>
        <div class="theme-sum">${esc(t.summary)}</div>
        ${t.sessionKeys.map(k => {
          const s = byKey[k];
          if (!s) return '';
          return `<div class="theme-sess" data-key="${esc(k)}">
            <span class="badge badge-${s.agent}">${AGENT_NAME[s.agent]}</span>
            <span class="t">${esc(s.title)}</span>
            <span style="margin-left:auto;color:var(--muted);flex:none">${fmtTime(s.endTime)}</span>
          </div>`;
        }).join('')}
      </div>`).join('') +
    `<div class="hint">生成于 ${fmtTime(ov.at)} · 点击会话可直接打开</div><div id="ovProg" class="hint"></div>`;
  body.querySelectorAll('.theme-sess').forEach(el => {
    el.onclick = () => {
      $('#overviewMask').classList.add('hidden');
      openSession(el.dataset.key);
    };
  });
}
async function generateOverview() {
  $('#overviewBody').innerHTML = '<div class="sum-loading">✨ 正在生成全局总览…</div>';
  const r = await api('/api/overview', { method: 'POST' });
  if (r.error) {
    $('#overviewBody').innerHTML = `<div class="sum-error">生成失败：${esc(r.error)}</div>`;
    return;
  }
  renderOverview(r.overview);
}
// 逐个调用 /api/summarize（串行，避免并发打爆 API）
async function batchSummarize() {
  if (batchRunning) return;
  batchRunning = true;
  const todo = state.sessions.filter(s => !s.hasSummary);
  const prog = () => $('#ovProg');
  let done = 0, failed = 0;
  for (const s of todo) {
    if (prog()) prog().textContent = `批量总结中… ${done + failed + 1}/${todo.length}（失败 ${failed}）：${s.title.slice(0, 30)}`;
    const r = await api('/api/summarize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: s.key }),
    });
    if (r.error) { failed++; if (/请先.*配置|API 401|API 403/.test(r.error)) break; }
    else { done++; s.hasSummary = true; }
  }
  batchRunning = false;
  if (prog()) prog().textContent = `批量总结完成：成功 ${done}，失败 ${failed}。正在生成总览…`;
  await generateOverview();
}

if ($('#btnExportGitPages')) {
  $('#btnExportGitPages').onclick = async () => {
    if (window.STATIC_EXPORT_DATA) {
      alert('当前页面已处于离线 Pages 模式！');
      return;
    }
    $('#btnExportGitPages').textContent = '📦 导出中…';
    try {
      const res = await api('/api/export-static', { method: 'POST' });
      if (res.ok) {
        alert(`静态网站打包成功！\n共导出 ${res.sessionCount} 个会话。\n文件位置：${res.distDir}\n\n【如何部署到 GitHub Pages】：\n1. 将生成的 dist 文件夹包含在 Git 提交中（或推送到 gh-pages 分支）。\n2. 在 GitHub 仓库设置 Settings -> Pages 中选择该分支/目录（如 /docs 或 gh-pages）发布即可！`);
      } else {
        alert('导出失败：' + (res.error || '未知错误'));
      }
    } catch (e) {
      alert('导出出错：' + e.message);
    } finally {
      $('#btnExportGitPages').textContent = '📦 导出 GitHub Pages 产物';
    }
  };
}

// ---------------------------------------------------------------------------
// 本地浏览器直接选择文件夹/日志文件解析 (用于 GitHub Pages 等静态部署)
// ---------------------------------------------------------------------------
if ($('#btnLoadLocal') && $('#localFileInput')) {
  $('#btnLoadLocal').onclick = () => $('#localFileInput').click();
  $('#localFileInput').onchange = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    
    $('#btnLoadLocal').textContent = '⏳ 解析中…';
    try {
      const parsedSessions = [];
      for (const file of files) {
        const path = file.webkitRelativePath || file.name;
        // 匹配 json / jsonl 文件
        if (!/\.(json|jsonl)$/i.test(path)) continue;
        
        try {
          const text = await file.text();
          let messages = [];
          if (path.endsWith('.jsonl')) {
            const lines = text.split('\n');
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const item = JSON.parse(line);
                if (item.type === 'USER_INPUT' || item.type === 'PLANNER_RESPONSE' || item.role || item.content) {
                  const role = item.role || (item.type === 'USER_INPUT' ? 'user' : 'assistant');
                  let contentStr = '';
                  if (typeof item.content === 'string') contentStr = item.content;
                  else if (Array.isArray(item.content)) {
                    contentStr = item.content.map(c => typeof c === 'string' ? c : (c.text || JSON.stringify(c))).join('\n');
                  } else if (item.content) {
                    contentStr = JSON.stringify(item.content);
                  }
                  if (contentStr) messages.push({ role, content: contentStr });
                }
              } catch (_) {}
            }
          } else {
            const data = JSON.parse(text);
            if (Array.isArray(data)) {
              messages = data;
            } else if (data.messages && Array.isArray(data.messages)) {
              messages = data.messages;
            }
          }
          
          if (messages.length > 0) {
            let agent = 'gemini';
            if (/claude/i.test(path)) agent = 'claude';
            else if (/codex/i.test(path)) agent = 'codex';
            else if (/qoder/i.test(path)) agent = 'qoder';
            else if (/opencode/i.test(path)) agent = 'opencode';
            else if (/openclaw/i.test(path)) agent = 'openclaw';
            
            const firstUserMsg = messages.find(m => m.role === 'user' || m.type === 'USER_INPUT')?.content || file.name;
            const title = firstUserMsg.slice(0, 60).replace(/\n/g, ' ');
            
            parsedSessions.push({
              key: 'local_' + Math.random().toString(36).slice(2, 9),
              agent,
              project: path.split('/')[0] || 'Local Import',
              title,
              msgCount: messages.length,
              mtime: file.lastModified || Date.now(),
              messages
            });
          }
        } catch (_) {}
      }

      if (parsedSessions.length > 0) {
        state.sessions = parsedSessions;
        window.LOCAL_SESSION_STORE = {};
        parsedSessions.forEach(s => { window.LOCAL_SESSION_STORE[s.key] = s; });
        renderSidebar();
        renderRules();
        renderList();
        alert(`成功导入并在内存中解析了 ${parsedSessions.length} 个本地会话！`);
      } else {
        alert('未在所选文件夹中找到有效的 JSON/JSONL 日志会话文件。');
      }
    } catch (err) {
      alert('解析本地文件出错: ' + err.message);
    } finally {
      $('#btnLoadLocal').textContent = '📂 选择本地日志目录/文件';
    }
  };
}

// 代理 openSession 方法以支持本地离线直接调取数据
const originalOpenSession = window.openSession;
window.openSession = async function(key) {
  if (window.LOCAL_SESSION_STORE && window.LOCAL_SESSION_STORE[key]) {
    const s = window.LOCAL_SESSION_STORE[key];
    state.current = { session: s, messages: s.messages, summary: null, flagInfo: [] };
    if ($('#sessionDetail')) $('#sessionDetail').style.display = 'block';
    if ($('#emptyState')) $('#emptyState').style.display = 'none';
    renderDetail();
    return;
  }
  if (typeof originalOpenSession === 'function') {
    return originalOpenSession(key);
  }
};

if ($('#btnLangToggle')) {
  $('#btnLangToggle').onclick = () => {
    state.lang = state.lang === 'zh' ? 'en' : 'zh';
    localStorage.setItem('agent_switch_lang', state.lang);
    renderSidebar();
    renderRules();
    renderList();
    if (state.current) renderDetail();
  };
}

// 启动：先取配置（自动总结开关依赖），再加载会话
if (!window.STATIC_EXPORT_DATA) {
  api('/api/config').then(cfg => { state.config = cfg; }).catch(() => {});
}
loadSessions(false);

