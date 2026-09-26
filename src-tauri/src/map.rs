//! The sound map: a 2-D arrangement where similar sounds sit together.
//! A t-SNE of up to `LANDMARKS` samples gives the map its shape; every other sample is
//! placed among its closest landmarks. Big libraries arrange in a second or two, and the
//! map keeps its shape while files are added.

use crate::model::MapLabel;
use crate::sounds::{Aspect, SoundIndex, OTHER_GROUP};
use base64::Engine as _;
use std::collections::HashMap;

pub const LANDMARKS: usize = 2000;
const NEIGHBOURS: usize = 6;

pub struct Layout {
    pub serial: u64,
    /// `SoundIndex::version` this was arranged from.
    pub version: u64,
    pub kind: Option<u8>,
    pub aspect: Aspect,
    pub ids: Vec<i64>,
    /// Positions in 0–1 (the longer side spans the whole range).
    pub xy: Vec<[f32; 2]>,
    /// Color group, brightness and level per point.
    meta: Vec<[u8; 3]>,
    pub labels: Vec<MapLabel>,
    landmarks: Vec<i64>,
    landmark_xy: Vec<[f32; 2]>,
}

impl Layout {
    pub fn key(&self) -> String {
        let kind = match self.kind {
            Some(0) => "oneshot",
            Some(_) => "loop",
            None => "all",
        };
        format!("{kind}-{}-{}", self.aspect.name(), self.serial)
    }

    /// 12 bytes per point, as documented on `MapLayout::points`.
    pub fn encode(&self) -> String {
        let mut out = Vec::with_capacity(self.ids.len() * 12);
        for (k, id) in self.ids.iter().enumerate() {
            out.extend((*id as i32).to_le_bytes());
            out.extend(((self.xy[k][0] * 65535.0).round() as u16).to_le_bytes());
            out.extend(((self.xy[k][1] * 65535.0).round() as u16).to_le_bytes());
            out.extend(self.meta[k]);
            out.push(0);
        }
        base64::engine::general_purpose::STANDARD.encode(out)
    }
}

fn splitmix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

/// Runs `f` for 0..n on all cores, keeping the order.
fn parallel<T: Send>(n: usize, f: impl Fn(usize) -> T + Sync) -> Vec<T> {
    let threads = std::thread::available_parallelism().map(|t| t.get()).unwrap_or(4).clamp(1, 16);
    if n < 256 || threads == 1 {
        return (0..n).map(f).collect();
    }
    let chunk = n.div_ceil(threads);
    std::thread::scope(|s| {
        let f = &f;
        let handles: Vec<_> = (0..threads).map(|t| s.spawn(move || (t * chunk..((t + 1) * chunk).min(n)).map(f).collect::<Vec<T>>())).collect();
        handles.into_iter().flat_map(|h| h.join().expect("layout worker panicked")).collect()
    })
}

fn sq(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum()
}

pub fn arrange(ix: &SoundIndex, kind: Option<u8>, aspect: Aspect, previous: Option<&Layout>, serial: u64) -> Layout {
    let members: Vec<usize> = (0..ix.len()).filter(|&i| kind.is_none_or(|k| ix.kinds[i] == k)).collect();
    let vectors: Vec<Vec<f32>> = members.iter().map(|&i| ix.weighted(i, aspect)).collect();

    // A library that only changed a little keeps its map; new samples find their place in it.
    let kept: Option<(Vec<i64>, Vec<[f32; 2]>)> = previous.and_then(|p| {
        let grown = members.len() as f64 / p.ids.len().max(1) as f64;
        let still: Vec<(i64, [f32; 2])> =
            p.landmarks.iter().zip(&p.landmark_xy).filter(|(id, _)| ix.position(**id).is_some()).map(|(id, xy)| (*id, *xy)).collect();
        let enough = still.len() * 10 >= p.landmarks.len() * 9 && !still.is_empty();
        (enough && (0.9..=1.1).contains(&grown)).then(|| still.into_iter().unzip())
    });
    let (landmarks, landmark_xy) = kept.unwrap_or_else(|| {
        let mut chosen: Vec<usize> = members.clone();
        if chosen.len() > LANDMARKS {
            chosen.sort_by_key(|&i| splitmix(ix.ids[i] as u64));
            chosen.truncate(LANDMARKS);
            chosen.sort_unstable();
        }
        let x: Vec<Vec<f32>> = chosen.iter().map(|&i| ix.weighted(i, aspect)).collect();
        (chosen.iter().map(|&i| ix.ids[i]).collect(), tsne(&x))
    });

    let landmark_vecs: Vec<Vec<f32>> = landmarks.iter().map(|id| ix.weighted(ix.position(*id).expect("landmark is indexed"), aspect)).collect();
    let landmark_of: HashMap<i64, usize> = landmarks.iter().enumerate().map(|(k, id)| (*id, k)).collect();
    // How far apart landmarks sit on the map, for spreading out samples placed near one.
    let spacing: Vec<f32> = parallel(landmark_xy.len(), |a| {
        let mut best = f32::MAX;
        for (b, q) in landmark_xy.iter().enumerate() {
            if a != b {
                let d = (landmark_xy[a][0] - q[0]).powi(2) + (landmark_xy[a][1] - q[1]).powi(2);
                best = best.min(d);
            }
        }
        if best == f32::MAX { 1.0 } else { best.sqrt() }
    });

    let raw: Vec<[f32; 2]> = parallel(members.len(), |m| {
        let id = ix.ids[members[m]];
        if let Some(&k) = landmark_of.get(&id) {
            return landmark_xy[k];
        }
        if landmark_vecs.is_empty() {
            return [0.0, 0.0];
        }
        let mut near: Vec<(usize, f32)> = landmark_vecs.iter().enumerate().map(|(k, v)| (k, sq(&vectors[m], v))).collect();
        let k = NEIGHBOURS.min(near.len());
        near.select_nth_unstable_by(k - 1, |a, b| a.1.total_cmp(&b.1));
        near.truncate(k);
        near.sort_by(|a, b| a.1.total_cmp(&b.1));
        let d0 = near[0].1.sqrt();
        let scale = 0.35 * d0 + 1e-4;
        let (mut x, mut y, mut wsum) = (0f32, 0f32, 0f32);
        for (k, d) in &near {
            let w = (-(d.sqrt() - d0) / scale).exp();
            x += w * landmark_xy[*k][0];
            y += w * landmark_xy[*k][1];
            wsum += w;
        }
        // A little deterministic scatter so samples near the same landmark don't stack up.
        let h = splitmix(id as u64);
        let angle = (h & 0xFFFF) as f32 / 65536.0 * std::f32::consts::TAU;
        let radius = 0.35 * spacing[near[0].0] * (((h >> 16) & 0xFFFF) as f32 / 65536.0).sqrt();
        [x / wsum + radius * angle.cos(), y / wsum + radius * angle.sin()]
    });

    let xy = normalize(&raw);
    let meta: Vec<[u8; 3]> = members.iter().map(|&i| [ix.groups[i], brightness_byte(ix.brightness[i]), level_byte(ix.level[i])]).collect();
    let labels = labels(&xy, &meta);
    Layout {
        serial,
        version: ix.version,
        kind,
        aspect,
        ids: members.iter().map(|&i| ix.ids[i]).collect(),
        xy,
        meta,
        labels,
        landmarks,
        landmark_xy,
    }
}

fn brightness_byte(hz: f32) -> u8 {
    if !hz.is_finite() {
        return 0;
    }
    let (lo, hi) = (150f32.log10(), 8000f32.log10());
    (((hz.max(1.0).log10() - lo) / (hi - lo)).clamp(0.0, 1.0) * 255.0).round() as u8
}

fn level_byte(db: f32) -> u8 {
    if !db.is_finite() {
        return 0;
    }
    (((db + 60.0) / 60.0).clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Centers the points in 0–1, ignoring the most extreme 0.5% on each side.
fn normalize(raw: &[[f32; 2]]) -> Vec<[f32; 2]> {
    if raw.is_empty() {
        return Vec::new();
    }
    let bounds = |axis: usize| {
        let mut v: Vec<f32> = raw.iter().map(|p| p[axis]).collect();
        v.sort_by(|a, b| a.total_cmp(b));
        let cut = v.len() / 200;
        (v[cut], v[v.len() - 1 - cut])
    };
    let ((x0, x1), (y0, y1)) = (bounds(0), bounds(1));
    let span = (x1 - x0).max(y1 - y0).max(1e-6);
    let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
    raw.iter().map(|p| [((p[0] - cx) / span + 0.5).clamp(0.0, 1.0), ((p[1] - cy) / span + 0.5).clamp(0.0, 1.0)]).collect()
}

/// One label per color group, where that group is densest.
fn labels(xy: &[[f32; 2]], meta: &[[u8; 3]]) -> Vec<MapLabel> {
    const GRID: usize = 32;
    let n = xy.len();
    let mut counts: HashMap<u8, Vec<u32>> = HashMap::new();
    let cell = |p: &[f32; 2]| ((p[0] * (GRID - 1) as f32).round() as usize, (p[1] * (GRID - 1) as f32).round() as usize);
    for (p, m) in xy.iter().zip(meta) {
        let (cx, cy) = cell(p);
        counts.entry(m[0]).or_insert_with(|| vec![0; GRID * GRID])[cy * GRID + cx] += 1;
    }
    let mut out = Vec::new();
    for (group, grid) in counts {
        let total: u32 = grid.iter().sum();
        if group == OTHER_GROUP || (total as usize) < 6.max(n / 200) {
            continue;
        }
        let around = |cx: usize, cy: usize| -> u32 {
            let mut s = 0;
            for y in cy.saturating_sub(1)..=(cy + 1).min(GRID - 1) {
                for x in cx.saturating_sub(1)..=(cx + 1).min(GRID - 1) {
                    s += grid[y * GRID + x];
                }
            }
            s
        };
        let (bx, by) = (0..GRID * GRID).map(|c| (c % GRID, c / GRID)).max_by_key(|&(x, y)| around(x, y)).unwrap_or((0, 0));
        let (mut sx, mut sy, mut k) = (0f32, 0f32, 0f32);
        for (p, m) in xy.iter().zip(meta) {
            let (cx, cy) = cell(p);
            if m[0] == group && cx.abs_diff(bx) <= 1 && cy.abs_diff(by) <= 1 {
                sx += p[0];
                sy += p[1];
                k += 1.0;
            }
        }
        if k > 0.0 {
            out.push(MapLabel { group, x: sx / k, y: sy / k, count: total as usize });
        }
    }
    out.sort_by_key(|l| l.group);
    out
}

/// Two principal components, as a deterministic starting point for t-SNE.
fn pca2(x: &[Vec<f32>]) -> Vec<[f32; 2]> {
    let n = x.len();
    let d = x.first().map_or(0, |r| r.len());
    if d == 0 {
        return (0..n).map(|i| [(i as f32).sin(), (i as f32 * 1.7).cos()]).collect();
    }
    let mut mean = vec![0f64; d];
    for r in x {
        for (m, v) in mean.iter_mut().zip(r) {
            *m += *v as f64 / n as f64;
        }
    }
    let mut cov = vec![0f64; d * d];
    for r in x {
        for a in 0..d {
            let va = r[a] as f64 - mean[a];
            for b in a..d {
                cov[a * d + b] += va * (r[b] as f64 - mean[b]);
            }
        }
    }
    for a in 0..d {
        for b in 0..a {
            cov[a * d + b] = cov[b * d + a];
        }
    }
    let mut comps: Vec<Vec<f64>> = Vec::new();
    for c in 0..2 {
        let mut v: Vec<f64> = (0..d).map(|i| 1.0 + ((i * 7 + c * 3) % 5) as f64 * 0.1).collect();
        for _ in 0..200 {
            let mut w: Vec<f64> = (0..d).map(|a| (0..d).map(|b| cov[a * d + b] * v[b]).sum()).collect();
            for p in &comps {
                let dot: f64 = w.iter().zip(p).map(|(a, b)| a * b).sum();
                w.iter_mut().zip(p).for_each(|(a, b)| *a -= dot * b);
            }
            let norm = w.iter().map(|a| a * a).sum::<f64>().sqrt();
            if norm < 1e-12 {
                break;
            }
            v = w.into_iter().map(|a| a / norm).collect();
        }
        comps.push(v);
    }
    x.iter()
        .enumerate()
        .map(|(i, r)| {
            let proj = |c: &Vec<f64>| r.iter().zip(&mean).zip(c).map(|((v, m), w)| (*v as f64 - m) * w).sum::<f64>() as f32;
            // Tiny deterministic offsets keep identical points apart.
            let jitter = (splitmix(i as u64) & 0xFFFF) as f32 / 65536.0 - 0.5;
            [proj(&comps[0]) + jitter * 1e-3, proj(&comps[1]) - jitter * 1e-3]
        })
        .collect()
}

/// Similarities between each point and its nearest neighbours, for a perplexity.
fn affinities(x: &[Vec<f32>], i: usize, k: usize, perplexity: f32) -> Vec<(usize, f32)> {
    let mut d: Vec<(usize, f32)> = x.iter().enumerate().filter(|(j, _)| *j != i).map(|(j, v)| (j, sq(&x[i], v))).collect();
    d.select_nth_unstable_by(k - 1, |a, b| a.1.total_cmp(&b.1));
    d.truncate(k);
    let dmin = d.iter().map(|e| e.1).fold(f32::MAX, f32::min);
    let target = perplexity.ln();
    let (mut beta, mut lo, mut hi) = (1f32, 0f32, f32::INFINITY);
    let mut p = vec![0f32; k];
    for _ in 0..64 {
        let mut sum = 0f32;
        let mut weighted = 0f32;
        for (pj, (_, dj)) in p.iter_mut().zip(&d) {
            *pj = (-beta * (dj - dmin)).exp();
            sum += *pj;
            weighted += *pj * (dj - dmin);
        }
        let entropy = sum.ln() + beta * weighted / sum;
        if (entropy - target).abs() < 1e-4 {
            break;
        }
        if entropy > target {
            lo = beta;
            beta = if hi.is_infinite() { beta * 2.0 } else { (beta + hi) / 2.0 };
        } else {
            hi = beta;
            beta = (beta + lo) / 2.0;
        }
    }
    let sum: f32 = p.iter().sum();
    d.iter().zip(&p).map(|((j, _), pj)| (*j, pj / sum)).collect()
}

/// Exact-gradient t-SNE into two dimensions.
pub fn tsne(x: &[Vec<f32>]) -> Vec<[f32; 2]> {
    let n = x.len();
    if n < 8 {
        return (0..n).map(|i| {
            let a = std::f32::consts::TAU * i as f32 / n.max(1) as f32;
            [a.cos(), a.sin()]
        }).collect();
    }
    let perplexity = 30f32.min((n - 1) as f32 / 3.0);
    let k = ((3.0 * perplexity).ceil() as usize).clamp(1, n - 1);
    let cond = parallel(n, |i| affinities(x, i, k, perplexity));
    let mut p: Vec<Vec<(usize, f32)>> = vec![Vec::new(); n];
    for (i, row) in cond.iter().enumerate() {
        for &(j, v) in row {
            p[i].push((j, v));
            p[j].push((i, v));
        }
    }
    let norm = 1.0 / (2.0 * n as f32);
    for row in &mut p {
        row.sort_by_key(|e| e.0);
        let mut merged: Vec<(usize, f32)> = Vec::with_capacity(row.len());
        for &(j, v) in row.iter() {
            match merged.last_mut() {
                Some(last) if last.0 == j => last.1 += v,
                _ => merged.push((j, v)),
            }
        }
        merged.iter_mut().for_each(|e| e.1 *= norm);
        *row = merged;
    }

    let mut y = pca2(x);
    let std = {
        let m = y.iter().map(|p| p[0]).sum::<f32>() / n as f32;
        (y.iter().map(|p| (p[0] - m).powi(2)).sum::<f32>() / n as f32).sqrt().max(1e-12)
    };
    y.iter_mut().for_each(|p| {
        p[0] *= 1e-4 / std;
        p[1] *= 1e-4 / std;
    });

    const ITERATIONS: usize = 600;
    const EXAGGERATED: usize = 200;
    const EXAGGERATION: f32 = 12.0;
    let learning_rate = (n as f32 / EXAGGERATION).max(50.0);
    let mut velocity = vec![[0f32; 2]; n];
    let mut gains = vec![[1f32; 2]; n];
    for it in 0..ITERATIONS {
        let (exaggeration, momentum) = if it < EXAGGERATED { (EXAGGERATION, 0.5) } else { (1.0, 0.8) };
        let yy = &y;
        let repulsion: Vec<([f32; 2], f64)> = parallel(n, |i| {
            let (xi, yi) = (yy[i][0], yy[i][1]);
            let (mut rx, mut ry, mut z) = (0f32, 0f32, 0f64);
            for (j, q) in yy.iter().enumerate() {
                if j == i {
                    continue;
                }
                let (dx, dy) = (xi - q[0], yi - q[1]);
                let w = 1.0 / (1.0 + dx * dx + dy * dy);
                z += w as f64;
                rx += w * w * dx;
                ry += w * w * dy;
            }
            ([rx, ry], z)
        });
        let z = repulsion.iter().map(|r| r.1).sum::<f64>().max(1e-12) as f32;
        for i in 0..n {
            let (mut ax, mut ay) = (0f32, 0f32);
            for &(j, pij) in &p[i] {
                let (dx, dy) = (y[i][0] - y[j][0], y[i][1] - y[j][1]);
                let w = 1.0 / (1.0 + dx * dx + dy * dy);
                ax += pij * exaggeration * w * dx;
                ay += pij * exaggeration * w * dy;
            }
            let grad = [4.0 * (ax - repulsion[i].0[0] / z), 4.0 * (ay - repulsion[i].0[1] / z)];
            for d in 0..2 {
                let g = &mut gains[i][d];
                *g = if (grad[d] > 0.0) != (velocity[i][d] > 0.0) { *g + 0.2 } else { (*g * 0.8).max(0.01) };
                velocity[i][d] = momentum * velocity[i][d] - learning_rate * *g * grad[d];
            }
        }
        let (mut mx, mut my) = (0f32, 0f32);
        for (p, v) in y.iter_mut().zip(&velocity) {
            p[0] += v[0];
            p[1] += v[1];
            mx += p[0];
            my += p[1];
        }
        let (mx, my) = (mx / n as f32, my / n as f32);
        y.iter_mut().for_each(|p| {
            p[0] -= mx;
            p[1] -= my;
        });
    }
    y
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sounds::tests::library;

    fn blob(center: [f32; 3], n: usize, seed: u64) -> Vec<Vec<f32>> {
        (0..n)
            .map(|i| {
                let h = splitmix(seed * 1000 + i as u64);
                let r = |s: u32| ((h >> s) & 0xFF) as f32 / 255.0 - 0.5;
                vec![center[0] + r(0), center[1] + r(8), center[2] + r(16)]
            })
            .collect()
    }

    #[test]
    fn tsne_keeps_clusters_apart() {
        let mut x = blob([0.0, 0.0, 0.0], 60, 1);
        x.extend(blob([8.0, 0.0, 0.0], 60, 2));
        x.extend(blob([0.0, 8.0, 8.0], 60, 3));
        let y = tsne(&x);
        let centroid = |r: std::ops::Range<usize>| {
            let n = r.len() as f32;
            let (sx, sy) = r.fold((0.0, 0.0), |a, i| (a.0 + y[i][0], a.1 + y[i][1]));
            [sx / n, sy / n]
        };
        let cs = [centroid(0..60), centroid(60..120), centroid(120..180)];
        let spread = |r: std::ops::Range<usize>, c: [f32; 2]| r.map(|i| ((y[i][0] - c[0]).powi(2) + (y[i][1] - c[1]).powi(2)).sqrt()).fold(0f32, f32::max);
        let widest = (0..3).map(|k| spread(k * 60..(k + 1) * 60, cs[k])).fold(0f32, f32::max);
        for a in 0..3 {
            for b in a + 1..3 {
                let gap = ((cs[a][0] - cs[b][0]).powi(2) + (cs[a][1] - cs[b][1]).powi(2)).sqrt();
                assert!(gap > widest, "clusters overlap: gap {gap}, spread {widest}");
            }
        }
    }

    #[test]
    fn arranges_a_library_and_keeps_its_shape() {
        let ix = SoundIndex::build(1, library());
        let layout = arrange(&ix, None, Aspect::Timbre, None, 1);
        assert_eq!(layout.ids.len(), ix.len());
        assert!(layout.xy.iter().all(|p| (0.0..=1.0).contains(&p[0]) && (0.0..=1.0).contains(&p[1])));
        let points = base64::engine::general_purpose::STANDARD.decode(layout.encode()).unwrap();
        assert_eq!(points.len(), ix.len() * 12);
        assert_eq!(i32::from_le_bytes(points[0..4].try_into().unwrap()) as i64, layout.ids[0]);
        // Kicks, hats and pads each get a label.
        assert_eq!(layout.labels.iter().map(|l| l.group).collect::<Vec<_>>(), vec![0, 2, 5]);

        // Only one-shots.
        let shots = arrange(&ix, Some(0), Aspect::Overall, None, 2);
        assert_eq!(shots.ids.len(), 16);

        // The same library arranged again keeps its landmarks' positions.
        let again = arrange(&ix, None, Aspect::Timbre, Some(&layout), 3);
        assert_eq!(again.xy, layout.xy);
        assert_eq!(again.key(), "all-timbre-3");
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use crate::db::FeatureRow;
    use crate::features::LEN;

    /// `cargo test --release --lib map::bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn arrange_a_big_library() {
        let n = 26_000;
        let rows: Vec<FeatureRow> = (0..n)
            .map(|i| {
                let cluster = (i % 9) as f32;
                let features = (0..LEN).map(|d| cluster * ((d * 7 % 5) as f32 - 2.0) + ((splitmix((i * LEN + d) as u64) & 0xFFFF) as f32 / 65536.0 - 0.5) * 3.0).collect();
                FeatureRow { id: i as i64 + 1, kind: (i % 3 == 0) as i64, source_id: 1, category: None, features }
            })
            .collect();
        let t = std::time::Instant::now();
        let ix = SoundIndex::build(1, rows);
        println!("index: {:.2?}", t.elapsed());
        let t = std::time::Instant::now();
        let l = arrange(&ix, None, Aspect::Overall, None, 1);
        println!("arrange {} points: {:.2?}", l.ids.len(), t.elapsed());
        let t = std::time::Instant::now();
        let again = arrange(&ix, None, Aspect::Overall, Some(&l), 2);
        println!("re-place: {:.2?}", t.elapsed());
        assert_eq!(again.ids.len(), n);
        let t = std::time::Instant::now();
        let q = ix.vector(5).to_vec();
        let hits = ix.nearest(&q, Aspect::Overall, 40, |_| true);
        println!("similar: {:.2?} ({} hits)", t.elapsed(), hits.len());
    }
}
