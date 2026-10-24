//go:build featurecoverage && windows

package bench

import "golang.org/x/sys/windows"

func processCPUSeconds() (float64, error) {
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(windows.CurrentProcess(), &created, &exited, &kernel, &user); err != nil {
		return 0, err
	}
	return float64(kernel.Nanoseconds()+user.Nanoseconds()) / 1_000_000_000, nil
}
