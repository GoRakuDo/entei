//go:build windows

package update

import (
	"errors"

	"golang.org/x/sys/windows"
)

// transientRenameErr reports whether a rename failure is a transient
// Windows lock condition worth retrying: a just-exited process may hold
// its image section for a few hundred ms, making MoveFileEx fail with a
// sharing violation (and a lock violation is the same class of transient
// state). Any other error is permanent and must fail immediately.
//
// windows.ERROR_SHARING_VIOLATION is syscall.Errno(32) and
// windows.ERROR_LOCK_VIOLATION is syscall.Errno(33); os.Rename wraps the
// raw errno in an *os.LinkError, which errors.Is unwraps by value.
var transientRenameErr = func(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}

// isCrossDeviceRenameErr reports whether a rename failed because the
// source and destination live on different volumes
// (windows.ERROR_NOT_SAME_DEVICE, errno 17): os.Rename cannot move a
// file across devices, and retrying cannot help — the caller falls back
// to copyThenRemove. windows.ERROR_* values are syscall.Errno
// constants; os.Rename wraps the raw errno in an *os.LinkError, which
// errors.Is unwraps by value (same mechanism as transientRenameErr).
var isCrossDeviceRenameErr = func(err error) bool {
	return errors.Is(err, windows.ERROR_NOT_SAME_DEVICE)
}
