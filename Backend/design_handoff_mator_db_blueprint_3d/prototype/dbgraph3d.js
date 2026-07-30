import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DOMAINS, TABLES, RELATIONS } from "./db-schema.js";

const TOWER_R = 8.4, STEP = 0.86, BASE_Y = 1.1;

class DbGraphStage extends HTMLElement {
  static get observedAttributes() { return ["selected", "domain-filter", "query", "edges-mode"]; }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    Object.assign(this.style, { display: "block", position: "absolute", inset: "0", overflow: "hidden" });

    const w = this.clientWidth || 1000, h = this.clientHeight || 700;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050505);
    this.scene.fog = new THREE.FogExp2(0x050505, 0.022);

    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 200);
    this.camera.position.set(0.5, 10.5, 24);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.domElement.style.cssText = "display:block; touch-action:none;";
    this.appendChild(this.renderer.domElement);

    this.overlay = document.createElement("div");
    this.overlay.style.cssText = "position:absolute; inset:0; pointer-events:none; font-family:'JetBrains Mono', monospace;";
    this.appendChild(this.overlay);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.07, minDistance: 5, maxDistance: 46, autoRotate: true, autoRotateSpeed: 0.32 });
    this.controls.maxPolarAngle = Math.PI * 0.52;
    this.controls.target.set(0, 4.2, 0);
    this._idleAt = performance.now();
    ["start", "change"].forEach(ev => this.controls.addEventListener(ev, () => { this._idleAt = performance.now(); this.controls.autoRotate = false; }));

    this.scene.add(new THREE.HemisphereLight(0x334455, 0x000000, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(6, 14, 8);
    this.scene.add(key);

    this._buildFloor();
    this._buildNodes();
    this._buildEdges();

    this._ray = new THREE.Raycaster();
    this._ray.params.Sprite = { threshold: 0 };
    this._ptr = new THREE.Vector2();
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", e => { this._down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener("pointerup", e => {
      if (!this._down) return;
      const moved = Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y);
      this._down = null;
      if (moved > 5) return;
      const hit = this._pick(e);
      this.dispatchEvent(new CustomEvent("table-select", { detail: { name: hit }, bubbles: true, composed: true }));
    });
    el.addEventListener("pointermove", e => {
      const hit = this._pick(e);
      el.style.cursor = hit ? "pointer" : "grab";
      if (hit !== this._hover) {
        this._hover = hit;
        this._applyState();
        this.dispatchEvent(new CustomEvent("table-hover", { detail: { name: hit }, bubbles: true, composed: true }));
      }
    });
    el.addEventListener("pointerleave", () => { if (this._hover) { this._hover = null; this._applyState(); } });

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this);
    this._clock = new THREE.Clock();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
    this._applyState();
    this.renderer.render(this.scene, this.camera);
  }

  disconnectedCallback() {
    cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
    if (this.renderer) this.renderer.dispose();
  }

  attributeChangedCallback(name, _o, v) {
    if (!this._built) return;
    if (name === "selected") { this._selected = v || null; this._applyState(); if (v) this.focus(v); }
    else this._applyState();
  }

  /* ---------- geometry ---------- */

  _buildFloor() {
    const grid = new THREE.GridHelper(70, 35, 0x2a2a2a, 0x161616);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    this.scene.add(grid);
  }

  _label(text, sub, fk, color, mode) {
    const S = 2, W = 512 * S, H = 116 * S;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");
    x.scale(S, S);
    const active = mode === "active", near = mode === "near";
    const r = 18;
    x.fillStyle = active ? "#f7f7f7" : near ? "rgba(30,30,30,.97)" : "rgba(13,13,13,.9)";
    x.strokeStyle = active ? color : near ? "rgba(180,180,180,.7)" : "rgba(110,110,110,.45)";
    x.lineWidth = active ? 7 : near ? 4 : 2.5;
    x.beginPath();
    x.moveTo(r, 5); x.lineTo(507 - r, 5); x.quadraticCurveTo(507, 5, 507, 5 + r);
    x.lineTo(507, 111 - r); x.quadraticCurveTo(507, 111, 507 - r, 111);
    x.lineTo(r, 111); x.quadraticCurveTo(5, 111, 5, 111 - r);
    x.lineTo(5, 5 + r); x.quadraticCurveTo(5, 5, r, 5);
    x.closePath(); x.fill(); x.stroke();
    x.save();
    x.beginPath();
    x.rect(5, 5, 14, 106);
    x.clip();
    x.fillStyle = color;
    x.fillRect(5, 5, 14, 106);
    x.restore();
    x.font = "700 42px 'JetBrains Mono', monospace";
    x.fillStyle = active ? "#050505" : "#ffffff";
    x.textBaseline = "middle";
    x.textAlign = "left";
    x.fillText(text, 36, 58, 360);
    x.textAlign = "right";
    x.font = "700 24px 'JetBrains Mono', monospace";
    x.fillStyle = active ? "#8a8a8a" : "#6f6f6f";
    x.fillText(sub, 493, 42);
    x.fillStyle = active ? color : "#8f8f8f";
    x.fillText(fk, 493, 76);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 8;
    return tex;
  }

  _domainLabel(text, color) {
    const c = document.createElement("canvas");
    c.width = 1024; c.height = 192;
    const x = c.getContext("2d");
    x.font = "800 78px Figtree, sans-serif";
    x.fillStyle = color;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.letterSpacing = "10px";
    x.shadowColor = "rgba(0,0,0,.9)";
    x.shadowBlur = 18;
    x.fillText(text.toUpperCase(), 512, 104);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 8;
    return tex;
  }

  _buildNodes() {
    this.nodes = {};
    this.pickables = [];
    this.towers = {};
    this.degree = {};
    RELATIONS.forEach(r => { this.degree[r[0]] = (this.degree[r[0]] || 0) + 1; this.degree[r[2]] = (this.degree[r[2]] || 0) + 1; });
    DOMAINS.forEach((d, di) => {
      const a = (di / DOMAINS.length) * Math.PI * 2;
      const cx = Math.cos(a) * TOWER_R, cz = Math.sin(a) * TOWER_R;
      const rows = TABLES.filter(t => t.d === d.id).slice().sort((p, q) => (this.degree[q.name] || 0) - (this.degree[p.name] || 0));

      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(1.5, 48),
        new THREE.MeshBasicMaterial({ color: d.color, transparent: true, opacity: 0.07 })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(cx, 0.012, cz);
      this.scene.add(disc);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.42, 1.52, 56),
        new THREE.MeshBasicMaterial({ color: d.color, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(cx, 0.02, cz);
      this.scene.add(ring);

      const h = rows.length * STEP + 1.1;
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.014, 0.014, h, 6),
        new THREE.MeshBasicMaterial({ color: d.color, transparent: true, opacity: 0.3 })
      );
      beam.position.set(cx, h / 2, cz);
      this.scene.add(beam);

      const dl = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._domainLabel(d.label, d.color), transparent: true, depthTest: false }));
      dl.scale.set(4.4, 0.82, 1);
      dl.position.set(cx, 0.5, cz);
      dl.renderOrder = 2;
      this.scene.add(dl);
      this.towers[d.id] = { ring, beam, disc, label: dl, color: d.color };

      rows.forEach((t, i) => {
        const y = BASE_Y + i * STEP;
        const fk = (this.degree[t.name] || 0) + " fk";
        const sub = t.cols.length + " col";
        const texN = this._label(t.name, sub, fk, d.color, "idle");
        const texR = this._label(t.name, sub, fk, d.color, "near");
        const texA = this._label(t.name, sub, fk, d.color, "active");
        const mat = new THREE.SpriteMaterial({ map: texN, transparent: true, depthWrite: false });
        const sp = new THREE.Sprite(mat);
        sp.scale.set(2.62, 0.6, 1);
        sp.position.set(cx, y, cz);
        sp.userData = { name: t.name, domain: d.id, color: d.color, texN, texR, texA, mat };
        sp.renderOrder = 3;
        this.scene.add(sp);
        this.nodes[t.name] = sp;
        this.pickables.push(sp);
      });
    });
  }

  _buildEdges() {
    this.edges = [];
    const center = new THREE.Vector3(0, 3.6, 0);
    RELATIONS.forEach(r => {
      const a = this.nodes[r[0]], b = this.nodes[r[2]];
      if (!a || !b) return;
      const pa = a.position.clone(), pb = b.position.clone();
      const mid = pa.clone().lerp(pb, 0.5);
      const sameTower = a.userData.domain === b.userData.domain;
      let out = mid.clone().sub(center);
      out.y = 0;
      if (out.length() < 0.001) out.set(1, 0, 0);
      out.normalize().multiplyScalar(sameTower ? 2.5 : 1.1 + pa.distanceTo(pb) * 0.12);
      const ctrl = mid.clone().add(out);
      ctrl.y = mid.y + (sameTower ? 0.2 : 1.5);
      const curve = new THREE.QuadraticBezierCurve3(pa, ctrl, pb);
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 34, 0.02, 6, false),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(a.userData.color), transparent: true, opacity: 0.14, depthWrite: false })
      );
      this.scene.add(mesh);

      const tip = curve.getPointAt(0.93);
      const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.07, 0.2, 8),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(a.userData.color), transparent: true, opacity: 0.2, depthWrite: false })
      );
      arrow.position.copy(tip);
      arrow.lookAt(pb);
      arrow.rotateX(Math.PI / 2);
      this.scene.add(arrow);

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 })
      );
      this.scene.add(dot);

      const tag = document.createElement("div");
      tag.style.cssText = "position:absolute; transform:translate(-50%,-50%); white-space:nowrap; padding:3px 7px; border-radius:6px; font-size:10px; font-weight:700; letter-spacing:.02em; background:rgba(5,5,5,.94); border:1px solid #2a2a2a; opacity:0; transition:opacity .12s;";
      this.overlay.appendChild(tag);

      this.edges.push({ parent: r[0], child: r[2], fk: r[3], onDelete: r[4], card: r[1], sameTower, curve, mesh, arrow, dot, tag, color: a.userData.color });
    });
  }

  /* ---------- state ---------- */

  _applyState() {
    const sel = this._selected || this.getAttribute("selected") || null;
    const hov = this._hover;
    const focus = hov || sel;
    const dom = this.getAttribute("domain-filter") || "all";
    const q = (this.getAttribute("query") || "").trim().toLowerCase();
    const mode = this.getAttribute("edges-mode") || "all";
    this._focus = focus;

    const inScope = n => {
      const u = this.nodes[n].userData;
      if (dom !== "all" && u.domain !== dom) return false;
      if (q && n.toLowerCase().indexOf(q) === -1) return false;
      return true;
    };
    const linked = new Set();
    if (focus) {
      linked.add(focus);
      this.edges.forEach(e => {
        if (e.parent === focus) linked.add(e.child);
        if (e.child === focus) linked.add(e.parent);
      });
    }

    Object.keys(this.nodes).forEach(n => {
      const sp = this.nodes[n], u = sp.userData;
      const scoped = inScope(n);
      const active = n === focus;
      const near = focus ? linked.has(n) : false;
      u.mat.map = active ? u.texA : (near ? u.texR : u.texN);
      u.mat.needsUpdate = true;
      let op = 1;
      if (!scoped) op = 0.1;
      else if (focus && !near) op = 0.15;
      u.mat.opacity = op;
      const s = active ? 1.3 : near ? 1.1 : 1;
      sp.scale.set(2.62 * s, 0.6 * s, 1);
    });

    const focusDomain = focus && this.nodes[focus] ? this.nodes[focus].userData.domain : null;
    Object.keys(this.towers || {}).forEach(id => {
      const tw = this.towers[id];
      const lit = !focusDomain || id === focusDomain;
      const scopedDom = dom === "all" || dom === id;
      tw.ring.material.opacity = scopedDom ? (lit ? 0.75 : 0.25) : 0.1;
      tw.disc.material.opacity = scopedDom ? (lit ? 0.11 : 0.05) : 0.02;
      tw.beam.material.opacity = scopedDom ? (lit ? 0.42 : 0.14) : 0.06;
      tw.label.material.opacity = scopedDom ? (lit ? 1 : 0.4) : 0.16;
    });

    this.edges.forEach(e => {
      const scoped = inScope(e.parent) && inScope(e.child);
      const out = focus && e.parent === focus;
      const inc = focus && e.child === focus;
      const touches = out || inc;
      let op = 0.13;
      if (mode === "cross" && e.sameTower) op = 0.02;
      if (!scoped) op = 0.012;
      if (focus) op = touches ? (out ? 0.98 : 0.72) : (scoped ? 0.035 : 0.012);
      if (mode === "selected" && !touches) op = focus ? 0.025 : 0.055;
      e.mesh.material.opacity = op;
      e.arrow.material.opacity = Math.min(1, op * 1.25);
      const hue = out ? 0xffffff : inc ? new THREE.Color(e.color).lerp(new THREE.Color(0xffffff), 0.35).getHex() : e.color;
      e.mesh.material.color.set(hue);
      e.arrow.material.color.set(hue);
      e.hot = !!touches;
      e.dot.material.opacity = touches ? 0.95 : 0;
      e.dot.visible = !!touches;
      if (e.tag) {
        if (touches) {
          e.tag.textContent = e.fk + "  " + e.card;
          e.tag.style.color = out ? "#ffffff" : e.color;
          e.tag.style.borderColor = out ? "#4a4a4a" : e.color + "66";
          e.tag.style.opacity = "1";
        } else e.tag.style.opacity = "0";
      }
    });
  }

  _pick(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this._ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this._ray.setFromCamera(this._ptr, this.camera);
    const hits = this._ray.intersectObjects(this.pickables, false).filter(h => h.object.material.opacity > 0.3);
    return hits.length ? hits[0].object.userData.name : null;
  }

  focus(name) {
    const sp = this.nodes && this.nodes[name];
    if (!sp) return;
    const p = sp.position;
    const dir = new THREE.Vector3(p.x, 0, p.z).normalize().multiplyScalar(6.2);
    this._camGoal = new THREE.Vector3(p.x + dir.x, p.y + 2.6, p.z + dir.z);
    this._lookGoal = p.clone();
    this._flying = true;
    this.controls.autoRotate = false;
    this._idleAt = performance.now();
  }

  resetView() {
    this._camGoal = new THREE.Vector3(0.5, 10.5, 24);
    this._lookGoal = new THREE.Vector3(0, 4.2, 0);
    this._flying = true;
  }

  _resize() {
    const w = this.clientWidth, h = this.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _loop() {
    this._raf = requestAnimationFrame(this._loop);
    const t = performance.now(), dt = this._clock.getDelta();

    if (this._flying) {
      this.camera.position.lerp(this._camGoal, 1 - Math.pow(0.002, dt));
      this.controls.target.lerp(this._lookGoal, 1 - Math.pow(0.002, dt));
      if (this.camera.position.distanceTo(this._camGoal) < 0.05) this._flying = false;
    } else if (t - this._idleAt > 4000) this.controls.autoRotate = true;

    const phase = (t / 1400) % 1;
    const w = this.clientWidth, h = this.clientHeight;
    const v = new THREE.Vector3();
    this.edges.forEach(e => {
      if (!e.hot) return;
      e.dot.position.copy(e.curve.getPointAt(phase));
      if (e.tag) {
        v.copy(e.curve.getPointAt(0.5)).project(this.camera);
        const behind = v.z > 1;
        e.tag.style.opacity = behind ? "0" : "1";
        e.tag.style.left = (v.x * 0.5 + 0.5) * w + "px";
        e.tag.style.top = (-v.y * 0.5 + 0.5) * h + "px";
      }
    });

    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    this._frames = (this._frames || 0) + 1;
    if (!this._fpsAt) this._fpsAt = t;
    if (t - this._fpsAt >= 1000) {
      this.dispatchEvent(new CustomEvent("graph-stats", { detail: { fps: Math.round((this._frames * 1000) / (t - this._fpsAt)) }, bubbles: true, composed: true }));
      this._frames = 0; this._fpsAt = t;
    }
  }
}

if (!customElements.get("dbgraph-stage")) customElements.define("dbgraph-stage", DbGraphStage);
