// Package media provides the byte-source abstraction behind the
// EizouDendenshi media endpoint. A GrowingSource models media with a known
// final size and a current available prefix — the shape of a file still
// being written by another process (a download in progress) — so the HTTP
// layer can answer "is this Range servable now?" explicitly, without a
// downloader and without blocking.
package media

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
)

// GrowingSource is a byte source with a known final size (Total) and a
// current available prefix [0, Available()).
//
// Contract:
//   - Available() returns a consistent snapshot; bytes [0, Available()) are
//     guaranteed readable at that moment.
//   - Availability is monotonic: it only grows (append-only writers) and
//     never exceeds Total().
//   - ReadAt never serves bytes at or beyond the availability it observes:
//     implementations enforce the bound themselves, so even a caller that
//     ignores the snapshot contract cannot obtain unavailable bytes (belt
//     and braces behind the HTTP layer's check).
//   - Implementations are safe for concurrent use.
type GrowingSource interface {
	io.ReaderAt
	// Total returns the known final size of the media in bytes.
	Total() int64
	// Available returns the number of bytes currently available
	// (0 <= n <= Total()).
	Available() int64
}

// MemSource is a deterministic in-memory growing fixture for tests and
// local QA. The payload is fully known up front; Available() is advanced
// explicitly with SetAvailable to simulate download progress without a
// downloader.
type MemSource struct {
	mu    sync.RWMutex
	data  []byte
	avail int64
}

// NewMemSource builds a fixture over data with avail bytes initially
// available (clamped to [0, len(data)]).
func NewMemSource(data []byte, avail int64) *MemSource {
	if avail < 0 {
		avail = 0
	}
	if avail > int64(len(data)) {
		avail = int64(len(data))
	}
	return &MemSource{data: data, avail: avail}
}

// Total implements GrowingSource.
func (m *MemSource) Total() int64 { return int64(len(m.data)) }

// Available implements GrowingSource.
func (m *MemSource) Available() int64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.avail
}

// SetAvailable advances availability. It is monotonic, mirroring the
// append-only writer contract: values at or below the current availability
// are ignored, values above Total are clamped. Lowering availability is
// intentionally impossible — the HTTP layer's snapshot-then-read pairing
// relies on availability only growing.
func (m *MemSource) SetAvailable(n int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if n <= m.avail {
		return
	}
	if n > int64(len(m.data)) {
		n = int64(len(m.data))
	}
	m.avail = n
}

// ReadAt implements io.ReaderAt, strictly bounded by the current
// availability: reads at or beyond Available() return io.EOF, and reads
// crossing the boundary are truncated to it. Unavailable bytes can never be
// served, even by a caller that ignores the contract.
func (m *MemSource) ReadAt(p []byte, off int64) (int, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if off < 0 || off >= m.avail {
		return 0, io.EOF
	}
	n := int64(len(p))
	if n > m.avail-off {
		n = m.avail - off
	}
	// off+n <= avail <= len(data); the int conversion is safe for any
	// in-memory payload.
	copy(p, m.data[int(off):int(off+n)])
	return int(n), nil
}

// FileSource is a growing source backed by a regular file that another
// process appends to — the download-in-progress shape, without a
// downloader. Total is fixed at construction; Available is the file's
// current size (Stat on the held descriptor), clamped to Total.
//
// Precondition: the writer must be append-only (no truncation or in-place
// rewrite) while the source is in use. The HTTP layer snapshots
// Available() and only reads within the snapshot; with an append-only
// writer that window is stable, so no unavailable byte can be served and
// there is no TOCTOU race between the availability check and the read.
type FileSource struct {
	mu    sync.Mutex
	f     *os.File
	total int64
}

// NewFileSource opens path and verifies it is a regular file whose current
// size does not exceed total. It fails fast (before any listener starts)
// on a missing path, a directory, or a size beyond the declared total.
// These errors are CLI/startup-level only; the HTTP layer never surfaces
// them.
func NewFileSource(path string, total int64) (*FileSource, error) {
	if total < 0 {
		return nil, errors.New("total must be non-negative")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if st.IsDir() {
		f.Close()
		return nil, fmt.Errorf("%s: is a directory", path)
	}
	if st.Size() > total {
		f.Close()
		return nil, fmt.Errorf("%s: current size %d exceeds declared total %d", path, st.Size(), total)
	}
	return &FileSource{f: f, total: total}, nil
}

// Total implements GrowingSource.
func (f *FileSource) Total() int64 { return f.total }

// Available implements GrowingSource: the file's current size, clamped to
// Total. Stat errors resolve to 0 (nothing available) — the safe direction,
// never a fabricated byte count.
func (f *FileSource) Available() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.f == nil {
		return 0
	}
	return f.availableLocked()
}

func (f *FileSource) availableLocked() int64 {
	st, err := f.f.Stat()
	if err != nil {
		return 0
	}
	if st.Size() > f.total {
		return f.total
	}
	return st.Size()
}

// ReadAt implements io.ReaderAt, strictly bounded by the availability at
// call time (a Stat on the held descriptor), mirroring MemSource: nothing
// beyond the currently available bytes is ever served.
func (f *FileSource) ReadAt(p []byte, off int64) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.f == nil {
		return 0, os.ErrClosed
	}
	avail := f.availableLocked()
	if off < 0 || off >= avail {
		return 0, io.EOF
	}
	if int64(len(p)) > avail-off {
		p = p[:int(avail-off)]
	}
	return f.f.ReadAt(p, off)
}

// Close releases the descriptor. Subsequent ReadAt returns os.ErrClosed and
// Available returns 0.
func (f *FileSource) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.f == nil {
		return nil
	}
	err := f.f.Close()
	f.f = nil
	return err
}
