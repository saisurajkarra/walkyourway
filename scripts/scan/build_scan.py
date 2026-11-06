#!/usr/bin/env python3
"""Build a dense, coloured 3D scan of a real street from open Mapillary photos (CC BY-SA), on a plain CPU.

  MAPILLARY_TOKEN=... python3 -I scripts/scan/build_scan.py \
      --bbox 2.3290,48.8590,2.3305,48.8600 --model path/to/depth_anything_v2_small.onnx --out out_dir

How it works
 1. Mapillary already solved every photo's camera pose (OpenSfM) and published a sparse 3D point cloud
    ("sfm_cluster") for each group of photos. We download one cluster and its photos.
 2. A monocular depth network (Depth Anything V2, ONNX) predicts dense relative depth for every photo.
 3. For each photo we fit depth = scale/shift against the solved 3D points visible in it (RANSAC), which turns the
    relative depth into real metres.
 4. Every pixel is back-projected through the solved camera pose into the shared world frame, filtered
    (sky, depth edges, low-confidence) and merged into one voxel-deduplicated coloured point set.
 5. Writes scan.bin (+ scan.json). With --preview it also re-renders the scan from the photos' own viewpoints and a
    novel viewpoint, so the geometry can be checked by eye.
"""
import argparse, json, math, os, struct, subprocess, sys, time, urllib.parse, zlib
import numpy as np
from PIL import Image

API = 'https://graph.mapillary.com/images'
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def curl_json(url):
    r = subprocess.run(['curl', '-s', '-m', '60', url], capture_output=True, text=True).stdout
    return json.loads(r or '{}')


def curl_file(url, path):
    subprocess.run(['curl', '-s', '-m', '120', '-o', path, url], check=True)


def rodrigues(r):
    r = np.asarray(r, np.float64); th = np.linalg.norm(r)
    if th < 1e-12: return np.eye(3)
    k = r / th; K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * (K @ K)


class Cam:
    """One solved photo: world -> camera is x_c = R x_w + t (OpenSfM; camera looks along +z, x right, y down)."""
    def __init__(self, shot, camera, w, h):
        self.R = rodrigues(shot['rotation']); self.t = np.array(shot['translation'], np.float64)
        self.C = -self.R.T @ self.t
        self.f, self.k1, self.k2 = camera['focal'], camera.get('k1', 0.0), camera.get('k2', 0.0)
        self.w, self.h, self.s = w, h, max(w, h)

    def project(self, Xw):
        Xc = Xw @ self.R.T + self.t; z = Xc[:, 2]
        x, y = Xc[:, 0] / z, Xc[:, 1] / z; r2 = x * x + y * y
        d = 1 + self.k1 * r2 + self.k2 * r2 * r2
        return (self.f * d * x * self.s + self.w / 2), (self.f * d * y * self.s + self.h / 2), z

    def rays(self, u, v):
        """Pixel coordinates -> unit-z camera rays (undistorted by fixed-point iteration)."""
        xn, yn = (u - self.w / 2) / (self.s * self.f), (v - self.h / 2) / (self.s * self.f); x, y = xn.copy(), yn.copy()
        for _ in range(6):
            r2 = x * x + y * y; d = 1 + self.k1 * r2 + self.k2 * r2 * r2
            x, y = xn / d, yn / d
        return x, y


def load_depth_model(path):
    import onnxruntime as ort
    so = ort.SessionOptions(); so.intra_op_num_threads = os.cpu_count() or 4
    return ort.InferenceSession(path, so, providers=['CPUExecutionProvider'])


def predict_disparity(sess, img, size=(518, 392)):
    """Relative inverse depth (bigger = nearer), float32 at `size` (w, h)."""
    a = (np.asarray(img.convert('RGB').resize(size, Image.BICUBIC), np.float32) / 255 - MEAN) / STD
    out = sess.run(None, {sess.get_inputs()[0].name: a.transpose(2, 0, 1)[None]})[0]
    return out.reshape(size[1], size[0]).astype(np.float32)


def bilinear(arr, u, v):
    """Sample arr (H, W) at float pixel coords (u, v) given in arr's own pixel units."""
    H, W = arr.shape; u = np.clip(u, 0, W - 1.001); v = np.clip(v, 0, H - 1.001)
    u0, v0 = np.floor(u).astype(int), np.floor(v).astype(int); fu, fv = u - u0, v - v0
    return (arr[v0, u0] * (1 - fu) * (1 - fv) + arr[v0, u0 + 1] * fu * (1 - fv) + arr[v0 + 1, u0] * (1 - fu) * fv + arr[v0 + 1, u0 + 1] * fu * fv)


def fit_scale(disp, uv_disp, invz, rng, iters=400, extra=None):
    """Robust fit invz ~= a*disp + b (a > 0). Returns (a, b, inliers, n).
    `extra` = (disp_values, invz_values): additional samples (e.g. the road plane) fitted together with the solved points."""
    d = bilinear(disp, uv_disp[0], uv_disp[1])
    if extra is not None: d = np.concatenate([d, extra[0]]); invz = np.concatenate([invz, extra[1]])
    n = len(invz); best = None
    if n < 20: return None
    for _ in range(iters):
        i, j = rng.choice(n, 2, replace=False)
        if abs(d[i] - d[j]) < 1e-3: continue
        a = (invz[i] - invz[j]) / (d[i] - d[j]); b = invz[i] - a * d[i]
        if a <= 0: continue
        res = np.abs(a * d + b - invz) / np.maximum(invz, 1e-3); inl = res < 0.12; c = int(inl.sum())
        if best is None or c > best[2]: best = (a, b, c, inl)
    if best is None or best[2] < 15: return None
    inl = best[3]; A = np.stack([d[inl], np.ones(inl.sum())], 1)
    a, b = np.linalg.lstsq(A, invz[inl], rcond=None)[0]
    if a <= 0: return None
    return a, b, best[2], n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bbox', required=True, help='lng_min,lat_min,lng_max,lat_max')
    ap.add_argument('--model', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--cluster', help='sfm_cluster id (default: the cluster with most photos in bbox)')
    ap.add_argument('--max-images', type=int, default=80); ap.add_argument('--stride', type=int, default=3)
    ap.add_argument('--voxel', type=float, default=0.06); ap.add_argument('--max-depth', type=float, default=32.0)
    ap.add_argument('--cam-height', type=float, default=1.45, help='phone height above the road (m); anchors the ground plane')
    ap.add_argument('--preview', action='store_true')
    a = ap.parse_args()
    tok = os.environ['MAPILLARY_TOKEN']; os.makedirs(a.out, exist_ok=True); img_dir = os.path.join(a.out, 'photos'); os.makedirs(img_dir, exist_ok=True)
    rng = np.random.default_rng(7)

    # 1. photos + cluster
    q = f"{API}?access_token={urllib.parse.quote(tok)}&bbox={a.bbox}&limit=2000&fields=id,captured_at,sfm_cluster,thumb_2048_url,width,height,camera_type,is_pano"
    rows = [r for r in curl_json(q).get('data', []) if r.get('sfm_cluster') and r.get('camera_type') in ('perspective', 'brown') and not r.get('is_pano')]
    by = {}
    for r in rows: by.setdefault(r['sfm_cluster']['id'], []).append(r)
    cid = a.cluster or max(by, key=lambda k: len(by[k]))
    photos = by[cid]; print(f'cluster {cid}: {len(photos)} perspective photos in bbox')
    cpath = os.path.join(a.out, 'cluster.bin'); curl_file(photos[0]['sfm_cluster']['url'], cpath)
    rec = json.loads(zlib.decompress(open(cpath, 'rb').read()))[0]
    ref = rec['reference_lla']; shots = rec['shots']; cams = rec['cameras']
    by_time = {round(s['capture_time'] * 1000): k for k, s in shots.items()}
    P = np.array([p['coordinates'] for p in rec['points'].values()], np.float64); Pc = np.array([p['color'] for p in rec['points'].values()], np.float32)
    med = np.median(P, 0); keep = np.linalg.norm(P - med, axis=1) < 150; P, Pc = P[keep], Pc[keep]
    print(f'{len(P)} solved 3D points kept (of {len(keep)}), {len(shots)} poses')

    sess = load_depth_model(a.model)
    clouds, centers, stats = [], [], []
    t0 = time.time()
    photos.sort(key=lambda r: r['captured_at'])
    for n, r in enumerate(photos[:a.max_images]):
        sk = by_time.get(r['captured_at'])
        if sk is None: continue
        shot = shots[sk]; cam = Cam(shot, cams[shot['camera']], r['width'], r['height']); centers.append((cam.C, shot['capture_time']))
        path = os.path.join(img_dir, f"{r['id']}.jpg")
        if not os.path.exists(path): curl_file(r['thumb_2048_url'], path)
        img = Image.open(path).convert('RGB'); W, H = img.size
        disp = predict_disparity(sess, img)
        # 3. align to metres with the solved points visible in this photo
        u, v, z = cam.project(P); ok = (z > 0.8) & (z < 60) & (u > 0) & (u < cam.w) & (v > 0) & (v < cam.h)
        # the road is a plane a.cam_height below the phone: inverse depth of a road pixel = (downward ray component) / height
        gx0, gy0 = np.meshgrid(np.linspace(0.12 * W, 0.88 * W, 36), np.linspace(0.68 * H, 0.97 * H, 18)); gx0, gy0 = gx0.ravel(), gy0.ravel()
        rx, ry = cam.rays(gx0, gy0); rw = np.stack([rx, ry, np.ones_like(rx)], 1) @ cam.R   # world direction of each ray (x_w = R^T x_c)
        down = -rw[:, 2]; gok = down > 0.12
        extra = (bilinear(disp, gx0[gok] / W * disp.shape[1], gy0[gok] / H * disp.shape[0]), down[gok] / a.cam_height) if gok.sum() > 30 else None
        fit = fit_scale(disp, (u[ok] / cam.w * disp.shape[1], v[ok] / cam.h * disp.shape[0]), 1 / z[ok], rng, extra=extra) if (ok.sum() >= 20 or extra is not None) else None
        if fit is None: stats.append((r['id'], 0, int(ok.sum()))); print(f'  [{n}] skipped: no usable depth fit'); continue
        sa, sb, inl, tot = fit
        # 4. back-project a pixel grid
        gx, gy = np.meshgrid(np.arange(0, W, a.stride), np.arange(0, H, a.stride)); gx, gy = gx.ravel().astype(np.float64), gy.ravel().astype(np.float64)
        d = bilinear(disp, gx / W * disp.shape[1], gy / H * disp.shape[0]); inv = sa * d + sb
        depth = 1 / np.maximum(inv, 1.0 / 400)
        # depth edges: large log-depth jumps between neighbouring samples are flying pixels
        gw = len(np.arange(0, W, a.stride)); gh = len(np.arange(0, H, a.stride)); L = np.log(depth).reshape(gh, gw)
        gxm = np.zeros_like(L); gym = np.zeros_like(L); gxm[:, 1:-1] = np.abs(L[:, 2:] - L[:, :-2]); gym[1:-1] = np.abs(L[2:] - L[:-2])
        edge = (np.maximum(gxm, gym) > 0.16).ravel()
        mask = (inv > 0) & (depth > 0.6) & (depth < a.max_depth) & ~edge & (gx > W * .02) & (gx < W * .98) & (gy > H * .02) & (gy < H * .98)
        x, y = cam.rays(gx[mask], gy[mask]); zc = depth[mask]
        Xc = np.stack([x * zc, y * zc, zc], 1); Xw = (Xc - cam.t) @ cam.R  # x_w = R^T (x_c - t)
        arr = np.asarray(img, np.uint8); col = arr[np.clip(gy[mask].astype(int), 0, H - 1), np.clip(gx[mask].astype(int), 0, W - 1)]
        clouds.append((Xw.astype(np.float32), col, zc.astype(np.float32))); stats.append((r['id'], inl / tot, tot))
        # where the fitted depth puts the road, relative to the camera (should be about -cam_height)
        inv_g = sa * bilinear(disp, gx0[gok] / W * disp.shape[1], gy0[gok] / H * disp.shape[0]) + sb
        gz = float(np.median(-down[gok] / np.maximum(inv_g, 1e-3))) if gok.sum() else float('nan')
        print(f'  [{n}] {len(Xw):7d} pts  fit {inl}/{tot} inliers  ' + (f'road at {gz:+.2f} m vs camera (target {-a.cam_height:+.2f})' if gz == gz else 'no road visible in this photo') + f'  ({time.time() - t0:.0f}s)')
    if not clouds: sys.exit('no usable photos')

    # 5. merge, nearest-wins voxel dedupe
    Xw = np.concatenate([c[0] for c in clouds]); col = np.concatenate([c[1] for c in clouds]); dep = np.concatenate([c[2] for c in clouds])
    o = np.argsort(dep); Xw, col, dep = Xw[o], col[o], dep[o]
    org = np.median(np.array([c for c, _ in centers]), 0)
    vox = np.floor((Xw - org) / a.voxel).astype(np.int64)
    key = (vox[:, 0] + (1 << 20)) * (1 << 42) + (vox[:, 1] + (1 << 20)) * (1 << 21) + (vox[:, 2] + (1 << 20))
    _, first = np.unique(key, return_index=True); Xw, col = Xw[first], col[first]
    print(f'merged {len(dep):,} -> {len(Xw):,} points at {a.voxel * 100:.0f} cm voxels')
    perm = np.random.default_rng(11).permutation(len(Xw)); Xw, col = Xw[perm], col[perm]  # shuffled: any prefix is a uniform subsample (quality levels)
    q = np.round((Xw - org) / 0.02).astype(np.int32)
    inside = (np.abs(q) < 32000).all(1); q, col = q[inside].astype(np.int16), col[inside]
    with open(os.path.join(a.out, 'scan.bin'), 'wb') as f: f.write(q.tobytes()); f.write(col.astype(np.uint8).tobytes())
    path = [[round(float(c[0] - org[0]), 2), round(float(c[1] - org[1]), 2), round(float(c[2] - org[2]), 2)] for c, _ in sorted(centers, key=lambda t: t[1])]
    json.dump({'ref': ref, 'origin': [float(v) for v in org], 'step': 0.02, 'count': int(len(q)), 'path': path, 'license': 'CC BY-SA 4.0, Mapillary contributors', 'cluster': cid},
              open(os.path.join(a.out, 'scan.json'), 'w'))
    print('wrote', len(q), 'points,', round(len(q) * 9 / 1e6, 1), 'MB')
    if a.preview: preview(a, photos, shots, cams, by_time, Xw, col, org)


def render(cam, Xw, col, W=640, H=480):
    u, v, z = cam.project(Xw); u, v = u * W / cam.w, v * H / cam.h
    ok = (z > 0.4) & (u > 1) & (u < W - 2) & (v > 1) & (v < H - 2); u, v, z, c = u[ok], v[ok], z[ok], col[ok]
    img = np.full((H, W, 3), (28, 36, 52), np.uint8); zb = np.full((H, W), 1e9, np.float32)
    o = np.argsort(-z)  # far first; near overwrites
    for du, dv in ((0, 0), (1, 0), (0, 1), (1, 1), (-1, 0), (0, -1)):
        pass
    r = np.clip(np.round(2.2 / np.sqrt(np.maximum(z, 0.5))).astype(int), 0, 3)
    for rr in range(3, -1, -1):
        sel = o[r[o] == rr] if rr else o[r[o] <= 0]
        for dy in range(-rr, rr + 1):
            for dx in range(-rr, rr + 1):
                yy, xx = np.clip(np.round(v[sel]).astype(int) + dy, 0, H - 1), np.clip(np.round(u[sel]).astype(int) + dx, 0, W - 1)
                img[yy, xx] = c[sel]
    return img


def preview(a, photos, shots, cams, by_time, Xw, col, org):
    out = []
    ks = [k for k in (by_time.get(r['captured_at']) for r in photos) if k]
    for tag, idx, shift in (('same viewpoint as photo', len(ks) // 4, 0.0), ('same viewpoint as photo', len(ks) // 2, 0.0), ('novel: 2 m to the side', len(ks) // 2, 2.0)):
        s = dict(shots[ks[idx]]); cm = cams[s['camera']]; cam = Cam(s, cm, cm['width'], cm['height'])
        if shift:
            R = rodrigues(s['rotation']); C = -R.T @ np.array(s['translation']) + R.T @ np.array([shift, 0, 0]); cam.C = C; cam.t = -R @ C
        out.append((tag, render(cam, Xw, col)))
    W = sum(i.shape[1] for _, i in out); canvas = Image.new('RGB', (W, 480 + 0)); x = 0
    for _, im in out: canvas.paste(Image.fromarray(im), (x, 0)); x += im.shape[1]
    canvas.save(os.path.join(a.out, 'preview.png')); print('preview ->', os.path.join(a.out, 'preview.png'))


if __name__ == '__main__': main()
