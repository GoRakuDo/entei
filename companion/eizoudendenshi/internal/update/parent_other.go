//go:build !windows

package update

import "syscall"

// parentAlive reports whether a process with the given PID still exists.
// Used by the --apply-update child to detect the parent's exit.
func parentAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
