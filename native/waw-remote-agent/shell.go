package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

/**
 * The shells one host offers, and how a command string becomes a process.
 *
 * POSIX hosts have one family (bash, else sh) and that is both the default and
 * the "posix" choice. Windows always has PowerShell; Git for Windows is an
 * optional second shell, and it is the only way to run the POSIX scripts this
 * product uses for snapshots. Neither is "the" Windows shell: a command written
 * with `Get-ChildItem` belongs to PowerShell, a `for …; do` loop to Git Bash,
 * and the caller names which it wrote. Defaults stay PowerShell so an
 * unadorned call behaves like every Windows user expects.
 *
 * cmd.exe is deliberately never a choice — its quoting and semantics differ
 * from both in exactly the ways a model's command would trip on; the bootstrap
 * side (the desktop bridge) uses it only as the transport for fixed scripts.
 */
type shellSpec struct {
	exe    string
	prefix []string
	flavor string // "posix" | "powershell"
	name   string // bash / sh / pwsh / powershell / gitbash
}

type shellSet struct {
	primary shellSpec
	posix   *shellSpec
	names   []string
	err     error
}

/**
 * Pick the shell a call asked for.
 *
 * "" / auto / default mean the primary; posix / bash / gitbash mean the POSIX
 * shell (Git Bash on Windows); powershell / pwsh mean PowerShell. A name that
 * this host does not have is an error that lists what it does have — silently
 * falling back would run the command in a language its author did not write.
 */
func (s shellSet) pick(requested string) (shellSpec, error) {
	req := strings.ToLower(strings.TrimSpace(requested))
	switch req {
	case "", "auto", "default":
		if s.err != nil {
			return shellSpec{}, s.err
		}
		return s.primary, nil
	case "posix", "bash", "gitbash", "sh", "msys":
		if s.posix != nil {
			return *s.posix, nil
		}
		return shellSpec{}, fmt.Errorf("shell %q is not available on this host (available: %s)", requested, strings.Join(s.names, ", "))
	case "powershell", "pwsh":
		if s.err == nil && s.primary.flavor == "powershell" {
			return s.primary, nil
		}
		return shellSpec{}, fmt.Errorf("shell %q is not available on this host (available: %s)", requested, strings.Join(s.names, ", "))
	}
	if s.err == nil && req == strings.ToLower(s.primary.name) {
		return s.primary, nil
	}
	return shellSpec{}, fmt.Errorf("unknown shell %q (available: %s)", requested, strings.Join(s.names, ", "))
}

func detectShells(goos string, lookPath func(string) (string, error), isGitBash func(string) bool) shellSet {
	if goos != "windows" {
		spec := shellSpec{exe: "sh", prefix: []string{"-lc"}, flavor: "posix", name: "sh"}
		if _, err := lookPath("bash"); err == nil {
			spec = shellSpec{exe: "bash", prefix: []string{"-lc"}, flavor: "posix", name: "bash"}
		}
		posix := spec
		return shellSet{primary: spec, posix: &posix, names: []string{spec.name}}
	}

	set := shellSet{}
	for _, name := range []string{"pwsh", "powershell"} {
		if exe, err := lookPath(name); err == nil {
			set.primary = shellSpec{
				exe:    exe,
				prefix: []string{"-NoProfile", "-NoLogo", "-NonInteractive", "-Command"},
				flavor: "powershell",
				name:   name,
			}
			break
		}
	}
	for _, candidate := range gitBashCandidates() {
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() {
			continue
		}
		if !isGitBash(candidate) {
			continue
		}
		posix := shellSpec{exe: candidate, prefix: []string{"-lc"}, flavor: "posix", name: "gitbash"}
		set.posix = &posix
		break
	}
	switch {
	case set.primary.exe != "":
		set.names = append(set.names, set.primary.name)
	case set.posix != nil:
		// No PowerShell at all: the POSIX shell is the only one there is.
		set.primary = *set.posix
		set.names = []string{set.primary.name}
	default:
		set.err = errors.New("windows host has neither PowerShell (pwsh/powershell) nor Git Bash")
		set.names = []string{}
	}
	if set.posix != nil && (set.primary.flavor != "posix" || set.primary.exe != set.posix.exe) {
		set.names = append(set.names, set.posix.name)
	}
	return set
}

/**
 * Where Git for Windows installs bash. `where bash` is NOT used: on a machine
 * with WSL it finds System32\bash.exe first, and that shell sees /mnt/c rather
 * than C:/ — every path the workspace uses would be wrong.
 */
func gitBashCandidates() []string {
	var out []string
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)"} {
		if dir := strings.TrimSpace(os.Getenv(env)); dir != "" {
			out = append(out, filepath.Join(dir, "Git", "bin", "bash.exe"))
			out = append(out, filepath.Join(dir, "Git", "usr", "bin", "bash.exe"))
		}
	}
	if dir := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); dir != "" {
		out = append(out, filepath.Join(dir, "Programs", "Git", "bin", "bash.exe"))
	}
	return out
}

/** Git Bash says MINGW64_NT-… / MSYS_NT-…; WSL says Linux, and has no distro here. */
func probeGitBash(exe string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, exe, "-c", "uname -s").Output()
	if err != nil {
		return false
	}
	system := strings.ToUpper(strings.TrimSpace(string(out)))
	return strings.HasPrefix(system, "MINGW") || strings.HasPrefix(system, "MSYS")
}

func defaultShells() shellSet {
	return detectShells(runtime.GOOS, exec.LookPath, probeGitBash)
}

/** One call's command, in the shell that call named. */
func (a *agent) commandFor(ctx context.Context, requested, cmdLine string) (*exec.Cmd, error) {
	spec, err := a.shells.pick(requested)
	if err != nil {
		return nil, err
	}
	return spec.command(ctx, cmdLine), nil
}

func (s shellSpec) command(ctx context.Context, cmdLine string) *exec.Cmd {
	script := cmdLine
	if s.flavor == "powershell" {
		script = wrapPowerShell(cmdLine)
	}
	args := make([]string, 0, len(s.prefix)+1)
	args = append(args, s.prefix...)
	args = append(args, script)
	return exec.CommandContext(ctx, s.exe, args...)
}

/**
 * `-Command` runs a script, not a single command: without this tail a failing
 * native command (or a failed cmdlet) still ends with PowerShell's own exit
 * code 0, and the host would report success for a command that failed.
 *
 * `$LASTEXITCODE` is only set by native commands, so it is initialised and only
 * consulted when non-zero; cmdlet failures are terminating (`Stop`) and go
 * through the catch. The catch writes plain text because Windows PowerShell
 * serialises its own error stream as CLIXML when stderr is a pipe, which turns
 * a one-line failure into `#< CLIXML … _x000D_` wire noise. UTF-8 both ways
 * keeps Chinese output and byte counts from being mangled by the code page.
 */
func wrapPowerShell(script string) string {
	// $OutputEncoding is what PowerShell uses when piping INTO a native
	// command; setting only [Console]::OutputEncoding leaves Windows
	// PowerShell 5.1 encoding that pipe as the ANSI code page, turning
	// non-ASCII arguments into '?'. InputEncoding covers the reverse direction
	// for the same reason.
	return "[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" +
		"[Console]::InputEncoding=[Text.Encoding]::UTF8\n" +
		"$OutputEncoding = [Text.UTF8Encoding]::new($false)\n" +
		"$ProgressPreference = 'SilentlyContinue'\n" +
		"$ErrorActionPreference = 'Stop'\n" +
		"try {\n" +
		"$global:LASTEXITCODE = 0\n" +
		script + "\n" +
		"if (-not $?) { exit 1 }\n" +
		"if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n" +
		"exit 0\n" +
		"} catch {\n" +
		"[Console]::Error.WriteLine($_.Exception.Message)\n" +
		"exit 1\n" +
		"}\n"
}
