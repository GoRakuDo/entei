//go:build !windows

package update

// transientRenameErr reports whether a rename failure is a transient
// lock condition worth retrying. POSIX renames (including Termux) never
// fail on sharing violations — a running image stays renameable — so no
// error class is transient and renameRetry is exactly one attempt.
var transientRenameErr = func(error) bool { return false }
