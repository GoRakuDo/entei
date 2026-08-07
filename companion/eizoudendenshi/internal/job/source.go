package job

import (
	"errors"
	"io"
	"os"
	"sync"
)

// JobSource is the completed job's media file exposed as a
// media.GrowingSource for the existing media/status bridge. It is created
// only at job completion, when the final size is known, so Available always
// equals Total (the representation is complete and fully servable). Reads
// are strictly bounded to the file's own size; Close releases the
// descriptor (used when a completed session is cancelled).
type JobSource struct {
	mu    sync.Mutex
	f     *os.File
	total int64
}

// NewJobSource opens the job's final media file at path, which must be a
// regular file of exactly total bytes. Errors are package-internal; the
// HTTP layer turns them into a generic failure.
func NewJobSource(path string, total int64) (*JobSource, error) {
	if total <= 0 {
		return nil, errors.New("total must be positive")
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
	if st.IsDir() || st.Size() != total {
		f.Close()
		return nil, errors.New("media file size does not match total")
	}
	return &JobSource{f: f, total: total}, nil
}

// Total implements media.GrowingSource.
func (s *JobSource) Total() int64 { return s.total }

// Available implements media.GrowingSource. The completed file is fully
// available.
func (s *JobSource) Available() int64 { return s.total }

// ReadAt implements io.ReaderAt, bounded to the file's own size.
func (s *JobSource) ReadAt(p []byte, off int64) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f == nil {
		return 0, os.ErrClosed
	}
	if off < 0 || off >= s.total {
		return 0, io.EOF
	}
	if int64(len(p)) > s.total-off {
		p = p[:s.total-off]
	}
	return s.f.ReadAt(p, off)
}

// Close releases the descriptor. ReadAt after Close returns os.ErrClosed.
func (s *JobSource) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f == nil {
		return nil
	}
	err := s.f.Close()
	s.f = nil
	return err
}

// PartSource is a growing media.GrowingSource over yt-dlp's `.part` file
// (speed mode instant playback). Total is unknown while the download runs
// (yt-dlp only knows the size at completion), so Total returns the current
// size — the growing-media contract is served with end clamped to the
// available prefix, and the client re-requests as data arrives.
//
// The file is append-only while the source is in use (yt-dlp writes then
// renames at completion); the descriptor is reopened on every read so the
// final rename never leaves a stale handle.
type PartSource struct {
	mu   sync.Mutex
	path string
}

// NewPartSource opens a growing .part file for streaming. The file need not
// exist yet (yt-dlp creates it shortly after launch); reads before creation
// resolve to EOF (0 available), matching the monotonic-availability
// contract.
func NewPartSource(path string) *PartSource {
	return &PartSource{path: path}
}

// Total implements media.GrowingSource. During download the final size is
// unknown; the current size is reported so `total` stays consistent with
// what is actually servable (never larger than the disk state).
func (s *PartSource) Total() int64 {
	return s.Available()
}

// Available implements media.GrowingSource: the .part file's current size.
func (s *PartSource) Available() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := os.Stat(s.path)
	if err != nil || st.IsDir() {
		return 0
	}
	return st.Size()
}

// ReadAt implements io.ReaderAt, strictly bounded by the current file size.
func (s *PartSource) ReadAt(p []byte, off int64) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := os.Open(s.path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		return 0, os.ErrNotExist
	}
	avail := st.Size()
	if off < 0 || off >= avail {
		return 0, io.EOF
	}
	if int64(len(p)) > avail-off {
		p = p[:int(avail-off)]
	}
	return f.ReadAt(p, off)
}

// Close releases nothing (descriptors are per-read); present for symmetry.
func (s *PartSource) Close() error { return nil }
