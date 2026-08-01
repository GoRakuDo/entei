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
