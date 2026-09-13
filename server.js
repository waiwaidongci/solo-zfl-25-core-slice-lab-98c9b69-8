import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "core-slices.json");
const port = Number(process.env.PORT || 3025);
const statuses = ["待切割", "制片中", "待观察", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];
const resolutions = ["续作", "退回"];

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      slices: [
        { id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨", logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" }, { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }] }
      ]
    }
  ],
  events: []
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (!Array.isArray(db.events)) db.events = [];
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function updateSampleStatus(sample) {
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) sample.status = "待观察";
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else sample.status = "待切割";
}

// 切片在样本间可能重号，事件关联统一使用 样本号|切片号 复合键
const sliceKey = (sampleId, sliceId) => `${sampleId}|${sliceId}`;
function findSlice(db, sampleId, sliceId) {
  const sample = db.samples.find(item => item.id === sampleId);
  const slice = sample && sample.slices.find(item => item.id === sliceId);
  return { sample, slice };
}
// 开放事件 → 冻结切片索引
function openEventBySlice(db) {
  const map = new Map();
  for (const event of db.events.filter(item => item.status === "开放")) {
    for (const target of event.slices) map.set(sliceKey(target.sampleId, target.sliceId), event);
  }
  return map;
}
// 串行化所有写操作，保证并发解除/登记时只有一个生效
let mutationQueue = Promise.resolve();
function mutate(fn) {
  const run = mutationQueue.then(fn);
  mutationQueue = run.catch(() => {});
  return run;
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; --danger:#8c3b2e; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    aside { display:grid; gap:22px; align-content:start; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    select[multiple] { min-height:130px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button:disabled { background:#b9c0b2; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(6,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.open { background:#f8e7e3; border-color:#e0b7b0; color:var(--danger); }
    .pill.done { background:#e6efe2; border-color:#b9d0ae; color:var(--accent); }
    .pill.frozen { background:#fdf3e0; border-color:#e6c98a; color:#8a6413; }
    .slice { border-top:1px solid var(--line); padding-top:10px; } .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
    .panel { margin-bottom:14px; } .event-head { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">样本、切片任务、制片步骤、交付与污染事件联动处置</div></div><button id="reload">刷新</button></header>
  <main>
    <aside>
      <form id="form">
        <h2>创建岩芯样本</h2>
        <label>项目</label><input name="project" required>
        <label>钻孔编号</label><input name="borehole" required>
        <label>岩芯箱号</label><input name="coreBox" required>
        <label>取样深度</label><input name="depth" required>
        <label>负责人</label><input name="owner" required>
        <label>初始切片编号</label><input name="sliceId" required>
        <label>染色方法</label><input name="method" required>
        <button>保存样本</button>
      </form>
      <form id="eventForm">
        <h2>登记污染事件</h2>
        <label>事件编号（重复提交只生效一次）</label><input name="eventNo" readonly>
        <label>涉及切片（按住 Ctrl 多选）</label><select name="sliceKeys" multiple required></select>
        <label>污染原因</label><textarea name="reason" required placeholder="如：染色剂交叉污染"></textarea>
        <label>处置工序</label><select name="handlingStep"></select>
        <label>登记人</label><input name="registeredBy" required>
        <button>登记事件并冻结切片</button>
      </form>
    </aside>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel"><div class="event-head"><h2>污染事件</h2><span class="meta" id="eventSummary"></span></div><div class="grid" id="events"></div></div>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};
    const form = document.querySelector("#form");
    const eventForm = document.querySelector("#eventForm");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const eventsEl = document.querySelector("#events");
    const eventSummary = document.querySelector("#eventSummary");
    let samples = [];
    let events = [];
    const newEventNo = () => "EVT-" + Date.now().toString(36).toUpperCase();
    const fmt = iso => iso ? new Date(iso).toLocaleString("zh-CN") : "";
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "请求失败");
      return data;
    }
    async function run(fn) { try { await fn(); } catch (error) { alert(error.message); } }
    function frozenMap() {
      const map = new Map();
      events.filter(event => event.status === "开放").forEach(event => event.slices.forEach(target => map.set(target.sampleId + "|" + target.sliceId, event)));
      return map;
    }
    function render() {
      const frozen = frozenMap();
      const openCount = events.filter(event => event.status === "开放").length;
      stats.innerHTML = statuses.map(s => '<div class="stat"><span>'+s+'</span><strong>'+samples.filter(item => item.status === s).length+'</strong></div>').join("")
        + '<div class="stat"><span>开放事件</span><strong>'+openCount+'</strong></div>'
        + '<div class="stat"><span>冻结切片</span><strong>'+frozen.size+'</strong></div>';
      eventSummary.textContent = events.length ? "共 "+events.length+" 起，开放 "+openCount+" 起" : "暂无事件";
      renderEventForm(frozen);
      renderEvents();
      renderSamples(frozen);
    }
    function renderEventForm(frozen) {
      const select = eventForm.elements.sliceKeys;
      select.innerHTML = samples.flatMap(sample => sample.slices.map(slice => {
        const key = sample.id+"|"+slice.id;
        const held = frozen.get(key);
        return '<option value="'+key+'">'+slice.id+' · '+sample.project+'（'+slice.status+'）'+(held ? "【冻结中 "+held.id+"】" : "")+'</option>';
      })).join("");
      eventForm.elements.handlingStep.innerHTML = steps.map(step => '<option>'+step+'</option>').join("");
    }
    function renderEvents() {
      eventsEl.innerHTML = events.length ? events.map(event => {
        const sliceNames = event.slices.map(target => target.sliceId+"（"+target.sampleId+"）").join("、");
        const head = '<div class="event-head"><h3>'+event.id+'</h3><span class="pill '+(event.status === "开放" ? "open" : "done")+'">'+event.status+'</span></div>'
          + '<div class="meta">编号 '+event.eventNo+' · 原因：'+event.reason+' · 处置工序：'+event.handlingStep+'</div>'
          + '<div class="meta">'+(event.status === "开放" ? "冻结切片" : "关联切片")+'：'+sliceNames+'</div>'
          + '<div class="meta">登记人：'+event.registeredBy+' · '+fmt(event.createdAt)+'</div>';
        if (event.status === "开放") {
          return '<article class="card">'+head
            + '<label>解除人（不能与登记人相同）</label><input data-releaser="'+event.id+'" placeholder="签核人姓名">'
            + '<label>解除依据</label><textarea data-basis="'+event.id+'" placeholder="复检结论、处置记录等"></textarea>'
            + '<label>处置方式</label><select data-resolution="'+event.id+'"><option>续作</option><option>退回</option></select>'
            + '<label>退回工序（选择退回时生效）</label><select data-returnstep="'+event.id+'">'+steps.map(step => '<option>'+step+'</option>').join("")+'</select>'
            + '<button data-release="'+event.id+'">解除事件</button></article>';
        }
        return '<article class="card">'+head
          + '<div class="meta">解除人：'+event.releasedBy+' · '+fmt(event.releasedAt)+'</div>'
          + '<div class="meta">解除依据：'+event.releaseBasis+'</div>'
          + '<div class="meta">处置结果：'+(event.resolution === "退回" ? "退回工序「"+event.returnStep+"」" : "续作")+'</div></article>';
      }).join("") : '<div class="meta">尚未登记污染事件。</div>';
      document.querySelectorAll("[data-release]").forEach(btn => btn.onclick = () => run(async () => {
        const id = btn.dataset.release;
        await api('/api/events/'+id+'/release', { method:'POST', body: JSON.stringify({
          releasedBy: document.querySelector('[data-releaser="'+id+'"]').value,
          basis: document.querySelector('[data-basis="'+id+'"]').value,
          resolution: document.querySelector('[data-resolution="'+id+'"]').value,
          returnStep: document.querySelector('[data-returnstep="'+id+'"]').value
        }) });
        await load();
      }));
    }
    function renderSamples(frozen) {
      samplesEl.innerHTML = samples.map(sample => '<article class="card"><h3>'+sample.project+'</h3><span class="pill">'+sample.status+'</span><div class="meta">'+sample.borehole+' · '+sample.coreBox+' · '+sample.depth+' · '+sample.owner+'</div><label>新增切片</label><input data-new-slice="'+sample.id+'" placeholder="切片编号"><input data-method="'+sample.id+'" placeholder="染色方法"><button data-add="'+sample.id+'">添加切片</button>'+sample.slices.map(slice => {
        const held = frozen.get(sample.id+"|"+slice.id);
        return '<div class="slice"><b>'+slice.id+'</b> '+(held ? '<span class="pill frozen">冻结中 · '+held.id+'</span>' : "")+'<div class="meta">'+slice.method+' · 当前步骤 '+slice.status+'</div><select data-step="'+sample.id+'|'+slice.id+'">'+steps.map(step => '<option>'+step+'</option>').join("")+'</select><textarea data-note="'+sample.id+'|'+slice.id+'" placeholder="步骤备注或观察结果"></textarea><button data-log="'+sample.id+'|'+slice.id+'" '+(held ? "disabled" : "")+'>记录步骤</button><div class="meta">'+slice.logs.map(log => log.step+"："+log.note).join(" / ")+'</div></div>';
      }).join("")+'<button data-deliver="'+sample.id+'">标记交付</button></article>').join("");
      document.querySelectorAll("[data-step]").forEach(sel => {
        const [sampleId, sliceId] = sel.dataset.step.split("|");
        const slice = samples.find(s => s.id === sampleId).slices.find(s => s.id === sliceId);
        sel.value = slice.status;
      });
      document.querySelectorAll("[data-add]").forEach(btn => btn.onclick = () => run(async () => {
        const id = btn.dataset.add;
        await api('/api/samples/'+id+'/slices', { method:'POST', body: JSON.stringify({ id: document.querySelector('[data-new-slice="'+id+'"]').value, method: document.querySelector('[data-method="'+id+'"]').value || "未指定" }) });
        await load();
      }));
      document.querySelectorAll("[data-log]").forEach(btn => btn.onclick = () => run(async () => {
        const [sampleId, sliceId] = btn.dataset.log.split("|");
        await api('/api/samples/'+sampleId+'/slices/'+sliceId+'/logs', { method:'POST', body: JSON.stringify({ step: document.querySelector('[data-step="'+sampleId+'|'+sliceId+'"]').value, note: document.querySelector('[data-note="'+sampleId+'|'+sliceId+'"]').value || "步骤完成" }) });
        await load();
      }));
      document.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = () => run(async () => { await api('/api/samples/'+btn.dataset.deliver+'/deliver', { method:'POST', body: JSON.stringify({}) }); await load(); }));
    }
    async function load(){
      [samples, events] = await Promise.all([api("/api/samples"), api("/api/events")]);
      render();
    }
    document.querySelector("#reload").onclick = load;
    form.onsubmit = event => {
      event.preventDefault();
      run(async () => {
        await api("/api/samples", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset(); await load();
      });
    };
    eventForm.onsubmit = event => {
      event.preventDefault();
      run(async () => {
        const fd = new FormData(eventForm);
        const result = await api("/api/events", { method:"POST", body: JSON.stringify({
          eventNo: fd.get("eventNo"),
          reason: fd.get("reason"),
          handlingStep: fd.get("handlingStep"),
          registeredBy: fd.get("registeredBy"),
          sliceKeys: fd.getAll("sliceKeys")
        }) });
        if (result.duplicated) alert("该事件编号已登记过，本次提交未重复生效。");
        eventForm.reset();
        eventForm.elements.eventNo.value = newEventNo();
        await load();
      });
    };
    eventForm.elements.eventNo.value = newEventNo();
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/samples") return sendJson(res, 200, (await loadDb()).samples);
    if (req.method === "GET" && url.pathname === "/api/events") return sendJson(res, 200, (await loadDb()).events);
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const result = await mutate(async () => {
        const db = await loadDb();
        const sample = { id: `CORE-${Date.now()}`, project: input.project, borehole: input.borehole, coreBox: input.coreBox, depth: input.depth, owner: input.owner, status: "待切割", delivery: "未交付", slices: [{ id: input.sliceId, method: input.method, observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "创建初始切片任务" }] }] };
        updateSampleStatus(sample);
        db.samples.unshift(sample);
        await saveDb(db);
        return { status: 201, data: sample };
      });
      return sendJson(res, result.status, result.data);
    }
    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const input = await body(req);
      const result = await mutate(async () => {
        const db = await loadDb();
        const sample = db.samples.find(item => item.id === addSlice[1]);
        if (!sample) return { status: 404, data: { error: "sample_not_found", message: "样本不存在" } };
        sample.slices.push({ id: input.id, method: input.method || "未指定", observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }] });
        updateSampleStatus(sample);
        await saveDb(db);
        return { status: 201, data: sample };
      });
      return sendJson(res, result.status, result.data);
    }
    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const input = await body(req);
      const result = await mutate(async () => {
        const db = await loadDb();
        const sample = db.samples.find(item => item.id === logMatch[1]);
        if (!sample) return { status: 404, data: { error: "sample_not_found", message: "样本不存在" } };
        const slice = sample.slices.find(item => item.id === logMatch[2]);
        if (!slice) return { status: 404, data: { error: "slice_not_found", message: "切片不存在" } };
        const held = openEventBySlice(db).get(sliceKey(sample.id, slice.id));
        if (held) return { status: 409, data: { error: "slice_frozen", message: `切片 ${slice.id} 正处于污染事件 ${held.id} 冻结中，不能推进工序`, event: held.id } };
        slice.status = input.step;
        if (input.step === "观察") slice.observation = input.note || slice.observation;
        slice.logs.push({ at: new Date().toISOString(), step: input.step, note: input.note || "" });
        updateSampleStatus(sample);
        await saveDb(db);
        return { status: 200, data: sample };
      });
      return sendJson(res, result.status, result.data);
    }
    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const result = await mutate(async () => {
        const db = await loadDb();
        const sample = db.samples.find(item => item.id === deliverMatch[1]);
        if (!sample) return { status: 404, data: { error: "sample_not_found", message: "样本不存在" } };
        const frozen = openEventBySlice(db);
        const affected = sample.slices
          .filter(slice => frozen.has(sliceKey(sample.id, slice.id)))
          .map(slice => ({ sliceId: slice.id, event: frozen.get(sliceKey(sample.id, slice.id)).id, reason: frozen.get(sliceKey(sample.id, slice.id)).reason }));
        if (affected.length) {
          const scope = affected.map(item => `${item.sliceId}（事件 ${item.event}：${item.reason}）`).join("、");
          return { status: 409, data: { error: "batch_has_frozen_slices", message: `批次存在冻结切片，拒绝交付。影响范围：${scope}`, affected } };
        }
        sample.delivery = "已交付";
        updateSampleStatus(sample);
        await saveDb(db);
        return { status: 200, data: sample };
      });
      return sendJson(res, result.status, result.data);
    }
    if (req.method === "POST" && url.pathname === "/api/events") {
      const input = await body(req);
      const result = await mutate(async () => {
        const db = await loadDb();
        const eventNo = String(input.eventNo || "").trim();
        if (eventNo) {
          const existing = db.events.find(item => item.eventNo === eventNo);
          if (existing) return { status: 200, data: { ...existing, duplicated: true } };
        }
        const reason = String(input.reason || "").trim();
        const registeredBy = String(input.registeredBy || "").trim();
        const handlingStep = String(input.handlingStep || "").trim();
        const sliceKeys = [...new Set(Array.isArray(input.sliceKeys) ? input.sliceKeys.map(String) : [])];
        if (!reason) return { status: 400, data: { error: "reason_required", message: "请填写污染原因" } };
        if (!registeredBy) return { status: 400, data: { error: "registrar_required", message: "请填写登记人" } };
        if (!taskSteps.includes(handlingStep)) return { status: 400, data: { error: "handling_step_invalid", message: "请选择有效的处置工序" } };
        if (!sliceKeys.length) return { status: 400, data: { error: "slices_required", message: "请至少选择一张切片" } };
        const frozen = openEventBySlice(db);
        const conflicts = [];
        const targets = [];
        for (const key of sliceKeys) {
          const [sampleId, sliceId] = key.split("|");
          const { slice } = findSlice(db, sampleId, sliceId);
          if (!slice) return { status: 404, data: { error: "slice_not_found", message: `切片不存在：${key}` } };
          const held = frozen.get(key);
          if (held) conflicts.push({ sliceId, sampleId, event: held.id });
          else targets.push({ sampleId, sliceId });
        }
        if (conflicts.length) {
          const scope = conflicts.map(item => `${item.sliceId}（已在事件 ${item.event}）`).join("、");
          return { status: 409, data: { error: "slice_already_frozen", message: `同一切片不能同时处于两个开放事件：${scope}`, conflicts } };
        }
        const event = {
          id: `EVT-${Date.now().toString(36).toUpperCase()}`,
          eventNo: eventNo || `EVT-${Date.now().toString(36).toUpperCase()}`,
          reason,
          handlingStep,
          slices: targets,
          registeredBy,
          status: "开放",
          createdAt: new Date().toISOString(),
          releasedBy: null,
          releaseBasis: null,
          resolution: null,
          returnStep: null,
          releasedAt: null
        };
        db.events.unshift(event);
        for (const target of targets) {
          const { slice } = findSlice(db, target.sampleId, target.sliceId);
          slice.logs.push({ at: new Date().toISOString(), step: slice.status, note: `污染事件 ${event.id} 登记冻结（登记人 ${registeredBy}）：${reason}` });
        }
        await saveDb(db);
        return { status: 201, data: event };
      });
      return sendJson(res, result.status, result.data);
    }
    const releaseMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/release$/);
    if (releaseMatch && req.method === "POST") {
      const input = await body(req);
      const result = await mutate(async () => {
        const db = await loadDb();
        const event = db.events.find(item => item.id === releaseMatch[1]);
        if (!event) return { status: 404, data: { error: "event_not_found", message: "事件不存在" } };
        if (event.status !== "开放") return { status: 409, data: { error: "event_already_released", message: `事件 ${event.id} 已由 ${event.releasedBy} 解除，不能重复解除`, event } };
        const releasedBy = String(input.releasedBy || "").trim();
        const basis = String(input.basis || "").trim();
        const resolution = String(input.resolution || "").trim();
        const returnStep = String(input.returnStep || "").trim();
        if (!releasedBy) return { status: 400, data: { error: "releaser_required", message: "请填写解除人" } };
        if (releasedBy === event.registeredBy) return { status: 409, data: { error: "same_person", message: "解除人不能与登记人相同" } };
        if (!basis) return { status: 400, data: { error: "basis_required", message: "请填写解除依据" } };
        if (!resolutions.includes(resolution)) return { status: 400, data: { error: "resolution_invalid", message: "请选择续作或退回" } };
        if (resolution === "退回") {
          if (!taskSteps.includes(returnStep)) return { status: 400, data: { error: "return_step_invalid", message: "退回时必须选择指定工序" } };
          // 退回只能沿工序链向回走：每张关联切片按各自当前位置分别判断，任一不满足则整单拒绝
          const returnIdx = taskSteps.indexOf(returnStep);
          const notBackward = [];
          for (const target of event.slices) {
            const { slice } = findSlice(db, target.sampleId, target.sliceId);
            if (!slice) continue;
            if (returnIdx >= taskSteps.indexOf(slice.status)) notBackward.push({ sliceId: target.sliceId, current: slice.status });
          }
          if (notBackward.length) {
            const detail = notBackward.map(item => `${item.sliceId}（当前 ${item.current}）`).join("、");
            return { status: 400, data: { error: "return_step_not_backward", message: `退回目标工序必须早于切片当前工序：${detail}`, notBackward } };
          }
        }
        event.status = "已解除";
        event.releasedBy = releasedBy;
        event.releaseBasis = basis;
        event.resolution = resolution;
        event.returnStep = resolution === "退回" ? returnStep : null;
        event.releasedAt = new Date().toISOString();
        for (const target of event.slices) {
          const { sample, slice } = findSlice(db, target.sampleId, target.sliceId);
          if (!slice) continue;
          if (resolution === "退回") slice.status = returnStep;
          slice.logs.push({ at: new Date().toISOString(), step: slice.status, note: `污染事件 ${event.id} 解除（解除人 ${releasedBy}）：${resolution === "退回" ? `退回工序「${returnStep}」` : "续作"}。依据：${basis}` });
          if (sample) updateSampleStatus(sample);
        }
        await saveDb(db);
        return { status: 200, data: event };
      });
      return sendJson(res, result.status, result.data);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
