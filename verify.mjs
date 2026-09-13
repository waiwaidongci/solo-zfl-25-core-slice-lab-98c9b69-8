// 污染事件联动处置全流程验证：登记、冻结、续作、返工、重复提交、并发解除、重启保留
// 用法：node verify.mjs          —— 跑完整流程（输出运行标识 RUN）
//      node verify.mjs check <RUN> —— 服务重启后校验数据保留
const base = `http://localhost:${process.env.PORT || 3025}`;
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}
async function api(path, options = {}) {
  const res = await fetch(base + path, options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const post = (path, payload) => api(path, { method: "POST", body: JSON.stringify(payload ?? {}) });

async function checkPersist(run) {
  const events = (await api("/api/events")).data;
  const samples = (await api("/api/samples")).data;
  const byNo = no => events.find(e => e.eventNo === no);
  const e1 = byNo(`EVT-VERIFY-${run}`);
  const e3 = byNo(`EVT-VERIFY3-${run}`);
  const e4 = byNo(`EVT-VERIFY4-${run}`);
  check("重启后事件记录保留", !!(e1 && e3 && e4), `共 ${events.length} 起事件`);
  check("重启后续作解除状态保留", e1?.status === "已解除" && e1?.resolution === "续作" && e1?.releasedBy === "苏晴");
  check("重启后退回解除状态保留", e3?.status === "已解除" && e3?.resolution === "退回" && e3?.returnStep === "切割");
  check("重启后并发解除结果保留", e4?.status === "已解除" && ["苏晴", "韩冰"].includes(e4?.releasedBy));
  const a1 = samples.flatMap(s => s.slices).find(sl => sl.id === `SL-A1-${run}`);
  const b1 = samples.flatMap(s => s.slices).find(sl => sl.id === `SL-B1-${run}`);
  // 并发解除的胜者决定 SL-B1 的落点：续作胜则保持切割，退回胜则为退回工序
  const expectedB1 = e4?.resolution === "退回" ? e4.returnStep : "切割";
  check("重启后切片工序状态保留", b1?.status === expectedB1 && !!a1, `SL-B1=${b1?.status}（并发解除胜方：${e4?.releasedBy} ${e4?.resolution}）`);
  const delivered = samples.find(s => s.slices.some(sl => sl.id === `SL-A1-${run}`));
  check("重启后交付状态保留", delivered?.delivery === "已交付");
  console.log(failures ? `\n${failures} 项未通过` : "\n重启保留校验全部通过");
  process.exit(failures ? 1 : 0);
}

async function main() {
  const run = Date.now().toString(36);
  console.log(`RUN=${run}`);

  // 准备：样本A（两张切片）、样本B（一张切片）
  const a = await post("/api/samples", { project: `验证矿段A-${run}`, borehole: "ZK-A", coreBox: "BX-A", depth: "10-11m", owner: "陆川", sliceId: `SL-A1-${run}`, method: "茜素红染色" });
  const sampleA = a.data.id;
  await post(`/api/samples/${sampleA}/slices`, { id: `SL-A2-${run}`, method: "未染色" });
  await post(`/api/samples/${sampleA}/slices/SL-A1-${run}/logs`, { step: "切割", note: "粗切完成" });
  const b = await post("/api/samples", { project: `验证矿段B-${run}`, borehole: "ZK-B", coreBox: "BX-B", depth: "20-21m", owner: "陆川", sliceId: `SL-B1-${run}`, method: "刚果红染色" });
  const sampleB = b.data.id;
  check("准备样本与切片", a.status === 201 && b.status === 201, `A=${sampleA} B=${sampleB}`);

  // 1. 登记事件：多选切片 + 原因 + 处置工序
  const eventNo = `EVT-VERIFY-${run}`;
  const e1 = await post("/api/events", { eventNo, reason: "染色剂交叉污染", handlingStep: "研磨", registeredBy: "陆川", sliceKeys: [`${sampleA}|SL-A1-${run}`, `${sampleA}|SL-A2-${run}`] });
  check("登记事件（多切片+原因+处置工序）", e1.status === 201 && e1.data.status === "开放" && e1.data.slices.length === 2, e1.data.id);
  const e1id = e1.data.id;

  // 2. 重复提交同一事件编号：只生效一次
  const dup = await post("/api/events", { eventNo, reason: "染色剂交叉污染", handlingStep: "研磨", registeredBy: "陆川", sliceKeys: [`${sampleA}|SL-A1-${run}`, `${sampleA}|SL-A2-${run}`] });
  const allEvents = (await api("/api/events")).data;
  check("重复登记同一事件只生效一次", dup.status === 200 && dup.data.duplicated === true && dup.data.id === e1id && allEvents.filter(e => e.eventNo === eventNo).length === 1);

  // 3. 冻结：关联切片不能推进
  const adv = await post(`/api/samples/${sampleA}/slices/SL-A1-${run}/logs`, { step: "研磨", note: "尝试推进" });
  check("冻结切片不能推进", adv.status === 409 && adv.data.error === "slice_frozen", adv.data.message);

  // 4. 冻结：批次不能交付，且返回影响范围
  const del = await post(`/api/samples/${sampleA}/deliver`);
  check("批次存在冻结切片拒绝交付并列出影响范围", del.status === 409 && del.data.error === "batch_has_frozen_slices" && del.data.affected.length === 2, del.data.message);

  // 5. 同一切片不能同时处于两个开放事件
  const e2 = await post("/api/events", { eventNo: `EVT-VERIFY2-${run}`, reason: "二次登记", handlingStep: "染色", registeredBy: "苏晴", sliceKeys: [`${sampleA}|SL-A1-${run}`] });
  check("同一切片不能进入第二个开放事件", e2.status === 409 && e2.data.error === "slice_already_frozen", e2.data.message);

  // 6. 解除人不能与登记人相同
  const rel1 = await post(`/api/events/${e1id}/release`, { releasedBy: "陆川", basis: "自检合格", resolution: "续作" });
  check("解除人不能与登记人相同", rel1.status === 409 && rel1.data.error === "same_person", rel1.data.message);

  // 7. 续作解除：填写依据，由他人签核
  const rel2 = await post(`/api/events/${e1id}/release`, { releasedBy: "苏晴", basis: "复检合格，无污染残留", resolution: "续作" });
  check("续作解除（依据+签核人）", rel2.status === 200 && rel2.data.status === "已解除" && rel2.data.resolution === "续作" && rel2.data.releaseBasis === "复检合格，无污染残留");

  // 8. 解除后可推进、可交付
  const adv2 = await post(`/api/samples/${sampleA}/slices/SL-A1-${run}/logs`, { step: "研磨", note: "解除后继续制片" });
  const del2 = await post(`/api/samples/${sampleA}/deliver`);
  check("解除后可推进可交付", adv2.status === 200 && del2.status === 200 && del2.data.delivery === "已交付");

  // 9. 返工：解除时退回指定工序（先推进到研磨，退回切割才是合法向后）
  await post(`/api/samples/${sampleB}/slices/SL-B1-${run}/logs`, { step: "研磨", note: "推进到研磨" });
  const e3 = await post("/api/events", { eventNo: `EVT-VERIFY3-${run}`, reason: "研磨液污染", handlingStep: "研磨", registeredBy: "陆川", sliceKeys: [`${sampleB}|SL-B1-${run}`] });
  const rel3 = await post(`/api/events/${e3.data.id}/release`, { releasedBy: "苏晴", basis: "更换批次磨液，需返工", resolution: "退回", returnStep: "切割" });
  const bAfter = (await api("/api/samples")).data.find(s => s.id === sampleB);
  check("退回指定工序（返工）", rel3.status === 200 && rel3.data.returnStep === "切割" && bAfter.slices[0].status === "切割" && bAfter.slices[0].logs.some(l => l.note.includes("退回工序")), `SL-B1=${bAfter.slices[0].status}`);

  // 10. 并发解除：只有一个生效
  const e4 = await post("/api/events", { eventNo: `EVT-VERIFY4-${run}`, reason: "二次污染排查", handlingStep: "观察", registeredBy: "陆川", sliceKeys: [`${sampleB}|SL-B1-${run}`] });
  const [r1, r2] = await Promise.all([
    post(`/api/events/${e4.data.id}/release`, { releasedBy: "苏晴", basis: "复检通过", resolution: "续作" }),
    post(`/api/events/${e4.data.id}/release`, { releasedBy: "韩冰", basis: "另一路并发解除", resolution: "退回", returnStep: "取样" })
  ]);
  const oks = [r1, r2].filter(r => r.status === 200).length;
  const conflicts = [r1, r2].filter(r => r.status === 409 && r.data.error === "event_already_released").length;
  const e4Final = (await api("/api/events")).data.find(e => e.id === e4.data.id);
  check("并发解除仅一次生效", oks === 1 && conflicts === 1 && e4Final.status === "已解除", `200×${oks} 409×${conflicts}`);

  // 11. 退回方向：目标必须早于每张切片各自的当前工序（C1 在染色，C2 在研磨）
  const c = await post("/api/samples", { project: `验证矿段C-${run}`, borehole: "ZK-C", coreBox: "BX-C", depth: "30-31m", owner: "陆川", sliceId: `SL-C1-${run}`, method: "茜素红染色" });
  const sampleC = c.data.id;
  await post(`/api/samples/${sampleC}/slices`, { id: `SL-C2-${run}`, method: "未染色" });
  await post(`/api/samples/${sampleC}/slices/SL-C1-${run}/logs`, { step: "染色", note: "推进到染色" });
  await post(`/api/samples/${sampleC}/slices/SL-C2-${run}/logs`, { step: "研磨", note: "推进到研磨" });
  const e5 = await post("/api/events", { eventNo: `EVT-VERIFY5-${run}`, reason: "退回方向校验", handlingStep: "切割", registeredBy: "陆川", sliceKeys: [`${sampleC}|SL-C1-${run}`, `${sampleC}|SL-C2-${run}`] });
  const e5id = e5.data.id;
  const slicesC = async () => (await api("/api/samples")).data.find(s => s.id === sampleC).slices;
  const logsBefore = Object.fromEntries((await slicesC()).map(s => [s.id, s.logs.length]));

  const fwd = await post(`/api/events/${e5id}/release`, { releasedBy: "苏晴", basis: "尝试向前退回", resolution: "退回", returnStep: "观察" });
  check("向前退回失败", fwd.status === 400 && fwd.data.error === "return_step_not_backward", fwd.data.message);

  const same = await post(`/api/events/${e5id}/release`, { releasedBy: "苏晴", basis: "尝试同工序退回", resolution: "退回", returnStep: "研磨" });
  check("同工序退回失败（各切片分别判断）", same.status === 400 && same.data.error === "return_step_not_backward" && same.data.notBackward.length === 1 && same.data.notBackward[0].sliceId === `SL-C2-${run}`, same.data.message);

  const unknown = await post(`/api/events/${e5id}/release`, { releasedBy: "苏晴", basis: "尝试未知工序", resolution: "退回", returnStep: "抛光" });
  check("未知工序退回失败", unknown.status === 400 && unknown.data.error === "return_step_invalid", unknown.data.message);

  const e5Mid = (await api("/api/events")).data.find(e => e.id === e5id);
  const mid = await slicesC();
  const unchanged = mid.every(s => s.logs.length === logsBefore[s.id])
    && mid.find(s => s.id === `SL-C1-${run}`).status === "染色"
    && mid.find(s => s.id === `SL-C2-${run}`).status === "研磨";
  check("失败解除后事件保持开放、状态和记录不变", e5Mid.status === "开放" && unchanged);

  const back = await post(`/api/events/${e5id}/release`, { releasedBy: "苏晴", basis: "磨液污染需返工", resolution: "退回", returnStep: "切割" });
  const backed = await slicesC();
  check("合法向后退回成功", back.status === 200 && backed.every(s => s.status === "切割"), backed.map(s => `${s.id}=${s.status}`).join(" "));

  // 12. 续作不受退回方向校验影响（即使附带向前工序也忽略）
  const e6 = await post("/api/events", { eventNo: `EVT-VERIFY6-${run}`, reason: "续作回归", handlingStep: "观察", registeredBy: "陆川", sliceKeys: [`${sampleC}|SL-C1-${run}`] });
  const cont = await post(`/api/events/${e6.data.id}/release`, { releasedBy: "韩冰", basis: "排查完成", resolution: "续作", returnStep: "观察" });
  const contSlice = (await slicesC()).find(s => s.id === `SL-C1-${run}`);
  check("续作不受退回校验影响", cont.status === 200 && cont.data.resolution === "续作" && cont.data.returnStep === null && contSlice.status === "切割");

  console.log(failures ? `\n${failures} 项未通过` : "\n全流程通过，可重启服务后执行：node verify.mjs check " + run);
  process.exit(failures ? 1 : 0);
}

process.argv[2] === "check" ? checkPersist(process.argv[3]) : main();
