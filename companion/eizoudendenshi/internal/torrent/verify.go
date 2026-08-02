package torrent

import (
	"crypto/sha1"
	"errors"
	"io"
	"os"
	"sync"
)

// Verified-prefix streaming availability (no RPC, no piece map from aria2).
//
// aria2 writes the selected file at piece offsets, so the on-disk SIZE is
// the full size with holes and is never availability. Instead the
// companion verifies pieces incrementally against the torrent's own SHA-1
// hashes (from the metadata phase): a piece is available only when its
// exact bytes hash-match. Holes read as zeros and therefore fail the hash
// unless the true content is literally zeros — in which case serving the
// bytes is correct anyway. Availability is therefore exact, piece-aligned,
// and contiguous (in-order + head-priority selection policy).

// SelectedSpan is the selected file's byte window in the GLOBAL torrent
// byte stream (all files concatenated), plus the global piece range that
// lies fully inside the file.
type SelectedSpan struct {
	FileIndex  int   // 1-based aria2 --select-file index
	Start      int64 // global offset of the selected file
	Length     int64
	FirstPiece int64 // first global piece fully inside [Start, Start+Length)
	LastPiece  int64 // inclusive
	// HeadGap is the selected file's leading bytes (before the first fully
	// inside piece) that can never be verified because their enclosing
	// global piece crosses into unselected files.
	HeadGap int64
}

// spanFor computes the selected file's global span from the metadata. The
// file's bytes are verifiable only through global pieces that lie fully
// inside the file; pieces crossing file boundaries include unselected
// bytes that are never downloaded and can never verify (honest buffering
// for multi-file layouts whose files are not piece-aligned).
func spanFor(meta *TorrentMetadata, fileIndex int) (SelectedSpan, error) {
	if meta == nil || fileIndex < 1 || fileIndex > len(meta.Files) {
		return SelectedSpan{}, errors.New("invalid file index")
	}
	var start int64
	for _, f := range meta.Files {
		if f.Index == fileIndex {
			span := SelectedSpan{
				FileIndex: fileIndex,
				Start:     start,
				Length:    f.Length,
			}
			pl := meta.PieceLength
			span.FirstPiece = (start + pl - 1) / pl // ceil
			if span.FirstPiece*pl >= start+f.Length {
				// No piece lies fully inside the file.
				span.FirstPiece = 0
				span.LastPiece = -1
				span.HeadGap = f.Length
				return span, nil
			}
			span.LastPiece = (start+f.Length)/pl - 1
			if span.LastPiece < span.FirstPiece {
				span.FirstPiece = 0
				span.LastPiece = -1
				span.HeadGap = f.Length
				return span, nil
			}
			span.HeadGap = span.FirstPiece*pl - start
			return span, nil
		}
		start += f.Length
	}
	return SelectedSpan{}, errors.New("file index not found")
}

// PrefixVerifier incrementally verifies the selected file's leading global
// pieces against the metadata hashes. Only the longest verified contiguous
// run from FirstPiece is reported.
type PrefixVerifier struct {
	mu             sync.Mutex
	meta           *TorrentMetadata
	span           SelectedSpan
	filePath       string // on-disk path of the selected file (job dir + sanitized path)
	nextPiece      int64
	verifiedPieces int64
}

func newPrefixVerifier(meta *TorrentMetadata, span SelectedSpan, filePath string) *PrefixVerifier {
	return &PrefixVerifier{
		meta:      meta,
		span:      span,
		filePath:  filePath,
		nextPiece: span.FirstPiece,
	}
}

// Available returns the verified contiguous prefix of the SELECTED FILE in
// file bytes (never the file's allocated size; never zero-probed).
func (v *PrefixVerifier) Available() int64 {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.span.LastPiece < v.span.FirstPiece || v.verifiedPieces == 0 {
		return 0
	}
	avail := v.verifiedPieces*v.meta.PieceLength - v.span.HeadGap
	if avail < 0 {
		avail = 0
	}
	if avail > v.span.Length {
		avail = v.span.Length
	}
	return avail
}

// Total is the selected file's full size (the known target).
func (v *PrefixVerifier) Total() int64 { return v.span.Length }

// ReadAt reads verified bytes only: any offset beyond Available() returns
// io.EOF (never fabricated bytes).
func (v *PrefixVerifier) ReadAt(p []byte, off int64) (int, error) {
	avail := v.Available()
	if off >= avail {
		return 0, io.EOF
	}
	if off+int64(len(p)) > avail {
		p = p[:avail-off]
	}
	n, err := v.readFileAt(p, off)
	if err != nil && n == 0 {
		return n, err
	}
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func (v *PrefixVerifier) readFileAt(p []byte, off int64) (int, error) {
	f, err := os.Open(v.filePath)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return f.ReadAt(p, off)
}

// VerifiedPieces is the count of contiguous verified pieces.
func (v *PrefixVerifier) VerifiedPieces() int64 {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.verifiedPieces
}

// Poll verifies the next unverified piece (bounded single-piece read).
// Returns (done, nil) when the whole file is verified. A piece whose bytes
// do not hash-match (still downloading / hole / partial) stops the run;
// the next poll retries it.
func (v *PrefixVerifier) Poll() (bool, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.span.LastPiece < v.span.FirstPiece {
		return true, nil
	}
	if v.nextPiece > v.span.LastPiece {
		return true, nil
	}
	pl := v.meta.PieceLength
	// The piece is fully inside the file: its bytes live at file offset
	// (pieceStart - span.Start), length pl.
	fileOffset := v.nextPiece*pl - v.span.Start
	buf := make([]byte, pl)
	f, err := os.Open(v.filePath)
	if err != nil {
		return false, nil // not on disk yet; retry next poll
	}
	defer f.Close()
	n, err := f.ReadAt(buf, fileOffset)
	if err != nil && n != len(buf) {
		return false, nil // partially written; retry
	}
	sum := sha1.Sum(buf)
	if !bytesEqual(sum[:], v.meta.PieceHashes[v.nextPiece]) {
		return false, nil // hole / partial / tampered; retry next poll
	}
	v.verifiedPieces++
	v.nextPiece++
	if v.nextPiece > v.span.LastPiece {
		return true, nil
	}
	return false, nil
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// selectedFilePath resolves the on-disk path of the selected file inside
// the private job dir (sanitized components only).
func selectedFilePath(dir string, tf TorrentFile) string {
	// tf.Path was sanitized at parse time (components joined with '/').
	return dir + "/" + tf.Path
}
