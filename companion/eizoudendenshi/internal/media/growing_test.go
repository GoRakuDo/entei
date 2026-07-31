package media

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// growData is a deterministic byte pattern for fixtures.
func growData(n int) []byte {
	d := make([]byte, n)
	for i := range d {
		d[i] = byte((i*7 + 3) % 251)
	}
	return d
}

func TestMemSourceTotalAndInitialAvailable(t *testing.T) {
	data := growData(2048)
	for _, tt := range []struct {
		name    string
		avail   int64
		wantAvl int64
	}{
		{"exact", 100, 100},
		{"zero", 0, 0},
		{"negative clamped to zero", -5, 0},
		{"above total clamped to total", 99999, 2048},
		{"at total", 2048, 2048},
	} {
		t.Run(tt.name, func(t *testing.T) {
			m := NewMemSource(data, tt.avail)
			if got := m.Total(); got != int64(len(data)) {
				t.Errorf("Total = %d, want %d", got, len(data))
			}
			if got := m.Available(); got != tt.wantAvl {
				t.Errorf("Available = %d, want %d", got, tt.wantAvl)
			}
		})
	}
}

// SetAvailable is monotonic: availability only grows, mirroring an
// append-only writer. Lowering it must be ignored — the HTTP layer's
// snapshot-then-read pairing relies on this.
func TestMemSourceSetAvailableMonotonic(t *testing.T) {
	data := growData(2048)
	m := NewMemSource(data, 100)
	m.SetAvailable(50) // below current: ignored
	if got := m.Available(); got != 100 {
		t.Fatalf("after SetAvailable(50): Available = %d, want 100", got)
	}
	m.SetAvailable(200)
	if got := m.Available(); got != 200 {
		t.Fatalf("after SetAvailable(200): Available = %d, want 200", got)
	}
	m.SetAvailable(99999) // above total: clamped
	if got := m.Available(); got != int64(len(data)) {
		t.Fatalf("after SetAvailable(99999): Available = %d, want %d", got, len(data))
	}
}

// The core invariant: ReadAt never serves bytes at or beyond the current
// availability — even when a caller ignores the snapshot contract. Reads
// crossing the boundary are truncated, reads past it return EOF.
func TestMemSourceReadAtEnforcesAvailability(t *testing.T) {
	data := growData(100)
	m := NewMemSource(data, 50)

	p := make([]byte, 10)
	n, err := m.ReadAt(p, 0)
	if err != nil || n != 10 {
		t.Fatalf("ReadAt(0): n=%d err=%v, want 10, nil", n, err)
	}
	if string(p) != string(data[0:10]) {
		t.Fatal("ReadAt(0) bytes do not match the payload")
	}

	// Crossing the boundary: truncated to the available prefix, and the
	// rest of p stays untouched (never fabricated).
	clear(p)
	p = make([]byte, 10)
	n, err = m.ReadAt(p, 45)
	if err != nil {
		t.Fatalf("ReadAt(45): unexpected err %v", err)
	}
	if n != 5 {
		t.Fatalf("ReadAt(45): n = %d, want 5 (truncated at availability)", n)
	}
	if string(p[0:5]) != string(data[45:50]) {
		t.Fatal("ReadAt(45) available bytes do not match")
	}
	for i := 5; i < len(p); i++ {
		if p[i] != 0 {
			t.Fatalf("ReadAt(45) served unavailable byte %d as %#x", 45+i, p[i])
		}
	}

	// Exactly at and beyond the boundary: EOF, zero bytes.
	for _, off := range []int64{50, 99, 100, 12345} {
		n, err = m.ReadAt(p, off)
		if n != 0 || !errors.Is(err, io.EOF) {
			t.Errorf("ReadAt(%d): n=%d err=%v, want 0, EOF", off, n, err)
		}
	}

	// Negative offset: refused.
	if _, err := m.ReadAt(p, -1); !errors.Is(err, io.EOF) {
		t.Errorf("ReadAt(-1): err = %v, want EOF", err)
	}
}

func TestFileSourceGrowth(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "grow.mp4")
	first := growData(100)
	if err := os.WriteFile(path, first, 0o600); err != nil {
		t.Fatal(err)
	}

	src, err := NewFileSource(path, 300)
	if err != nil {
		t.Fatalf("NewFileSource: %v", err)
	}
	defer src.Close()

	if got := src.Total(); got != 300 {
		t.Errorf("Total = %d, want 300", got)
	}
	if got := src.Available(); got != 100 {
		t.Errorf("Available = %d, want 100", got)
	}

	// Append more bytes (the simulated download progress).
	more := growData(50)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(more); err != nil {
		t.Fatal(err)
	}
	f.Close()

	if got := src.Available(); got != 150 {
		t.Errorf("after append: Available = %d, want 150", got)
	}

	// Reads within availability serve real bytes; reads past it are EOF.
	p := make([]byte, 10)
	n, err := src.ReadAt(p, 145)
	if err != nil || n != 5 {
		t.Fatalf("ReadAt(145): n=%d err=%v, want 5, nil (truncated at availability)", n, err)
	}
	if string(p[0:5]) != string(growData(50)[45:50]) {
		t.Error("ReadAt(145) bytes do not match appended data")
	}
	for i := 5; i < len(p); i++ {
		if p[i] != 0 {
			t.Fatalf("ReadAt(145) served unavailable byte %d", 145+i)
		}
	}
	if n, err := src.ReadAt(p, 150); n != 0 || !errors.Is(err, io.EOF) {
		t.Errorf("ReadAt(150): n=%d err=%v, want 0, EOF", n, err)
	}

	// Close: descriptor released, reads fail cleanly, availability is 0.
	if err := src.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := src.ReadAt(p, 0); !errors.Is(err, os.ErrClosed) {
		t.Errorf("ReadAt after Close: err = %v, want os.ErrClosed", err)
	}
	if got := src.Available(); got != 0 {
		t.Errorf("Available after Close = %d, want 0", got)
	}
}

func TestFileSourceValidation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "grow.mp4")
	if err := os.WriteFile(path, growData(200), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("missing file", func(t *testing.T) {
		if _, err := NewFileSource(filepath.Join(dir, "nope.mp4"), 300); err == nil {
			t.Fatal("want error for missing file")
		}
	})
	t.Run("directory", func(t *testing.T) {
		if _, err := NewFileSource(dir, 300); err == nil {
			t.Fatal("want error for directory")
		}
	})
	t.Run("size exceeds total", func(t *testing.T) {
		if _, err := NewFileSource(path, 100); err == nil {
			t.Fatal("want error when current size exceeds declared total")
		}
	})
	t.Run("negative total", func(t *testing.T) {
		if _, err := NewFileSource(path, -1); err == nil {
			t.Fatal("want error for negative total")
		}
	})
	t.Run("exact size accepted", func(t *testing.T) {
		src, err := NewFileSource(path, 200)
		if err != nil {
			t.Fatalf("NewFileSource: %v", err)
		}
		src.Close()
	})
}
