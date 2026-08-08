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
// (speed mode instant playback). The final size is unknown while the
// download runs, so the total is pinned as soon as the downloader's
// estimate is known (SetTotal): after that Total() reports the fixed
// estimate — the correct 416 boundary — while Available() keeps tracking
// the growing prefix. Before the pin Total() returns the current size, so
// the HTTP layer long-polls a range instead of falsely answering 416.
//
// The file is append-only while the source is in use (yt-dlp writes then
// renames at completion); the descriptor is reopened on every read so the
// final rename never leaves a stale handle.
type PartSource struct {
	mu    sync.Mutex
	path  string
	total int64 // pinned estimated final size (0 = not yet pinned)
}

// NewPartSource opens a growing .part file for streaming. The file need not
// exist yet (yt-dlp creates it shortly after launch); reads before creation
// resolve to EOF (0 available), matching the monotonic-availability
// contract.
func NewPartSource(path string) *PartSource {
	return &PartSource{path: path}
}

// SetTotal pins the estimated final total of the download. It is valid
// once: the first positive value is kept and later calls are ignored (a
// second, larger estimate must not move the 416 boundary mid-stream).
// Values <= 0 are ignored (the caller guards "total unknown"). A value
// below the bytes already on disk is raised to the current size — a stale
// estimate must never make Total smaller than what is actually servable.
// Callers invoke it while the job's PartSource instance lives; see
// Manager.refreshDownloadState.
func (s *PartSource) SetTotal(total int64) {
	if total <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.total != 0 {
		return // already decided
	}
	if st, err := os.Stat(s.path); err == nil && !st.IsDir() && st.Size() > total {
		total = st.Size()
	}
	s.total = total
}

// TotalFixed implements the fixed-total marker consumed by
// media.TotalFixed: the estimate is pinned once SetTotal succeeded.
func (s *PartSource) TotalFixed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.total > 0
}

// Total implements media.GrowingSource. Once SetTotal pinned the estimate
// it returns that fixed value (the 416 boundary); before the pin it
// returns the current size so `total` stays consistent with what is
// actually servable (never larger than the disk state).
func (s *PartSource) Total() int64 {
	s.mu.Lock()
	t := s.total
	s.mu.Unlock()
	if t > 0 {
		return t
	}
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
