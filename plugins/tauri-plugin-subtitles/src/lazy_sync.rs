//! LazySync — offset estimation between a user subtitle track and an
//! embedded reference track.
//!
//! This is a line-by-line port of the TypeScript implementation that used to
//! run on the browser main thread:
//! `apps/web/src/features/player/lazy-sync.ts` (docs/SUBTITLE_SYNC.md §10).
//!
//! Algorithm (prefix consensus inlier matching — RANSAC-style hypothesis
//! voting + fine median):
//!
//! 1. Sample the DL'd prefix: `drift[0..30]` and `ref[0..60]`.
//! 2. Vote on candidate offsets from the leading-pair cross-product
//!    (`drift[0..10] × ref[0..20]`), binned to a 25 ms grid.
//! 3. For each candidate, scan every drift cue in the prefix, find the
//!    closest ref cue, and count it as an inlier when the error is ≤ 0.5 s.
//! 4. Take the candidate with the most inliers. Fail-closed when its support
//!    is not above 50 % of `min(drift, ref)`.
//! 5. The fine median of the winning inlier set is the estimate.
//!
//! Robust against extra cues in the reference (the K-ON! failure mode that
//! motivated the rewrite): extra ref cues become "no match" for the wrong
//! candidates instead of silently corrupting the diffs.

use std::cmp::Ordering;
use std::collections::HashMap;

use crate::parser::SubtitleCue;

/// Offset threshold (ffsubsync `--suppress-output-if-offset-less-than`):
/// an offset below this is sub-frame noise — the subtitle counts as already
/// in sync, so no shift is applied.
pub const LAZY_SYNC_MIN_OFFSET_MS: f64 = 100.0;

/// Maximum offset: values beyond this are treated as broken estimates.
pub const LAZY_SYNC_MAX_OFFSET_MS: f64 = 3_600_000.0;

/// Minimum fraction of cues (denominator: `min(N_DRIFT, N_REF)`) that must
/// be inliers for the winning candidate. Below this fraction no single
/// offset is representative and the estimate is refused (fail-closed).
pub const LAZY_SYNC_MIN_CONCENTRATION: f64 = 0.5;

/// Tolerance for "closest ref cue" inlier matching: a drift cue counts as an
/// inlier when there exists a ref cue within this many seconds of
/// `drift.start + offset`.
pub const MATCH_TOLERANCE_SEC: f64 = 0.5;

/// Maximum number of drift cues considered by the consensus algorithm.
pub const N_DRIFT_MAX: usize = 30;

/// Maximum number of ref cues scanned as nearest-neighbor targets.
pub const N_REF_MAX: usize = 60;

/// Maximum number of leading drift cues used to seed candidate offsets.
pub const CANDIDATE_DRIFT_MAX: usize = 10;

/// Maximum number of leading ref cues used to seed candidate offsets.
pub const CANDIDATE_REF_MAX: usize = 20;

/// Round candidate offsets to this grid so near-identical hypotheses from
/// multiple prefix pairs collapse to a single vote (25 ms = 1 frame at
/// 40 fps, well below human timing perception).
const CANDIDATE_BIN_MS: f64 = 25.0;

/// Estimated offset with the number of inliers it was derived from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OffsetEstimate {
    /// Offset in milliseconds (reference − drift).
    pub offset_ms: f64,
    /// Number of drift cues that matched a ref cue for the winning
    /// candidate.
    pub pair_count: usize,
}

/// Estimate the constant offset (reference − drift) between the user subtitle
/// (drift) and the embedded track (reference), in **seconds**.
///
/// The unit matches [`SubtitleCue::start`] so the value can be added to a
/// cue's `start` / `end` directly. `None` means "no trustworthy estimate"
/// (fail-closed): either side is empty, no single offset dominates the vote,
/// or the median offset exceeds one hour.
///
/// An offset whose magnitude is below 100 ms is sub-frame noise and is
/// reported as `Some(0.0)` — "already in sync" — rather than as a tiny
/// shift. `Some(0.0)` and `None` are therefore different outcomes: the first
/// means the tracks agree, the second means the estimator refused.
pub fn estimate_lazy_sync_offset(
    ref_cues: &[SubtitleCue],
    drift_cues: &[SubtitleCue],
) -> Option<f64> {
    let estimate = estimate_offset_ms(drift_cues, ref_cues)?;
    let offset_seconds = estimate.offset_ms / 1000.0;
    if offset_seconds.abs() < LAZY_SYNC_MIN_OFFSET_MS / 1000.0 {
        Some(0.0)
    } else {
        Some(offset_seconds)
    }
}

/// Estimate the constant offset (reference − drift) in milliseconds.
///
/// Returns `None` when:
///
/// - either side has no cues;
/// - the winning candidate's support is not above 50 % of `min(N_DRIFT,
///   N_REF)` (bimodal split, broken reference, mid-track rank misalignment
///   that puts every candidate below the threshold, …);
/// - the median offset exceeds one hour.
pub fn estimate_offset_ms(
    drift_cues: &[SubtitleCue],
    ref_cues: &[SubtitleCue],
) -> Option<OffsetEstimate> {
    if drift_cues.is_empty() || ref_cues.is_empty() {
        return None;
    }

    // Sample the DL'd prefix.
    let n_drift = drift_cues.len().min(N_DRIFT_MAX);
    let n_ref = ref_cues.len().min(N_REF_MAX);
    let drift_sample = &drift_cues[..n_drift];
    let ref_sample = &ref_cues[..n_ref];

    // Seed candidate offsets from the leading-pair cross-product, binned to a
    // 25 ms grid (near-identical hypotheses collapse to a single vote).
    let cand_drift_len = n_drift.min(CANDIDATE_DRIFT_MAX);
    let cand_ref_len = n_ref.min(CANDIDATE_REF_MAX);

    // Map: bin index (round(diffMs / 25)) → representative offsetMs. Using
    // the binned ms value as both key and stored value keeps the candidate
    // aligned to the 25 ms grid used for voting — every vote for the same
    // bin is a vote for the same offset.
    let mut candidate_map: HashMap<i64, f64> = HashMap::new();
    // Insertion order, so the candidates are scored in the same order as the
    // TypeScript `Map` iteration.
    let mut candidate_order: Vec<i64> = Vec::new();
    for drift_cue in drift_sample.iter().take(cand_drift_len) {
        let drift_start = drift_cue.start;
        for ref_cue in ref_sample.iter().take(cand_ref_len) {
            let diff_ms = (ref_cue.start - drift_start) * 1000.0;
            if diff_ms.abs() > LAZY_SYNC_MAX_OFFSET_MS {
                continue;
            }
            let bin = js_round(diff_ms / CANDIDATE_BIN_MS) as i64;
            if let std::collections::hash_map::Entry::Vacant(entry) = candidate_map.entry(bin) {
                entry.insert(bin as f64 * CANDIDATE_BIN_MS);
                candidate_order.push(bin);
            }
        }
    }
    if candidate_order.is_empty() {
        return None;
    }

    // Score each candidate: for every drift cue, find the closest ref cue and
    // count it as an inlier when the error is ≤ MATCH_TOLERANCE_SEC. Record
    // the EXACT diff (matchedRef.start − d.start) * 1000 — the fine median of
    // these is the returned offset.
    let mut best_offset_ms: Option<f64> = None;
    let mut max_inliers = 0usize;
    let mut best_inlier_diffs: Vec<f64> = Vec::new();

    for bin in &candidate_order {
        let offset_ms = candidate_map[bin];
        let offset_sec = offset_ms / 1000.0;
        let mut inlier_diffs: Vec<f64> = Vec::new();
        for drift_cue in drift_sample {
            let target = drift_cue.start + offset_sec;
            let mut min_error = f64::INFINITY;
            let mut matched_ref_idx: Option<usize> = None;
            for (index, ref_cue) in ref_sample.iter().enumerate() {
                let error = (ref_cue.start - target).abs();
                if error < min_error {
                    min_error = error;
                    matched_ref_idx = Some(index);
                }
            }
            if min_error <= MATCH_TOLERANCE_SEC {
                if let Some(index) = matched_ref_idx {
                    inlier_diffs.push((ref_sample[index].start - drift_cue.start) * 1000.0);
                }
            }
        }
        if inlier_diffs.len() > max_inliers {
            max_inliers = inlier_diffs.len();
            best_offset_ms = Some(offset_ms);
            best_inlier_diffs = inlier_diffs;
        }
    }

    // Fail-closed: no offset dominates → refuse.
    //
    // The denominator is min(N_DRIFT, N_REF) — the inlier count is bounded by
    // the smaller of the two sides, so the threshold is meaningful only when
    // also bounded by it.
    let _best_offset_ms = best_offset_ms?;
    let concentration_denom = n_drift.min(n_ref) as f64;
    if max_inliers as f64 / concentration_denom <= LAZY_SYNC_MIN_CONCENTRATION {
        return None;
    }

    // Fine median from the best inlier set. The median is taken at
    // `floor(len / 2)` — the upper median for an even count — exactly like
    // the TypeScript implementation.
    best_inlier_diffs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let median_ms = js_round(best_inlier_diffs[best_inlier_diffs.len() / 2]);

    if !median_ms.is_finite() {
        return None;
    }

    // Median 0 = already in sync: return an estimate (not None) so the caller
    // converges silently.
    if median_ms == 0.0 {
        return Some(OffsetEstimate {
            offset_ms: 0.0,
            pair_count: max_inliers,
        });
    }

    // Extreme values are broken estimates.
    if median_ms.abs() > LAZY_SYNC_MAX_OFFSET_MS {
        return None;
    }

    Some(OffsetEstimate {
        offset_ms: median_ms,
        pair_count: max_inliers,
    })
}

/// JavaScript `Math.round`: ties round toward positive infinity.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}
