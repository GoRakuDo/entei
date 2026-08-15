package torrent

import (
	"context"
	"io"
	"os"
	"sync"

	"eizoudendenshi/internal/media"
)

// torrentMediaSource adapts a Magnet job's selected media to
// media.GrowingSource so the PCM endpoint can convert it (sub-to-audio
// subtitle sync). Reads are served through a shared anacrolix reader
// (HTTPReader) via Seek+Read; concurrent ReadAt calls are serialized by a
// mutex. The source watches the owning session's job end: after cancel /
// eviction / error, operations fail closed instead of touching a dropped
// torrent.
type torrentMediaSource struct {
	handle TorrentHandle
	done   <-chan struct{} // closed when the owning session's job ends

	mu     sync.Mutex        // serializes the shared reader (seek+read)
	reader io.ReadSeekCloser // lazy; opened on the first ReadAt
	cancel context.CancelFunc
}

// GrowingMediaSource is a media.GrowingSource whose backing reader can be
// released explicitly (the PCM endpoint closes it after the conversion).
type GrowingMediaSource interface {
	media.GrowingSource
	Close() error
}

func newTorrentMediaSource(h TorrentHandle, done <-chan struct{}) GrowingMediaSource {
	return &torrentMediaSource{handle: h, done: done}
}

// Total implements media.GrowingSource.
func (s *torrentMediaSource) Total() int64 {
	return s.handle.SelectedLength()
}

// Available implements media.GrowingSource: the verified contiguous prefix.
// It equals Total when the download is complete; after the session ends it
// reports 0 (the safe direction — never a fabricated byte count).
func (s *torrentMediaSource) Available() int64 {
	select {
	case <-s.done:
		return 0
	default:
	}
	return s.handle.AvailablePrefix()
}

// ReadAt implements io.ReaderAt by seeking the shared anacrolix reader and
// reading. Concurrent ReadAt calls are serialized by s.mu (a seek+read on
// one reader is not independently atomic). The reader is created lazily
// with a Close-cancelled context; a job that ended fails closed
// (os.ErrClosed).
func (s *torrentMediaSource) ReadAt(p []byte, off int64) (int, error) {
	select {
	case <-s.done:
		return 0, os.ErrClosed
	default:
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reader == nil {
		ctx, cancel := context.WithCancel(context.Background())
		r, err := s.handle.HTTPReader(ctx)
		if err != nil {
			cancel()
			return 0, err
		}
		s.reader = r
		s.cancel = cancel
	}
	if _, err := s.reader.Seek(off, io.SeekStart); err != nil {
		return 0, err
	}
	return s.reader.Read(p)
}

// Close releases the shared anacrolix reader and cancels its context.
// Idempotent.
func (s *torrentMediaSource) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	if s.reader != nil {
		r := s.reader
		s.reader = nil
		return r.Close()
	}
	return nil
}
