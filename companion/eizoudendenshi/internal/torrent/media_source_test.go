package torrent

import (
	"io"
	"os"
	"sync"
	"testing"
)

// fakeVideoHandle builds a fakeHandle with one selected video file and the
// given downloaded prefix.
func fakeVideoHandle(t *testing.T, length int64, avail int64) *fakeHandle {
	t.Helper()
	files := []TorrentFile{
		{ID: "f0", Path: "video.mp4", Length: length, Kind: KindVideo},
	}
	h := newFakeHandle(files)
	if err := h.Select("f0", ""); err != nil {
		t.Fatalf("Select: %v", err)
	}
	h.avail.Store(avail)
	return h
}

func TestTorrentMediaSourceComplete(t *testing.T) {
	h := fakeVideoHandle(t, 100, 100) // download complete
	src := newTorrentMediaSource(h, make(chan struct{}))
	defer src.Close()

	if total := src.Total(); total != 100 {
		t.Errorf("Total = %d, want 100", total)
	}
	// Complete → Available equals Total (the PCM endpoint's gate).
	if a := src.Available(); a != 100 {
		t.Errorf("Available = %d, want 100 (complete)", a)
	}

	// ReadAt serves the exact bytes at an offset (fakeReader content is
	// byte((off+i) & 0xff)).
	buf := make([]byte, 10)
	n, err := src.ReadAt(buf, 5)
	if err != nil || n != 10 {
		t.Fatalf("ReadAt(10, 5) = (%d, %v), want (10, nil)", n, err)
	}
	if buf[0] != 5 || buf[9] != 14 {
		t.Errorf("ReadAt content = %v, want byte((off+i)&0xff)", buf)
	}

	// Reading at the end yields EOF.
	if _, err := src.ReadAt(make([]byte, 1), 100); err != io.EOF {
		t.Errorf("ReadAt at end = %v, want io.EOF", err)
	}
}

func TestTorrentMediaSourceBuffering(t *testing.T) {
	h := fakeVideoHandle(t, 100, 40) // partial download
	src := newTorrentMediaSource(h, make(chan struct{}))
	defer src.Close()

	if a := src.Available(); a != 40 {
		t.Errorf("Available = %d, want 40", a)
	}
	// Bytes within the available prefix are readable.
	buf := make([]byte, 10)
	if _, err := src.ReadAt(buf, 0); err != nil {
		t.Fatalf("ReadAt within prefix: %v", err)
	}
}

func TestTorrentMediaSourceJobEnded(t *testing.T) {
	h := fakeVideoHandle(t, 100, 100)
	done := make(chan struct{})
	src := newTorrentMediaSource(h, done)
	close(done) // job ended (cancel / eviction)
	_ = src.Close()

	// After the job ends the source fails closed.
	if a := src.Available(); a != 0 {
		t.Errorf("Available after job end = %d, want 0", a)
	}
	if _, err := src.ReadAt(make([]byte, 1), 0); err != os.ErrClosed {
		t.Errorf("ReadAt after job end = %v, want os.ErrClosed", err)
	}
}

func TestTorrentMediaSourceConcurrentReadAt(t *testing.T) {
	h := fakeVideoHandle(t, 4096, 4096)
	src := newTorrentMediaSource(h, make(chan struct{}))
	defer src.Close()

	var wg sync.WaitGroup
	errCh := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			buf := make([]byte, 4)
			if _, err := src.ReadAt(buf, int64(i%10)*4); err != nil {
				errCh <- err
			}
		}(i)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Errorf("concurrent ReadAt: %v", err)
	}
}
