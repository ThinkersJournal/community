# PROVES: Task 2 (write-up section 2, 'Checker blind spot found and fixed'): the strace checker. Flags write-capable opens (the openat regex accepts strace -y output),
#   fs mutations, shared-writable mmap and writes to anything but pipe, socket, /dev/null (and memfd with ALLOW_MEMFD=1); exits 1 on any violation.
# INPUTS: arguments: one or more strace trace files; env ALLOW_MEMFD=1 permits memfd_create and writes to /memfd: targets. Runs inside the distro (pure text parsing).
# EFFECTS: read-only; prints a summary and up to 6 violations; exit status 1 if any.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway environment you created yourself (pass 2: a throwaway WSL2 distro;
#   c8.py: a container named tjspike2-pdq or similar tjspike* name).
# ARCHIVED: preserved verbatim from the spike session, path variables parameterised only.
import os, re, sys
ALLOW_MEMFD = os.environ.get('ALLOW_MEMFD') == '1'
# usage: stracecheck.py trace [more traces]; prints summary; exit 1 if any write-capable file access / non-pipe write found
WRITEFLAGS = ('O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_TRUNC')
viol = []
n_lines = 0
n_open_ro = 0
write_targets = {}
for tp in sys.argv[1:]:
    for line in open(tp, errors='replace'):
        n_lines += 1
        m = re.search(r'\b(openat|open|creat)\((?:AT_FDCWD(?:<[^>]*>)?, )?"([^"]*)"(?:\.\.\.)?(?:, ([A-Z_|0-9x]+))?', line)
        if m:
            sc, path, flags = m.groups()
            flags = flags or ''
            if sc == 'creat' or any(f in flags for f in WRITEFLAGS):
                if not path.startswith('/dev/null') and not path.startswith('/proc/self'):
                    viol.append(('open-write', path, flags, line.strip()[:160]))
            else:
                n_open_ro += 1
            continue
        if re.search(r'\bmemfd_create\(', line):
            if ALLOW_MEMFD:
                write_targets['memfd_create_calls'] = write_targets.get('memfd_create_calls', 0) + 1
            else:
                viol.append(('memfd_create', '', '', line.strip()[:160]))
            continue
        if re.search(r'\b(mkdir|mkdirat|rename|renameat2?|link|linkat|symlink|symlinkat|truncate|ftruncate|fallocate|unlink|unlinkat)\(', line) and 'ENOENT' not in line:
            viol.append(('fs-mutation', '', '', line.strip()[:160])); continue
        m = re.search(r'\bmmap\([^,]*, \d+, ([A-Z_|]+), ([A-Z_|]+), (\d+)<([^>]*)>', line)
        if m and 'PROT_WRITE' in m.group(1) and 'MAP_SHARED' in m.group(2):
            viol.append(('mmap-shared-write-file', m.group(4), m.group(2), line.strip()[:160])); continue
        m = re.search(r'\b(write|pwrite64|sendfile|copy_file_range|writev)\((\d+)<([^>]*)>', line)
        if m:
            tgt = m.group(3)
            kind = 'memfd' if (ALLOW_MEMFD and tgt.startswith('/memfd:')) else 'pipe' if tgt.startswith('pipe:') else 'socket' if tgt.startswith('socket:') else tgt if tgt == '/dev/null' else 'FILE:' + tgt
            write_targets[kind] = write_targets.get(kind, 0) + 1
            if kind.startswith('FILE:'):
                viol.append(('write-to-file', tgt, '', line.strip()[:160]))
print(f'trace_lines={n_lines} readonly_opens={n_open_ro} write_targets={write_targets} violations={len(viol)}')
for v in viol[:6]:
    print('  VIOLATION', v)
sys.exit(1 if viol else 0)
