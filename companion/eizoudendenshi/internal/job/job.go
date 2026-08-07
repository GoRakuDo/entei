// Package job implements the EizouDendenshi YouTube local-source job
// boundary (ED-2F): a single-session, process-supervised download job that
// produces a private temp-directory media file which later feeds the
// existing growing-media / status bridge.
//
// Security contract:
//   - The download helper is spawned with exec.Command and a FIXED argument
//     vector; the validated URL is the only user-derived value and is passed
//     as its own argv element. No shell is ever involved.
//   - The helper path is pinned by configuration; it is never derived from
//     a request.
//   - Job responses and errors are metadata-only. The URL, local paths, the
//     helper command line, raw helper stderr, and any credentials never
//     leave the package.
//   - All job files live in a private temp directory that the job owns and
//     removes on cancel/failure; user files are never touched.
//   - At most one job may exist at a time (one active session); creating a
//     second is a conflict.
package job

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
)

// State is the job state machine. It maps onto the existing
// growing-media/status contract: queued/downloading → status "buffering"
// (media not servable yet), complete → status "complete", error → status
// "error", cancelled → no active source.
type State string

const (
	StateQueued      State = "queued"
	StateDownloading State = "downloading"
	StateBuffering   State = "buffering"
	StateComplete    State = "complete"
	StateError       State = "error"
	StateCancelled   State = "cancelled"
)

// Media is the metadata-only availability view of the job's media file.
// During download the total is unknown (yt-dlp only knows it at the end),
// so Total is 0 while available reports the current bytes on disk; after
// completion Total equals the final size.
type Media struct {
	Available int64 `json:"available"`
	Total     int64 `json:"total"`
	HeadReady bool  `json:"headReady"`
}

// Snapshot is the redacted public view of a job. It never contains the
// URL, local paths, the helper command line, or helper output. Error is a
// generic message present only in the error state.
type Snapshot struct {
	ID      string `json:"id"`
	State   State  `json:"state"`
	Mode    Mode   `json:"mode"`
	Quality int    `json:"quality,omitempty"` // selected format height (0 = unknown)
	Error   string `json:"error,omitempty"`
	Media   Media  `json:"media"`
}

// Mode is the YouTube download strategy (docs/EIZOU_DENDENSHI.md "YouTube
// 再生モード設定"). Empty mode means ModeQuality (the default).
type Mode string

const (
	// ModeQuality — DASH 1080p cap; plays after the download (mux) completes.
	ModeQuality Mode = "quality"
	// ModeSpeed — progressive single-file; plays while downloading (.part).
	ModeSpeed Mode = "speed"
)

// ValidMode reports whether m is a known download mode.
func ValidMode(m Mode) bool {
	return m == ModeQuality || m == ModeSpeed
}

// ErrInvalidMode is returned when an unknown download mode is requested.
var ErrInvalidMode = errors.New("invalid download mode")

// ErrConflict is returned when a job is already active (one-session policy).
var ErrConflict = errors.New("a job is already active")

// ErrNotFound is returned when the requested job id does not exist.
var ErrNotFound = errors.New("job not found")

// newJobID returns an opaque 32-hex-char job identifier. It carries no
// relationship to the URL or any local path.
func newJobID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}
