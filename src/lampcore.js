// Lamp thread generator core — shared by the web page and node tests.
// All units mm. Requires an initialised manifold-3d module `M` (after M.setup()).

export const DEFAULTS = {
  ledD: 59.4, ledH: 7.9, cableD: 2.8, cableZ: 1.6,
  pocketClr: 0.30, wall: 1.5, floor: 1.5,
  pitch: 2.0, depth: 0.9, thClr: 0.30, threadH: 8.5, collarWall: 2.6,
  bandH: 5.5, slotAngle: 180, pushHole: true,
};

// ---------- STL parsing ----------
export function parseSTL(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) {
      const pos = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(o + k * 4, true);
      }
      return pos;
    }
  }
  const text = new TextDecoder().decode(u8);
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  const out = []; let m;
  while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
  if (!out.length || out.length % 9) throw new Error("This file isn't a readable STL (binary or ASCII).");
  return new Float32Array(out);
}

export function bounds(pos) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  return { mn, mx, ext: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
}

export function guessUnitScale(pos) {
  const e = Math.max(...bounds(pos).ext);
  if (e < 1.5) return { scale: 1000, unit: "m" };
  if (e < 25) return { scale: 10, unit: "cm" };
  return { scale: 1, unit: "mm" };
}

// Orient: map chosen "up" direction to +Z, scale, then put bottom at z=0 centred on XY bbox centre.
export const UP_DIRS = ["+Z", "-Z", "+Y", "-Y", "+X", "-X"];
function orientPoint(x, y, z, up) {
  switch (up) {
    case "+Z": return [x, y, z];
    case "-Z": return [x, -y, -z];
    case "+Y": return [x, -z, y];
    case "-Y": return [x, z, -y];
    case "+X": return [-z, y, x];
    case "-X": return [z, y, -x];
  }
}
export function orient(pos, up, scale) {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const p = orientPoint(pos[i] * scale, pos[i + 1] * scale, pos[i + 2] * scale, up);
    out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
  }
  const b = bounds(out);
  const cx = (b.mn[0] + b.mx[0]) / 2, cy = (b.mn[1] + b.mx[1]) / 2, z0 = b.mn[2];
  for (let i = 0; i < out.length; i += 3) { out[i] -= cx; out[i + 1] -= cy; out[i + 2] -= z0; }
  return out;
}

// Weld duplicated STL vertices into an indexed mesh.
export function weld(pos, tol = 1e-4) {
  const map = new Map(), verts = [], tri = new Uint32Array(pos.length / 3);
  const q = 1 / tol;
  for (let i = 0; i < pos.length; i += 3) {
    const key = Math.round(pos[i] * q) + "," + Math.round(pos[i + 1] * q) + "," + Math.round(pos[i + 2] * q);
    let id = map.get(key);
    if (id === undefined) { id = verts.length / 3; map.set(key, id); verts.push(pos[i], pos[i + 1], pos[i + 2]); }
    tri[i / 3] = id;
  }
  // drop degenerate triangles
  const keep = [];
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    if (a !== b && b !== c && a !== c) keep.push(a, b, c);
  }
  return { vert: new Float32Array(verts), tri: new Uint32Array(keep) };
}

export function toManifold(M, pos) {
  const { vert, tri } = weld(pos);
  const mesh = new M.Mesh({ numProp: 3, vertProperties: vert, triVerts: tri });
  mesh.merge();
  try { return new M.Manifold(mesh); }
  catch (e) {
    throw new Error("The model isn't a closed solid (it has holes or loose faces), so threads can't be cut into it. Repair it in your slicer or CAD tool (e.g. Bambu Studio → Fix model) and try again.");
  }
}

// ---------- opening analysis ----------
function polyArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; } return a / 2; }
function inside(pt, polys) { // even-odd
  let c = false;
  for (const p of polys) for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
export function analyseBottom(man, h = 0.4) {
  const polys = man.slice(h).toPolygons();
  if (!polys.length) return { open: false, rIn: 0, rOut: 0, polys };
  let rIn = Infinity, rOut = 0;
  for (const p of polys) for (const [x, y] of p) { const r = Math.hypot(x, y); rIn = Math.min(rIn, r); rOut = Math.max(rOut, r); }
  const open = !inside([0, 0], polys);
  return { open, rIn: open ? rIn : 0, rOut, polys };
}

// Try all six up-directions. A real lamp opening leads up into a hollow that widens
// (the inside of the shade); a dimple or recess narrows and closes. Score = widest empty
// radius around the axis while walking up from the bottom, until the axis hits material.
function cavityScore(man) {
  const H = man.boundingBox().max[2];
  const first = analyseBottom(man, 0.4);
  if (!first.open) return { score: 0, rIn: 0 };
  let score = first.rIn;
  for (let i = 1; i <= 12; i++) {
    const a = analyseBottom(man, 0.4 + (H * 0.6) * i / 12);
    if (!a.open) break;
    score = Math.max(score, a.rIn);
  }
  return { score, rIn: first.rIn };
}
export function autoUp(M, pos, scale) {
  let best = { up: "+Z", score: -1, rIn: 0 };
  for (const up of UP_DIRS) {
    let man; try { man = toManifold(M, orient(pos, up, scale)); } catch { return { up: "+Z", rIn: 0, failed: true }; }
    const s = cavityScore(man);
    man.delete();
    if (s.score > best.score + 0.5) best = { up, ...s };
  }
  return best;
}

// ---------- thread geometry ----------
function threadSection(M, root, depth, pitch, n = 288) {
  const c = pitch * 0.15, fl = pitch * 0.35, ro = pitch * 0.15;
  const f = (u) => {
    if (u < c) return depth; u -= c;
    if (u < fl) return depth * (1 - u / fl); u -= fl;
    if (u < ro) return 0; u -= ro;
    return depth * (u / fl);
  };
  const pts = [];
  for (let i = 0; i < n; i++) {
    const th = 2 * Math.PI * i / n;
    let u = (-pitch * th / (2 * Math.PI)) % pitch; if (u < 0) u += pitch;
    const r = root + f(u);
    pts.push([r * Math.cos(th), r * Math.sin(th)]);
  }
  return new M.CrossSection([pts]);
}
function threaded(M, root, depth, pitch, h, z0 = 0) {
  const turns = h / pitch;
  return M.Manifold.extrude(threadSection(M, root, depth, pitch), h, Math.ceil(turns * 72), 360 * turns).translate([0, 0, z0]);
}
const SEG = 192;
const cyl = (M, r, h, z0 = 0, r2) => M.Manifold.cylinder(h, r, r2 ?? r, SEG).translate([0, 0, z0]);
const box = (M, x0, x1, y0, y1, z0, z1) => M.Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0]);

export function derive(P) {
  const pocketR = P.ledD / 2 + P.pocketClr;
  const rootR = pocketR + P.wall;
  const crestR = rootR + P.depth;
  const collarROut = crestR + P.thClr + P.collarWall;
  const cableTop = P.floor + P.cableZ + P.cableD / 2;
  const bandH = Math.max(P.bandH, cableTop + 0.8);
  const ledTop = P.floor + P.ledH;
  const threadH = Math.max(P.threadH, ledTop + 0.6 - bandH, P.pitch * 2);
  return { pocketR, rootR, crestR, collarROut, cableTop, bandH, ledTop, threadH, wallTop: bandH + threadH };
}

// Main entry: coverMan is the oriented cover (bottom at z=0, centred). Returns manifolds + report.
export function generate(M, coverMan, P) {
  const D = derive(P);
  const notes = [];
  const bottom = analyseBottom(coverMan);

  // ----- base -----
  let base = cyl(M, D.crestR, D.bandH)
    .subtract(cyl(M, D.crestR + 5, 0.6, -0.01))
    .add(cyl(M, D.crestR - 0.6, 0.6, 0, D.crestR));
  let neck = threaded(M, D.rootR, P.depth, P.pitch, D.threadH, D.bandH).add(cyl(M, D.rootR + 0.01, D.threadH, D.bandH));
  const coneH = D.threadH + 40;
  neck = neck.intersect(M.Manifold.cylinder(coneH, D.rootR - 0.2 + coneH, D.rootR - 0.2, SEG).translate([0, 0, D.wallTop - coneH]));
  base = base.add(neck).subtract(cyl(M, D.pocketR, D.wallTop, P.floor));
  if (P.pushHole) base = base.subtract(cyl(M, Math.min(8, D.pocketR * 0.3), P.floor + 1, -0.5));
  const sw = P.cableD / 2 + 0.4;
  const slot = box(M, -(D.crestR + 5), -(D.pocketR - 4), -sw, sw, -1, D.wallTop + 1).rotate([0, 0, P.slotAngle - 180]);
  base = base.subtract(slot);

  // ----- cover -----
  const cutR = D.collarROut - 0.4;
  let cover = coverMan.subtract(cyl(M, cutR, D.threadH + 1, -1));
  let collar = cyl(M, D.collarROut, D.threadH)
    .subtract(threaded(M, D.rootR + P.thClr, P.depth, P.pitch, D.threadH + 2 * P.pitch, -P.pitch))
    .subtract(M.Manifold.cylinder(1.0, D.crestR + P.thClr + 0.6, D.rootR + P.thClr - 0.4, SEG).translate([0, 0, -0.01]))
    .subtract(M.Manifold.cylinder(1.0, D.rootR + P.thClr - 0.4, D.crestR + P.thClr + 0.6, SEG).translate([0, 0, D.threadH - 0.99]));
  if (bottom.open && bottom.rIn > cutR) {
    // opening wider than the collar: bridge it with a flat flange that overlaps the shell
    const wallT = Math.max(0.6, bottom.rOut - bottom.rIn);
    const flangeR = bottom.rIn + Math.min(wallT * 0.6, 1.2);
    collar = collar.add(cyl(M, flangeR, 1.6).subtract(cyl(M, D.collarROut - 0.2, 2, -0.1)));
    notes.push(`The cover's opening (Ø${(2 * bottom.rIn).toFixed(1)} mm) is wider than the threaded ring, so a 1.6 mm flange was added to bridge the gap.`);
  }
  cover = cover.add(collar);

  // ----- checks -----
  const parts = cover.decompose().length;
  if (parts > 1) notes.push(`Warning: the threaded ring didn't fully join the cover (${parts} separate pieces). Check the bottom of the cover in the preview.`);
  const shellR = Math.max(analyseBottom(coverMan, D.threadH * 0.5).rOut, analyseBottom(coverMan, D.threadH).rOut);
  if (shellR && shellR < D.collarROut) notes.push(`Warning: the cover's lower part (Ø${(2 * shellR).toFixed(1)} mm) is narrower than the threaded ring (Ø${(2 * D.collarROut).toFixed(1)} mm), so the ring will stick out. Use a smaller LED or scale the cover up.`);
  if (!bottom.open) notes.push("The cover had a closed bottom; an opening for the base was cut into it.");
  const clash = base.intersect(cover.translate([0, 0, D.bandH])).volume();
  if (clash > 0.01) notes.push(`Warning: the base and cover overlap by ${clash.toFixed(2)} mm³.`);

  return { base, cover, D, bottom, notes, clash };
}

// ---------- export ----------
export function toSTL(man, name = "part") {
  const m = man.getMesh();
  const vp = m.vertProperties, tv = m.triVerts, np = m.numProp, n = tv.length / 3;
  const buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  const hdr = new TextEncoder().encode(("lamp-thread-maker " + name).slice(0, 79));
  new Uint8Array(buf, 0, hdr.length).set(hdr);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const a = tv[3 * t] * np, b = tv[3 * t + 1] * np, c = tv[3 * t + 2] * np;
    const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
    const wx = vp[c] - vp[a], wy = vp[c + 1] - vp[a + 1], wz = vp[c + 2] - vp[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true); o += 12;
    for (const v of [a, b, c]) { dv.setFloat32(o, vp[v], true); dv.setFloat32(o + 4, vp[v + 1], true); dv.setFloat32(o + 8, vp[v + 2], true); o += 12; }
    o += 2;
  }
  return new Uint8Array(buf);
}

// Minimal store-only ZIP writer.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function zip(files) { // [{name, data:Uint8Array}]
  const enc = new TextEncoder(), chunks = [], central = []; let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true); h.setUint16(26, nm.length, true);
    chunks.push(new Uint8Array(h.buffer), nm, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nm);
    off += 30 + nm.length + sz;
  }
  const cdSize = central.reduce((s, a) => s + a.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...chunks, ...central, new Uint8Array(e.buffer)], { type: "application/zip" });
}
