//go:build windows

package update

import "golang.org/x/sys/windows"

// parentAlive reports whether a process with the given PID still exists.
// Used by the --apply-update child to detect the parent's exit.
func parentAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	windows.CloseHandle(h)
	return true
}
