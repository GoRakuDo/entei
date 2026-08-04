package torrent

import (
	"context"
	"io"

	"eizoudendenshi/internal/diag"
)

// Engine is the narrow abstraction isolating the anacrolix/torrent library
// from the job manager and HTTP layer. The manager talks to this interface
// only; anacrolix specifics live in engine_anacrolix.go. This keeps the
// deterministic manager/API tests independent of the library's network
// behavior (a fake engine can be injected).
type Engine interface {
	// Start begins fetching metadata for a magnet and blocks (bounded by
	// ctx) until the torrent Info is available. It must not download any
	// payload.
	Start(ctx context.Context, magnet string) (TorrentHandle, error)
	// Close releases all resources (no seeding, no public listeners).
	Close() error
}

// EngineFactory creates a fresh Engine for each torrent session. storageDir
// is the session-private, absolute, existing (or created) directory the
// engine must use for its persistent state (anacrolix piece-completion DB).
// The manager owns the directory and removes it after the session ends.
type EngineFactory func(storageDir string) (Engine, error)

// LoggerSettable is the optional capability an Engine may implement to
// receive the manager's diagnostic logger (nil-safe) before Start. Engines
// without it simply stay silent — the logging feature is an opt-in
// addition and never changes behavior for existing engines.
type LoggerSettable interface {
	SetLogger(l *diag.Logger)
}

// TorrentFile is the sanitized, metadata-only view of one torrent file. It
// carries an opaque id and safe display fields — never an absolute path,
// the magnet, or tracker data.
type TorrentFile struct {
	ID           string `json:"id"`                     // opaque, stable ("f0", "f1", …)
	Path         string `json:"path"`                   // sanitized basename only (no directory)
	RelativePath string `json:"relativePath,omitempty"` // safe relative path with directory (normalized "/")
	Length       int64  `json:"length"`                 // file size in bytes
	Kind         string `json:"kind"`                   // video | audio | subtitle | other
}

// TorrentHandle is the active torrent session.
type TorrentHandle interface {
	// Name is the sanitized torrent display name.
	Name() string
	// Files returns the sanitized file list (id, path, length, kind by
	// extension). Available before any payload download.
	Files() []TorrentFile
	// Select sets piece priorities so that ONLY the selected files are
	// downloaded (unselected → priority 0), with the head of the selected
	// video prioritized (the bounded bootstrap window raised above the rest
	// of the file) and in-order readahead.
	Select(videoFileID string, subtitleFileID string) error
	// Reader returns a seekable reader over the selected video file. Reads
	// block until data is available or ctx is done. The reader drives the
	// piece priority (seek → the needed pieces become highest priority) and
	// a bounded forward readahead.
	Reader(ctx context.Context) (io.ReadSeekCloser, error)
	// StartBootstrap begins demand scheduling for the selected video's head:
	// a dedicated bounded reader seeks to byte 0 and issues one read so the
	// engine's reader demand registers the head pieces (first piece "Now",
	// the bounded readahead window "Readahead") immediately, before any HTTP
	// range request arrives. It must not block; the reader is closed when
	// ctx is done. Fails only when the selection is not readable.
	StartBootstrap(ctx context.Context) error
	// AvailablePrefix returns the verified contiguous prefix length of the
	// selected video (piece-accurate; never the allocated size).
	AvailablePrefix() int64
	// SelectedLength is the selected video's total byte length.
	SelectedLength() int64
	// Close releases the handle (cancels the download; no seeding).
	Close() error
}
