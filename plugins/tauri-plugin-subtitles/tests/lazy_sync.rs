//! LazySync offset estimation tests.
//!
//! Ported one-to-one from the TypeScript suite that guarded the browser
//! implementation: `apps/web/tests/lazy-sync.test.ts`.
//!
//! The TypeScript estimator returns milliseconds; the public Rust API
//! returns seconds so it can be added to a cue's `start` / `end` directly.
//! Both are covered here.

use tauri_plugin_subtitles::{estimate_lazy_sync_offset, estimate_offset_ms, SubtitleCue};

fn cue(id: usize, start: f64, text: &str) -> SubtitleCue {
    SubtitleCue {
        id,
        start,
        end: start + 2.0,
        text: text.to_string(),
    }
}

fn track(count: usize, step: f64, offset: f64, prefix: &str) -> Vec<SubtitleCue> {
    (0..count)
        .map(|index| cue(index, index as f64 * step + offset, &format!("{prefix}-{index}")))
        .collect()
}

#[test]
fn detects_a_positive_1_5_second_offset() {
    let drift = track(10, 5.0, 0.0, "ja");
    let reference = track(10, 5.0, 1.5, "en");

    let estimate = estimate_offset_ms(&drift, &reference).expect("estimate");
    assert_eq!(estimate.offset_ms, 1500.0);
    assert_eq!(estimate.pair_count, 10);

    assert_eq!(
        estimate_lazy_sync_offset(&reference, &drift),
        Some(1.5),
        "the public API reports seconds"
    );
}

#[test]
fn detects_a_positive_8_5_second_offset() {
    let drift = track(10, 3.0, 0.0, "ja");
    let reference = track(10, 3.0, 8.5, "en");

    let estimate = estimate_offset_ms(&drift, &reference).expect("estimate");
    assert_eq!(estimate.offset_ms, 8500.0);
}

#[test]
fn detects_a_positive_180_second_offset() {
    let drift = track(10, 5.0, 0.0, "ja");
    let reference = track(10, 5.0, 180.0, "en");

    let estimate = estimate_offset_ms(&drift, &reference).expect("estimate");
    assert_eq!(estimate.offset_ms, 180_000.0);
}

#[test]
fn resists_outliers() {
    let mut drift = track(12, 5.0, 0.0, "ja");
    let reference = track(12, 5.0, 5.0, "en");
    // Scatter two drift cues to wildly wrong times.
    drift[0] = cue(0, 999.0, "ja-0");
    drift[11] = cue(11, 1000.0, "ja-11");

    let estimate = estimate_offset_ms(&drift, &reference).expect("estimate");
    assert_eq!(estimate.offset_ms, 0.0);
    assert_eq!(estimate.pair_count, 10);
}

#[test]
fn prefix_consensus_on_a_long_track() {
    let drift = track(200, 5.0, 0.0, "ja");
    let reference = track(200, 5.0, 2.5, "en");

    let estimate = estimate_offset_ms(&drift, &reference).expect("estimate");
    assert_eq!(estimate.offset_ms, 2500.0);
    assert_eq!(estimate.pair_count, 30);
}

#[test]
fn handles_a_large_reference_track() {
    let drift = track(83, 0.45, 0.0, "ja");
    let reference = track(16_315, 0.45, 1.5, "en");

    let estimate = estimate_offset_ms(&drift, &reference).expect("estimate");
    assert_eq!(estimate.offset_ms, 1500.0);
    assert_eq!(estimate.pair_count, 30);
}

#[test]
fn returns_none_when_the_drift_side_is_empty() {
    let reference = track(10, 5.0, 0.0, "en");
    assert!(estimate_offset_ms(&[], &reference).is_none());
    assert!(estimate_lazy_sync_offset(&reference, &[]).is_none());
}

#[test]
fn returns_none_when_the_reference_side_is_empty() {
    let drift = track(10, 5.0, 0.0, "ja");
    assert!(estimate_offset_ms(&drift, &[]).is_none());
    assert!(estimate_lazy_sync_offset(&[], &drift).is_none());
}

#[test]
fn returns_none_when_both_sides_are_empty() {
    assert!(estimate_offset_ms(&[], &[]).is_none());
}

#[test]
fn already_in_sync_returns_zero_instead_of_none() {
    let cues = track(10, 5.0, 0.0, "line");
    let estimate = estimate_offset_ms(&cues, &cues).expect("estimate");
    assert_eq!(estimate.offset_ms, 0.0);
    assert_eq!(estimate.pair_count, 10);

    // `Some(0.0)` — "already in sync" — is not the same as `None` ("refused").
    assert_eq!(estimate_lazy_sync_offset(&cues, &cues), Some(0.0));
}

#[test]
fn fails_closed_on_a_bimodal_split() {
    // 5 pairs at −1.5 s and 5 at +1.5 s: 5/10 = 50 % is not above the 50 %
    // threshold, so no single offset dominates and the estimate is refused.
    let drift = track(10, 5.0, 10.0, "ja");
    let reference: Vec<SubtitleCue> = (0..10)
        .map(|index| {
            let start = index as f64 * 5.0 + 10.0 + if index < 5 { -1.5 } else { 1.5 };
            cue(index, start, &format!("en-{index}"))
        })
        .collect();

    assert!(estimate_offset_ms(&drift, &reference).is_none());
    assert!(estimate_lazy_sync_offset(&reference, &drift).is_none());
}

#[test]
fn picks_the_no_shift_candidate_for_a_mid_track_gap() {
    // A 3 s gap inserted mid-track splits the diffs into 3× 0 s and 3× +3 s.
    // Both candidates score 5/6 inliers and the first one encountered (the
    // no-shift candidate) wins.
    let drift = track(6, 3.0, 0.0, "ja");
    let reference: Vec<SubtitleCue> = (0..6)
        .map(|index| {
            let start = if index >= 3 {
                index as f64 * 3.0 + 3.0
            } else {
                index as f64 * 3.0
            };
            cue(index, start, &format!("en-{index}"))
        })
        .collect();

    let estimate = estimate_offset_ms(&drift, &reference).expect("estimate");
    assert_eq!(estimate.offset_ms, 0.0);
    assert_eq!(estimate.pair_count, 5);
}

#[test]
fn picks_the_smaller_offset_candidate_for_a_large_offset_with_a_gap() {
    let drift = track(6, 3.0, 0.0, "ja");
    let reference: Vec<SubtitleCue> = (0..6)
        .map(|index| {
            let start = if index >= 3 {
                index as f64 * 3.0 + 3.0
            } else {
                index as f64 * 3.0
            } + 8.7;
            cue(index, start, &format!("en-{index}"))
        })
        .collect();

    let estimate = estimate_offset_ms(&drift, &reference).expect("estimate");
    assert_eq!(estimate.offset_ms, 8700.0);
    assert_eq!(estimate.pair_count, 5);
}

#[test]
fn returns_none_when_the_offset_exceeds_one_hour() {
    let drift = track(10, 5.0, 0.0, "ja");
    let reference = track(10, 5.0, 3700.0, "en");

    assert!(estimate_offset_ms(&drift, &reference).is_none());
}

#[test]
fn detects_a_negative_offset() {
    let drift = track(10, 5.0, 3.0, "ja");
    let reference = track(10, 5.0, 0.0, "en");

    let estimate = estimate_offset_ms(&drift, &reference).expect("estimate");
    assert_eq!(estimate.offset_ms, -3000.0);
    assert_eq!(
        estimate_lazy_sync_offset(&reference, &drift),
        Some(-3.0),
        "the public API reports seconds and keeps the sign"
    );
}

#[test]
fn works_with_a_single_cue_on_each_side() {
    let drift = vec![cue(0, 10.0, "ja-0")];
    let reference = vec![cue(0, 12.5, "en-0")];

    let estimate = estimate_offset_ms(&drift, &reference).expect("estimate");
    assert_eq!(estimate.offset_ms, 2500.0);
    assert_eq!(estimate.pair_count, 1);
}

#[test]
fn detects_the_offset_when_the_reference_has_extra_sign_cues() {
    // The real-world K-ON! failure mode: the embedded reference holds three
    // extra on-screen sign cues, which shifts every rank pair. The prefix
    // consensus seeds candidates from the leading pairs and validates them
    // against the whole prefix, so the correct offset wins by a wide margin.
    let drift = track(20, 5.0, 0.0, "ja");
    let mut reference: Vec<SubtitleCue> = Vec::new();
    let mut next_id = 0usize;
    for index in 0..20 {
        let dialogue_start = index as f64 * 5.0 + 10.0;
        match index {
            0 => reference.push(cue(next_id, 12.0, "sign-A")),
            3 => reference.push(cue(next_id, 26.0, "sign-B")),
            8 => reference.push(cue(next_id, 48.0, "sign-C")),
            _ => {}
        }
        next_id += 1;
        reference.push(cue(next_id, dialogue_start, &format!("en-{index}")));
        next_id += 1;
    }
    assert_eq!(reference.len(), 23);

    let estimate = estimate_offset_ms(&drift, &reference).expect("estimate");
    assert_eq!(estimate.offset_ms, 10_000.0);
    assert!(estimate.pair_count >= 20);
}

#[test]
fn a_sub_frame_offset_is_reported_as_zero() {
    // 50 ms is below the 100 ms sub-frame threshold.
    let drift = track(10, 5.0, 0.0, "ja");
    let reference = track(10, 5.0, 0.05, "en");

    assert_eq!(estimate_lazy_sync_offset(&reference, &drift), Some(0.0));
}
