import * as THREE from "three";
import { OrbitControls } from "three/addons/OrbitControls.js";

const $ = (s) => document.querySelector(s);
const COL = { seam: 0x5ec8ff, sel: 0xffd23f, ok: 0x3ddc97, bad: 0xff5d5d };
const _EXAMPLES_UNUSED = [
  "Weld all front stiffeners, 6 mm fillet",
  "Ön taraftaki 2. takviyeyi 8 mm, 2 paso kaynakla",
  "Only the vertical front stiffener seams, 5 mm, stitch 40/120",
  "Weld the selected seams, 10 mm, 3 passes with weave",
];

let scene, camera, renderer, controls, robot, arcLight, glow;
let SCENE = null, RESULT = null, selected = new Set();
const seamMesh = {}, beadMesh = [];
let playing = false, tNow = 0, tEnd = 0, lastTs = 0, follow = false, lastTip = null;

// ------------------------------------------------------------------ kinematics
function dh(a, alpha, d, th) {
  const ct = Math.cos(th), st = Math.sin(th), ca = Math.cos(alpha), sa = Math.sin(alpha);
  return new THREE.Matrix4().set(ct, -st * ca, st * sa, a * ct, st, ct * ca, -ct * sa, a * st, 0, sa, ca, d, 0, 0, 0, 1);
}
function fkAll(q) {
  const r = SCENE.robot, out = [new THREE.Matrix4()];
  let T = new THREE.Matrix4();
  for (let i = 0; i < 6; i++) { T = T.clone().multiply(dh(r.a[i], r.alpha[i], r.d[i], q[i])); out.push(T.clone()); }
  return out;
}

// ------------------------------------------------------------------ scene
function mat(color, rough = 0.6, metal = 0.3, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}
function boxMesh(c, h, R, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(2 * h[0], 2 * h[1], 2 * h[2]), material);
  const M = new THREE.Matrix4().set(R[0][0], R[0][1], R[0][2], c[0], R[1][0], R[1][1], R[1][2], c[1], R[2][0], R[2][1], R[2][2], c[2], 0, 0, 0, 1);
  m.applyMatrix4(M);
  return m;
}
function cyl(r, color, len = 1) {
  const g = new THREE.CylinderGeometry(r, r, len, 28);
  g.rotateX(Math.PI / 2); // along +z
  g.translate(0, 0, len / 2);
  return new THREE.Mesh(g, mat(color, 0.45, 0.5));
}
function placeBetween(mesh, a, b) {
  const d = new THREE.Vector3().subVectors(b, a), L = d.length();
  mesh.position.copy(a);
  mesh.scale.set(1, 1, Math.max(L, 1e-4));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.normalize());
}

function initThree() {
  const el = $("#view");
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(el.clientWidth, el.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  el.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1014);
  scene.fog = new THREE.Fog(0x0d1014, 4, 9);
  camera = new THREE.PerspectiveCamera(42, el.clientWidth / el.clientHeight, 0.01, 50);
  camera.up.set(0, 0, 1);
  camera.position.set(-0.35, -1.45, 1.15);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0.55, 0.0, 0.32);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1d22, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-1.5, -2, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2 });
  scene.add(sun);
  const grid = new THREE.GridHelper(6, 60, 0x223040, 0x161c24);
  grid.rotation.x = Math.PI / 2; grid.position.z = -0.051;
  scene.add(grid);
  arcLight = new THREE.PointLight(0x9fd6ff, 0, 1.2, 2);
  scene.add(arcLight);
  glow = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 16), new THREE.MeshBasicMaterial({ color: 0xe6f4ff, transparent: true, opacity: 0.95 }));
  glow.visible = false;
  scene.add(glow);
  window.addEventListener("resize", () => {
    renderer.setSize(el.clientWidth, el.clientHeight);
    camera.aspect = el.clientWidth / el.clientHeight; camera.updateProjectionMatrix();
  });
  renderer.domElement.addEventListener("pointerdown", onPick);
}

function buildCell() {
  const t = SCENE.table;
  const table = boxMesh(t.center, t.half, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], mat(0x2b333d, 0.8, 0.4));
  table.receiveShadow = true; scene.add(table);
  for (const f of SCENE.fixtures) {
    const m = boxMesh(f.center, f.half, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], mat(0x3a4552, 0.7, 0.5));
    m.castShadow = m.receiveShadow = true; scene.add(m);
  }
  const steel = mat(0x8e98a3, 0.42, 0.75);
  for (const p of SCENE.part.plates) {
    const m = boxMesh(p.center, p.half, p.R, steel);
    m.castShadow = m.receiveShadow = true; scene.add(m);
  }
  for (const s of SCENE.seams) {
    const a = new THREE.Vector3(...s.start), b = new THREE.Vector3(...s.end);
    const n = new THREE.Vector3(...s.bisector).multiplyScalar(0.003);
    const g = new THREE.TubeGeometry(new THREE.LineCurve3(a.clone().add(n), b.clone().add(n)), 8, 0.0028, 8, false);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: COL.seam }));
    m.userData.sid = s.id;
    seamMesh[s.id] = m; scene.add(m);
  }
  // robot: base, link capsules, joint housings, torch
  robot = { links: [], joints: [], torch: {} };
  const base = cyl(0.095, 0x9aa5b1, 0.09); base.position.set(0, 0, -0.0); scene.add(base);
  const R = [0.08, 0.065, 0.055, 0.05, 0.05, 0.045];
  for (let i = 0; i < 6; i++) {
    const l = cyl(R[i], 0xc9d1d9); l.castShadow = true; scene.add(l); robot.links.push(l);
    const j = cyl(R[i] * 1.18, 0x2c3e50, 0.12); j.castShadow = true; scene.add(j); robot.joints.push(j);
  }
  robot.torch.body = cyl(SCENE.torch.body_r, 0x1d232b); robot.torch.neck = cyl(0.013, 0x30363d);
  robot.torch.nozzle = cyl(SCENE.torch.nozzle_r, 0xb87333);
  for (const k in robot.torch) { robot.torch[k].castShadow = true; scene.add(robot.torch[k]); }
}

function setRobot(q) {
  const Ts = fkAll(q), P = Ts.map((T) => new THREE.Vector3().setFromMatrixPosition(T));
  for (let i = 0; i < 6; i++) {
    placeBetween(robot.links[i], P[i], P[i + 1]);
    robot.links[i].visible = P[i].distanceTo(P[i + 1]) > 1e-3;
    const z = new THREE.Vector3().setFromMatrixColumn(Ts[i], 2);
    const j = robot.joints[i];
    j.position.copy(P[i]).addScaledVector(z, -0.06);
    j.scale.set(1, 1, 1);
    j.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), z);
  }
  const F = Ts[6], tor = SCENE.torch;
  const bend = new THREE.Vector3(0, 0, tor.mount).applyMatrix4(F);
  const TCP = F.clone().multiply(new THREE.Matrix4().fromArray(tor.tcp.flat()).transpose());
  const tip = new THREE.Vector3().setFromMatrixPosition(TCP);
  const zt = new THREE.Vector3().setFromMatrixColumn(TCP, 2);
  placeBetween(robot.torch.body, P[6], bend);
  placeBetween(robot.torch.neck, bend, tip.clone().addScaledVector(zt, -0.045));
  placeBetween(robot.torch.nozzle, tip.clone().addScaledVector(zt, -0.045), tip.clone().addScaledVector(zt, -0.014));
  return tip;
}

// ------------------------------------------------------------------ UI
function seamColor(sid) {
  if (selected.has(sid)) return COL.sel;
  const st = RESULT?.seam_status?.[sid];
  if (st) return st.ok ? COL.ok : COL.bad;
  return COL.seam;
}
function refreshSeams() {
  for (const s of SCENE.seams) seamMesh[s.id].material.color.setHex(seamColor(s.id));
  const list = $("#seams"); list.innerHTML = "";
  for (const s of SCENE.seams) {
    const st = RESULT?.seam_status?.[s.id];
    const d = document.createElement("div");
    d.className = "seam" + (selected.has(s.id) ? " sel" : "");
    d.innerHTML = `<span class="id">${s.id}</span><span class="d">${s.b_name} → ${s.a_name}<br><span class="pos">${s.length_mm.toFixed(0)} mm · ${s.position}${st && !st.ok ? " · " + st.reason : ""}${st && st.trim_mm ? " · ends −" + st.trim_mm + " mm" : ""}</span></span><span class="st">${st ? (st.ok ? "✓" : "✕") : ""}</span>`;
    d.onclick = () => toggle(s.id);
    list.appendChild(d);
  }
  $("#seamCount").textContent = `(${SCENE.seams.length})`;
  if ($("#selCount")) $("#selCount").textContent = selected.size ? `${selected.size} selected` : "";
}
function toggle(sid) { selected.has(sid) ? selected.delete(sid) : selected.add(sid); refreshSeams(); }

const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let downAt = null;
function onPick(e) {
  downAt = [e.clientX, e.clientY];
  renderer.domElement.addEventListener("pointerup", function up(ev) {
    renderer.domElement.removeEventListener("pointerup", up);
    if (Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4) return; // a drag, not a click
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    ray.params.Mesh = { threshold: 0.01 };
    const hits = ray.intersectObjects(Object.values(seamMesh));
    if (hits.length) toggle(hits[0].object.userData.sid);
  });
}

function kpi(k, v, cls = "") { return `<div class="kpi"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`; }

const URSIM = { "front-stiffeners": "job1" };

async function loadJob(slug, prompt) {
  document.querySelectorAll(".job").forEach((b) => b.classList.toggle("on", b.dataset.slug === slug));
  stop();
  $("#progressCard").hidden = false;
  $("#steps").innerHTML = `<li class="cur">Loading recorded run…</li>`;
  const r = await (await fetch(`data/jobs/${slug}.json`)).json();
  $("#steps").innerHTML = [
    `<b>Prompt</b> “${r.prompt}”`,
    `<b>Interpreted</b> ${r.spec.explanation || ""}`,
    `<b>Planned</b> ${r.checks.seams_planned}/${r.checks.seams_requested} seams · torch angles, passes, posture, reach, collisions, UR clamp zone`,
    `<b>Re-checked</b> ${r.verify.configs_checked.toLocaleString()} robot poses independently`,
    `<b>Wrote</b> URScript (UR e-Series) + FANUC TP draft`,
  ].map((x) => `<li>${x}</li>`).join("");
  const u = URSIM[slug];
  if (u) {
    const v = await (await fetch(`data/ursim/${u}.json`)).json();
    $("#ursimCard").hidden = false;
    $("#ursim").innerHTML = `<div class="ursim">
      <div class="row2"><span>Controller</span><b>${v.ursim_version.replace("URSoftware ", "")}</b></div>
      <div class="row2"><span>Program</span><b>${v.program_finished === false ? "did not finish" : "ran to the end"}</b></div>
      <div class="row2"><span>Weld start/end points reached</span><b>${v.weld_waypoints_reached}</b></div>
      <div class="row2"><span>Max deviation from plan</span><b>${v.max_weld_waypoint_err_rad} rad</b></div>
      <div class="row2"><span>Protective stops</span><b>${v.safety_events.length}</b></div>
      <div class="row2"><span>Run time on controller</span><b>${(v.run_time_s / 60).toFixed(1)} min</b></div>
      <div class="note">Dry-run variant: identical motion, welder not connected. Joint positions logged at 125 Hz from the controller's real-time interface.</div></div>`;
  } else {
    $("#ursimCard").hidden = true;
  }
  showResult(r);
}

function showResult(r) {
  RESULT = r; selected = new Set();
  const c = r.checks, v = r.verify;
  $("#checksCard").hidden = false;
  $("#explain").textContent = r.spec.explanation || "";
  const allOk = c.seams_planned === c.seams_requested;
  $("#checks").innerHTML =
    kpi("Reach", `${c.seams_planned}/${c.seams_requested} seams`, allOk ? "ok" : "bad") +
    kpi("Collisions", v.collision_free ? `none · ${v.configs_checked} poses` : "found", v.collision_free ? "ok" : "bad") +
    kpi("Min clearance", `${v.min_clearance_mm} mm`) +
    kpi("Singularity margin", `${c.min_wrist_margin}`, c.min_wrist_margin > 0.08 ? "ok" : "bad") +
    kpi("Joint limits / speed", v.joint_limit_violations.length + v.joint_speed_violations.length ? "violations" : "within", "ok") +
    kpi("Weld length", `${(c.weld_length_mm / 1000).toFixed(2)} m`) +
    kpi("Arc time", `${(c.arc_time_s / 60).toFixed(1)} min`) +
    kpi("Cycle time", `${(c.cycle_time_s / 60).toFixed(1)} min`);
  refreshSeams();
  // beads
  for (const m of beadMesh) scene.remove(m.mesh);
  beadMesh.length = 0;
  const arcFrames = {};
  r.frames.forEach((f) => { if (f.arc) (arcFrames[f.seam + ":" + f.bead] ??= []).push(f.t); });
  const used = {};
  for (const b of r.beads) {
    const key = b.seam + ":" + b.bead;
    const ts = arcFrames[key] || [];
    const off = used[key] || 0; used[key] = off + b.points.length;
    const times = ts.slice(off, off + b.points.length);
    const pts = b.points.map((p) => new THREE.Vector3(...p));
    if (pts.length < 2) continue;
    const r0 = Math.max(0.0022, (b.leg_mm / 1000) * 0.42 / Math.sqrt(b.passes));
    const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, r0, 10, false);
    const m = new THREE.Mesh(g, mat(0xff7a1a, 0.35, 0.6, { emissive: 0xff5500, emissiveIntensity: 1.2 }));
    m.geometry.setDrawRange(0, 0);
    scene.add(m);
    beadMesh.push({ mesh: m, times, segs: pts.length * 2, cool: 0 });
  }
  tEnd = r.frames[r.frames.length - 1].t; tNow = 0;
  $("#play").disabled = $("#scrub").disabled = false;
  $("#code").hidden = false; $("#code").classList.add("min"); $("#codeToggle").textContent = "Show code"; showCode("urscript");
  play();
}

function showCode(tab) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("#codeText").textContent = RESULT?.programs?.[tab] || "(no program)";
  $("#codeText").dataset.tab = tab;
}

// ------------------------------------------------------------------ playback
function frameAt(t) {
  const F = RESULT.frames;
  let lo = 0, hi = F.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (F[mid].t <= t) lo = mid; else hi = mid; }
  const a = F[lo], b = F[hi], u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  return { q: a.q.map((v, i) => v + (b.q[i] - v) * u), arc: a.arc && b.arc, a };
}
function render(t) {
  if (!RESULT) return;
  const f = frameAt(t);
  const tip = setRobot(f.q);
  lastTip = tip;
  const on = f.arc;
  arcLight.intensity = on ? 2.5 + Math.random() * 2.5 : 0;
  arcLight.position.copy(tip); glow.position.copy(tip); glow.visible = on;
  for (const b of beadMesh) {
    let k = 0; while (k < b.times.length && b.times[k] <= t) k++;
    const frac = b.times.length ? k / b.times.length : 0;
    b.mesh.geometry.setDrawRange(0, Math.floor(frac * b.segs) * 10 * 6);
    const done = frac >= 1, age = done ? t - b.times[b.times.length - 1] : 0;
    const heat = done ? Math.max(0, 1 - age / 20) : 1;
    b.mesh.material.emissiveIntensity = 0.05 + 1.2 * heat;
    b.mesh.material.color.setRGB(0.35 + 0.65 * heat, 0.33 + 0.15 * heat, 0.32 - 0.2 * heat);
  }
  const hud = $("#hud");
  if (on) { hud.style.display = "block"; hud.textContent = `Welding ${f.a.seam} · bead ${f.a.bead}`; }
  else if (f.a.event) { hud.style.display = "block"; hud.textContent = f.a.event; }
  else hud.style.display = "none";
  $("#clock").textContent = `${t.toFixed(1)} / ${tEnd.toFixed(1)} s`;
  $("#scrub").value = Math.round((t / tEnd) * 1000);
}
function play() { playing = true; $("#play").textContent = "❚❚"; lastTs = performance.now(); }
function stop() { playing = false; $("#play").textContent = "▶"; }

function loop(ts) {
  requestAnimationFrame(loop);
  if (playing && RESULT) {
    tNow += ((ts - lastTs) / 1000) * Number($("#speed").value);
    if (tNow >= tEnd) { tNow = tEnd; stop(); }
    render(tNow);
  }
  lastTs = ts;
  if (follow && lastTip) {
    const off = new THREE.Vector3().subVectors(camera.position, controls.target);
    controls.target.lerp(lastTip, 0.08);
    const want = off.setLength(Math.max(0.45, Math.min(off.length(), 0.75)));
    camera.position.lerp(controls.target.clone().add(want), 0.08);
  }
  controls.update();
  renderer.render(scene, camera);
}

// ------------------------------------------------------------------ boot
async function boot() {
  SCENE = await (await fetch("data/scene.json")).json();
  initThree(); buildCell();
  setRobot([0, -1.745, 1.92, -1.745, -1.571, 0]);
  refreshSeams();
  const jobs = await (await fetch("data/jobs/index.json")).json();
  const box = $("#jobs");
  for (const j of jobs) {
    const b = document.createElement("button");
    b.className = "job"; b.dataset.slug = j.slug;
    b.innerHTML = `<div class="p">“${j.prompt}”</div><div class="m">${j.planned}/${j.requested} seams planned · ${j.verified ? "verified collision-free" : "not verified"}${j.ursim === "passed" ? " · ran on URSim" : " · URSim run pending"}</div>`;
    b.onclick = () => loadJob(j.slug);
    box.appendChild(b);
  }
  $("#play").onclick = () => (playing ? stop() : (tNow >= tEnd && (tNow = 0), play()));
  $("#scrub").oninput = (e) => { stop(); tNow = (e.target.value / 1000) * tEnd; render(tNow); };
  document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => showCode(b.dataset.tab)));
  $("#codeToggle").onclick = () => { const c = $("#code"); c.classList.toggle("min"); $("#codeToggle").textContent = c.classList.contains("min") ? "Show code" : "Hide"; };
  $("#follow").onclick = () => { follow = !follow; $("#follow").classList.toggle("on", follow); if (!follow) controls.target.set(0.55, 0, 0.32); };
  $("#download").onclick = () => {
    const tab = $("#codeText").dataset.tab, txt = RESULT?.programs?.[tab];
    if (!txt) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain" }));
    a.download = tab === "urscript" ? "weldra_job.script" : "WELDRA_JOB.LS"; a.click();
  };
  requestAnimationFrame(loop);
  loadJob(jobs[0].slug);
}
boot();
