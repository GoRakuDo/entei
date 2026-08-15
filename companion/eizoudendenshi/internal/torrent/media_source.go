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

	ctx    context.Context // reader context; cancelled on job end / Close
	cancel context.CancelFunc
	closed chan struct{} // closed by Close(); stops the done-watcher goroutine
	once   sync.Once

	mu     sync.Mutex        // serializes the shared reader (seek+read)
	reader io.ReadSeekCloser // lazy; opened on the first ReadAt
}

// GrowingMediaSource is a media.GrowingSource whose backing reader can be
// released explicitly (the PCM endpoint closes it after the conversion).
// Close is only meaningful for torrent-backed sources — the fixture grow
// source's closer is a no-op.
type GrowingMediaSource interface {
	media.GrowingSource
	Close() error
}

func newTorrentMediaSource(h TorrentHandle, done <-chan struct{}) GrowingMediaSource {
	ctx, cancel := context.WithCancel(context.Background())
	s := &torrentMediaSource{
		handle: h,
		done:   done,
		ctx:    ctx,
		cancel: cancel,
		closed: make(chan struct{}),
	}
	// Watch the session's job end: a job cancelled mid-read must unblock the
	// reader through its context. Without this watcher, Read could block
	// forever on a reader whose job ended after the done check (TOCTOU gap).
	go func() {
		select {
		case <-done:
			cancel()
		case <-s.closed: // Close() stops the watcher (no goroutine leak)
		}
	}()
	return s
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
	// Self-enforce the availability boundary (GrowingSource contract —
	// belt-and-braces behind the HTTP layer's check): bytes at or beyond
	// the verified prefix are never served, mirroring MemSource/FileSource.
	avail := s.handle.AvailablePrefix()
	if off < 0 || off >= avail {
		return 0, io.EOF
	}
	if int64(len(p)) > avail-off {
		p = p[:int(avail-off)]
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reader == nil {
		r, err := s.handle.HTTPReader(s.ctx)
		if err != nil {
			return 0, err
		}
		s.reader = r
	}
	if _, err := s.reader.Seek(off, io.SeekStart); err != nil {
		return 0, err
	}
	return s.reader.Read(p)
}

// Close releases the shared anacrolix reader and cancels its context.
// Idempotent.
func (s *torrentMediaSource) Close() error {
	// Stop the done-watcher goroutine, then release: cancel is idempotent
	// (concurrent calls are safe), so an in-flight Read unblocks via the
	// context even if the watcher already fired.
	s.once.Do(func() { close(s.closed) })
	s.cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reader != nil {
		r := s.reader
		s.reader = nil
		return r.Close()
	}
	return nil
}
