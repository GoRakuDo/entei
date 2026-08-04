//go:build !windows

package update

import (
	"errors"
	"syscall"
)

// transientRenameErr reports whether a rename failure is a transient
// lock condition worth retrying. POSIX renames (including Termux) never
// fail on sharing violations — a running image stays renameable — so no
// error class is transient and renameRetry is exactly one attempt.
var transientRenameErr = func(error) bool { return false }

// isCrossDeviceRenameErr reports whether a rename failed because the
// source and destination are on different filesystems (EXDEV): os.Rename
// cannot move a file across filesystems, and retrying cannot help — the
// caller falls back to copyThenRemove.
var isCrossDeviceRenameErr = func(err error) bool {
	return errors.Is(err, syscall.EXDEV)
}
